"""central-postgres: a small server + admin panel for a Render Postgres instance."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth
from .config import settings
from .db import pools
from .routers import rows, server, sql, tables

log = logging.getLogger("central-postgres")
STATIC = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        pool = await pools.get()
        async with pool.acquire() as conn:
            v = await conn.fetchval("SHOW server_version")
        log.warning("Connected to Postgres %s (database %s)", v, settings.default_database)
    except Exception as e:  # keep the panel up so the error is visible there
        log.error("Could not connect to Postgres at startup: %s", e)
    yield
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


@app.exception_handler(OSError)
async def conn_error(request: Request, exc: OSError):
    return JSONResponse({"detail": f"Cannot reach the database: {exc}"}, status_code=502)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
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


app.include_router(auth.router)
app.include_router(server.router)
app.include_router(tables.router)
app.include_router(rows.router)
app.include_router(rows.dump_router)
app.include_router(sql.router)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    try:
        pool = await pools.get()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "database": "up"}
    except Exception as e:
        return JSONResponse({"status": "degraded", "database": str(e)}, status_code=503)


@app.get("/api/{rest:path}", include_in_schema=False)
async def api_404(rest: str):
    raise HTTPException(404, "Not found")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}", include_in_schema=False)
async def panel(path: str):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
