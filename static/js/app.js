/**
 * Main Application Coordinator — Stem Splitter Studio
 * Orchestrates UI views, drag-and-drop, state store, Web Audio Engine,
 * channel strip rendering, and master transport controls.
 */

import { ApiClient } from './api.js';
import { AudioEngine } from './audio-engine.js';
import { WaveformRenderer } from './waveform.js';
import { StudioStore } from './state.js';

// Chromatic Stem Signatures
const STEM_CONFIG = {
  vocals: { label: 'Vocals', color: '#f43f5e', icon: '🎤' },
  bass: { label: 'Bass', color: '#06b6d4', icon: '🎸' },
  drums: { label: 'Drums', color: '#f59e0b', icon: '🥁' },
  guitar: { label: 'Guitar', color: '#10b981', icon: '🎸' },
  piano: { label: 'Piano', color: '#a855f7', icon: '🎹' },
  synth: { label: 'Synth', color: '#00f5d4', icon: '🎛️' },
  strings: { label: 'Strings', color: '#ec4899', icon: '🎻' },
  brass: { label: 'Brass', color: '#eab308', icon: '🎺' },
  organ: { label: 'Organ', color: '#7c3aed', icon: '⛪' },
  keys: { label: 'Keys', color: '#14b8a6', icon: '🎹' },
  other: { label: 'Other', color: '#94a3b8', icon: '📦' },
};

class StemSplitterApp {
  constructor() {
    this.store = new StudioStore();
    this.engine = new AudioEngine();
    this.stopPolling = null;
    this.rafId = null;
    this.resizeObserver = null;
    this.allMuted = false;

    /** @type {Array<{ id: string, name: string, url: string, color: string, peaks: Float32Array, canvas: HTMLCanvasElement, stripEl?: HTMLElement, meterEl?: HTMLElement, loadingEl?: HTMLElement, waveContainer?: HTMLElement }>} */
    this.loadedStems = [];

    // DOM Elements
    this.dom = {
      uploadView: document.getElementById('uploadView'),
      processingView: document.getElementById('processingView'),
      studioView: document.getElementById('studioView'),
      errorView: document.getElementById('errorView'),

      // Upload controls
      dropzone: document.getElementById('dropzone'),
      fileInput: document.getElementById('audioFileInput'),
      presetCards: document.querySelectorAll('.preset-card'),
      recentSplitsList: document.getElementById('recentSplitsList'),
      recentSplitsWrapper: document.getElementById('recentSplitsWrapper'),

      // Processing elements
      procName: document.getElementById('procName'),
      procStage: document.getElementById('procStage'),
      procPercent: document.getElementById('procPercent'),
      procBarFill: document.getElementById('procBarFill'),
      stepPass1: document.getElementById('stepPass1'),
      stepPass2: document.getElementById('stepPass2'),
      stepPass3: document.getElementById('stepPass3'),
      cancelProcessingBtn: document.getElementById('cancelProcessingBtn'),

      // Error elements
      errorText: document.getElementById('errorText'),
      errorRetryBtn: document.getElementById('errorRetryBtn'),

      // Studio Header
      trackNameDisplay: document.getElementById('trackNameDisplay'),
      trackQualityBadge: document.getElementById('trackQualityBadge'),
      stemCountBadge: document.getElementById('stemCountBadge'),
      downloadZipBtn: document.getElementById('downloadZipBtn'),
      newSplitBtn: document.getElementById('newSplitBtn'),

      // Transport controls
      playPauseBtn: document.getElementById('playPauseBtn'),
      returnZeroBtn: document.getElementById('returnZeroBtn'),
      loopToggleBtn: document.getElementById('loopToggleBtn'),
      timelineScrubber: document.getElementById('timelineScrubber'),
      timelineTrackFill: document.getElementById('timelineTrackFill'),
      timelinePlayheadHandle: document.getElementById('timelinePlayheadHandle'),
      timecodeCurrent: document.getElementById('timecodeCurrent'),
      timecodeTotal: document.getElementById('timecodeTotal'),
      masterVolSlider: document.getElementById('masterVolSlider'),
      masterVuL: document.getElementById('masterVuL'),
      masterVuR: document.getElementById('masterVuR'),

      // Global actions
      muteAllBtn: document.getElementById('muteAllBtn'),
      clearSolosBtn: document.getElementById('clearSolosBtn'),

      // Tracklist container
      channelStripList: document.getElementById('channelStripList'),
    };

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.renderRecentSplits();

    // Subscribe to store view state
    this.store.subscribe((state) => {
      this.handleViewState(state.view);
    });

    // Check URL for existing job
    const params = new URLSearchParams(window.location.search);
    const initialJobId = params.get('job');
    if (initialJobId) {
      this.loadExistingJob(initialJobId);
    }
  }

  bindEvents() {
    // Dropzone Drag & Drop
    const { dropzone, fileInput } = this.dom;
    dropzone.addEventListener('click', () => {
      fileInput.value = ''; // Clear value so re-uploading same file triggers change
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) {
        this.startUpload(e.target.files[0]);
      }
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length) {
        this.startUpload(e.dataTransfer.files[0]);
      }
    });

    // Quality Preset Cards
    const selectPreset = (card) => {
      this.dom.presetCards.forEach((c) => {
        c.classList.remove('selected');
        c.setAttribute('aria-checked', 'false');
      });
      card.classList.add('selected');
      card.setAttribute('aria-checked', 'true');
      const quality = card.dataset.quality;
      this.store.setState({ quality });
    };

    this.dom.presetCards.forEach((card) => {
      card.addEventListener('click', () => selectPreset(card));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectPreset(card);
        }
      });
    });

    // Cancel / Reset
    this.dom.cancelProcessingBtn.addEventListener('click', () => this.resetStudio());
    this.dom.errorRetryBtn.addEventListener('click', () => this.resetStudio());
    this.dom.newSplitBtn.addEventListener('click', () => this.resetStudio());

    // Transport Events
    this.dom.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    this.dom.returnZeroBtn.addEventListener('click', () => {
      this.engine.seek(0);
      this.updateTimelineUI(0);
      this.dom.timecodeCurrent.textContent = '00:00.00';
      this.redrawAllWaveforms(0);
    });

    this.dom.loopToggleBtn.addEventListener('click', () => {
      this.engine.loopEnabled = !this.engine.loopEnabled;
      this.dom.loopToggleBtn.classList.toggle('active', this.engine.loopEnabled);
    });

    // Timeline Scrubber Click & Drag (Smooth non-blocking scrub)
    let isScrubbing = false;
    let wasPlayingBeforeScrub = false;

    const handleScrub = (e) => {
      const rect = this.dom.timelineScrubber.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = progress * this.engine.duration;
      this.engine.playhead = targetTime;
      this.updateTimelineUI(progress);
      this.dom.timecodeCurrent.textContent = this.formatTimecode(targetTime);
      this.redrawAllWaveforms(progress);
    };

    this.dom.timelineScrubber.addEventListener('mousedown', (e) => {
      if (this.engine.duration === 0) return;
      isScrubbing = true;
      wasPlayingBeforeScrub = this.engine.isPlaying;
      if (wasPlayingBeforeScrub) {
        this.engine.pause();
      }
      handleScrub(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isScrubbing) handleScrub(e);
    });

    window.addEventListener('mouseup', () => {
      if (isScrubbing) {
        isScrubbing = false;
        this.engine.seek(this.engine.playhead);
        if (wasPlayingBeforeScrub) {
          this.engine.play();
        }
      }
    });

    // Master Volume
    this.dom.masterVolSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value) / 100;
      this.engine.setMasterVolume(vol);
    });

    // Global Mute All
    this.dom.muteAllBtn.addEventListener('click', () => {
      this.allMuted = !this.allMuted;
      this.dom.muteAllBtn.textContent = this.allMuted ? '🔊 Unmute All' : '🔇 Mute All';
      this.loadedStems.forEach((s) => {
        const track = this.engine.tracks.get(s.id);
        if (track) {
          track.muted = this.allMuted;
          const muteBtn = s.stripEl?.querySelector('.btn-mute') || document.querySelector(`.btn-mute[data-stem="${s.id}"]`);
          if (muteBtn) muteBtn.classList.toggle('active', this.allMuted);
          const strip = s.stripEl || document.querySelector(`.channel-strip[data-stem="${s.id}"]`);
          if (strip) strip.classList.toggle('is-muted', this.allMuted);
        }
      });
      this.engine.applyGains();
    });

    // Clear All Solos
    this.dom.clearSolosBtn.addEventListener('click', () => {
      this.engine.clearAllSolos();
      document.querySelectorAll('.btn-solo').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.channel-strip').forEach((s) => {
        s.classList.remove('is-soloed', 'is-solo-inactive');
      });
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (this.store.state.view !== 'studio') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.code === 'Home' || e.key === '0') {
        e.preventDefault();
        this.engine.seek(0);
        this.updateTimelineUI(0);
        this.dom.timecodeCurrent.textContent = '00:00.00';
        this.redrawAllWaveforms(0);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const target = Math.max(0, this.engine.getCurrentTime() - 5);
        this.engine.seek(target);
        const progress = this.engine.duration > 0 ? target / this.engine.duration : 0;
        this.updateTimelineUI(progress);
        this.dom.timecodeCurrent.textContent = this.formatTimecode(target);
        this.redrawAllWaveforms(progress);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const target = Math.min(this.engine.duration, this.engine.getCurrentTime() + 5);
        this.engine.seek(target);
        const progress = this.engine.duration > 0 ? target / this.engine.duration : 0;
        this.updateTimelineUI(progress);
        this.dom.timecodeCurrent.textContent = this.formatTimecode(target);
        this.redrawAllWaveforms(progress);
      } else if (e.code === 'KeyL') {
        e.preventDefault();
        this.engine.loopEnabled = !this.engine.loopEnabled;
        this.dom.loopToggleBtn.classList.toggle('active', this.engine.loopEnabled);
      }
    });

    // Window Resize -> redraw high-DPI waveforms
    window.addEventListener('resize', () => {
      if (this.store.state.view === 'studio') {
        const progress = this.engine.duration > 0 ? this.engine.getCurrentTime() / this.engine.duration : 0;
        this.redrawAllWaveforms(progress);
      }
    });
  }

  handleViewState(view) {
    const views = {
      upload: this.dom.uploadView,
      processing: this.dom.processingView,
      studio: this.dom.studioView,
      error: this.dom.errorView,
    };

    Object.entries(views).forEach(([key, el]) => {
      if (key === view) {
        el.classList.remove('hidden');
        el.classList.add('fade-in');
      } else {
        el.classList.add('hidden');
        el.classList.remove('fade-in');
      }
    });
  }

  async renderRecentSplits() {
    // 1. Fetch server completed jobs
    const serverJobs = await ApiClient.getRecentJobs();

    // 2. Merge with localStorage jobs
    const localJobs = this.store.state.recentJobs || [];
    const jobMap = new Map();

    for (const j of localJobs) {
      if (j && j.id) jobMap.set(j.id, j);
    }
    for (const sj of serverJobs) {
      if (sj && sj.id) {
        const existing = jobMap.get(sj.id);
        jobMap.set(sj.id, {
          id: sj.id,
          title: sj.name || existing?.title || sj.id,
          quality: sj.quality || existing?.quality || 'fast',
          stemCount: sj.stem_count || existing?.stemCount || 6,
          timestamp: sj.timestamp || existing?.timestamp || Date.now(),
        });
      }
    }

    const merged = Array.from(jobMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (!merged.length) {
      this.dom.recentSplitsWrapper.classList.add('hidden');
      return;
    }

    this.dom.recentSplitsWrapper.classList.remove('hidden');
    this.dom.recentSplitsList.innerHTML = merged
      .map(
        (job) => `
        <div class="panel-raised" style="padding: 0.75rem 1rem; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
          <div style="overflow: hidden;">
            <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px;">${this.escapeHtml(job.title)}</div>
            <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
              <span class="badge" style="background: rgba(99, 102, 241, 0.15); color: var(--brand-primary); text-transform: uppercase;">${this.escapeHtml(job.quality)}</span>
              <span>· ${job.stemCount} stems</span>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm open-job-btn" data-job="${encodeURIComponent(job.id)}">
            Open 🎚️
          </button>
        </div>`
      )
      .join('');

    this.dom.recentSplitsList.querySelectorAll('.open-job-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const jobId = decodeURIComponent(btn.dataset.job);
        this.store.syncUrl(jobId);
        this.loadExistingJob(jobId);
      });
    });
  }

  async startUpload(file) {
    // Guard size
    const MAX_MB = 300;
    if (file.size > MAX_MB * 1024 * 1024) {
      this.showError(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Limit is ${MAX_MB} MB.`);
      return;
    }

    this.store.setView('processing');
    this.dom.procName.textContent = file.name;
    this.dom.procStage.textContent = 'Uploading to server…';
    this.dom.procPercent.textContent = '0%';
    this.dom.procBarFill.style.width = '0%';
    this.updatePipelineSteps('upload');

    try {
      const res = await ApiClient.uploadAudio(file, this.store.state.quality, (p) => {
        const uploadPct = Math.round(p.percent * 0.35); // Upload is 0-35% of workflow
        this.dom.procBarFill.style.width = `${uploadPct}%`;
        this.dom.procPercent.textContent = `${uploadPct}%`;
        this.dom.procStage.textContent = `Uploading track (${p.percent}%) · ${p.speedMBs} MB/s`;
      });

      this.store.setState({ currentJobId: res.job_id });
      this.store.syncUrl(res.job_id);
      this.trackJobStatus(res.job_id);
    } catch (err) {
      this.showError(err.message);
    }
  }

  trackJobStatus(jobId) {
    let simulatedProgress = 35;

    this.stopPolling = ApiClient.pollJobStatus(
      jobId,
      (data) => {
        if (data.status === 'queued') {
          this.dom.procStage.textContent = 'In GPU Queue — waiting for worker thread…';
          this.dom.procPercent.textContent = '38%';
          this.dom.procBarFill.style.width = '38%';
          this.updatePipelineSteps('queued');
        } else if (data.status === 'processing') {
          if (simulatedProgress < 94) {
            simulatedProgress += Math.random() * 0.6 + 0.2;
          }
          const pct = Math.round(simulatedProgress);
          this.dom.procPercent.textContent = `${pct}%`;
          this.dom.procBarFill.style.width = `${pct}%`;
          this.dom.procStage.textContent = data.stage || 'Processing neural separation…';
          this.updatePipelineSteps(data.stage || 'processing');
        } else if (data.status === 'completed') {
          this.dom.procPercent.textContent = '100%';
          this.dom.procBarFill.style.width = '100%';
          this.dom.procStage.textContent = 'Separation complete! Initializing DAW console…';
          this.updatePipelineSteps('completed');

          setTimeout(() => {
            this.buildStudioPlayer(data, jobId);
          }, 400);
        }
      },
      (errorMsg) => {
        this.showError(errorMsg);
      }
    );
  }

  async loadExistingJob(jobId) {
    this.store.setView('processing');
    this.dom.procName.textContent = `Session: ${jobId}`;
    this.dom.procStage.textContent = 'Checking session status…';
    this.dom.procPercent.textContent = '50%';
    this.dom.procBarFill.style.width = '50%';

    this.trackJobStatus(jobId);
  }

  updatePipelineSteps(stage) {
    const text = (stage || '').toLowerCase();
    const { stepPass1, stepPass2, stepPass3 } = this.dom;

    [stepPass1, stepPass2, stepPass3].forEach((s) => s.classList.remove('active', 'completed'));

    if (text.includes('pass 1') || text.includes('vocal')) {
      stepPass1.classList.add('active');
    } else if (text.includes('pass 2') || text.includes('instrument') || text.includes('sw')) {
      stepPass1.classList.add('completed');
      stepPass2.classList.add('active');
    } else if (text.includes('pass 3') || text.includes('peeling') || text.includes('mega')) {
      stepPass1.classList.add('completed');
      stepPass2.classList.add('completed');
      stepPass3.classList.add('active');
    } else if (text === 'completed') {
      stepPass1.classList.add('completed');
      stepPass2.classList.add('completed');
      stepPass3.classList.add('completed');
    }
  }

  async buildStudioPlayer(data, jobId) {
    this.store.setView('studio');
    const resolvedJobId =
      jobId ||
      this.store.state.currentJobId ||
      (data.stems && data.stems[0] ? data.stems[0].split('/')[3] : '');

    this.dom.trackNameDisplay.textContent = data.name || 'Untitled Track';
    this.dom.trackQualityBadge.textContent = (data.quality || 'Fast').toUpperCase();
    this.dom.stemCountBadge.textContent = `${data.stems.length} STEMS`;
    this.dom.downloadZipBtn.href = ApiClient.getDownloadZipUrl(resolvedJobId);

    // Save to history
    this.store.recordJobHistory(
      resolvedJobId,
      data.name,
      data.quality || 'fast',
      data.stems.length
    );

    // CRITICAL BUG FIX: dispose old session BEFORE initializing fresh AudioContext
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.engine.dispose();
    this.engine.initContext();

    this.loadedStems = [];
    this.dom.channelStripList.innerHTML = '';
    this.allMuted = false;
    this.dom.muteAllBtn.textContent = '🔇 Mute All';
    this.dom.playPauseBtn.textContent = '▶';
    this.updateTimelineUI(0);
    this.dom.timecodeCurrent.textContent = '00:00.00';
    this.dom.timecodeTotal.textContent = '/ 00:00.00';

    // ResizeObserver ensures high-DPI waveforms re-render whenever layout or window size changes
    this.resizeObserver = new ResizeObserver(() => {
      const progress = this.engine.duration > 0 ? this.engine.getCurrentTime() / this.engine.duration : 0;
      this.redrawAllWaveforms(progress);
    });

    const stemDetails = data.stem_details || [];

    // Render skeleton strips and fetch audio in parallel
    for (let i = 0; i < data.stems.length; i++) {
      const url = data.stems[i];
      const filename = url.split('/').pop();
      const stemKey = filename.replace('.wav', '').toLowerCase();
      const meta = STEM_CONFIG[stemKey] || { label: stemDetails[i]?.name || stemKey, color: '#94a3b8', icon: '🎵' };

      const stripEl = this.createChannelStripElement(stemKey, meta, url, stemDetails[i]?.size);
      this.dom.channelStripList.appendChild(stripEl);

      const canvas = stripEl.querySelector('.strip-wave-canvas');
      const meterEl = stripEl.querySelector('.strip-meter-fill');
      const loadingEl = stripEl.querySelector('.strip-wave-loading');
      const waveContainer = stripEl.querySelector('.strip-wave-container');

      const stemObj = {
        id: stemKey,
        name: meta.label,
        url,
        color: meta.color,
        peaks: null,
        canvas,
        stripEl,
        meterEl,
        loadingEl,
        waveContainer,
      };
      this.loadedStems.push(stemObj);

      if (waveContainer) {
        this.resizeObserver.observe(waveContainer);
      }

      // Draw initial loading skeleton on canvas
      WaveformRenderer.drawLoadingSkeleton(canvas, meta.color);

      // Async fetch and decode
      this.loadStemAudio(stemObj);
    }

    // Start 60fps render loop for VU meters & playhead animation
    this.startRenderLoop();
  }

  createChannelStripElement(stemKey, meta, downloadUrl, sizeBytes) {
    const strip = document.createElement('div');
    strip.className = 'channel-strip';
    strip.dataset.stem = stemKey;

    const sizeFormatted = sizeBytes ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : 'WAV 44.1k';

    strip.innerHTML = `
      <!-- Info Left -->
      <div class="strip-info">
        <span class="stem-indicator-dot" style="background: ${meta.color}; color: ${meta.color}"></span>
        <div class="strip-text">
          <span class="strip-name" title="${this.escapeHtml(meta.label)}">${meta.icon} ${this.escapeHtml(meta.label)}</span>
          <span class="strip-meta mono">${sizeFormatted}</span>
        </div>
      </div>

      <!-- Mini VU Meter -->
      <div class="strip-meter">
        <div class="strip-meter-fill" data-meter="${stemKey}"></div>
      </div>

      <!-- Waveform Canvas -->
      <div class="strip-wave-container" data-wave="${stemKey}">
        <canvas class="strip-wave-canvas" data-canvas="${stemKey}"></canvas>
        <div class="strip-wave-loading">
          <div class="strip-loading-spinner"></div>
          <span class="mono">Loading stem...</span>
        </div>
        <div class="strip-wave-cursor" data-cursor="${stemKey}"></div>
        <div class="strip-wave-tooltip mono" data-tooltip="${stemKey}">0:00</div>
      </div>

      <!-- Channel Controls -->
      <div class="strip-controls">
        <!-- Pan -->
        <div class="pan-control">
          <input type="range" class="pan-slider" data-pan="${stemKey}" min="-100" max="100" value="0" title="Stereo Pan (Center)">
          <span class="pan-label mono" data-pan-label="${stemKey}">C</span>
        </div>

        <!-- Mute & Solo -->
        <button class="toggle-btn btn-mute" data-stem="${stemKey}" title="Mute Track">M</button>
        <button class="toggle-btn btn-solo" data-stem="${stemKey}" title="Solo Track">S</button>

        <!-- Volume Fader -->
        <div class="fader-control">
          <input type="range" class="fader-slider" data-vol="${stemKey}" min="0" max="150" value="100" title="Channel Volume">
          <span class="fader-readout mono" data-vol-label="${stemKey}">0.0 dB</span>
        </div>

        <!-- Single Stem WAV Download -->
        <a href="${downloadUrl}" download class="strip-download-btn" title="Download ${this.escapeHtml(meta.label)} WAV">
          ⬇
        </a>
      </div>
    `;

    // Bind channel events
    const muteBtn = strip.querySelector('.btn-mute');
    const soloBtn = strip.querySelector('.btn-solo');
    const volSlider = strip.querySelector('.fader-slider');
    const volLabel = strip.querySelector('.fader-readout');
    const panSlider = strip.querySelector('.pan-slider');
    const panLabel = strip.querySelector('.pan-label');
    const waveContainer = strip.querySelector('.strip-wave-container');
    const cursor = strip.querySelector('.strip-wave-cursor');
    const tooltip = strip.querySelector('.strip-wave-tooltip');

    muteBtn.addEventListener('click', () => {
      const isMuted = this.engine.toggleTrackMute(stemKey);
      muteBtn.classList.toggle('active', isMuted);
      strip.classList.toggle('is-muted', isMuted);
    });

    soloBtn.addEventListener('click', () => {
      const isSolo = this.engine.toggleTrackSolo(stemKey);
      soloBtn.classList.toggle('active', isSolo);
      strip.classList.toggle('is-soloed', isSolo);

      // Dim non-soloed tracks for standard DAW visual feedback
      const anySolo = Array.from(this.engine.tracks.values()).some((t) => t.solo);
      this.loadedStems.forEach((s) => {
        const tr = this.engine.tracks.get(s.id);
        if (s.stripEl) {
          if (anySolo) {
            s.stripEl.classList.toggle('is-solo-inactive', !tr?.solo);
          } else {
            s.stripEl.classList.remove('is-solo-inactive');
          }
        }
      });
    });

    volSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) / 100; // 0.0 to 1.5
      this.engine.setTrackVolume(stemKey, val);

      // Decibel conversion: 20 * log10(val)
      if (val === 0) {
        volLabel.textContent = '-inf dB';
      } else {
        const dB = (20 * Math.log10(val)).toFixed(1);
        volLabel.textContent = `${dB > 0 ? '+' : ''}${dB} dB`;
      }
    });

    panSlider.addEventListener('input', (e) => {
      const panVal = parseFloat(e.target.value) / 100; // -1 to +1
      this.engine.setTrackPan(stemKey, panVal);
      if (panVal === 0) {
        panLabel.textContent = 'C';
      } else if (panVal < 0) {
        panLabel.textContent = `L${Math.abs(Math.round(panVal * 100))}`;
      } else {
        panLabel.textContent = `R${Math.round(panVal * 100)}`;
      }
    });

    // Waveform Click to Seek
    waveContainer.addEventListener('click', (e) => {
      if (this.engine.duration === 0) return;
      const rect = waveContainer.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const seekTime = pct * this.engine.duration;
      this.engine.seek(seekTime);
      this.updateTimelineUI(pct);
      this.dom.timecodeCurrent.textContent = this.formatTimecode(seekTime);
      this.redrawAllWaveforms(pct);
    });

    // Waveform Hover Tooltip & Cursor
    waveContainer.addEventListener('mousemove', (e) => {
      const rect = waveContainer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));
      cursor.style.left = `${x}px`;
      tooltip.style.left = `${x}px`;
      tooltip.textContent = this.formatTimecode(pct * this.engine.duration);
    });

    return strip;
  }

  async loadStemAudio(stemObj) {
    try {
      this.engine.initContext();
      const res = await fetch(stemObj.url);
      if (!res.ok) throw new Error(`Failed to load ${stemObj.name} (HTTP ${res.status})`);
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await this.engine.ctx.decodeAudioData(arrayBuffer);

      // Compute peaks for retina rendering
      stemObj.peaks = WaveformRenderer.computePeaks(audioBuffer, 1600);

      // Register with audio engine
      const track = this.engine.addTrack(stemObj.id, audioBuffer, 1.0);

      // If audio engine is already playing, dynamically start source at current playhead
      if (this.engine.isPlaying) {
        const src = this.engine.ctx.createBufferSource();
        src.buffer = audioBuffer;
        if (track.pannerNode) {
          src.connect(track.pannerNode);
        } else {
          src.connect(track.gainNode);
        }
        const offset = Math.max(0, Math.min(this.engine.getCurrentTime(), audioBuffer.duration - 0.005));
        if (offset < audioBuffer.duration) {
          src.start(0, offset);
        }
        track.source = src;
      }

      // Hide loading indicator overlay
      if (stemObj.loadingEl) {
        stemObj.loadingEl.style.display = 'none';
      }

      // Draw initial waveform on next animation frame
      requestAnimationFrame(() => {
        const progress = this.engine.duration > 0 ? this.engine.getCurrentTime() / this.engine.duration : 0;
        WaveformRenderer.drawWaveform(stemObj.canvas, stemObj.peaks, stemObj.color, progress);
      });

      // Update total duration readout
      this.dom.timecodeTotal.textContent = `/ ${this.formatTimecode(this.engine.duration)}`;
    } catch (err) {
      console.error(`Error loading stem ${stemObj.name}:`, err);
      if (stemObj.loadingEl) {
        stemObj.loadingEl.innerHTML = `<span style="color: var(--status-danger);">⚠️ Failed to load</span>`;
      }
    }
  }

  async togglePlayPause() {
    if (this.engine.isPlaying) {
      this.engine.pause();
      this.dom.playPauseBtn.textContent = '▶';
    } else {
      const started = await this.engine.play();
      this.dom.playPauseBtn.textContent = started ? '⏸' : '▶';
    }
  }

  startRenderLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);

    const tick = () => {
      if (this.store.state.view === 'studio') {
        if (this.engine.isPlaying) {
          const currentTime = this.engine.getCurrentTime();
          const progress = this.engine.duration > 0 ? currentTime / this.engine.duration : 0;

          // Update transport timecode & timeline scrubber
          this.updateTimelineUI(progress);
          this.dom.timecodeCurrent.textContent = this.formatTimecode(currentTime);

          // Redraw waveforms playhead
          this.redrawAllWaveforms(progress);

          if (!this.engine.isPlaying) {
            this.dom.playPauseBtn.textContent = '▶';
          }
        }

        // Animate VU meters
        this.updateVuMeters();
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  updateTimelineUI(progress) {
    const pct = `${(progress * 100).toFixed(2)}%`;
    this.dom.timelineTrackFill.style.width = pct;
    this.dom.timelinePlayheadHandle.style.left = pct;
  }

  redrawAllWaveforms(progress) {
    for (const stem of this.loadedStems) {
      if (stem.peaks && stem.canvas) {
        WaveformRenderer.drawWaveform(stem.canvas, stem.peaks, stem.color, progress);
      }
    }
  }

  updateVuMeters() {
    // Master VU Meter
    const masterLevel = this.engine.getMasterLevel();
    const masterWidth = `${Math.min(100, Math.round(masterLevel * 100))}%`;
    this.dom.masterVuL.style.width = masterWidth;
    this.dom.masterVuR.style.width = masterWidth;

    // Stem VU Meters (Direct access via cached element, no querySelector in loop)
    for (const stem of this.loadedStems) {
      if (stem.meterEl) {
        const level = this.engine.getTrackLevel(stem.id);
        stem.meterEl.style.height = `${Math.min(100, Math.round(level * 100))}%`;
      }
    }
  }

  showError(msg) {
    if (this.stopPolling) {
      this.stopPolling();
      this.stopPolling = null;
    }
    this.store.setView('error');
    this.dom.errorText.textContent = msg || 'An unexpected error occurred.';
  }

  resetStudio() {
    if (this.stopPolling) {
      this.stopPolling();
      this.stopPolling = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.engine.dispose();
    this.loadedStems = [];
    this.dom.channelStripList.innerHTML = '';
    this.allMuted = false;
    this.dom.muteAllBtn.textContent = '🔇 Mute All';
    this.dom.playPauseBtn.textContent = '▶';
    this.updateTimelineUI(0);
    this.dom.timecodeCurrent.textContent = '00:00.00';
    this.dom.timecodeTotal.textContent = '/ 00:00.00';
    this.dom.masterVuL.style.width = '0%';
    this.dom.masterVuR.style.width = '0%';
    this.dom.fileInput.value = '';
    this.store.syncUrl(null);
    this.store.setView('upload');
    this.renderRecentSplits();
  }

  formatTimecode(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00.00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  new StemSplitterApp();
});
