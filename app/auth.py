"""Authentication: panel login (signed cookie) and API keys for other services."""
from __future__ import annotations

import hmac
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import APIKeyHeader
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from .config import settings

COOKIE = "cp_session"
_signer = URLSafeTimedSerializer(settings.secret_key, salt="central-postgres-session")

# naive in-memory brute-force protection: 10 failed logins / 10 min / IP
_failures: dict[str, deque] = defaultdict(deque)
_WINDOW, _MAX_FAILS = 600, 10


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def _api_key_from(request: Request) -> str | None:
    key = request.headers.get("x-api-key")
    if key:
        return key
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


_api_key_scheme = APIKeyHeader(name="X-API-Key", auto_error=False, description="One of the keys in API_KEYS")


def require_auth(request: Request, _key: str | None = Security(_api_key_scheme)) -> str:
    """Dependency: allow a valid API key, or a valid panel session cookie."""
    key = _api_key_from(request)
    if key is not None:
        if any(_eq(key, k) for k in settings.api_keys):
            return "api-key"
        raise HTTPException(401, "Invalid API key")

    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Not logged in")
    try:
        user = _signer.loads(token, max_age=settings.session_max_age)
    except SignatureExpired:
        raise HTTPException(401, "Session expired")
    except BadSignature:
        raise HTTPException(401, "Invalid session")

    # CSRF guard: cookie-authenticated writes must come from the panel's fetch()
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("x-cp-client") != "panel":
        raise HTTPException(403, "Missing X-CP-Client header")
    return user


router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


def _secure_cookie(request: Request) -> bool:
    if settings.cookie_secure in {"true", "1", "yes"}:
        return True
    if settings.cookie_secure in {"false", "0", "no"}:
        return False
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return proto == "https"


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    ip = _client_ip(request)
    now = time.time()
    q = _failures[ip]
    while q and q[0] < now - _WINDOW:
        q.popleft()
    if len(q) >= _MAX_FAILS:
        raise HTTPException(429, "Too many failed logins. Try again in a few minutes.")

    ok = _eq(body.username, settings.admin_username) and _eq(body.password, settings.admin_password)
    if not ok:
        q.append(now)
        time.sleep(0.4)
        raise HTTPException(401, "Wrong username or password")

    q.clear()
    response.set_cookie(
        COOKIE,
        _signer.dumps(body.username),
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(request),
        path="/",
    )
    return {"user": body.username}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(user: str = Depends(require_auth)):
    return {"user": user}
