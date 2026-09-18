# Stem Splitter Studio

AI stem separation web app — FastAPI + audio-separator, running locally on GPU.
Separates any track into up to 11 stems, with an in-browser mixer and server-side
mix export.

## Quick start

```bash
cd C:\Codez\Stem_Split
.venv\Scripts\python -m uvicorn app:app --port 8000
# open http://127.0.0.1:8000
```

> Always use the venv python (`.venv\Scripts\python`), not the system python —
> all dependencies (torch, audio-separator, librosa) live in the venv.

## Quality modes

| Mode | Stems | Pipeline | Time (5-min song, RTX 3050) |
|---|---|---|---|
| Fast | 6 | ep_317 BS-RoFormer vocals → BS-Roformer-SW 6-stem | ~9 min |
| Precision | 6 | 2-model vocal ensemble (ep_317 + ep_3005, avg_fft), overlap 6/4, lossless gain | ~25 min |
| Extended | 11 | Precision + chained Mega-53 extractors on the "other" residual (synth, strings, brass, organ, keys) | ~30 min |

## Features

- Upload (drag & drop, 300 MB cap) with quality selection
- Live progress with per-pass stage chips (Upload → Vocals → Split → Extract)
- Library of past jobs — survives server restarts (state persisted per job)
- Player: per-stem colored waveforms, synchronized Web Audio playback,
  per-stem volume / Mute / Solo, master volume, click-to-seek, spacebar play
- Mix presets — save/load per-track volume setups (localStorage)
- **Mix export** — server renders your custom mix with ffmpeg → WAV download
- Track analysis — duration, BPM estimate, sample rate
- Command palette (⌘K / Ctrl+K): navigate, play, export, open any track
- Health endpoint `/api/health` (GPU, queue, version)

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/upload` | Multipart `file` + `quality` (fast/precision/extended) → `{job_id}` |
| GET | `/api/status/{id}` | Job state/stage; completed → stem URLs |
| GET | `/api/jobs` | Library listing |
| GET | `/api/download/{id}/{stem}` | Single stem WAV (range requests supported) |
| GET | `/api/download/{id}` | All stems as ZIP |
| POST | `/api/mix/{id}` | JSON `{stems: {key: gain}, format, master}` → rendered mix file |
| GET | `/api/analysis/{id}` | Duration/BPM/sample rate (cached per job) |
| GET | `/api/health` | System status |

## Architecture

- `app.py` — FastAPI backend, single GPU worker thread (serialized jobs),
  state persisted to `web_stems/<job>/state.json`
- `static/index.html` — single-file SPA (warm-light design system, docs/DESIGN.md)
- `docs/DESIGN.md` — design tokens & component spec
- `docs/ARCHITECTURE.md` — frontend architecture
- Models cached in `C:/tmp/audio-separator-models` (~3.5 GB total)

## Job lifecycle

```
upload → queued → processing (Pass 1: vocals [ensemble] → Pass 2: 6-stem
→ [extended only] Pass 3: chained extraction) → completed | error
```

Jobs persist 24 h, then pruned on next startup. Uploads deleted after success.

## Known limits

- 4 GB VRAM: models run serialized; one job at a time (queue orders the rest)
- Extended-mode stems are gain-preserving but not perfectly sum-reconstructive
  on loud masters (clip-guard) — see DESIGN/ARCHITECTURE docs
- Cloud storage not wired yet (rclone/R2 path documented in ARCHITECTURE.md §11)
