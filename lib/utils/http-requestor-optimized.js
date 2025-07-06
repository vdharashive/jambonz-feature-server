const {request} = require('undici');
const parseUrl = require('parse-url');
const assert = require('assert');
const BaseRequestor = require('./base-requestor');
const {HookMsgTypes} = require('./constants.json');
const snakeCaseKeys = require('./snakecase-keys');
const {getConnectionPoolManager} = require('./connection-pool-manager');
const {
  HTTP_POOL,
  HTTP_TIMEOUT,
  HTTP_PROXY_IP,
  HTTP_PROXY_PORT,
  HTTP_PROXY_PROTOCOL,
  NODE_ENV,
  HTTP_USER_AGENT_HEADER,
} = require('../config');
const {HTTPResponseError} = require('./error');

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

/**
 * Optimized HTTP requestor with improved connection pooling and performance
 */
class OptimizedHttpRequestor extends BaseRequestor {
  constructor(logger, account_sid, hook, secret) {
    super(logger, account_sid, hook, secret);

    this.method = hook.method || 'POST';
    this.authHeader = basicAuth(hook.username, hook.password);
    this.backoffMs = 500;
    this.maxRetries = 3;
    this.retryDelay = 1000;

    assert(this._isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));

    const u = this._parsedUrl = parseUrl(this.url);
    this._protocol = u.protocol;
    this._resource = u.resource;
    this._port = u.port;
    this._search = u.search;
    this._usePools = HTTP_POOL && parseInt(HTTP_POOL);

    // Use the optimized connection pool manager
    if (this._usePools) {
      this.poolManager = getConnectionPoolManager();
    }

    // Request statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retryCount: 0,
      totalResponseTime: 0,
      averageResponseTime: 0
    };
  }

  /**
   * Get the appropriate client for the request
   * @param {string} url - The request URL
   * @returns {Object} Client and request configuration
   */
  getClientConfig(url) {
    const absUrl = this._isRelativeUrl(url) ? `${this.baseUrl}${url}` : url;
    const parsedUrl = parseUrl(absUrl);
    
    let client = null;
    let path = '';
    let query = '';
    
    if (this._usePools) {
      // Use connection pool for better performance
      if (this._isRelativeUrl(url)) {
        client = this.poolManager.getPool(this.baseUrl);
        path = url;
      } else {
        const baseUrl = `${parsedUrl.protocol}://${parsedUrl.resource}${parsedUrl.port ? ':' + parsedUrl.port : ''}`;
        client = this.poolManager.getPool(baseUrl);
        path = parsedUrl.pathname;
        query = parsedUrl.query;
      }
    } else {
      // Use individual client
      client = this.poolManager.getClient(absUrl);
      path = parsedUrl.pathname;
      query = parsedUrl.query;
    }
    
    return { client, path, query, absUrl };
  }

  /**
   * Make an HTTP request with optimized connection handling
   * @param {string} type - Request type
   * @param {Object|string} hook - Hook configuration or URL
   * @param {Object} params - Request parameters
   * @param {Object} httpHeaders - Additional HTTP headers
   * @param {Object} span - Tracing span
   * @returns {Promise<any>} Response data
   */
  async request(type, hook, params, httpHeaders = {}, span) {
    // Skip jambonz:error over HTTP
    if (type === 'jambonz:error') return;

    assert(HookMsgTypes.includes(type));

    const startTime = process.hrtime();
    const payload = params ? snakeCaseKeys(params, ['customerData', 'sip', 'env_vars', 'args']) : null;
    const url = hook.url || hook;
    const method = hook.method || 'POST';
    
    this.stats.totalRequests++;
    
    // Set up headers
    httpHeaders = {
      ...httpHeaders,
      ...(HTTP_USER_AGENT_HEADER && {'user-agent': HTTP_USER_AGENT_HEADER})
    };

    assert.ok(url, 'OptimizedHttpRequestor:request url was not provided');
    assert.ok(['GET', 'POST'].includes(method), `OptimizedHttpRequestor:request method must be 'GET' or 'POST' not ${method}`);

    // Handle WebSocket handover
    if (this._isAbsoluteUrl(url) && url.startsWith('ws')) {
      const WsRequestor = require('./ws-requestor');
      this.logger.debug({hook}, 'OptimizedHttpRequestor: switching to websocket connection');
      const h = typeof hook === 'object' ? hook : {url: hook};
      const requestor = new WsRequestor(this.logger, this.account_sid, h, this.secret);
      if (type === 'session:redirect') {
        this.close();
        this.emit('handover', requestor);
      }
      return requestor.request('session:new', hook, params, httpHeaders, span);
    }

    // Parse URL for retry configuration
    const parsedUrl = parseUrl(this._isRelativeUrl(url) ? `${this.baseUrl}${url}` : url);
    const hash = parsedUrl.hash || '';
    const hashObj = hash ? this._parseHashParams(hash) : {};
    
    // Retry configuration
    const maxRetries = Math.min(Math.abs(parseInt(hashObj.rc || '0')), 5);
    const retryPolicy = hashObj.rp || 'ct';
    const retryPolicyValues = retryPolicy.split(',').map(v => v.trim());
    
    let retryCount = 0;
    let lastError = null;
    let response = null;

    while (retryCount <= maxRetries) {
      try {
        response = await this.makeRequest(url, method, payload, httpHeaders, span);
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        retryCount++;
        
        // Check if we should retry
        if (retryCount <= maxRetries && this._shouldRetry(error, retryPolicyValues)) {
          this.logger.info({
            error: error.message,
            baseUrl: this.baseUrl,
            url,
            retryCount,
            maxRetries
          }, `Retrying request (${retryCount}/${maxRetries})`);
          
          this.stats.retryCount++;
          const delay = this.backoffMs * Math.pow(2, retryCount - 1);
          await this.sleep(delay);
        } else {
          break; // No more retries
        }
      }
    }

    // Update statistics
    const responseTime = this.calculateResponseTime(startTime);
    this.updateStats(response !== null, responseTime);

    if (lastError && !response) {
      await this.handleError(lastError, url);
      throw lastError;
    }

    // Log successful response
    if (response && (Array.isArray(response) || type === 'llm:tool-call')) {
      this.logger.info({response}, `OptimizedHttpRequestor:request ${method} ${url} succeeded in ${responseTime}ms`);
    }

    return response;
  }

  /**
   * Make a single HTTP request
   * @param {string} url - Request URL
   * @param {string} method - HTTP method
   * @param {Object} payload - Request payload
   * @param {Object} httpHeaders - HTTP headers
   * @param {Object} span - Tracing span
   * @returns {Promise<any>} Response data
   */
  async makeRequest(url, method, payload, httpHeaders, span) {
    const { client, path, query, absUrl } = this.getClientConfig(url);
    
    const sigHeader = this._generateSigHeader(payload, this.secret);
    const headers = {
      ...sigHeader,
      ...this.authHeader,
      ...httpHeaders,
      ...('POST' === method && {'Content-Type': 'application/json'})
    };

    const requestOptions = {
      path,
      query,
      method,
      headers,
      ...('POST' === method && {body: JSON.stringify(payload)}),
      timeout: HTTP_TIMEOUT,
      followRedirects: false
    };

    this.logger.debug({url, absUrl, headers}, 'OptimizedHttpRequestor: sending request');

    let response;
    if (HTTP_PROXY_IP) {
      response = await request(absUrl, requestOptions);
    } else {
      response = await client.request(requestOptions);
    }

    const {statusCode, body} = response;

    if (![200, 202, 204].includes(statusCode)) {
      const error = new HTTPResponseError(statusCode);
      throw error;
    }

    if (response.headers['content-type']?.includes('application/json')) {
      return await body.json();
    }

    return '';
  }

  /**
   * Calculate response time from start time
   * @param {Array} startTime - Process hrtime start time
   * @returns {number} Response time in milliseconds
   */
  calculateResponseTime(startTime) {
    const diff = process.hrtime(startTime);
    return diff[0] * 1000 + diff[1] * 1e-6;
  }

  /**
   * Update request statistics
   * @param {boolean} success - Whether the request was successful
   * @param {number} responseTime - Response time in milliseconds
   */
  updateStats(success, responseTime) {
    if (success) {
      this.stats.successfulRequests++;
      this.stats.totalResponseTime += responseTime;
      this.stats.averageResponseTime = this.stats.totalResponseTime / this.stats.successfulRequests;
    } else {
      this.stats.failedRequests++;
    }
  }

  /**
   * Handle request errors
   * @param {Error} error - The error object
   * @param {string} url - Request URL
   */
  async handleError(error, url) {
    if (error.statusCode) {
      this.logger.info({baseUrl: this.baseUrl, url},
        `web callback returned unexpected status code ${error.statusCode}`);
    } else {
      this.logger.error({err: error, baseUrl: this.baseUrl, url},
        'web callback returned unexpected error');
    }

    // Generate alerts
    let opts = {account_sid: this.account_sid};
    if (error.code === 'ECONNREFUSED') {
      opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url};
    } else if (error.name === 'StatusError') {
      opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_STATUS_FAILURE, url, status: error.statusCode};
    } else {
      opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url, detail: error.message};
    }

    try {
      await this.Alerter.writeAlerts(opts);
    } catch (alertError) {
      this.logger.info({err: alertError, opts}, 'Error writing alert');
    }
  }

  /**
   * Sleep for a specified duration
   * @param {number} ms - Duration in milliseconds
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get request statistics
   * @returns {Object} Request statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.totalRequests > 0 ? 
        (this.stats.successfulRequests / this.stats.totalRequests) * 100 : 0,
      failureRate: this.stats.totalRequests > 0 ?
        (this.stats.failedRequests / this.stats.totalRequests) * 100 : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retryCount: 0,
      totalResponseTime: 0,
      averageResponseTime: 0
    };
  }

  /**
   * Close the requestor and cleanup resources
   */
  close() {
    // Connection pool manager handles cleanup automatically
    // No need to close individual connections
  }
}

module.exports = OptimizedHttpRequestor;