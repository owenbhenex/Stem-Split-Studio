"""
auth.py — Dropbox OAuth 2.0 (PKCE) + encrypted token store + session cookies.

Security model
--------------
- App auth (Dropbox OAuth code flow with PKCE): the user's Dropbox refresh
  token is stored AES-GCM encrypted at rest (key derived from AUTH_SECRET).
- Session: random 32-byte token, stored in an HttpOnly+SameSite=Lax cookie,
  signed with HMAC (tamper-evident). Sessions in memory with sliding expiry.
- All /api/* routes (except /api/auth/* and /api/health) require a session.
- Local mode: if no DROPBOX_CLIENT_ID is configured, a single local user is
  auto-created on first visit ("local mode") so the app keeps working offline.
"""

import os
import time
import base64
import hashlib
import hmac
import secrets
import logging
import threading
from pathlib import Path

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse

log = logging.getLogger("stem_splitter.auth")

# ---------------------------------------------------------------- config
AUTH_DIR = Path(os.environ.get("STEM_AUTH_DIR", Path(__file__).resolve().parent / ".auth"))
AUTH_DIR.mkdir(exist_ok=True)

SESSION_COOKIE = "stem_session"
SESSION_TTL = 24 * 3600  # 24h sliding

DROPBOX_CLIENT_ID = os.environ.get("DROPBOX_CLIENT_ID", "")
DROPBOX_CLIENT_SECRET_FILE = AUTH_DIR / "dropbox_secret.txt"

# The auth secret: prefer env; else load/generate a persistent key file.
_SECRET_FILE = AUTH_DIR / "auth_secret.key"


def _load_or_create_secret() -> bytes:
    if os.environ.get("STEM_AUTH_SECRET"):
        return os.environ["STEM_AUTH_SECRET"].encode()
    if _SECRET_FILE.exists():
        return _SECRET_FILE.read_bytes()
    key = base64.b64encode(secrets.token_bytes(32))
    _SECRET_FILE.write_bytes(key)
    try:
        _SECRET_FILE.chmod(0o600)
    except OSError:
        pass  # Windows ACLs differ; best-effort
    return key


AUTH_SECRET = _load_or_create_secret()


def _aes_key(purpose: bytes) -> bytes:
    """Derive a purpose-bound AES-256 key from the auth secret."""
    return HKDF(
        algorithm=hashes.SHA256(), length=32,
        salt=b"stem-splitter-studio", info=purpose,
    ).derive(base64.b64decode(AUTH_SECRET))


# ---------------------------------------------------------------- token store
class TokenStore:
    """AES-GCM encrypted JSON blobs on disk, one file per subject."""

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(exist_ok=True)

    def _path(self, sub: str) -> Path:
        # subject ids are validated [a-zA-Z0-9_-]+ upstream
        return self.dir / f"tok_{sub}.bin"

    def save(self, sub: str, data: dict):
        aes = AESGCM(_aes_key(b"dropbox-token"))
        nonce = secrets.token_bytes(12)
        ct = aes.encrypt(nonce, __import__("json").dumps(data).encode(), b"")
        self._path(sub).write_bytes(nonce + ct)

    def load(self, sub: str) -> dict | None:
        p = self._path(sub)
        if not p.exists():
            return None
        try:
            raw = p.read_bytes()
            aes = AESGCM(_aes_key(b"dropbox-token"))
            return __import__("json").loads(aes.decrypt(raw[:12], raw[12:], b""))
        except Exception:
            log.exception("token decrypt failed for %s", sub)
            return None

    def delete(self, sub: str):
        self._path(sub).unlink(missing_ok=True)


TOKENS = TokenStore(AUTH_DIR)


def get_client_secret() -> str:
    if DROPBOX_CLIENT_SECRET_FILE.exists():
        return DROPBOX_CLIENT_SECRET_FILE.read_text(encoding="utf-8").strip()
    return ""


# ---------------------------------------------------------------- sessions
SESSIONS: dict[str, dict] = {}  # sid -> {sub, name, email, exp}
_SESSIONS_LOCK = threading.Lock()


def _sign(value: str) -> str:
    mac = hmac.new(base64.b64decode(AUTH_SECRET), value.encode(), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def create_session(sub: str, name: str, email: str | None) -> str:
    sid = secrets.token_urlsafe(32)
    with _SESSIONS_LOCK:
        # prune expired
        now = time.time()
        for k in [k for k, v in SESSIONS.items() if v["exp"] < now]:
            del SESSIONS[k]
        SESSIONS[sid] = {"sub": sub, "name": name, "email": email, "exp": now + SESSION_TTL}
    return f"{sid}.{_sign(sid)}"


def resolve_session(cookie_value: str | None) -> dict | None:
    if not cookie_value or "." not in cookie_value:
        return None
    sid, sig = cookie_value.rsplit(".", 1)
    if not hmac.compare_digest(_sign(sid), sig):
        return None
    with _SESSIONS_LOCK:
        s = SESSIONS.get(sid)
        if not s or s["exp"] < time.time():
            return None
        s["exp"] = time.time() + SESSION_TTL  # sliding
        return s


def drop_session(cookie_value: str | None):
    if not cookie_value or "." not in cookie_value:
        return
    sid = cookie_value.rsplit(".", 1)[0]
    with _SESSIONS_LOCK:
        SESSIONS.pop(sid, None)


# ---------------------------------------------------------------- dropbox oauth
AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize"
TOKEN_URL = "https://api.dropboxapi.com/oauth2/token"


def dropbox_configured() -> bool:
    return bool(DROPBOX_CLIENT_ID)


def make_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return verifier, challenge


def build_authorize_url(redirect_uri: str, state: str, code_challenge: str) -> str:
    q = requests.Request(
        "GET", AUTHORIZE_URL, params={
            "response_type": "code",
            "client_id": DROPBOX_CLIENT_ID,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "token_access_type": "offline",
        }).prepare().url
    return q


def exchange_code(code: str, redirect_uri: str, code_verifier: str) -> dict:
    """Exchange authorization code for access + refresh tokens."""
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }
    if get_client_secret():
        # confidential app
        r = requests.post(TOKEN_URL, data=data,
                          auth=(DROPBOX_CLIENT_ID, get_client_secret()), timeout=30)
    else:
        # PKCE public app
        data["client_id"] = DROPBOX_CLIENT_ID
        r = requests.post(TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    return r.json()


def refresh_access_token(refresh_token: str) -> str:
    data = {"grant_type": "refresh_token", "refresh_token": refresh_token}
    if get_client_secret():
        r = requests.post(TOKEN_URL, data=data,
                          auth=(DROPBOX_CLIENT_ID, get_client_secret()), timeout=30)
    else:
        data["client_id"] = DROPBOX_CLIENT_ID
        r = requests.post(TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def get_dropbox_account(access_token: str) -> dict:
    r = requests.post(
        "https://api.dropboxapi.com/2/users/get_current_account",
        headers={"Authorization": f"Bearer {access_token}"}, timeout=30)
    r.raise_for_status()
    d = r.json()
    return {
        "sub": d["account_id"],
        "name": d["name"].get("display_name") or d["email"],
        "email": d["email"],
    }


def get_valid_access_token(sub: str) -> str | None:
    """Return a working access token for the subject, refreshing if needed."""
    tok = TOKENS.load(sub)
    if not tok:
        return None
    if tok.get("expires_at", 0) > time.time() + 60:
        return tok["access_token"]
    try:
        at = refresh_access_token(tok["refresh_token"])
        tok["access_token"] = at
        tok["expires_at"] = time.time() + 14400
        TOKENS.save(sub, tok)
        return at
    except Exception:
        log.exception("dropbox refresh failed for %s", sub)
        return None


# ---------------------------------------------------------------- request guard
PUBLIC_PATHS = {"/api/auth/status", "/api/auth/login", "/api/auth/callback", "/api/health"}


async def require_session(request: Request) -> dict:
    """Dependency/middleware helper — raises 401 unless a valid session exists."""
    sess = resolve_session(request.cookies.get(SESSION_COOKIE))
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return sess


def session_middleware_dispatch(request: Request, call_next):
    """ASGI-style middleware body: guard /api/* except public paths."""
    path = request.url.path
    if (path.startswith("/api/") and path not in PUBLIC_PATHS
            and not (path.startswith("/api/auth/"))):
        sess = resolve_session(request.cookies.get(SESSION_COOKIE))
        if not sess:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return call_next(request)
