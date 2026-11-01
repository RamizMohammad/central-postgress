"""central-postgres: a small server + admin panel for a Render Postgres instance."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import os
import urllib.request
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import asyncpg
from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth
from .config import settings
from .db import pools
from . import appkeys, backup
from . import redis_control, redis_core
from .routers import backup as backup_routes
from .routers import data_api, keys, redis_admin, redis_api, rows, server, sql, tables

log = logging.getLogger("central-postgres")
STATIC = Path(__file__).resolve().parent.parent / "static"


class _SkipHealthz(logging.Filter):
    """Render and Docker poll /healthz every few seconds; keep it out of the access log."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "/healthz" not in record.getMessage()


logging.getLogger("uvicorn.access").addFilter(_SkipHealthz())

# Render sets RENDER_EXTERNAL_URL on web services. Pinging the public URL (not
# localhost) counts as inbound traffic, which is what keeps a free service awake.
KEEPALIVE_URL = os.getenv("KEEPALIVE_URL") or os.getenv("RENDER_EXTERNAL_URL", "")
KEEPALIVE_INTERVAL = int(os.getenv("KEEPALIVE_INTERVAL", "20"))


def _ping(target: str) -> None:
    with urllib.request.urlopen(target, timeout=10):
        pass


async def _keepalive(url: str) -> None:
    target = url.rstrip("/") + "/healthz"
    while True:
        await asyncio.sleep(KEEPALIVE_INTERVAL)
        try:
            await asyncio.to_thread(_ping, target)
        except Exception as e:  # 503 when the DB is down, network blips, etc.
            log.warning("Keep-alive ping to %s failed: %s", target, e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        pool = await pools.get()
        async with pool.acquire() as conn:
            v = await conn.fetchval("SHOW server_version")
        log.warning("Connected to Postgres %s (database %s)", v, settings.default_database)
    except Exception as e:  # keep the panel up so the error is visible there
        log.error("Could not connect to Postgres at startup: %s", e)
    task = None
    if KEEPALIVE_URL and KEEPALIVE_INTERVAL > 0:
        task = asyncio.create_task(_keepalive(KEEPALIVE_URL))
        log.warning("Keep-alive: pinging %s/healthz every %ss", KEEPALIVE_URL.rstrip("/"), KEEPALIVE_INTERVAL)
    auto = None
    if settings.auto_backup_hours > 0:
        auto = asyncio.create_task(backup.auto_backup_loop())
        log.warning("Automatic backups every %sh, keeping %s", settings.auto_backup_hours, settings.auto_backup_keep)
    yield
    for t in (task, auto):
        if t:
            t.cancel()
            with suppress(asyncio.CancelledError):
                await t
    await redis_core.close()
    await appkeys.flush_usage()
    await appkeys.close_all_key_pools()
    await pools.close_all()


app = FastAPI(
    title="central-postgres",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)


@app.exception_handler(asyncpg.PostgresError)
async def pg_error(request: Request, exc: asyncpg.PostgresError):
    body = {
        "detail": getattr(exc, "message", None) or str(exc),
        "pg_code": getattr(exc, "sqlstate", None),
    }
    for attr in ("detail", "hint", "position"):
        val = getattr(exc, attr, None)
        if val:
            body[f"pg_{attr}"] = val
    return JSONResponse(body, status_code=400)


@app.exception_handler(asyncpg.InterfaceError)
async def pg_interface_error(request: Request, exc: asyncpg.InterfaceError):
    return JSONResponse({"detail": f"Database driver error: {exc}"}, status_code=500)


try:
    from redis.exceptions import ConnectionError as RedisConnectionError
    from redis.exceptions import RedisError, ResponseError
    from redis.exceptions import TimeoutError as RedisTimeoutError

    @app.exception_handler(RedisError)
    async def redis_error(request: Request, exc: RedisError):
        if isinstance(exc, (RedisConnectionError, RedisTimeoutError)):
            return JSONResponse({"detail": f"Cannot reach Redis: {exc}"}, status_code=503)
        if isinstance(exc, ResponseError):  # e.g. WRONGTYPE: an operation on a key of another type
            return JSONResponse({"detail": str(exc)}, status_code=409)
        return JSONResponse({"detail": f"Redis error: {exc}"}, status_code=500)
except ImportError:  # pragma: no cover
    pass


@app.exception_handler(OSError)
async def conn_error(request: Request, exc: OSError):
    return JSONResponse({"detail": f"Cannot reach the database: {exc}"}, status_code=502)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        # index.html links assets as /static/x?v=<content hash>, so a deploy changes the URL
        resp.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if request.query_params.get("v") else "no-cache"
        )
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if not request.url.path.startswith("/api/docs"):
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
    return resp


class SelectiveGZip:
    """gzip the panel's HTML/JS/CSS and JSON, but never file downloads or uploads:
    backups and dumps are already compressed, can be many GB, and must keep streaming."""

    _SKIP_SUFFIX = ("/dump", "/export", "/upload")

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=6)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope["path"]
            download = path.endswith(self._SKIP_SUFFIX) or (
                path.startswith("/api/backup/files/") and not path.endswith("/inspect")
            )
            if not download:
                return await self.gzip(scope, receive, send)
        return await self.app(scope, receive, send)


app.add_middleware(SelectiveGZip)


@app.middleware("http")
async def redis_metrics(request: Request, call_next):
    """Counts every Central Redis API call (/redis/{project}/{operation}/…) into
    hourly per-project metrics, and stamps the key's last use."""
    path = request.url.path
    if not path.startswith("/redis/"):
        return await call_next(request)
    parts = path.split("/")
    if len(parts) < 4 or not parts[2] or not parts[3]:
        return await call_next(request)
    project_id, operation = parts[2], parts[3]
    started = time.perf_counter()
    response = await call_next(request)
    if getattr(request.state, "redis_project", None) == project_id:  # only authenticated calls
        await redis_core.record(
            project_id, operation=operation, method=request.method, path=path[len("/redis/") + len(project_id):],
            status=response.status_code, duration_ms=(time.perf_counter() - started) * 1000,
            error=getattr(request.state, "redis_error", None))
        key_id = getattr(request.state, "redis_key_id", None)
        if key_id and response.status_code < 500:
            await redis_control.touch_key(key_id)
    return response

app.include_router(auth.router)
app.include_router(server.router)
app.include_router(tables.router)
app.include_router(rows.router)
app.include_router(rows.dump_router)
app.include_router(sql.router)
app.include_router(keys.router)
app.include_router(data_api.router)
app.include_router(backup_routes.router)
app.include_router(redis_admin.router)
app.include_router(redis_api.router)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    try:
        pool = await pools.get()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "database": "up"}
    except Exception as e:
        return JSONResponse({"status": "degraded", "database": str(e)}, status_code=503)


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
@app.api_route("/v1/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
@app.api_route("/redis/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
async def api_404(rest: str):
    raise HTTPException(404, "Not found")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _asset_version() -> str:
    h = hashlib.sha256()
    for f in sorted(STATIC.rglob("*")):
        if f.is_file() and f.name != "index.html":
            h.update(f.name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:12]


_INDEX = (STATIC / "index.html").read_text().replace("__V__", _asset_version())


@app.get("/{path:path}", include_in_schema=False)
async def panel(path: str):
    return HTMLResponse(_INDEX, headers={"Cache-Control": "no-cache"})
