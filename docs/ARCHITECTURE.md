# Stem Splitter Studio — Frontend Architecture v1.0

> Full-fledged SPA in a single static file (no build step), served by FastAPI.
> Vanilla ES2022 modules pattern: one global `App` state object, per-view render
> functions, an event-delegation layer, and a Web Audio engine class. No framework
> — the app is small enough that framework overhead buys nothing, and Owen ships
> it by copying files.

## 1. System Context

```
┌───────────────────────────── Browser ─────────────────────────────┐
│  index.html (shell)                                               │
│  ├── App state + router (hash-based: #/upload #/library #/job/:id)│
│  ├── Views: UploadView · LibraryView · ProcessingView · PlayerView│
│  ├── AudioEngine (Web Audio API)                                  │
│  └── WaveformRenderer (Canvas 2D, devicePixelRatio-aware)         │
└───────────────┬───────────────────────────────────────────────────┘
                │ REST/JSON + audio file GETs
┌───────────────▼───────────────────────────────────────────────────┐
│ FastAPI (app.py)                                                  │
│  POST /api/upload        → {job_id}     (multipart: file, quality)│
│  GET  /api/jobs          → {jobs[]}     (library listing)         │
│  GET  /api/status/:id    → job state    (poll while processing)   │
│  GET  /api/download/:id/:stem  → audio/wav (206 range support)    │
│  GET  /api/download/:id  → stems.zip                              │
│  GET  /                  → this SPA                               │
└───────────────┬───────────────────────────────────────────────────┘
                │ single GPU worker thread (serialized queue)
        audio-separator 0.47 (torch/CUDA)
```

## 2. Module Layout (single-file, logically separated)

```
static/
├── index.html      — shell, all views as <template>-like hidden sections
└── (inline <script>) — the whole app; sections marked by banner comments:
     ├── §1 State        — App object, constants, STEM_COLORS
     ├── §2 Router       — hash routing + view lifecycle
     ├── §3 API          — fetch wrappers (upload with XHR progress, poll)
     ├── §4 AudioEngine  — Web Audio: master gain, per-stem gain nodes,
     │                     synchronized start/stop, seek, rAF tick loop
     ├── §5 Waveform     — peak extraction (1500 buckets), canvas draw
     ├── §6 Views        — renderUpload/renderLibrary/renderProcessing/
     │                     renderPlayer + DOM event bindings
     └── §7 Boot        — ?job= & hash resolution, init
```

## 3. State Model

```js
App = {
  view: 'upload' | 'library' | 'processing' | 'player',
  jobId: string | null,
  job: { id, display, quality, state, stage, stems[], error },
  stems: [ { key, name, url, color, buffer, peaks, gain, vol, muted, solo, source } ],
  audio: { ctx, master, playing, playhead, startedAt, duration },
  pollTimer, crawl,
}
```

**Rules**
- State mutations happen ONLY through named functions (`setState`, `updateStem`),
  which then trigger targeted re-renders — no full-page redraws except view swaps.
- `state.json` on the server is the source of truth across reloads; the client
  re-fetches on boot if `?job=` or `#/job/:id` present.

## 4. Routing

Hash-based (works from `file://` too, and survives static hosting):

| Hash | View | Source of data |
|---|---|---|
| `#/upload` (default) | Upload + quality cards | — |
| `#/library` | Job list | `GET /api/jobs` |
| `#/job/:id` | Processing or Player (depends on state) | `GET /api/status/:id` |

Legacy `?job=<id>` still works: boot redirects to `#/job/:id`.

View lifecycle: `enter(view)` hides others, calls the view's `render()`, binds
events; `leave()` unbinds rAF loops and stops audio.

## 5. AudioEngine

- One `AudioContext`, one `masterGain` → destination.
- Per stem: `AudioBufferSourceNode` → per-stem `GainNode` → master.
- All sources started in the same tick → sample-accurate sync.
- `seekTo(t)`: stop all, recreate sources with `start(0, t)`, reset `startedAt`.
- Mute/Solo resolve into per-stem gain targets (`setTargetAtTime`, 10ms smoothing):
  `audible = anySolo ? stem.solo : !stem.muted`.
- Master volume: single gain, 10ms smoothing.
- Playhead: `ctx.currentTime - startedAt`, rAF loop redraws waveforms + transport.

**Decode strategy**: stems decode in parallel after job completion; each waveform
paints as its buffer arrives (per-stem `drawWaveform`), no global barrier.

## 6. Waveform Renderer

- Peak extraction: mono-mix L/R, 1500 buckets, per-bucket min/max of `|sample|`.
- Draw: 1 CSS px per column; played region in stem color, unplayed at 20% alpha.
- Canvas sized ×devicePixelRatio; re-render on resize (debounced).
- Click on any waveform = global seek (position × duration).

## 7. Processing View & Polling

- Upload via XHR for progress events (fetch has no upload progress).
- Poll `/api/status/:id` every 2.5s (4s on network error, capped retries).
- Progress bar: 0–40% upload (real), 40–93% GPU crawl (honest indeterminate),
  100% on completion. Stage label from server (`stage` field).

## 8. Library View

- `GET /api/jobs` → list rows: name, quality pill, stem count, time-ago.
- Row click → `#/job/:id` (re-opens player, re-decodes stems).
- Empty state with upload CTA.

## 9. Error Handling

- Upload rejects (ext/size/quality) surface inline in Processing view.
- Job errors (server `state: "error"`) replace the view with the message + retry.
- Player audio decode failures mark the track row as unavailable (row dims,
  download still works) instead of killing the player.

## 10. Performance Budgets

- Waveform decode+draw: < 3s for 11 stems × 5-min song (parallel fetch).
- Peak memory: 11 stems × 51MB PCM ≈ 560MB — acceptable on desktop; mobile
  falls back to single-stem playback (audio element) if `AudioContext` decode
  exceeds ~700MB (not implemented in v1 — documented limit).
- rAF loop does canvas redraw of visible rows only.

## 11. Future Extension Points

- `#/mixer` — save/load per-stem volume presets (localStorage).
- Cloud sync: `App.job` serializes to a manifest; a `SyncManager` would diff
  local `web_stems/` against remote (rclone/R2) and stream from remote URLs.
- Keyboard shortcuts palette (Linear-style Cmd+K) — registry in §6.
- WebSocket push for stage changes (replaces polling) when server grows one.
