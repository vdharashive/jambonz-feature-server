const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const normalizeJambones = require('../utils/normalize-jambones');

class Lex extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.credentials = this.data.credentials;
    this.bot = this.data.bot;
    this.alias = this.data.alias;
    this.region = this.data.region;
    this.bargein = this.data.bargein || false;
    this.passDtmf = this.data.passDtmf || false;
    if (this.data.noInputTimeout) this.noInputTimeout = this.data.noInputTimeout * 1000;
    if (this.data.tts) {
      this.vendor = this.data.tts.vendor || 'default';
      this.language = this.data.tts.language || 'default';
      this.voice = this.data.tts.voice || 'default';
    }

    this.botName = `${this.bot}:${this.alias}:${this.region}`;
    if (this.data.eventHook) this.eventHook = this.data.eventHook;
    if (this.eventHook && Array.isArray(this.data.events)) {
      this.events = this.data.events;
    }
    else if (this.eventHook) {
      // send all events by default - except interim transcripts
      this.events = [
        'intent',
        'transcription',
        'dtmf',
        'start-play',
        'stop-play',
        'play-interrupted',
        'response-text'
      ];
    }
    else {
      this.events = [];
    }
    if (this.data.actionHook) this.actionHook = this.data.actionHook;
  }

  get name() { return TaskName.Lex; }

  async exec(cs, ep) {
    await super.exec(cs);

    try {
      await this.init(cs, ep);

      this.logger.debug(`starting lex bot ${this.botName}`);

      // kick it off
      this.ep.api('aws_lex_start', `${this.ep.uuid} ${this.bot} ${this.alias} ${this.region}`)
        .catch((err) => {
          this.logger.error({err}, `Error starting lex bot ${this.botName}`);
          this.notifyTaskDone();
        });

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Lex:exec error');
    }
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('Lex:kill');
      this.ep.removeCustomEventListener('lex::intent');
      this.ep.removeCustomEventListener('lex::transcription');
      this.ep.removeCustomEventListener('lex::audio_provided');
      this.ep.removeCustomEventListener('lex::text_response');
      this.ep.removeCustomEventListener('lex::playback_interruption');
      this.ep.removeCustomEventListener('lex::error');
      this.ep.removeAllListeners('dtmf');

      this.performAction({lexResult: 'caller hungup'})
        .catch((err) => this.logger.error({err}, 'lex - error w/ action webook'));

      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.notifyTaskDone();
  }

  async init(cs, ep) {
    this.ep = ep;
    try {
      if (this.vendor === 'default') {
        this.vendor = cs.speechSynthesisVendor;
        this.language = cs.speechSynthesisLanguage;
        this.voice = cs.speechSynthesisVoice;
      }
      this.ep.addCustomEventListener('lex::intent', this._onIntent.bind(this, ep, cs));
      this.ep.addCustomEventListener('lex::transcription', this._onTranscription.bind(this, ep, cs));
      this.ep.addCustomEventListener('lex::audio_provided', this._onAudioProvided.bind(this, ep, cs));
      this.ep.addCustomEventListener('lex::text_response', this._onTextResponse.bind(this, ep, cs));
      this.ep.addCustomEventListener('lex::playback_interruption', this._onPlaybackInterruption.bind(this, ep, cs));
      this.ep.addCustomEventListener('lex::error', this._onError.bind(this, ep, cs));
      this.ep.on('dtmf', this._onDtmf.bind(this, ep, cs));

      if (this.bargein) {
        await this.ep.set('x-amz-lex:barge-in-enabled', 1);
      }
      if (this.noInputTimeout) {
        await this.ep.set('x-amz-lex:start-silence-threshold-ms', this.noInputTimeout);
      }

    } catch (err) {
      this.logger.error({err}, 'Error setting listeners');
      throw err;
    }
  }

  /**
   * An intent has been returned.
   * we may get an empty intent, signified by ...
   * In such a case, we just restart the bot.
   * @param {*} ep -  media server endpoint
   * @param {*} evt - event data
   */
  _onIntent(ep, cs, evt) {
    this.logger.debug({evt}, `got intent for ${this.botName}`);
    if (this.events.includes('intent')) {
      this._performHook(cs, this.eventHook, {event: 'intent', data: evt});
    }
  }

  /**
   * A transcription - either interim or final - has been returned.
   * If we are doing barge-in based on hotword detection, check for the hotword or phrase.
   * If we are playing a filler sound, like typing, during the fullfillment phase, start that
   * if this is a final transcript.
   * @param {*} ep  -  media server endpoint
   * @param {*} evt - event data
   */
  _onTranscription(ep, cs, evt) {
    this.logger.debug({evt}, `got transcription for ${this.botName}`);
    if (this.events.includes('transcription')) {
      this._performHook(cs, this.eventHook, {event: 'transcription', data: evt});
    }
  }

  /**
   * @param {*} evt - event data
   */
  async _onTextResponse(ep, cs, evt) {
    this.logger.debug({evt}, `got text response for ${this.botName}`);
    if (this.events.includes('response-text')) {
      this._performHook(cs, this.eventHook, {event: 'response-text', data: evt});
    }
    if (this.vendor && ['PlainText', 'SSML'].includes(evt.type) && evt.msg) {
      const {srf} = cs;
      const {synthAudio} = srf.locals.dbHelpers;

      try {
        this.logger.debug(`tts with ${this.vendor} ${this.voice}`);
        const fp = await synthAudio({
          text: evt.msg,
          vendor: this.vendor,
          language: this.language,
          voice: this.voice,
          salt: cs.callSid
        });
        if (fp) cs.trackTmpFile(fp);
        if (this.events.includes('start-play')) {
          this._performHook(cs, this.eventHook, {event: 'start-play', data: {path: fp}});
        }
        await ep.play(fp);
        if (this.events.includes('stop-play')) {
          this._performHook(cs, this.eventHook, {event: 'stop-play', data: {path: fp}});
        }
        this.logger.debug(`finished tts, sending play_done  ${this.vendor} ${this.voice}`);
        this.ep.api('aws_lex_play_done', this.ep.uuid)
          .catch((err) => {
            this.logger.error({err}, `Error sending play_done ${this.botName}`);
          });
      } catch (err) {
        this.logger.error({err}, 'Lex:_onTextResponse - error playing tts');
      }
    }
  }

  /**
   * @param {*} evt - event data
   */
  _onPlaybackInterruption(ep, cs, evt) {
    this.logger.debug({evt}, `got playback interruption for ${this.botName}`);
    if (this.bargein) {
      if (this.events.includes('play-interrupted')) {
        this._performHook(cs, this.eventHook, {event: 'play-interrupted', data: {}});
      }
      this.ep.api('uuid_break', this.ep.uuid)
        .catch((err) => this.logger.info(err, 'Lex::_onPlaybackInterruption - Error killing audio'));
    }
  }

  /**
   * Lex has returned an error of some kind.
   * @param {*} evt - event data
   */
  _onError(ep, cs, evt) {
    this.logger.error({evt}, `got error for bot ${this.botName}`);
  }

  /**
   * Audio has been received from lex and written to a temporary disk file.
   * Start playing the audio, after killing any filler sound that might be playing.
   * When the audio completes, start the no-input timer.
   * @param {*} ep -  media server endpoint
   * @param {*} evt - event data
   */
  async _onAudioProvided(ep, cs, evt) {
    if (this.vendor) return;

    this.waitingForPlayStart = false;
    this.logger.debug({evt}, `got audio file for bot ${this.botName}`);

    try {
      if (this.events.includes('start-play')) {
        this._performHook(cs, this.eventHook, {event: 'start-play', data: {path: evt.path}});
      }
      await ep.play(evt.path);
      if (this.events.includes('stop-play')) {
        this._performHook(cs, this.eventHook, {event: 'stop-play', data: {path: evt.path}});
      }
      this.logger.debug({evt}, `done playing audio file for bot ${this.botName}`);
      this.ep.api('aws_lex_play_done', this.ep.uuid)
        .catch((err) => {
          this.logger.error({err}, `Error sending play_done ${this.botName}`);
        });
    } catch (err) {
      this.logger.error({err}, `Error playing file ${evt.path} for both ${this.botName}`);
    }

  }

  /**
   * receive a dmtf entry from the caller.
   * If we have active dtmf instructions, collect and process accordingly.
   */
  _onDtmf(ep, cs, evt) {
    this.logger.debug({evt}, 'Lex:_onDtmf');
    if (this.events.includes('dtmf')) {
      this._performHook(cs, this.eventHook, {event: 'dtmf', data: evt});
    }
    if (this.passDtmf) {
      this.ep.api('aws_lex_dtmf', `${this.ep.uuid} ${evt.dtmf}`)
        .catch((err) => {
          this.logger.error({err}, `Error sending dtmf ${evt.dtmf} ${this.botName}`);
        });
    }
  }

  async _performHook(cs, hook, results) {
    const json = await this.cs.requestor.request(hook, results);
    if (json && Array.isArray(json)) {
      const makeTask = require('./make_task');
      const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
      if (tasks && tasks.length > 0) {
        this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
        this.performAction({lexResult: 'redirect'}, false);
        cs.replaceApplication(tasks);
      }
    }
  }

}

module.exports = Lex;