"""
Stem Splitter Studio — FastAPI backend.

Pipeline (matches Logic Pro's Stem Splitter output set: vocals, drums, bass,
piano, guitar, other):

  Pass 1  model_bs_roformer_ep_317 (flagship 2-stem)  -> pristine Vocals + Instrumental
  Pass 2  BS-Roformer-SW (6-stem) on the Instrumental -> bass / drums / guitar / piano / other
          (cascading keeps vocal bleed OUT of the instrument stems; the SW model's
           own "vocals" output on an instrumental is just residual -> discarded)

Jobs run on ONE background GPU worker thread (serialized) so concurrent uploads
can't OOM the 4GB card. Job state is tracked in memory AND written to disk so a
server restart doesn't leave the UI polling forever.
"""

import os
import re
import json
import time
import uuid
import queue
import shutil
import logging
import threading
import zipfile
import traceback
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import librosa
import soundfile as sf
import numpy as np

import torch
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from audio_separator.separator import Separator
from audio_separator.separator.ensembler import Ensembler

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = APP_DIR / "web_uploads"
OUTPUT_DIR = APP_DIR / "web_stems"
MODEL_DIR = os.environ.get("AUDIO_SEPARATOR_MODEL_DIR", "C:/tmp/audio-separator-models")

VOCALS_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"  # best-in-class vocal isolation (SDR 12.98)
VOCALS_MODEL_2 = "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt"  # 2nd opinion for precision ensemble (SDR 11.44)
SIX_STEM_MODEL = "BS-Roformer-SW.ckpt"  # 6-stem BS-Roformer: bass/drums/guitar/piano/vocals/other

# Pass-3 extractors: MVSep Mega-53 family, one 2-stem model per extra instrument.
# Each extracts its instrument from the residual "other" stem; we chain them
# sequentially (pro "chained separation" workflow) so every extracted stem is
# subtracted from the residual before the next extraction.
EXTRA_STEM_MODELS = {
    "synth": "bs_mega_53stem_synth_mvsep.ckpt",
    "strings": "bs_mega_53stem_strings_mvsep.ckpt",
    "brass": "bs_mega_53stem_brass_mvsep.ckpt",
    "organ": "bs_mega_53stem_organ_mvsep.ckpt",
    "keys": "bs_mega_53stem_keys_mvsep.ckpt",
}

# Quality presets ---------------------------------------------------------------
# fast:    model defaults — overlap 4/2, pydub 16-bit, per-stem peak normalize 0.9
# precision: vocal ensemble (ep_317 + ep_3005, avg_fft — the algorithm audio-separator's
#            own "vocal balanced" preset uses), overlap 6/4 for smoother masks,
#            soundfile writer preserving input bit depth, normalize 1.0 (clip-guard only)
QUALITY_PRESETS = {
    "fast": {
        "pass1_models": [VOCALS_MODEL],
        "pass1_overlap": None,   # model default (4)
        "pass2_overlap": None,   # model default (2)
        "pass3_overlap": None,   # model default (2)
        "norm_threshold": 0.9,
        "use_soundfile": False,
        "extra_stems": False,
    },
    "precision": {
        "pass1_models": [VOCALS_MODEL, VOCALS_MODEL_2],
        "pass1_overlap": 6,
        "pass2_overlap": 4,
        "pass3_overlap": 3,
        "norm_threshold": 1.0,
        "use_soundfile": True,
        "extra_stems": False,
    },
    "extended": {
        # 11 stems: everything in precision + synth/strings/brass/organ/keys
        # extracted from the "other" residual via chained 2-stem models.
        "pass1_models": [VOCALS_MODEL, VOCALS_MODEL_2],
        "pass1_overlap": 6,
        "pass2_overlap": 4,
        "pass3_overlap": 3,
        "norm_threshold": 1.0,
        "use_soundfile": True,
        "extra_stems": True,
    },
}

BASE_STEMS = ["vocals", "bass", "drums", "guitar", "piano", "other"]
EXPECTED_STEMS = BASE_STEMS + list(EXTRA_STEM_MODELS.keys())
STEM_LABELS = {
    "vocals": "Vocals", "bass": "Bass", "drums": "Drums",
    "guitar": "Guitar", "piano": "Piano", "other": "Other",
    "synth": "Synth", "strings": "Strings", "brass": "Brass",
    "organ": "Organ", "keys": "Keys",
}

ALLOWED_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".wma", ".aiff", ".opus"}
MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # 300 MB
JOB_RETENTION_SECONDS = 24 * 3600

for d in (UPLOAD_DIR, OUTPUT_DIR):
    d.mkdir(exist_ok=True)

def _ensure_model_registry():
    """
    Register the locally-downloaded Mega-53 extractor models in audio-separator's
    model list (download_checks.json — the same registry UVR uses). Entries are
    ckpt -> yaml pairs; download_file_if_not_exists skips files already on disk,
    so no network is needed. Re-applied at every startup in case UVR refreshes
    the file.
    """
    path = Path(MODEL_DIR) / "download_checks.json"
    if not path.exists():
        return  # first Separator() instantiation will fetch it; registry re-applied next boot
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    roformer_list = data.get("roformer_download_list", {})
    changed = False
    for stem, ckpt in EXTRA_STEM_MODELS.items():
        yaml_name = f"{ckpt[:-5]}_config.yaml"
        entry_name = f"Roformer Model: Mega-53 {STEM_LABELS[stem]} | (by MVSep/ZFTurbo)"
        if entry_name not in roformer_list:
            roformer_list[entry_name] = {ckpt: yaml_name}
            changed = True
    if changed:
        data["roformer_download_list"] = roformer_list
        path.write_text(json.dumps(data, indent=4), encoding="utf-8")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ensure_model_registry()
    _prune_old_jobs()
    threading.Thread(target=gpu_worker, daemon=True, name="gpu-worker").start()
    yield


app = FastAPI(title="Stem Splitter Studio", lifespan=lifespan)

# Security: auth guard + tightened CORS --------------------------------------------
from auth import (
    SESSION_COOKIE, TOKENS, dropbox_configured, get_valid_access_token,
    create_session, resolve_session, drop_session, session_middleware_dispatch,
    make_pkce, build_authorize_url, exchange_code, get_dropbox_account,
)
import cloud
from cloud import SYNC, remote_job_path
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware


class AuthGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if (path.startswith("/api/") and not path.startswith("/api/auth/")
                and path != "/api/health"):
            sess = resolve_session(request.cookies.get(SESSION_COOKIE))
            if not sess:
                return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        return await call_next(request)


app.add_middleware(AuthGuardMiddleware)

CORS_ORIGINS = os.environ.get("STEM_CORS_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# Per-user job ownership: JOBS entries gain "owner" = subject id.
# Session header injected via dependency.
from fastapi import Depends

# --------------------------------------------------------------------------------------
# Job state
# --------------------------------------------------------------------------------------
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_QUEUE: "queue.Queue[str]" = queue.Queue()


def _persist(job: dict):
    """Write the job state next to its stems so status survives a restart."""
    try:
        (OUTPUT_DIR / job["id"]).mkdir(parents=True, exist_ok=True)
        (OUTPUT_DIR / job["id"] / "state.json").write_text(
            json.dumps({k: job.get(k) for k in ("id", "owner", "display", "quality", "state", "stage", "error", "stems")}),
            encoding="utf-8",
        )
    except Exception:
        pass


def _update(job: dict, **fields):
    job.update(fields)
    _persist(job)


def _free_vram():
    gc = __import__("gc")
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


# --------------------------------------------------------------------------------------
# GPU pipeline
# --------------------------------------------------------------------------------------
MODEL_SHORT = {
    VOCALS_MODEL: "BS-RoFormer",
    VOCALS_MODEL_2: "Mel-RoFormer",
    SIX_STEM_MODEL: "6-stem BS-RoFormer",
}


def _make_separator(job_dir: Path, preset: dict, overlap: int | None) -> Separator:
    return Separator(
        output_dir=str(job_dir),
        output_format="WAV",
        model_file_dir=MODEL_DIR,
        normalization_threshold=preset["norm_threshold"],
        use_soundfile=preset["use_soundfile"],
        mdxc_params={"segment_size": 256, "overlap": overlap},
        use_native_fp16=torch.cuda.is_available(),  # halves VRAM, ~2x speed on CUDA (verified path for bs_roformer)
    )


def _load_pair(job_dir: Path, wav_name: str) -> np.ndarray | None:
    """Load a stem pair (channels, samples); returns None if file missing."""
    p = job_dir / wav_name
    if not p.exists():
        return None
    wav, sr = librosa.load(str(p), mono=False, sr=44100)
    if wav.ndim == 1:
        wav = np.asfortranarray([wav, wav])
    return wav


def _write_stem(job_dir: Path, name: str, wave: np.ndarray, preset: dict, reference: Path):
    """Write an ensembled (channels, samples) waveform, matching the reference file's bit depth."""
    subtype = "PCM_24"
    try:
        ref_subtype = sf.info(str(reference)).subtype
        if ref_subtype in ("PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"):
            subtype = ref_subtype
    except Exception:
        pass
    data = wave.T  # soundfile wants (samples, channels)
    peak = float(np.abs(data).max()) if data.size else 0.0
    if peak > preset["norm_threshold"]:
        data = data * (preset["norm_threshold"] / peak)
    sf.write(str(job_dir / name), data, 44100, subtype=subtype)


def run_pipeline(job: dict):
    job_dir = OUTPUT_DIR / job["id"]
    # Fresh directory every run — no stale stems from previous attempts can leak in
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True)
    src = UPLOAD_DIR / job["file"]
    preset = QUALITY_PRESETS[job.get("quality", "fast")]

    # ---- Pass 1: pristine vocals -----------------------------------------------------
    _update(job, state="processing", stage="Pass 1/2 — Isolating vocals (BS-RoFormer)")

    for i, model in enumerate(preset["pass1_models"]):
        if len(preset["pass1_models"]) > 1:
            _update(job, stage=f"Pass 1/2 — Vocals model {i+1}/{len(preset['pass1_models'])} ({MODEL_SHORT.get(model, model[:18])})")
        sep = _make_separator(job_dir, preset, preset["pass1_overlap"])
        sep.load_model(model_filename=model)
        sep.separate(
            str(src),
            custom_output_names={"Vocals": "p1_vocals_a" if i == 0 else "p1_vocals_b", "Instrumental": "p1_inst_a" if i == 0 else "p1_inst_b"},
        )
        del sep
        _free_vram()

    # Ensemble the two opinions (avg_fft — same algorithm as audio-separator's
    # "vocal balanced" preset) when precision mode is on.
    if len(preset["pass1_models"]) > 1:
        _update(job, stage="Pass 1/2 — Ensembling vocal models (avg_fft)")
        a = _load_pair(job_dir, "p1_vocals_a.wav")
        b = _load_pair(job_dir, "p1_vocals_b.wav")
        ia = _load_pair(job_dir, "p1_inst_a.wav")
        ib = _load_pair(job_dir, "p1_inst_b.wav")
        if a is None or b is None or ia is None or ib is None:
            raise RuntimeError("Pass 1 ensemble incomplete — one model produced no output.")
        logger = logging.getLogger("stem_splitter.ensemble")
        ens_vocals = Ensembler(logger, "avg_fft").ensemble([a, b])
        ens_inst = Ensembler(logger, "avg_fft").ensemble([ia, ib])
        # Clip-guard only: write with soundfile at the input's bit depth
        _write_stem(job_dir, "vocals.wav", ens_vocals, preset, reference=src)
        _write_stem(job_dir, "instrumental.wav", ens_inst, preset, reference=src)
        for tmp in ("p1_vocals_a.wav", "p1_vocals_b.wav", "p1_inst_a.wav", "p1_inst_b.wav"):
            (job_dir / tmp).unlink(missing_ok=True)
    else:
        # Fast path: rename single-model outputs to canonical names
        (job_dir / "p1_vocals_a.wav").rename(job_dir / "vocals.wav")
        (job_dir / "p1_inst_a.wav").rename(job_dir / "instrumental.wav")

    instrumental = job_dir / "instrumental.wav"
    if not instrumental.exists():
        raise RuntimeError("Pass 1 finished but produced no instrumental track.")

    # ---- Pass 2: split the instrumental into instrument stems ------------------------
    _update(job, stage="Pass 2/3 — Splitting instruments (6-stem BS-Roformer)")
    sep = _make_separator(job_dir, preset, preset["pass2_overlap"])
    sep.load_model(model_filename=SIX_STEM_MODEL)
    sep.separate(
        str(instrumental),
        custom_output_names={
            "bass": "bass", "drums": "drums", "guitar": "guitar",
            "piano": "piano", "other": "other",
            "vocals": "residual_vocals",  # leftover vocal bleed in the instrumental -> discard
        },
    )
    del sep
    _free_vram()

    # ---- Pass 3 (extended only): peel extra instruments off the "other" residual ------
    if preset.get("extra_stems"):
        residual = job_dir / "other.wav"
        if not residual.exists():
            raise RuntimeError("Pass 2 produced no 'other' stem to extract extra instruments from.")

        total = len(EXTRA_STEM_MODELS)
        for i, (stem, model) in enumerate(EXTRA_STEM_MODELS.items()):
            _update(job, stage=f"Pass 3/3 — Extracting {STEM_LABELS[stem]} ({i+1}/{total}) from residual")
            # Work on a temp copy: the extractor reads it and writes stem + new residual
            work = job_dir / "p3_input.wav"
            shutil.copyfile(residual, work)
            # Remove the old residual BEFORE separating so the new one can take its place
            residual.unlink()

            sep = _make_separator(job_dir, preset, preset["pass3_overlap"])
            sep.load_model(model_filename=model)
            sep.separate(
                str(work),
                custom_output_names={stem: stem, "other": "other"},
            )
            del sep
            _free_vram()

            if not (job_dir / f"{stem}.wav").exists() or not residual.exists():
                raise RuntimeError(f"Pass 3 failed to extract '{stem}' from the residual.")
            work.unlink()

    # ---- Clean intermediates, collect results ----------------------------------------
    for tmp_name in ("instrumental.wav", "residual_vocals.wav"):
        tmp = job_dir / tmp_name
        if tmp.exists():
            tmp.unlink()

    expected = EXPECTED_STEMS if preset.get("extra_stems") else BASE_STEMS
    stems = []
    for stem in expected:
        p = job_dir / f"{stem}.wav"
        if not p.exists():
            continue
        stems.append({"name": STEM_LABELS[stem], "file": f"{stem}.wav", "size": p.stat().st_size})

    missing = [s for s in expected if s not in [x["file"][:-4] for x in stems]]
    if missing:
        raise RuntimeError(f"Pipeline finished but these stems are missing: {', '.join(missing)}")

    _update(job, state="completed", stage="Done", stems=stems)

    # Cloud sync: push stems + manifest to the owner's Dropbox (best-effort)
    owner = job.get("owner")
    if owner and cloud_sync_enabled(owner):
        try:
            SYNC.push_job_async(owner, get_valid_access_token, job["id"],
                                OUTPUT_DIR / job["id"],
                                {"id": job["id"], "display": job.get("display"), "stems": stems})
        except Exception:
            pass

    # Input no longer needed once the split succeeded
    try:
        src.unlink()
    except OSError:
        pass


def cloud_sync_enabled(sub: str) -> bool:
    """Cloud sync is on when the subject has a stored Dropbox token."""
    return TOKENS.load(sub) is not None


def gpu_worker():
    """Single consumer: only one job touches the GPU at a time."""
    while True:
        job_id = JOB_QUEUE.get()
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if job is None:
            continue
        try:
            run_pipeline(job)
        except Exception as e:  # noqa: BLE001 — surface ANY failure to the UI, never swallow
            print(f"[job {job_id}] FAILED: {e}\n{traceback.format_exc()}")
            _update(job, state="error", stage="Failed", error=str(e))


# --------------------------------------------------------------------------------------
# Maintenance
# --------------------------------------------------------------------------------------
def _prune_old_jobs():
    import time
    cutoff = time.time() - JOB_RETENTION_SECONDS
    for d in OUTPUT_DIR.iterdir():
        if d.is_dir() and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)
    for f in UPLOAD_DIR.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)


# --------------------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------------------
async def _session(request: Request) -> dict:
    sess = resolve_session(request.cookies.get(SESSION_COOKIE))
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return sess


@app.post("/api/upload")
async def upload_audio(request: Request, file: UploadFile = File(...), quality: str = Form("fast")):
    sess = await _session(request)
    display = file.filename or "track"
    ext = os.path.splitext(display)[1].lower()
    if ext not in ALLOWED_EXT:
        return JSONResponse(status_code=400, content={"message": f"Unsupported file type '{ext}'. Allowed: {sorted(ALLOWED_EXT)}"})
    if quality not in QUALITY_PRESETS:
        return JSONResponse(status_code=400, content={"message": f"Unknown quality '{quality}'. Use: {sorted(QUALITY_PRESETS)}"})

    job_id = uuid.uuid4().hex[:12]
    saved = UPLOAD_DIR / f"{job_id}{ext}"

    size = 0
    with saved.open("wb") as buf:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                buf.close()
                saved.unlink(missing_ok=True)
                return JSONResponse(status_code=413, content={"message": f"File too large (limit {MAX_UPLOAD_BYTES // (1024*1024)} MB)."})
            buf.write(chunk)

    job = {
        "id": job_id, "owner": sess["sub"], "display": display, "file": saved.name, "quality": quality,
        "state": "queued", "stage": "Queued", "error": None, "stems": [],
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    _persist(job)
    JOB_QUEUE.put(job_id)
    return {"status": "queued", "job_id": job_id}


def _load_job(job_id: str, owner: str | None = None):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job:
        if owner and job.get("owner") not in (None, owner):
            return None
        return job
    job_dir = OUTPUT_DIR / job_id
    state_file = job_dir / "state.json"
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            if owner and data.get("owner") not in (None, owner):
                return None
            return data
        except Exception:
            pass
    # Fallback: reconstruct from existing wav files if directory exists
    if job_dir.is_dir():
        wav_files = sorted(job_dir.glob("*.wav"))
        if wav_files:
            stems = []
            for wf in wav_files:
                stem_key = wf.stem.lower()
                label = STEM_LABELS.get(stem_key, wf.stem.capitalize())
                stems.append({"name": label, "file": wf.name, "size": wf.stat().st_size})
            quality = "extended" if len(stems) > 6 else "fast"
            return {
                "id": job_id,
                "display": job_id,
                "quality": quality,
                "state": "completed",
                "stage": "Done",
                "error": None,
                "stems": stems,
            }
    return None


@app.get("/api/jobs")
async def list_jobs(request: Request):
    """Jobs owned by the session user (legacy ownerless jobs treated as local-user's)."""
    sess = await _session(request)
    results = []
    if not OUTPUT_DIR.exists():
        return {"jobs": []}
    for item in OUTPUT_DIR.iterdir():
        if item.is_dir():
            job = _load_job(item.name, owner=sess["sub"])
            if job and job.get("state") == "completed":
                results.append({
                    "id": job["id"],
                    "name": job.get("display", item.name),
                    "quality": job.get("quality", "fast"),
                    "stem_count": len(job.get("stems", [])),
                    "timestamp": int(item.stat().st_mtime * 1000),
                })
    results.sort(key=lambda x: x["timestamp"], reverse=True)
    return {"jobs": results}


@app.get("/api/status/{job_id}")
async def get_status(job_id: str, request: Request):
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None:
        return {"status": "unknown"}
    resp = {"status": job["state"], "stage": job.get("stage", ""), "name": job.get("display", ""), "quality": job.get("quality", "fast")}
    if job["state"] == "completed":
        resp["stems"] = [f"/api/download/{job_id}/{s['file']}" for s in job["stems"]]
        resp["stem_details"] = job["stems"]
    if job["state"] == "error":
        resp["error"] = job.get("error", "Unknown error")
    return resp


@app.get("/api/download/{job_id}/{filename}")
async def download_stem(job_id: str, filename: str, request: Request):
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None:
        return JSONResponse(status_code=404, content={"message": "Not found"})
    # Block path traversal and weird names outright
    if not re.fullmatch(r"[A-Za-z0-9_.\-]+", filename) or ".." in filename:
        return JSONResponse(status_code=400, content={"message": "Invalid filename"})
    file_path = (OUTPUT_DIR / job_id / filename).resolve()
    if not str(file_path).startswith(str(OUTPUT_DIR.resolve())):
        return JSONResponse(status_code=400, content={"message": "Invalid path"})
    if not file_path.exists():
        return JSONResponse(status_code=404, content={"message": "Stem file not found"})
    return FileResponse(path=file_path, filename=filename, media_type="audio/wav")


@app.get("/api/download/{job_id}")
async def download_all(job_id: str, request: Request):
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None or job["state"] != "completed":
        return JSONResponse(status_code=404, content={"message": "Job not found or not completed"})
    job_dir = OUTPUT_DIR / job_id
    prefix = re.sub(r"[^A-Za-z0-9_\-]+", "_", job.get("display", "stems")).strip("_") or "stems"
    zip_path = job_dir / "stems.zip"

    # Build the ZIP on disk once, then serve it with range support — no RAM buffering
    if not zip_path.exists():
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
            for s in job["stems"]:
                zf.write(job_dir / s["file"], arcname=f"{prefix} - {s['name']}.wav")

    return FileResponse(
        path=zip_path,
        filename=f"{prefix} stems.zip",
        media_type="application/zip",
    )


# --------------------------------------------------------------------------------------
# System features: mix render, analysis, health
# --------------------------------------------------------------------------------------
@app.post("/api/mix/{job_id}")
async def render_mix(job_id: str, request: Request, body: dict = None):
    """
    Render a custom mix server-side with ffmpeg from the client's per-stem
    volumes/mutes. Body: { "stems": {"vocals": 0.9, "drums": 0.0, ...},
                          "format": "wav" | "mp3", "master": 1.0 }
    """
    body = body or {}
    stem_gains = body.get("stems") or {}
    fmt = body.get("format", "wav")
    master = float(body.get("master", 1.0))
    if fmt not in ("wav", "mp3"):
        return JSONResponse(status_code=400, content={"message": "format must be wav or mp3"})
    if not isinstance(stem_gains, dict) or not stem_gains:
        return JSONResponse(status_code=400, content={"message": "stems map required"})

    job = _load_job(job_id, owner=(await _session(request))["sub"])
    if job is None or job["state"] != "completed":
        return JSONResponse(status_code=404, content={"message": "Job not found or not completed"})
    job_dir = OUTPUT_DIR / job_id
    if any(not re.fullmatch(r"[a-z0-9_]+", k) for k in stem_gains):
        return JSONResponse(status_code=400, content={"message": "invalid stem key"})

    # Build an ffmpeg filtergraph: per-stem volume, then sum
    inputs, filters = [], []
    idx = 0
    for stem_key, gain in stem_gains.items():
        p = job_dir / f"{stem_key}.wav"
        if not p.exists():
            continue
        g = max(0.0, min(1.0, float(gain))) * master
        if g <= 0:
            continue  # muted — skip file entirely
        inputs += ["-i", str(p)]
        filters.append(f"[{idx}:a]volume={g:.4f}[s{idx}]")
        idx += 1
    if not inputs:
        return JSONResponse(status_code=400, content={"message": "all stems are muted"})

    mix_inputs = "".join(f"[s{i}]" for i in range(idx))
    filter_complex = ";".join(filters) + f";{mix_inputs}amix=inputs={idx}:normalize=0[out]"

    prefix = re.sub(r"[^A-Za-z0-9_\\-]+", "_", job.get("display", "mix")).strip("_") or "mix"
    out = job_dir / f"mix.{fmt}"
    cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_complex,
           "-map", "[out]", "-ac", "2", "-ar", "44100"]
    if fmt == "mp3":
        cmd += ["-b:a", "320k"]
    else:
        cmd += ["-c:a", "pcm_s16le"]
    cmd.append(str(out))

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0 or not out.exists():
        return JSONResponse(status_code=500, content={"message": f"ffmpeg failed: {proc.stderr[-400:]}"})

    return FileResponse(path=out, filename=f"{prefix} mix.{fmt}", media_type="audio/mpeg" if fmt == "mp3" else "audio/wav")


@app.get("/api/analysis/{job_id}")
async def analyze_job(job_id: str, request: Request):
    """Duration, sample rate, channels, and BPM estimate (from the vocals stem)."""
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None or job["state"] != "completed":
        return JSONResponse(status_code=404, content={"message": "Job not found or not completed"})
    job_dir = OUTPUT_DIR / job_id

    # cached analysis lives next to the stems
    cache = job_dir / "analysis.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except Exception:
            pass

    info = sf.info(str(job_dir / "vocals.wav"))
    duration = float(info.duration)
    bpm = None
    try:
        ref = job_dir / "vocals.wav" if (job_dir / "vocals.wav").exists() else job_dir / "other.wav"
        y, sr = librosa.load(str(ref), mono=True, sr=22050)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(np.atleast_1d(tempo)[0]), 1)
    except Exception:
        pass

    result = {
        "id": job_id, "name": job.get("display", ""),
        "duration": round(duration, 2), "sample_rate": info.samplerate,
        "channels": info.channels, "bpm": bpm,
        "stems": len(job.get("stems", [])), "quality": job.get("quality", "fast"),
    }
    cache.write_text(json.dumps(result), encoding="utf-8")
    return result


# --------------------------------------------------------------------------------------
# Auth routes (public — exempt from the session guard)
# --------------------------------------------------------------------------------------
import secrets as _secrets
from fastapi.responses import RedirectResponse

# In-flight OAuth states: state -> {verifier, redirect_uri}
OAUTH_STATES: dict[str, dict] = {}
OAUTH_TTL = 600


@app.get("/api/auth/status")
async def auth_status(request: Request):
    sess = resolve_session(request.cookies.get(SESSION_COOKIE))
    return {
        "authenticated": bool(sess),
        "user": {"name": sess["name"], "email": sess.get("email")} if sess else None,
        "dropbox_configured": dropbox_configured(),
        "dropbox_linked": bool(sess and TOKENS.load(sess["sub"])),
    }


@app.get("/api/auth/login")
async def auth_login(request: Request):
    """Start OAuth. If Dropbox isn't configured, create a local session."""
    if not dropbox_configured():
        # Local mode: single-user session (works offline)
        sub = "local-user"
        sid = create_session(sub, "Local user", None)
        resp = JSONResponse({"status": "ok", "mode": "local"})
        resp.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="lax",
                        max_age=24 * 3600, path="/")
        return resp

    redirect_uri = str(request.base_url).rstrip("/") + "/api/auth/callback"
    state = _secrets.token_urlsafe(24)
    verifier, challenge = make_pkce()
    OAUTH_STATES[state] = {"verifier": verifier, "redirect_uri": redirect_uri, "exp": time.time() + OAUTH_TTL}
    # prune expired states
    for k in [k for k, v in OAUTH_STATES.items() if v["exp"] < time.time()]:
        OAUTH_STATES.pop(k, None)
    return RedirectResponse(build_authorize_url(redirect_uri, state, challenge))


@app.get("/api/auth/callback")
async def auth_callback(code: str = "", state: str = "", error: str = ""):
    import time as _time
    if error:
        return JSONResponse(status_code=400, content={"message": f"OAuth denied: {error}"})
    st = OAUTH_STATES.pop(state, None)
    if not st:
        return JSONResponse(status_code=400, content={"message": "Unknown or expired OAuth state"})
    try:
        tokens = exchange_code(code, st["redirect_uri"], st["verifier"])
        account = get_dropbox_account(tokens["access_token"])
    except Exception as e:
        return JSONResponse(status_code=502, content={"message": f"Dropbox auth failed: {e}"})

    # persist tokens encrypted
    TOKENS.save(account["sub"], {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token"),
        "expires_at": _time.time() + int(tokens.get("expires_in", 14400)),
        "account": account,
    })
    sid = create_session(account["sub"], account["name"], account["email"])
    resp = RedirectResponse("/")
    resp.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="lax",
                    max_age=24 * 3600, path="/")
    return resp


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    drop_session(request.cookies.get(SESSION_COOKIE))
    resp = JSONResponse({"status": "ok"})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


# --------------------------------------------------------------------------------------
# New features: delete, rename, cloud pull, cloud space
# --------------------------------------------------------------------------------------
@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str, request: Request):
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None:
        return JSONResponse(status_code=404, content={"message": "Job not found"})
    with JOBS_LOCK:
        JOBS.pop(job_id, None)
    shutil.rmtree(OUTPUT_DIR / job_id, ignore_errors=True)
    # also remove from Dropbox if linked
    if TOKENS.load(sess["sub"]):
        token = get_valid_access_token(sess["sub"])
        if token:
            try:
                cloud.delete_path(token, remote_job_path(job_id))
            except Exception:
                pass
    return {"status": "deleted"}


@app.post("/api/jobs/{job_id}/rename")
async def rename_job(job_id: str, request: Request, body: dict = None):
    sess = await _session(request)
    job = _load_job(job_id, owner=sess["sub"])
    if job is None:
        return JSONResponse(status_code=404, content={"message": "Job not found"})
    name = (body or {}).get("name", "").strip()
    if not name or len(name) > 120:
        return JSONResponse(status_code=400, content={"message": "name required (1-120 chars)"})
    job["display"] = name
    _persist(job)
    with JOBS_LOCK:
        JOBS[job_id] = job
    return {"status": "renamed", "name": name}


@app.post("/api/jobs/{job_id}/pull")
async def pull_job_from_cloud(job_id: str, request: Request):
    """Download a job's stems from Dropbox to local storage."""
    sess = await _session(request)
    token = get_valid_access_token(sess["sub"])
    if not token:
        return JSONResponse(status_code=400, content={"message": "Dropbox not linked"})
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        entries = cloud.list_folder(token, remote_job_path(job_id))
        pulled = 0
        for e in entries:
            if e.get(".tag") == "file" and e["name"].endswith((".wav", ".json")):
                cloud.download_file(token, e["path_lower"], job_dir / e["name"])
                pulled += 1
        if pulled == 0:
            return JSONResponse(status_code=404, content={"message": "Nothing in cloud for this job"})
        return {"status": "pulled", "files": pulled}
    except cloud.DropboxError as e:
        return JSONResponse(status_code=502, content={"message": str(e)})


@app.get("/api/cloud/space")
async def cloud_space(request: Request):
    sess = await _session(request)
    token = get_valid_access_token(sess["sub"])
    if not token:
        return {"linked": False}
    try:
        usage = cloud.get_space_usage(token)
        return {"linked": True, **usage}
    except Exception:
        return {"linked": True, "error": "usage unavailable"}


@app.get("/api/cloud/jobs")
async def cloud_jobs(request: Request):
    """List jobs present in the user's Dropbox (merged view for the Library)."""
    sess = await _session(request)
    token = get_valid_access_token(sess["sub"])
    if not token:
        return {"linked": False, "jobs": []}
    try:
        entries = cloud.list_folder(token, cloud.ROOT)
        jobs = []
        for e in entries:
            if e.get(".tag") == "folder":
                jobs.append({"id": e["name"], "in_cloud": True})
        return {"linked": True, "jobs": jobs}
    except cloud.DropboxError as e:
        return {"linked": True, "jobs": [], "error": str(e)}


@app.get("/api/health")
async def health():
    gpu = torch.cuda.is_available()
    gpu_name = torch.cuda.get_device_name(0) if gpu else None
    vram_total = torch.cuda.get_device_properties(0).total_memory if gpu else 0
    import audio_separator
    with JOBS_LOCK:
        n_jobs = len(JOBS)
    return {
        "status": "ok",
        "version": "2.0.0",
        "gpu": {"available": gpu, "name": gpu_name, "vram_mb": round(vram_total / 2**20) if gpu else 0},
        "queue_depth": JOB_QUEUE.qsize(),
        "jobs_in_memory": n_jobs,
        "audio_separator": getattr(audio_separator, "__version__", "unknown"),
    }


if os.path.exists(APP_DIR / "static"):
    app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000)
