const assert = require('assert');
const BaseRequestor = require('./base-requestor');
const short = require('short-uuid');
const parseUrl = require('parse-url');
const {HookMsgTypes, WS_CLOSE_CODES} = require('./constants.json');
const Websocket = require('ws');
const snakeCaseKeys = require('./snakecase-keys');
const {
  RESPONSE_TIMEOUT_MS,
  JAMBONES_WS_PING_INTERVAL_MS,
  MAX_RECONNECTS,
  JAMBONES_WS_HANDSHAKE_TIMEOUT_MS,
  JAMBONES_WS_MAX_PAYLOAD,
  HTTP_USER_AGENT_HEADER
} = require('../config');
const MTYPE_WANTS_ACK = [
  'call:status',
  'verb:status',
  'jambonz:error',
  'llm:event',
  'llm:tool-call',
  'tts:streaming-event',
  'tts:tokens-result',
];
const MTYPE_NO_DATA = [
  'llm:tool-output',
  'tts:flush',
  'tts:clear'
];

class WsRequestor extends BaseRequestor {
  constructor(logger, account_sid, hook, secret) {
    super(logger, account_sid, hook, secret);
    this.connections = 0;
    this.messagesInFlight = new Map();
    this.maliciousClient = false;
    this.closedGracefully = false;
    this.backoffMs = 500;
    this.connectInProgress = false;
    this.queuedMsg = [];
    this.id = short.generate();

    assert(this._isAbsoluteUrl(this.url));

    const parsedUrl = parseUrl(this.url);
    const hash = parsedUrl.hash || '';
    const hashObj = hash ? this._parseHashParams(hash) : {};

    // remove hash
    this.cleanUrl = hash ? this.url.replace(`#${hash}`, '') : this.url;

    // Retry policy: rp valid values: 4xx, 5xx, ct, rt, all, default is ct
    // Retry count: rc valid values: 1-5, default is 5 for websockets
    this.maxReconnects = Math.min(Math.abs(parseInt(hashObj.rc) || MAX_RECONNECTS), 5);
    this.retryPolicy = hashObj.rp || 'ct';
    this.retryPolicyValues = this.retryPolicy.split(',').map((v) => v.trim());

    this.on('socket-closed', this._onSocketClosed.bind(this));
  }

  /**
   * Send a JSON payload over the websocket.  If this is the first request,
   * open the websocket.
   * All requests expect an ack message in response
   * @param {object|string} hook - may be a absolute or relative url, or an object
   * @param {string} [hook.url] - an absolute or relative url
   * @param {string} [hook.method] - 'GET' or 'POST'
   * @param {string} [hook.username] - if basic auth is protecting the endpoint
   * @param {string} [hook.password] - if basic auth is protecting the endpoint
   * @param {object} [params] - request parameters
   */
  async request(type, hook, params, httpHeaders = {}, span) {
    assert(HookMsgTypes.includes(type));
    const url = hook.url || hook;
    const wantsAck = !MTYPE_WANTS_ACK.includes(type);

    if (this.maliciousClient) {
      this.logger.info({url: this.url}, 'WsRequestor:request - discarding msg to malicious client');
      return;
    }
    if (this.closedGracefully) {
      this.logger.debug(`WsRequestor:request - discarding ${type} because socket was closed gracefully`);
      return;
    }

    if (type === 'session:new') this.call_sid = params.callSid;
    if (type === 'session:reconnect') {
      this._reconnectPromise = new Promise((resolve, reject) => {
        this._reconnectResolve = resolve;
        this._reconnectReject = reject;
      });
    }

    /* if we have an absolute url, and it is http then do a standard webhook */
    if (this._isAbsoluteUrl(url) && url.startsWith('http')) {
      const HttpRequestor = require('./http-requestor');
      this.logger.debug({hook}, 'WsRequestor: sending a webhook (HTTP)');
      const h = typeof hook === 'object' ? hook : {url: hook};
      const requestor = new HttpRequestor(this.logger, this.account_sid, h, this.secret);
      if (type === 'session:redirect') {
        this.close();
        this.emit('handover', requestor);
      }
      return requestor.request(type, hook, params, httpHeaders, span);
    }

    /* connect if necessary */
    const queueMsg = () => {
      this.logger.debug(
        `WsRequestor:request(${this.id}) - queueing ${type} message since we are connecting`);
      if (wantsAck) {
        const p = new Promise((resolve, reject) => {
          this.queuedMsg.push({type, hook, params, httpHeaders, promise: {resolve, reject}});
        });
        return p;
      }
      else {
        this.queuedMsg.push({type, hook, params, httpHeaders});
      }
      return;
    };
    if (!this.ws) {
      if (this.connectInProgress) {
        return queueMsg();
      }
      this.connectInProgress = true;
      this.logger.debug(`WsRequestor:request(${this.id}) - connecting since we do not have a connection for ${type}`);

      try {
        let retryCount = 0;
        let lastError = null;

        while (retryCount <= this.maxReconnects) {
          try {
            this.logger.debug({retryCount, maxReconnects: this.maxReconnects},
              'WsRequestor:request - attempting connection retry');

            // Ensure clean state before each connection attempt
            if (this.ws) {
              this.ws.removeAllListeners();
              this.ws = null;
            }

            const startAt = process.hrtime();
            await this._connect();
            const rtt = this._roundTrip(startAt);
            this.stats.histogram('app.hook.connect_time', rtt, ['hook_type:app']);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            retryCount++;

            if (retryCount <= this.maxReconnects &&
                this.retryPolicyValues?.length &&
                this._shouldRetry(error, this.retryPolicyValues)) {

              const delay = this.backoffMs;
              this.backoffMs = this.backoffMs < 2000 ? this.backoffMs * 2 : (this.backoffMs + 2000);
              this.logger.debug({delay}, 'WsRequestor:request - waiting before retry');
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }

            this.logger.error({error: error.message, retryCount, maxReconnects: this.maxReconnects},
              'WsRequestor:request - all connection attempts failed');
            throw lastError;
          }
        }

        // If we exit the loop without success, throw the last error
        if (lastError) {
          throw lastError;
        }
      } catch (err) {
        this.logger.info({url, err, retryPolicy: this.retryPolicy},
          'WsRequestor:request - all connection attempts failed');
        this.connectInProgress = false;
        return Promise.reject(err);
      }
    }
    // If jambonz wait for ack from reconnect, queue the msg until reconnect is acked
    if (type !== 'session:reconnect' && this._reconnectPromise) {
      return queueMsg();
    }
    assert(this.ws);

    /* prepare and send message */
    let payload = params ? snakeCaseKeys(params, ['customerData', 'sip', 'env_vars', 'args']) : null;
    if (type === 'session:new' || type === 'session:adulting') this._sessionData = payload;
    if (type === 'session:reconnect') payload = this._sessionData;
    assert.ok(url, 'WsRequestor:request url was not provided');

    const msgid = short.generate();
    // save initial msgid in case we need to reconnect during initial session:new
    if (type === 'session:new') this._initMsgId = msgid;

    const b3 = httpHeaders?.b3 ? {b3: httpHeaders.b3} : {};
    const obj = {
      type,
      msgid,
      call_sid: this.call_sid,
      hook: [
        'verb:hook', 'dial:confirm', 'session:redirect', 'llm:event', 'llm:tool-call'
      ].includes(type) ? url : undefined,
      data: {...payload},
      ...b3
    };
    // add msgid to span attributes if it exists
    if (span) {
      span.setAttributes({'msgid': msgid});
    }

    const sendQueuedMsgs = () => {
      if (this.queuedMsg.length > 0) {
        for (const {type, hook, params, httpHeaders, promise} of this.queuedMsg) {
          this.logger.debug(`WsRequestor:request - preparing queued ${type} for sending`);
          if (promise) {
            this.request(type, hook, params, httpHeaders, span)
              .then((res) => promise.resolve(res))
              .catch((err) => promise.reject(err));
          }
          else setImmediate(this.request.bind(this, type, hook, params, httpHeaders));
        }
        this.queuedMsg.length = 0;
      }
    };

    const rejectQueuedMsgs = (err) => {
      if (this.queuedMsg.length > 0) {
        for (const {promise} of this.queuedMsg) {
          this.logger.debug(`WsRequestor:request - preparing queued ${type} for rejectQueuedMsgs`);
          if (promise) {
            promise.reject(err);
          }
        }
        this.queuedMsg.length = 0;
      }
    };

    //this.logger.debug({obj}, `websocket: sending (${url})`);

    /* special case: reconnecting before we received ack to session:new */
    let reconnectingWithoutAck = false;
    if (type === 'session:reconnect' && this._initMsgId) {
      reconnectingWithoutAck = true;
      const obj = this.messagesInFlight.get(this._initMsgId);
      this.messagesInFlight.delete(this._initMsgId);
      this.messagesInFlight.set(msgid, obj);
      this._initMsgId = msgid;
    }

    /* simple notifications */
    if (!wantsAck || reconnectingWithoutAck) {
      this.ws?.send(JSON.stringify(obj), () => {
        this.logger.debug({obj}, `WsRequestor:request websocket: sent (${url})`);
        sendQueuedMsgs();
      });
      return;
    }

    /* messages that require an ack */
    return new Promise((resolve, reject) => {
      /* give the far end a reasonable amount of time to ack our message */
      const timer = setTimeout(() => {
        const {failure} = this.messagesInFlight.get(msgid) || {};
        failure && failure(`timeout from far end for msgid ${msgid}`);
        this.messagesInFlight.delete(msgid);
      }, RESPONSE_TIMEOUT_MS);

      /* save the message info for reply */
      const startAt = process.hrtime();
      this.messagesInFlight.set(msgid, {
        timer,
        success: (response) => {
          clearTimeout(timer);
          const rtt = this._roundTrip(startAt);
          this.logger.debug({response}, `WsRequestor:request ${url} succeeded in ${rtt}ms`);
          this.stats.histogram('app.hook.ws_response_time', rtt, ['hook_type:app']);
          resolve(response);
          if (this._reconnectResolve) {
            this._reconnectResolve();
          }
        },
        failure: (err) => {
          if (this._reconnectReject) {
            this._reconnectReject(err);
          }
          clearTimeout(timer);
          reject(err);
        }
      });

      /* send the message */
      this.ws.send(JSON.stringify(obj), async() => {
        this.logger.debug({obj}, `WsRequestor:request websocket: sent (${url})`);
        // If session:reconnect is waiting for ack, hold here until ack to send queuedMsgs
        if (this._reconnectPromise) {
          try {
            await this._reconnectPromise;
          } catch (err) {
            // bad thing happened to session:recconnect
            rejectQueuedMsgs(err);
            this.emit('reconnect-error');
            return;
          } finally {
            this._reconnectPromise = null;
            this._reconnectResolve = null;
            this._reconnectReject = null;
          }
        }
        sendQueuedMsgs();
      });
    });
  }

  _stopPingTimer() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  close(code = WS_CLOSE_CODES.NormalClosure) {
    this.closedGracefully = true;
    this.logger.debug(`WsRequestor:close closing socket with code ${code}`);
    this._stopPingTimer();
    try {
      if (this.ws) {
        this.ws.close(code);
        this.ws.removeAllListeners();
        this.ws = null;
      }
      this._clearPendingMessages();
    } catch (err) {
      this.logger.info({err}, 'WsRequestor: Error closing socket');
    }
  }

  _connect() {
    assert(!this.ws);
    this._stopPingTimer();
    return new Promise((resolve, reject) => {
      const handshakeTimeout = JAMBONES_WS_HANDSHAKE_TIMEOUT_MS ?
        parseInt(JAMBONES_WS_HANDSHAKE_TIMEOUT_MS) :
        1500;
      let opts = {
        followRedirects: true,
        maxRedirects: 2,
        handshakeTimeout,
        maxPayload: JAMBONES_WS_MAX_PAYLOAD ? parseInt(JAMBONES_WS_MAX_PAYLOAD) : 24 * 1024,
        headers: {
          ...(HTTP_USER_AGENT_HEADER && {'user-agent' : HTTP_USER_AGENT_HEADER})
        }
      };
      if (this.username && this.password) opts = {...opts, auth: `${this.username}:${this.password}`};

      // Clean up any existing connection event listeners to prevent interference between retry attempts
      this.removeAllListeners('ready');
      this.removeAllListeners('not-ready');

      this
        .once('ready', (ws) => {
          this.logger.debug('WsRequestor:_connect - ready event fired, resolving Promise');
          this.removeAllListeners('not-ready');
          if (this.connections > 1) this.request('session:reconnect', this.url);
          resolve();
        })
        .once('not-ready', (err) => {
          this.logger.error({err: err.message}, 'WsRequestor:_connect - not-ready event fired, rejecting Promise');
          this.removeAllListeners('ready');
          reject(err);
        });
      const ws = new Websocket(this.cleanUrl, ['ws.jambonz.org'], opts);
      this._setHandlers(ws);
    });
  }

  _setHandlers(ws) {
    ws
      .once('open', this._onOpen.bind(this, ws))
      .once('close', this._onClose.bind(this))
      .on('message', this._onMessage.bind(this))
      .once('unexpected-response', this._onUnexpectedResponse.bind(this, ws))
      .on('error', this._onError.bind(this));
  }

  _clearPendingMessages() {
    for (const [msgid, obj] of this.messagesInFlight) {
      const {timer} = obj;
      clearTimeout(timer);
      if (!this._initMsgId) obj.failure(`abandoning msgid ${msgid} since socket is closed`);
    }
    this.messagesInFlight.clear();
  }

  _onError(err) {
    if (this.connectInProgress) {
      this.logger.info({url: this.url, err}, 'WsRequestor:_onError - emitting not-ready for connection attempt');
      this.emit('not-ready', err);
    }
    else if (this.connections === 0) {
      this.emit('not-ready', err);
    }
  }

  _onOpen(ws) {
    this.logger.info({url: this.url}, `WsRequestor(${this.id}) - successfully connected`);
    if (this.ws) this.logger.info({old_ws: this.ws._socket.address()}, 'WsRequestor:_onOpen');
    assert(!this.ws);
    this.ws = ws;
    this.connectInProgress = false;
    this.connections++;
    this.emit('ready', ws);

    if (JAMBONES_WS_PING_INTERVAL_MS > 15000) {
      this._pingTimer = setInterval(() => this.ws?.ping(), JAMBONES_WS_PING_INTERVAL_MS);
    }
  }

  _onClose(code) {
    this.logger.info(`WsRequestor(${this.id}) - closed from far end ${code}`);
    this._stopPingTimer();
    if (this.connections > 0 && code !== 1000) {
      this.logger.info({url: this.url}, 'WsRequestor - socket closed unexpectedly from remote side');
      this.emit('socket-closed');
    }
    else if (code === 1000) this.closedGracefully = true;
    this.ws?.removeAllListeners();
    this.ws = null;
  }

  _onUnexpectedResponse(ws, req, res) {
    assert(!this.ws);
    this.logger.info({
      headers: res.headers,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage
    }, 'WsRequestor - unexpected response');
    this.emit('connection-failure');

    const error = new Error(`${res.statusCode} ${res.statusMessage}`);
    error.statusCode = res.statusCode;
    this.connectInProgress = false;

    this.emit('not-ready', error);
  }

  _onSocketClosed() {
    this.ws = null;
    this.emit('connection-dropped');
    this._stopPingTimer();

    if (this.connections > 0 && this.connections < this.maxReconnects && !this.closedGracefully) {
      if (!this._initMsgId) this._clearPendingMessages();
      this.logger.debug(`WsRequestor:_onSocketClosed waiting ${this.backoffMs} to reconnect`);
      this._scheduleReconnect('_onSocketClosed');
    }
  }

  _scheduleReconnect(source) {
    this.logger.debug(`WsRequestor:_scheduleReconnect waiting ${this.backoffMs} to reconnect (${source})`);
    setTimeout(() => {
      this.logger.debug(
        {haveWs: !!this.ws, connectInProgress: this.connectInProgress},
        `WsRequestor:_scheduleReconnect time to reconnect (${source})`);
      if (!this.ws && !this.connectInProgress) {
        this.connectInProgress = true;
        return this._connect()
          .catch((err) => this.logger.error(`WsRequestor:${source} There is error while reconnect`, err))
          .finally(() => this.connectInProgress = false);
      } else {
        this.logger.debug(
          {haveWs: !!this.ws, connectInProgress: this.connectInProgress},
          `WsRequestor:_scheduleReconnect skipping reconnect attempt (${source}) - conditions not met`);
      }
    }, this.backoffMs);
    this.backoffMs = this.backoffMs < 2000 ? this.backoffMs * 2 : (this.backoffMs + 2000);
  }

  _onMessage(content, isBinary) {
    if (this.isBinary) {
      this.logger.info({url: this.url}, 'WsRequestor:_onMessage - discarding binary message');
      this.maliciousClient = true;
      this.ws.close();
      return;
    }

    /* messages must be JSON format */
    try {
      const obj = JSON.parse(content);
      this.logger.debug({obj}, 'WsRequestor:_onMessage - received message');
      //const {type, msgid, command, call_sid = this.call_sid, queueCommand = false, data} = obj;
      const {type, msgid, command, queueCommand = false, tool_call_id, data} = obj;
      const call_sid = obj.callSid || this.call_sid;

      //this.logger.debug({obj}, 'WsRequestor:request websocket: received');
      assert.ok(type, 'type property not supplied');

      switch (type) {
        case 'ack':
          assert.ok(msgid, 'msgid not supplied');
          this._recvAck(msgid, data);
          break;

        case 'command':
          assert.ok(command, 'command property not supplied');
          assert.ok(data || MTYPE_NO_DATA.includes(command), 'data property not supplied');
          this._recvCommand(msgid, command, call_sid, queueCommand, tool_call_id, data);
          break;

        default:
          assert.ok(false, `invalid type property: ${type}`);
      }
    } catch (err) {
      this.logger.info({err, content}, 'WsRequestor:_onMessage - invalid incoming message');
      const params = {
        msg: 'InvalidMessage',
        details: err.message,
        content: Buffer.from(content).toString('utf-8')
      };
      const {writeAlerts, AlertType} = this.Alerter;
      writeAlerts({
        account_sid: this.account_sid,
        alert_type: AlertType.INVALID_APP_PAYLOAD,
        target_sid: this.call_sid,
        message: err.message,

      }).catch((err) => this.logger.info({err}, 'Error generating alert for invalid message'));
      this.request('jambonz:error', '/error', params)
        .catch((err) => this.logger.debug({err}, 'WsRequestor:_onMessage - Error sending'));
    }
  }

  _recvAck(msgid, data) {
    this._initMsgId = null;
    const obj = this.messagesInFlight.get(msgid);
    if (!obj) {
      this.logger.info({url: this.url}, `WsRequestor:_recvAck - ack to unknown msgid ${msgid}, discarding`);
      return;
    }
    //this.logger.debug({url: this.url}, `WsRequestor:_recvAck - received response to ${msgid}`);
    this.messagesInFlight.delete(msgid);
    const {success} = obj;
    success && success(data);
  }

  _recvCommand(msgid, command, call_sid, queueCommand, tool_call_id, data) {
    // TODO: validate command
    this.logger.debug({msgid, command, call_sid, queueCommand, data}, 'received command');
    this.emit('command', {msgid, command, call_sid, queueCommand, tool_call_id, data});
  }
}

module.exports = WsRequestor;
