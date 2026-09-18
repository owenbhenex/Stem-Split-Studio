# 📋 Product Requirements Document (PRD) — Stem Splitter Studio Frontend

**Product Name**: Stem Splitter Studio Frontend (v2.0)  
**Target Audience**: Music Producers, Audio Engineers, DJs/Remixers, Vocalists, Sample Curators  
**Platform**: Web (Modern Desktop & Tablet Browsers — Chrome, Edge, Firefox, Safari)  
**Backend Coupling**: FastAPI Audio Separator Backend (`/api/upload`, `/api/status/{id}`, `/api/download/{id}`)

---

## 1. Executive Summary & Vision

Stem Splitter Studio provides DAW-grade, AI-driven audio separation directly in the browser. While the backend employs state-of-the-art cascading RoFormer neural networks (2-stem vocal isolation, 6-stem instrumental decomposition, and 11-stem chained instrument peeling), the frontend must provide a matching **DAW-grade studio multitrack mixing environment**.

The goal of the v2.0 frontend is to transform the existing rudimentary single-file interface into a high-performance, visually stunning **Web Multitrack DAW & Stem Separation Console** built on Vanilla Web Technologies (HTML5, Vanilla CSS3, Modern Modular ES6+ JavaScript, Web Audio API, and HTML5 Canvas).

---

## 2. User Personas & Core Use Cases

| Persona | Primary Goal | Key Frontend Needs |
| :--- | :--- | :--- |
| **Electronic Music Producer / DJ** | Extract clean vocal acapellas and synth leads for bootlegs and remixes. | Fast drag-and-drop, solo/mute auditioning, quick A/B comparisons, 11-stem separation option, single-click individual and bulk ZIP export. |
| **Mixing / Mastering Engineer** | De-bleed instrumental tracks or isolate rhythm sections (drums & bass) for re-balancing. | Precision lossless audio quality, stereo panning, per-stem gain faders with dB readouts, real-time VU peak meters, A-B loop scrubbing. |
| **Vocalist / Karaoke Creator** | Remove lead vocals to create high-fidelity backing tracks. | Simple preset picker (Fast vs Precision vs Extended), clear progress tracker with visual stage feedback, instant playback once ready. |
| **Sample Hunter / Beatmaker** | Isolate isolated guitars, keys, or brass stabs from vintage recordings. | Visual waveform navigation, precision playhead scrubbing, instant stem download without waiting for full ZIP extraction. |

---

## 3. Core Functional Requirements

### 3.1 Audio Ingestion & Preset Configuration
- **Drag-and-Drop Zone**:
  - Full-surface reactive drop target with hover animations and file type acceptance (`.wav`, `.mp3`, `.flac`, `.m4a`, `.ogg`, `.aac`, `.opus`, `.aiff`, `.wma`).
  - File validation before upload: file format verification, 300 MB size limit guard, audio duration & format preview.
- **Separation Quality Mode Selector**:
  - **⚡ Fast (6 Stems)**: Quick turnaround (~9 min on GPU), default overlap, 16-bit normalized output.
  - **🎯 Precision (6 Stems)**: Vocal ensemble (`ep_317` + `ep_3005`), high overlap (6/4), lossless 24/32-bit float preservation.
  - **🪄 Extended (11 Stems)**: Chained MVSep Mega-53 isolation (+ Synth, Strings, Brass, Organ, Keys) from residual other stem.
  - Informative badge / card UI explaining model breakdown and estimated processing load.
- **Upload Progress**:
  - True upload telemetry via `XMLHttpRequest.upload.onprogress`.
  - Display percentage, bytes uploaded, and upload speed transfer rate.

### 3.2 Job Lifecycle & Real-Time Pipeline Tracker
- **Stage-by-Stage Animated Visualizer**:
  - `Queued`: Position in GPU worker queue.
  - `Pass 1`: Isolating Vocals & Instrumental Bed (`BS-RoFormer ep_317` / Ensemble).
  - `Pass 2`: Decomposing Instruments into Bass, Drums, Guitar, Piano, Other (`BS-RoFormer-SW`).
  - `Pass 3`: Chained Instrument Peeling for Extended Stems (`MVSep Mega-53` Synth, Strings, Brass, Organ, Keys).
  - `Finalizing`: Packing stems and finalizing metadata.
- **Resilient Polling & State Recovery**:
  - Exponential backoff with retry logic on temporary network interruption.
  - Auto-resume via URL parameter `?job=<id>`.
  - LocalStorage history: List of recent separation sessions with instant reload.

### 3.3 Multitrack Studio DAW Player & Mixer
- **Synchronized Multi-Stem Audio Engine**:
  - Driven by `Web Audio API` (`AudioContext`, `AudioBufferSourceNode`, `GainNode`, `StereoPannerNode`, `AnalyserNode`).
  - Zero-drift sample-accurate multitrack playback.
- **Master Bus Control Strip**:
  - Master Play / Pause / Return-to-Zero controls.
  - Master Volume fader (0% to 125% with soft-clipping safety limiter).
  - Master Stereo VU Meter with peak hold indicator.
  - Global Actions: "Mute All", "Unmute All", "Clear All Solos".
  - One-click "Download All Stems (ZIP)" button with download size badge.
- **Per-Stem Channel Strips**:
  - Dynamic stem color-coded accent tag and icon (Vocals, Bass, Drums, Guitar, Piano, Synth, Strings, Brass, Organ, Keys, Other).
  - Interactive Hi-DPI Waveform Canvas:
    * Pre-rendered peak amplitude envelope.
    * Real-time scrubbable playhead cursor.
    * Click-to-seek and drag-to-scrub.
    * Hover timecode tooltip.
  - Solo (S) and Mute (M) matrix:
    * Exclusive or multi-solo support with priority routing.
    * Immediate gain target ramp (`setTargetAtTime`) to eliminate audio clicks/pops.
  - Stereo Pan Slider (-100% Left to +100% Right with center detent).
  - Volume Fader with decibel display (`-inf dB` to `+6 dB`).
  - Real-Time Stem VU Meter (RMS + Peak).
  - Direct individual stem WAV download button.
- **Timeline & Transport Navigation**:
  - Transport Timecode Display: Current time (`MM:SS.mmm`) / Total duration (`MM:SS`).
  - Interactive Timeline Ruler with bar/time markers.
  - A-B Loop Region: Ability to set Loop Start [ and Loop End ] to loop difficult sections continuously.
  - Keyboard Shortcuts:
    * `Space`: Play / Pause toggle.
    * `Home` or `0`: Return to start (0:00).
    * `Left / Right Arrow`: Seek +/- 5 seconds.
    * `M`: Mute selected track.
    * `S`: Solo selected track.
    * `L`: Toggle A-B Loop.

---

## 4. Non-Functional & Performance Requirements

1. **Pure Vanilla Architecture**: Zero framework bloat (no React/Vue runtime overhead). Vanilla CSS3 and modular vanilla ES6+ JS guarantee instant load times (<100ms first contentful paint) and maximum responsiveness.
2. **Audio Performance**: Audio operations run on dedicated Web Audio threads; UI rendering runs strictly via `requestAnimationFrame` with zero audio glitching or buffer underruns.
3. **Hi-DPI Canvas Rendering**: Waveforms scale cleanly on Retina / 4K displays with `window.devicePixelRatio` scaling.
4. **Resilience & Fault Tolerance**: Robust handling of dropped connections, corrupted audio decodes, browser backgrounding/tab suspension, and server errors.
5. **Memory Management**: Dispose `AudioBuffer` and clean up `AudioContext` nodes upon job reset to prevent memory leaks during extended mixing sessions.
