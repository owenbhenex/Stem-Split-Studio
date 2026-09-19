"""
cloud.py — Dropbox storage engine for completed jobs.

Layout in the user's Dropbox (App folder):
    /Apps/Stem Splitter Studio/<job_id>/<stem>.wav
    /Apps/Stem Splitter Studio/<job_id>/state.json

Sync model: local-first. When a job completes, its stems + state are pushed
to Dropbox in the background. Listing merges local + cloud manifests. A job
present in the cloud but not locally can be pulled on demand.
"""

import io
import json
import logging
import threading
from pathlib import Path

import requests

log = logging.getLogger("stem_splitter.cloud")

API = "https://content.dropboxapi.com"      # content endpoints
RPC = "https://api.dropboxapi.com"          # rpc endpoints
CHUNK = 32 * 1024 * 1024                    # 32 MB upload chunks


class DropboxError(Exception):
    pass


def _headers(token: str, api_arg: dict | None = None, json_body=None):
    h = {"Authorization": f"Bearer {token}"}
    if api_arg is not None:
        h["Dropbox-API-Arg"] = json.dumps(api_arg)
    return h


def upload_file(token: str, local_path: Path, remote_path: str) -> dict:
    """Upload a file; uses chunked sessions for large files."""
    size = local_path.stat().st_size
    if size <= CHUNK:
        with open(local_path, "rb") as f:
            r = requests.post(
                f"{API}/2/files/upload",
                headers=_headers(token, {
                    "path": remote_path, "mode": "overwrite",
                    "mute": True, "autorename": False,
                }),
                data=f.read(), timeout=600)
        if r.status_code >= 300:
            raise DropboxError(f"upload failed {r.status_code}: {r.text[:200]}")
        return r.json()

    # chunked
    with open(local_path, "rb") as f:
        first = f.read(CHUNK)
        r = requests.post(
            f"{API}/2/files/upload_session/start",
            headers=_headers(token), data=first, timeout=600)
        if r.status_code >= 300:
            raise DropboxError(f"session start failed: {r.text[:200]}")
        session_id = r.json()["session_id"]
        offset = len(first)

        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            r = requests.post(
                f"{API}/2/files/upload_session/append_v2",
                headers=_headers(token, {
                    "cursor": {"session_id": session_id, "offset": offset},
                    "close": False,
                }),
                data=chunk, timeout=600)
            if r.status_code >= 300:
                raise DropboxError(f"append failed at {offset}: {r.text[:200]}")
            offset += len(chunk)

        r = requests.post(
            f"{API}/2/files/upload_session/finish",
            headers=_headers(token, {
                "cursor": {"session_id": session_id, "offset": offset},
                "commit": {"path": remote_path, "mode": "overwrite", "mute": True},
            }),
            timeout=600)
        if r.status_code >= 300:
            raise DropboxError(f"finish failed: {r.text[:200]}")
        return r.json()


def download_file(token: str, remote_path: str, local_path: Path):
    r = requests.post(
        f"{API}/2/files/download",
        headers=_headers(token, {"path": remote_path}),
        timeout=1800, stream=True)
    if r.status_code >= 300:
        raise DropboxError(f"download failed {r.status_code}: {r.text[:200]}")
    local_path.parent.mkdir(parents=True, exist_ok=True)
    with open(local_path, "wb") as f:
        for chunk in r.iter_content(1024 * 1024):
            f.write(chunk)


def list_folder(token: str, remote_path: str = "", recursive: bool = False) -> list[dict]:
    r = requests.post(
        f"{RPC}/2/files/list_folder",
        headers=_headers(token, json_body=None),
        json={"path": remote_path or None, "recursive": recursive,
              "include_media_info": False, "include_deleted": False},
        timeout=120)
    if r.status_code == 409:  # path not found -> empty
        return []
    if r.status_code >= 300:
        raise DropboxError(f"list_folder failed: {r.status_code} {r.text[:200]}")
    entries = r.json().get("entries", [])
    has_more = r.json().get("has_more", False)
    cursor = r.json().get("cursor")
    while has_more:
        r = requests.post(f"{RPC}/2/files/list_folder/continue",
                          headers=_headers(token), json={"cursor": cursor}, timeout=120)
        if r.status_code >= 300:
            raise DropboxError(f"list continue failed: {r.text[:200]}")
        entries += r.json().get("entries", [])
        has_more = r.json().get("has_more", False)
        cursor = r.json().get("cursor")
    return entries


def delete_path(token: str, remote_path: str):
    r = requests.post(
        f"{RPC}/2/files/delete_v2",
        headers=_headers(token), json={"path": remote_path}, timeout=120)
    if r.status_code >= 300 and r.status_code != 409:
        raise DropboxError(f"delete failed: {r.text[:200]}")


def get_space_usage(token: str) -> dict:
    r = requests.post(f"{RPC}/2/users/get_space_usage",
                      headers=_headers(token), timeout=30)
    r.raise_for_status()
    d = r.json()
    return {"used_mb": round(d["used"] / 2**20), "allocation_mb": round(d["allocation"]["allocated"] / 2**20)}


# ---------------------------------------------------------------- job sync
ROOT = "/stem-splitter-studio"


def remote_job_path(job_id: str) -> str:
    return f"{ROOT}/{job_id}"


class SyncManager:
    """Background push of completed jobs to the user's Dropbox."""

    def __init__(self):
        self._threads: list[threading.Thread] = []

    def push_job_async(self, sub: str, access_token_fn, job_id: str, job_dir: Path, manifest: dict):
        t = threading.Thread(
            target=self._push, args=(sub, access_token_fn, job_id, job_dir, manifest),
            daemon=True, name=f"sync-{job_id}")
        t.start()
        self._threads.append(t)

    def _push(self, sub, access_token_fn, job_id, job_dir, manifest):
        try:
            token = access_token_fn(sub)
            if not token:
                log.warning("no dropbox token for %s — skipping sync", sub)
                return
            # state.json first (manifest), then stems
            state_local = job_dir / "state.json"
            if state_local.exists():
                upload_file(token, state_local, f"{remote_job_path(job_id)}/state.json")
            for f in job_dir.iterdir():
                if f.suffix.lower() == ".wav" and f.is_file():
                    upload_file(token, f, f"{remote_job_path(job_id)}/{f.name}")
            log.info("synced job %s to dropbox for %s", job_id, sub)
        except Exception:
            log.exception("dropbox sync failed for job %s", job_id)


SYNC = SyncManager()
