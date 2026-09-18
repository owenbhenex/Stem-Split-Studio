/**
 * Web Audio Engine — Stem Splitter Studio
 * Manages sample-accurate multitrack playback, click-free parameter smoothing,
 * stereo panning, solo/mute routing matrix, and real-time VU peak metering.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.masterLimiter = null;
    this.masterAnalyser = null;

    /** @type {Map<string, StemTrack>} */
    this.tracks = new Map();

    this.isPlaying = false;
    this.playhead = 0; // In seconds
    this.startTime = 0; // AudioContext time when current playback started
    this.duration = 0; // Max duration across all stems in seconds

    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // Buffer for analyser reading
    this.meterDataArray = new Uint8Array(32);
  }

  /**
   * Initialize AudioContext upon user gesture or audio load
   */
  initContext() {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();

      // Master Limiter (Soft Clipper / Ear Protection)
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.setValueAtTime(-0.5, this.ctx.currentTime);
      this.masterLimiter.knee.setValueAtTime(3.0, this.ctx.currentTime);
      this.masterLimiter.ratio.setValueAtTime(20.0, this.ctx.currentTime);
      this.masterLimiter.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.masterLimiter.release.setValueAtTime(0.1, this.ctx.currentTime);

      // Master Gain
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);

      // Master Analyser
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 64;
      this.masterAnalyser.smoothingTimeConstant = 0.6;

      // Graph: MasterGain -> Limiter -> MasterAnalyser -> Destination
      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Register a stem track into the engine
   * @param {string} id - Stem key (e.g. "vocals")
   * @param {AudioBuffer} audioBuffer
   * @param {number} initialVol - Default 0.9
   */
  addTrack(id, audioBuffer, initialVol = 0.9) {
    this.initContext();

    // Channel Strip Nodes
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(initialVol, this.ctx.currentTime);

    // Panner Node (Stereo)
    let pannerNode = null;
    if (this.ctx.createStereoPanner) {
      pannerNode = this.ctx.createStereoPanner();
      pannerNode.pan.setValueAtTime(0, this.ctx.currentTime);
    }

    // Analyser Node for track VU meter
    const analyserNode = this.ctx.createAnalyser();
    analyserNode.fftSize = 64;
    analyserNode.smoothingTimeConstant = 0.65;

    // Connect Track Graph
    if (pannerNode) {
      pannerNode.connect(gainNode);
    }
    gainNode.connect(analyserNode);
    analyserNode.connect(this.masterGain);

    const track = {
      id,
      buffer: audioBuffer,
      source: null,
      gainNode,
      pannerNode,
      analyserNode,
      vol: initialVol,
      pan: 0,
      muted: false,
      solo: false,
    };

    this.tracks.set(id, track);

    if (audioBuffer.duration > this.duration) {
      this.duration = audioBuffer.duration;
      this.loopEnd = this.duration;
    }

    this.applyGains();
    return track;
  }

  /**
   * Recalculate and smoothly ramp gain for all tracks based on Solo / Mute states
   */
  applyGains() {
    if (!this.ctx) return;
    const anySolo = Array.from(this.tracks.values()).some((t) => t.solo);
    const now = this.ctx.currentTime;
    const rampTime = 0.015; // 15ms click-free crossfade

    for (const track of this.tracks.values()) {
      let targetGain = 0;
      if (anySolo) {
        targetGain = track.solo ? track.vol : 0;
      } else {
        targetGain = track.muted ? 0 : track.vol;
      }
      track.gainNode.gain.setTargetAtTime(targetGain, now, rampTime);
    }
  }

  /**
   * Set channel volume (0.0 to 1.5)
   */
  setTrackVolume(id, vol) {
    const track = this.tracks.get(id);
    if (!track) return;
    track.vol = Math.max(0, Math.min(1.5, vol));
    this.applyGains();
  }

  /**
   * Set channel stereo pan (-1.0 to +1.0)
   */
  setTrackPan(id, pan) {
    const track = this.tracks.get(id);
    if (!track || !track.pannerNode || !this.ctx) return;
    const clamped = Math.max(-1, Math.min(1, pan));
    track.pan = clamped;
    track.pannerNode.pan.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
  }

  /**
   * Toggle track mute
   */
  toggleTrackMute(id) {
    const track = this.tracks.get(id);
    if (!track) return false;
    track.muted = !track.muted;
    this.applyGains();
    return track.muted;
  }

  /**
   * Toggle track solo
   */
  toggleTrackSolo(id) {
    const track = this.tracks.get(id);
    if (!track) return false;
    track.solo = !track.solo;
    this.applyGains();
    return track.solo;
  }

  /**
   * Clear all solos
   */
  clearAllSolos() {
    for (const track of this.tracks.values()) {
      track.solo = false;
    }
    this.applyGains();
  }

  /**
   * Set master volume (0.0 to 1.25)
   */
  setMasterVolume(vol) {
    if (!this.masterGain || !this.ctx) return;
    const clamped = Math.max(0, Math.min(1.25, vol));
    this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.015);
  }

  /**
   * Start sample-accurate synchronized playback across all loaded stems
   * @returns {Promise<boolean>}
   */
  async play() {
    this.initContext();
    if (this.tracks.size === 0 || this.duration === 0) return false;

    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {
        console.warn('AudioContext resume failed:', e);
      }
    }

    if (this.isPlaying) return true;

    // Guard against playhead past duration
    if (this.playhead >= this.duration) {
      this.playhead = this.loopEnabled ? this.loopStart : 0;
    }

    const now = this.ctx.currentTime;
    this.startTime = now - this.playhead;

    for (const track of this.tracks.values()) {
      if (!track.buffer) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;

      if (track.pannerNode) {
        src.connect(track.pannerNode);
      } else {
        src.connect(track.gainNode);
      }

      const offset = Math.max(0, Math.min(this.playhead, track.buffer.duration - 0.005));
      if (this.playhead < track.buffer.duration) {
        src.start(0, offset);
      }
      track.source = src;
    }

    this.isPlaying = true;
    return true;
  }

  /**
   * Pause playback and hold current position
   */
  pause() {
    if (!this.isPlaying) return;
    this.stopSources();
    if (this.ctx) {
      this.playhead = Math.max(0, Math.min(this.ctx.currentTime - this.startTime, this.duration));
    }
    this.isPlaying = false;
  }

  /**
   * Stop all active buffer sources
   */
  stopSources() {
    for (const track of this.tracks.values()) {
      if (track.source) {
        try {
          track.source.stop();
        } catch {
          // Ignore if already stopped
        }
        try {
          track.source.disconnect();
        } catch {}
        track.source = null;
      }
    }
  }

  /**
   * Seek to timestamp in seconds
   * @param {number} time
   */
  seek(time) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.pause();
    }
    this.playhead = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) {
      this.play();
    }
  }

  /**
   * Get current playhead position in seconds
   * @returns {number}
   */
  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) {
      return this.playhead;
    }
    const current = this.ctx.currentTime - this.startTime;
    if (this.loopEnabled && current >= this.loopEnd) {
      this.seek(this.loopStart);
      return this.loopStart;
    }
    if (current >= this.duration) {
      this.pause();
      this.playhead = 0;
      return 0;
    }
    return current;
  }

  /**
   * Sample RMS/peak value for a given track (0.0 to 1.0)
   * @param {string} id
   * @returns {number}
   */
  getTrackLevel(id) {
    if (!this.isPlaying) return 0;
    const track = this.tracks.get(id);
    if (!track || !track.analyserNode) return 0;

    track.analyserNode.getByteTimeDomainData(this.meterDataArray);
    let sum = 0;
    for (let i = 0; i < this.meterDataArray.length; i++) {
      const v = (this.meterDataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.meterDataArray.length);
    return Math.min(1, rms * 3.5); // Boost scale for UI visibility
  }

  /**
   * Sample master output level (0.0 to 1.0)
   * @returns {number}
   */
  getMasterLevel() {
    if (!this.isPlaying || !this.masterAnalyser) return 0;
    this.masterAnalyser.getByteTimeDomainData(this.meterDataArray);
    let sum = 0;
    for (let i = 0; i < this.meterDataArray.length; i++) {
      const v = (this.meterDataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.meterDataArray.length);
    return Math.min(1, rms * 3.0);
  }

  /**
   * Clean up all audio nodes and buffers
   */
  dispose() {
    this.pause();
    this.stopSources();
    this.tracks.clear();
    this.duration = 0;
    this.playhead = 0;
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }
}
