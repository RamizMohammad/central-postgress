"""Authentication: panel login (password and/or Google), signed session cookie, admin API keys.

Google sign-in uses the server-side OAuth 2.0 authorization-code flow:

    /api/auth/google/start     -> redirect to Google (state kept in a signed, short-lived cookie)
    /api/auth/google/callback  -> code exchanged for an ID token directly with Google over TLS,
                                  email checked against GOOGLE_ALLOWED_EMAILS, session cookie set

The allowlist is checked again on every request, so removing an address from .env
(and restarting) ends that person's existing sessions too.
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.responses import RedirectResponse
from fastapi.security import APIKeyHeader
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from .config import settings

log = logging.getLogger("central-postgres.auth")

COOKIE = "cp_session"
STATE_COOKIE = "cp_oauth_state"
_signer = URLSafeTimedSerializer(settings.secret_key, salt="central-postgres-session")
_state_signer = URLSafeTimedSerializer(settings.secret_key, salt="central-postgres-oauth-state")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}
CALLBACK_PATH = "/api/auth/google/callback"

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


def _read_session(request: Request) -> dict:
    """Decoded session cookie as {"u": user, "m": "password"|"google", "n": display name}."""
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Not logged in")
    try:
        data = _signer.loads(token, max_age=settings.session_max_age)
    except SignatureExpired:
        raise HTTPException(401, "Session expired")
    except BadSignature:
        raise HTTPException(401, "Invalid session")
    if isinstance(data, str):  # cookies issued before Google sign-in existed
        data = {"u": data, "m": "password"}
    if not isinstance(data, dict) or not data.get("u"):
        raise HTTPException(401, "Invalid session")
    if data.get("m") == "google":
        if not settings.google_enabled or not settings.email_allowed(data["u"]):
            raise HTTPException(401, "This Google account is no longer allowed")
    elif not settings.password_login:
        raise HTTPException(401, "Password sign-in is disabled")
    return data


_api_key_scheme = APIKeyHeader(name="X-API-Key", auto_error=False, description="One of the keys in API_KEYS")


def require_auth(request: Request, _key: str | None = Security(_api_key_scheme)) -> str:
    """Dependency: allow a valid API key, or a valid panel session cookie."""
    key = _api_key_from(request)
    if key is not None:
        if any(_eq(key, k) for k in settings.api_keys):
            return "api-key"
        raise HTTPException(401, "Invalid API key")

    user = _read_session(request)["u"]

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


def _set_session(response: Response, request: Request, payload: dict) -> None:
    response.set_cookie(
        COOKIE,
        _signer.dumps(payload),
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(request),
        path="/",
    )


@router.get("/config")
def auth_config():
    """Public: which sign-in methods the login page should offer."""
    return {"password": settings.password_login, "google": settings.google_enabled}


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    if not settings.password_login:
        raise HTTPException(403, "Password sign-in is disabled. Use Google.")
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
    _set_session(response, request, {"u": body.username, "m": "password"})
    return {"user": body.username}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request, user: str = Depends(require_auth)):
    if user == "api-key":
        return {"user": user, "method": "api-key", "name": None}
    s = _read_session(request)
    return {"user": s["u"], "method": s.get("m", "password"), "name": s.get("n")}


# --------------------------------------------------------------------------- Google
def _redirect_uri(request: Request) -> str:
    if settings.google_redirect_url:
        return settings.google_redirect_url
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host.split(',')[0].strip()}{CALLBACK_PATH}"


def _fail(message: str) -> RedirectResponse:
    resp = RedirectResponse("/?auth_error=" + urllib.parse.quote(message), status_code=303)
    resp.delete_cookie(STATE_COOKIE, path=CALLBACK_PATH)
    return resp


@router.get("/google/start", include_in_schema=False)
def google_start(request: Request):
    if not settings.google_enabled:
        return _fail("Google sign-in is not configured on this server.")
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": _redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
        "access_type": "online",
    }
    # Only one allowed address: pre-select it in Google's account chooser.
    if len(settings.google_allowed_emails) == 1 and not settings.google_allowed_emails[0].startswith("@"):
        params["login_hint"] = settings.google_allowed_emails[0]
    resp = RedirectResponse(GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params), status_code=303)
    resp.set_cookie(
        STATE_COOKIE, _state_signer.dumps(state), max_age=600, httponly=True,
        samesite="lax", secure=_secure_cookie(request), path=CALLBACK_PATH,
    )
    return resp


def _exchange_code(code: str, redirect_uri: str) -> dict:
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(GOOGLE_TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Google rejected the sign-in ({e.code}): {body}") from e


def _jwt_claims(id_token: str) -> dict:
    # The token came straight from Google's token endpoint over TLS, which OpenID
    # Connect accepts in place of a signature check (Core 1.0, section 3.1.3.7).
    payload = id_token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


@router.get("/google/callback", include_in_schema=False)
async def google_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    if not settings.google_enabled:
        return _fail("Google sign-in is not configured on this server.")
    if error:
        return _fail("Google sign-in was cancelled." if error == "access_denied" else f"Google sign-in failed: {error}")
    try:
        expected = _state_signer.loads(request.cookies.get(STATE_COOKIE, ""), max_age=600)
    except (BadSignature, SignatureExpired):
        expected = None
    if not code or not state or not expected or not _eq(state, expected):
        return _fail("Sign-in expired or was started in another tab. Please try again.")

    try:
        tokens = await asyncio.to_thread(_exchange_code, code, _redirect_uri(request))
        claims = _jwt_claims(tokens["id_token"])
    except Exception as e:  # network, bad code, malformed token
        log.warning("Google token exchange failed: %s", e)
        return _fail("Could not complete Google sign-in. Please try again.")

    email = str(claims.get("email", "")).lower()
    if (
        claims.get("iss") not in GOOGLE_ISSUERS
        or claims.get("aud") != settings.google_client_id
        or float(claims.get("exp", 0)) < time.time()
    ):
        return _fail("Google returned an invalid sign-in token.")
    if not claims.get("email_verified"):
        return _fail("That Google account's email address is not verified.")
    if not settings.email_allowed(email):
        log.warning("Google sign-in refused for %s from %s", email, _client_ip(request))
        return _fail(f"{email} is not allowed to use this panel.")

    resp = RedirectResponse("/#/overview", status_code=303)
    resp.delete_cookie(STATE_COOKIE, path=CALLBACK_PATH)
    _set_session(resp, request, {"u": email, "m": "google", "n": claims.get("name") or email})
    log.warning("Google sign-in: %s", email)
    return resp
