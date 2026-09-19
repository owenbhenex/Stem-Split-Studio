# Stem Splitter Studio

AI stem separation web app — FastAPI + audio-separator, running locally on GPU.
Separates any track into up to 11 stems, with an in-browser mixer, server-side
mix export, **Dropbox OAuth cloud sync**, and **per-user authentication**.

## Quick start

```bash
cd C:\Codez\Stem_Split
.venv\Scripts\python -m uvicorn app:app --port 8000
# open http://127.0.0.1:8000
```

> Always use the venv python (`.venv\Scripts\python`), not the system python —
> all dependencies (torch, audio-separator, librosa) live in the venv.

## Authentication

Two modes, chosen automatically:

- **Local mode** (default, no setup): first visit creates a single-user local
  session automatically. Everything works offline.
- **Dropbox OAuth mode**: set `DROPBOX_CLIENT_ID` (env) and optionally put the
  app secret in `.auth/dropbox_secret.txt`. Users then sign in with Dropbox,
  and every completed job syncs to their Dropbox under
  `Apps/Stem Splitter Studio/<job_id>/`.

### Enabling Dropbox (one-time, 3 minutes)

1. Go to https://www.dropbox.com/developers/apps → **Create app**
2. Choose: **Scoped access** → **App folder** → name it (e.g. "Stem Splitter Studio")
3. In **Settings** tab, copy the **App key** → set env var:
   `set DROPBOX_CLIENT_ID=your_app_key`
4. In **Settings → OAuth 2 → Redirect URIs**, add: `http://127.0.0.1:8000/api/auth/callback`
   (for LAN/hosted use, add that origin too)
5. In **Permissions** tab, enable: `files.content.write`, `files.content.read`,
   `files.metadata.read`, `account_info.read` → Submit
6. Restart the server. The topbar now shows **Sign in with Dropbox**.

Security notes:
- OAuth uses PKCE + state; refresh tokens are AES-256-GCM encrypted at rest
  (`.auth/`), key derived from an auto-generated secret (or `STEM_AUTH_SECRET`).
- Sessions: HttpOnly + SameSite=Lax cookies, HMAC-signed, 24h sliding expiry.
- All `/api/*` endpoints require a session (except `/api/auth/*`, `/api/health`).
- CORS locked to same-origin by default (override with `STEM_CORS_ORIGINS`).
- Jobs are owner-scoped: users only see/download their own jobs.

## Quality modes

| Mode | Stems | Pipeline | Time (5-min song, RTX 3050) |
|---|---|---|---|
| Fast | 6 | ep_317 BS-RoFormer vocals → BS-Roformer-SW 6-stem | ~9 min |
| Precision | 6 | 2-model vocal ensemble (ep_317 + ep_3005, avg_fft), overlap 6/4, lossless gain | ~25 min |
| Extended | 11 | Precision + chained Mega-53 extractors on the "other" residual (synth, strings, brass, organ, keys) | ~30 min |

## Features

- Upload (drag & drop, 300 MB cap) with quality selection
- Live progress with per-pass stage chips (Upload → Vocals → Split → Extract)
- Library of past jobs — rename, delete (local + cloud), owner-scoped
- Player: per-stem colored waveforms, synchronized Web Audio playback,
  per-stem volume / Mute / Solo, master volume, click-to-seek, spacebar play
- Mix presets — save/load per-track volume setups (localStorage)
- **Mix export** — server renders your custom mix with ffmpeg → WAV download
- Track analysis — duration, BPM estimate, sample rate
- Command palette (⌘K / Ctrl+K): navigate, play, export, open any track
- **Cloud**: auto-sync completed jobs to Dropbox, pull-from-cloud, space usage
- Health endpoint `/api/health` (GPU, queue, version)

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/status` | public | Session + Dropbox link state |
| GET | `/api/auth/login` | public | Start OAuth (or local auto-session) |
| GET | `/api/auth/callback` | public | OAuth redirect target |
| POST | `/api/auth/logout` | session | End session |
| POST | `/api/upload` | session | Multipart `file` + `quality` → `{job_id}` |
| GET | `/api/jobs` | session | Owner's library |
| GET | `/api/status/{id}` | session | Job state/stage; completed → stem URLs |
| DELETE | `/api/jobs/{id}` | session | Delete job (local + cloud) |
| POST | `/api/jobs/{id}/rename` | session | Rename |
| POST | `/api/jobs/{id}/pull` | session | Pull job from Dropbox to local |
| GET | `/api/cloud/jobs` | session | Jobs present in Dropbox |
| GET | `/api/cloud/space` | session | Dropbox quota usage |
| GET | `/api/download/{id}/{stem}` | session | Single stem WAV (range requests) |
| GET | `/api/download/{id}` | session | All stems ZIP |
| POST | `/api/mix/{id}` | session | JSON `{stems, format, master}` → rendered mix |
| GET | `/api/analysis/{id}` | session | Duration/BPM/sample rate (cached) |
| GET | `/api/health` | public | System status |

## Architecture

- `app.py` — FastAPI backend: auth guard middleware, single GPU worker thread
  (serialized jobs), per-user job ownership, cloud sync hooks
- `auth.py` — Dropbox OAuth (PKCE), AES-GCM token store, signed session cookies
- `cloud.py` — Dropbox content API (chunked upload/download), SyncManager
- `static/index.html` — single-file SPA (warm-light design system, docs/DESIGN.md)
- `docs/DESIGN.md`, `docs/ARCHITECTURE.md` — design tokens, frontend architecture
- Models cached in `C:/tmp/audio-separator-models` (~3.5 GB total)
- `.auth/` — auth secret + encrypted Dropbox tokens (never commit this)

## Job lifecycle

```
upload → queued → processing (Pass 1: vocals [ensemble] → Pass 2: 6-stem
→ [extended] Pass 3: chained extraction) → completed (→ Dropbox sync) | error
```

Jobs persist 24 h locally, then pruned on next startup (cloud copies remain).

## Known limits

- 4 GB VRAM: models run serialized; one job at a time (queue orders the rest)
- OAuth state + sessions are in-memory — server restart logs everyone out
  (Dropbox refresh tokens persist, so re-login is one click)
- Cloud sync is push-on-complete + manual pull; no background reconciliation

