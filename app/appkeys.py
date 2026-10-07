"""App keys: scoped API keys for external applications.

Each key is bound to ONE database and an access level (read / write / full).
Behind every key is a dedicated, unprivileged Postgres login role
(`cpk_<id>`). Queries sent with the key run *as that role*, so Postgres itself
enforces what the key can see and change — a key can't reach other databases,
can't escalate, and can't undo its restrictions with `SET ROLE` tricks.

The role's password is never stored or shown: it is derived from SECRET_KEY
with HMAC, and re-applied automatically if SECRET_KEY ever changes.

Key metadata lives in META_DATABASE (default `postgres`), schema
`central_postgres`, table `api_keys`. Only a SHA-256 hash of each key is kept.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import logging
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from urllib.parse import quote, urlparse, urlunparse

import asyncpg
from fastapi import HTTPException

from .config import settings
from .db import _ssl_mode, pools
from .sqlutil import ident, literal

log = logging.getLogger("central-postgres.appkeys")

KEY_PREFIX = "cpk_"
ACCESS_LEVELS = ("read", "write", "full")

_TABLE_PRIVS = {"read": "SELECT", "write": "SELECT, INSERT, UPDATE, DELETE", "full": "ALL PRIVILEGES"}
_SEQ_PRIVS = {"read": "SELECT", "write": "USAGE, SELECT", "full": "ALL PRIVILEGES"}

META_DDL = """
CREATE SCHEMA IF NOT EXISTS central_postgres;
CREATE TABLE IF NOT EXISTS central_postgres.api_keys (
    id                 text PRIMARY KEY,
    name               text NOT NULL,
    secret_hash        text NOT NULL,
    database           text NOT NULL,
    role_name          text NOT NULL,
    access             text NOT NULL CHECK (access IN ('read', 'write', 'full')),
    schemas            text[] NOT NULL DEFAULT '{public}',
    allowed_ips        text[] NOT NULL DEFAULT '{}',
    rate_limit_per_min integer NOT NULL DEFAULT 600,
    max_rows           integer NOT NULL DEFAULT 10000,
    expires_at         timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz,
    last_used_ip       text,
    use_count          bigint NOT NULL DEFAULT 0,
    revoked_at         timestamptz
);
REVOKE ALL ON SCHEMA central_postgres FROM PUBLIC;
"""


@dataclass
class AppKey:
    id: str
    name: str
    secret_hash: str
    database: str
    role_name: str
    access: str
    schemas: list[str]
    allowed_ips: list[str]
    rate_limit_per_min: int
    max_rows: int
    expires_at: object
    revoked_at: object

    @classmethod
    def from_record(cls, r) -> "AppKey":
        return cls(**{k: r[k] for k in cls.__dataclass_fields__})


# --------------------------------------------------------------------------- helpers
def hash_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode()).hexdigest()


def role_password(role: str) -> str:
    digest = hmac.new(settings.secret_key.encode(), f"app-key-role:{role}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def parse_key(raw: str) -> tuple[str, str] | None:
    """cpk_<id>_<secret> -> (id, full_key)"""
    if not raw or not raw.startswith(KEY_PREFIX):
        return None
    rest = raw[len(KEY_PREFIX):]
    key_id, sep, secret = rest.partition("_")
    if not sep or not key_id or not secret or len(key_id) > 32:
        return None
    return key_id, raw


def normalise_ips(items: list[str]) -> list[str]:
    out = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        try:
            out.append(str(ipaddress.ip_network(item, strict=False)))
        except ValueError:
            raise HTTPException(400, f"Not an IP address or CIDR range: {item!r}")
    return out


def ip_allowed(ip: str | None, allowed: list[str]) -> bool:
    if not allowed:
        return True
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in ipaddress.ip_network(n, strict=False) for n in allowed)


# --------------------------------------------------------------------------- metadata store
_meta_ready = False
_meta_lock = asyncio.Lock()


async def meta_pool() -> asyncpg.Pool:
    global _meta_ready
    pool = await pools.get(settings.meta_database)
    if not _meta_ready:
        async with _meta_lock:
            if not _meta_ready:
                async with pool.acquire() as conn:
                    await conn.execute(META_DDL)
                _meta_ready = True
    return pool


# small cache so each API request doesn't hit the metadata table
_cache: dict[str, tuple[float, AppKey | None]] = {}
_CACHE_TTL = 30.0


def forget(key_id: str) -> None:
    _cache.pop(key_id, None)


async def lookup(key_id: str) -> AppKey | None:
    hit = _cache.get(key_id)
    now = time.monotonic()
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    pool = await meta_pool()
    async with pool.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM central_postgres.api_keys WHERE id = $1", key_id)
    key = AppKey.from_record(r) if r else None
    _cache[key_id] = (now, key)
    return key


_last_touch: dict[str, float] = {}
_pending_uses: dict[str, int] = defaultdict(int)


async def touch(key_id: str, ip: str | None) -> None:
    """Count every call, but write to the metadata table at most every 15 s per key."""
    _pending_uses[key_id] += 1
    now = time.monotonic()
    if now - _last_touch.get(key_id, 0) < 15:
        return
    _last_touch[key_id] = now
    n = _pending_uses.pop(key_id, 0)
    try:
        pool = await meta_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE central_postgres.api_keys SET last_used_at = now(), last_used_ip = $2, "
                "use_count = use_count + $3 WHERE id = $1",
                key_id, ip, n,
            )
    except Exception as e:  # never fail a request because of bookkeeping
        _pending_uses[key_id] += n
        log.warning("Could not record key usage: %s", e)


async def flush_usage() -> None:
    """Write any counted-but-unsaved calls (on shutdown)."""
    if not _pending_uses:
        return
    try:
        pool = await meta_pool()
        async with pool.acquire() as conn:
            for key_id, n in list(_pending_uses.items()):
                await conn.execute(
                    "UPDATE central_postgres.api_keys SET use_count = use_count + $2 WHERE id = $1", key_id, n
                )
        _pending_uses.clear()
    except Exception as e:
        log.warning("Could not flush key usage: %s", e)


def client_ip(request) -> str | None:
    """Real client IP. nginx sets X-Real-IP to $remote_addr, which clients can't forge."""
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else None


# --------------------------------------------------------------------------- rate limiting
_hits: dict[str, deque] = defaultdict(deque)


def check_rate(key: AppKey) -> None:
    if key.rate_limit_per_min <= 0:
        return
    now = time.monotonic()
    q = _hits[key.id]
    while q and q[0] <= now - 60:
        q.popleft()
    if len(q) >= key.rate_limit_per_min:
        retry = max(1, int(60 - (now - q[0])) + 1)
        raise HTTPException(429, f"Rate limit of {key.rate_limit_per_min} requests/minute reached",
                            headers={"Retry-After": str(retry)})
    q.append(now)


# --------------------------------------------------------------------------- per-key pools
_key_pools: dict[str, asyncpg.Pool] = {}
_key_pool_lock = asyncio.Lock()


def _dsn(role: str, database: str) -> str:
    u = urlparse(settings.database_url)
    host = u.hostname or "localhost"
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{quote(role, safe='')}:{quote(role_password(role), safe='')}@{host}"
    if u.port:
        netloc += f":{u.port}"
    return urlunparse(u._replace(netloc=netloc, path="/" + quote(database, safe="")))


async def _create_key_pool(key: AppKey) -> asyncpg.Pool:
    kwargs = dict(
        dsn=_dsn(key.role_name, key.database),
        min_size=0,
        max_size=settings.app_key_pool_max,
        max_inactive_connection_lifetime=60,
        command_timeout=max(settings.statement_timeout_ms / 1000 + 5, 10),
        server_settings={
            "application_name": f"central-postgres:{key.name}"[:63],
            "statement_timeout": str(settings.statement_timeout_ms),
        },
    )
    ssl = _ssl_mode(settings.database_url)
    if ssl is not None:
        kwargs["ssl"] = ssl
    pool = await asyncpg.create_pool(**kwargs)
    async with pool.acquire():  # fail fast on bad credentials
        pass
    return pool


async def key_pool(key: AppKey) -> asyncpg.Pool:
    pool = _key_pools.get(key.id)
    if pool is not None and not pool.is_closing():
        return pool
    async with _key_pool_lock:
        pool = _key_pools.get(key.id)
        if pool is not None and not pool.is_closing():
            return pool
        try:
            pool = await _create_key_pool(key)
        except asyncpg.InvalidPasswordError:
            # SECRET_KEY changed (or the role was edited): re-apply the derived password.
            admin = await pools.get(settings.meta_database)
            async with admin.acquire() as conn:
                await conn.execute(
                    f"ALTER ROLE {ident(key.role_name)} LOGIN PASSWORD {literal(role_password(key.role_name))}"
                )
            pool = await _create_key_pool(key)
        _key_pools[key.id] = pool
        return pool


async def close_key_pool(key_id: str) -> None:
    pool = _key_pools.pop(key_id, None)
    if pool is not None:
        try:
            await asyncio.wait_for(pool.close(), timeout=5)
        except Exception:
            pool.terminate()


async def close_all_key_pools() -> None:
    for k in list(_key_pools):
        await close_key_pool(k)


# --------------------------------------------------------------------------- grants
async def apply_grants(key_role: str, database: str, access: str, schemas: list[str],
                       extra_creators: list[str] | None = None) -> list[str]:
    """(Re)grant the key role its access on every schema. Returns warnings."""
    warnings: list[str] = []
    r = ident(key_role)
    pool = await pools.get(database)
    async with pool.acquire() as conn:
        await conn.execute(f"GRANT CONNECT, TEMPORARY ON DATABASE {ident(database)} TO {r}")
        for schema in schemas:
            exists = await conn.fetchval("SELECT 1 FROM pg_namespace WHERE nspname = $1", schema)
            if not exists:
                raise HTTPException(400, f"Schema '{schema}' does not exist in database '{database}'")
            s = ident(schema)
            stmts = [
                f"GRANT USAGE{', CREATE' if access == 'full' else ''} ON SCHEMA {s} TO {r}",
                f"GRANT {_TABLE_PRIVS[access]} ON ALL TABLES IN SCHEMA {s} TO {r}",
                f"GRANT {_SEQ_PRIVS[access]} ON ALL SEQUENCES IN SCHEMA {s} TO {r}",
            ]
            if access == "full":
                stmts.append(f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {s} TO {r}")
            for st in stmts:
                try:
                    await conn.execute(st)
                except asyncpg.PostgresError as e:
                    warnings.append(f"{st}: {e}")

            # Make tables created LATER (by the app's own user, the db owner, or the admin)
            # visible too: default privileges are per creating role.
            creators = await conn.fetch(
                """
                SELECT DISTINCT rolname FROM (
                    SELECT pg_get_userbyid(c.relowner) AS rolname
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S')
                    UNION SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1
                    UNION SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()
                    UNION SELECT current_user
                    UNION SELECT unnest($3::text[])
                ) x
                WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> $2
                  AND EXISTS (SELECT 1 FROM pg_roles WHERE pg_roles.rolname = x.rolname)
                """,
                schema, key_role, extra_creators or [],
            )
            for row in creators:
                c = ident(row["rolname"])
                for st in (
                    f"ALTER DEFAULT PRIVILEGES FOR ROLE {c} IN SCHEMA {s} GRANT {_TABLE_PRIVS[access]} ON TABLES TO {r}",
                    f"ALTER DEFAULT PRIVILEGES FOR ROLE {c} IN SCHEMA {s} GRANT {_SEQ_PRIVS[access]} ON SEQUENCES TO {r}",
                ):
                    try:
                        await conn.execute(st)
                    except asyncpg.PostgresError as e:
                        warnings.append(f"default privileges for {row['rolname']} in {schema}: {e.__class__.__name__}")
    return warnings


async def drop_key_role(key: AppKey) -> list[str]:
    """Hand anything the role created to the database owner, then drop it."""
    warnings: list[str] = []
    await close_key_pool(key.id)
    admin = await pools.get(settings.meta_database)
    async with admin.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", key.role_name)
        db_owner = await conn.fetchval("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1", key.database)
    if not exists:
        return warnings
    if db_owner:
        # Terminate leftover sessions of this role, then clean up inside its database.
        try:
            async with admin.acquire() as conn:
                await conn.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", key.role_name
                )
        except asyncpg.PostgresError:
            pass
        try:
            pool = await pools.get(key.database)
            async with pool.acquire() as conn:
                await conn.execute(f"REASSIGN OWNED BY {ident(key.role_name)} TO {ident(db_owner)}")
                await conn.execute(f"DROP OWNED BY {ident(key.role_name)}")
        except asyncpg.PostgresError as e:
            warnings.append(f"cleanup in {key.database}: {e}")
    try:
        async with admin.acquire() as conn:
            await conn.execute(f"DROP ROLE {ident(key.role_name)}")
    except asyncpg.PostgresError as e:
        warnings.append(f"role {key.role_name} kept: {e}")
    return warnings


def new_key() -> tuple[str, str]:
    key_id = secrets.token_hex(5)
    return key_id, f"{KEY_PREFIX}{key_id}_{secrets.token_urlsafe(32)}"


async def active_keys_for(database: str) -> list[AppKey]:
    pool = await meta_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM central_postgres.api_keys WHERE database = $1 AND revoked_at IS NULL", database
        )
    return [AppKey.from_record(r) for r in rows]


async def sync_database(database: str) -> list[str]:
    """Re-grant every active key on a database. Tables made by a *full* key are
    then visible to the database's other keys too."""
    keys = await active_keys_for(database)
    full_roles = [k.role_name for k in keys if k.access == "full"]
    warnings: list[str] = []
    for k in keys:
        warnings += [f"{k.name}: {w}" for w in await apply_grants(
            k.role_name, k.database, k.access, k.schemas, [r for r in full_roles if r != k.role_name])]
    return warnings
