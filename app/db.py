"""One small asyncpg pool per database, created lazily.

Postgres connections are bound to a single database, so browsing several
databases means one pool each. Pools are kept small (POOL_MAX, default 5)
because Render plans have a hard connection limit.
"""
from __future__ import annotations

import asyncio
from urllib.parse import quote, urlparse, urlunparse, parse_qs

import asyncpg

from .config import settings


def _ssl_mode(url: str):
    mode = settings.db_ssl
    if mode in {"disable", "false", "off", "0"}:
        return False
    if mode in {"require", "prefer", "allow", "verify-ca", "verify-full"}:
        return mode
    # auto
    parsed = urlparse(url)
    if "sslmode" in parse_qs(parsed.query):
        return None  # let asyncpg read sslmode from the URL
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "::1"} or host.startswith("/"):
        return False
    if "." not in host:
        # Render *internal* hostnames look like dpg-xxxxxxxx-a (no dots)
        return "prefer"
    return "require"


def dsn_for(database: str) -> str:
    parsed = urlparse(settings.database_url)
    return urlunparse(parsed._replace(path="/" + quote(database, safe="")))


class PoolManager:
    def __init__(self) -> None:
        self._pools: dict[str, asyncpg.Pool] = {}
        self._lock = asyncio.Lock()

    async def get(self, database: str | None = None) -> asyncpg.Pool:
        database = database or settings.default_database
        pool = self._pools.get(database)
        if pool is not None and not pool.is_closing():
            return pool
        async with self._lock:
            pool = self._pools.get(database)
            if pool is not None and not pool.is_closing():
                return pool
            kwargs = dict(
                dsn=dsn_for(database),
                min_size=settings.pool_min,
                max_size=settings.pool_max,
                max_inactive_connection_lifetime=120,
                command_timeout=max(settings.statement_timeout_ms / 1000 + 5, 10),
                server_settings={
                    "application_name": "central-postgres",
                    "statement_timeout": str(settings.statement_timeout_ms),
                },
            )
            ssl = _ssl_mode(settings.database_url)
            if ssl is not None:
                kwargs["ssl"] = ssl
            pool = await asyncpg.create_pool(**kwargs)
            self._pools[database] = pool
            return pool

    async def close(self, database: str) -> None:
        async with self._lock:
            pool = self._pools.pop(database, None)
        if pool is not None:
            try:
                await asyncio.wait_for(pool.close(), timeout=5)
            except Exception:
                pool.terminate()

    async def close_all(self) -> None:
        for name in list(self._pools):
            await self.close(name)

    def open_databases(self) -> list[str]:
        return sorted(self._pools)


pools = PoolManager()
