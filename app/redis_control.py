"""Central Redis control plane, stored in Postgres.

Projects and their `sk_live_` API keys used to live in MongoDB. They now live in
META_DATABASE (default `postgres`), schema `central_postgres`, next to the
Postgres app keys, so full-server backups include them automatically.

Only a SHA-256 digest of each key is stored — the same digest the old service
stored, which is why keys imported from MongoDB keep working unchanged.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone

import asyncpg
from fastapi import HTTPException

from .config import settings
from .db import pools

log = logging.getLogger("central-postgres.redis")

API_KEY_PREFIX = "sk_live_"
MAX_KEYS_PER_PROJECT = 10
PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,38}[a-z0-9]$")

DDL = """
CREATE SCHEMA IF NOT EXISTS central_postgres;
CREATE TABLE IF NOT EXISTS central_postgres.redis_projects (
    id                text PRIMARY KEY,
    name              text NOT NULL,
    description       text NOT NULL DEFAULT '',
    default_ttl       integer NOT NULL DEFAULT 0,
    apply_default_ttl boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    imported_from     text
);
CREATE TABLE IF NOT EXISTS central_postgres.redis_api_keys (
    id           text PRIMARY KEY,
    project_id   text NOT NULL REFERENCES central_postgres.redis_projects(id) ON DELETE CASCADE,
    name         text NOT NULL,
    key_hash     text NOT NULL UNIQUE,
    masked       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    rotated_at   timestamptz,
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS redis_api_keys_project_idx ON central_postgres.redis_api_keys (project_id);
REVOKE ALL ON SCHEMA central_postgres FROM PUBLIC;
"""

_ready = False
_ready_lock = asyncio.Lock()


async def pool() -> asyncpg.Pool:
    global _ready
    p = await pools.get(settings.meta_database)
    if not _ready:
        async with _ready_lock:
            if not _ready:
                async with p.acquire() as conn:
                    await conn.execute(DDL)
                _ready = True
    return p


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(v):
    return v.isoformat() if v else None


# --------------------------------------------------------------------------- keys
def generate_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def mask_key(key: str) -> str:
    body = key[len(API_KEY_PREFIX):] if key.startswith(API_KEY_PREFIX) else key
    if len(body) <= 8:
        return API_KEY_PREFIX + "•" * len(body)
    return f"{API_KEY_PREFIX}{body[:4]}{'•' * 12}{body[-4:]}"


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(12)}"


def normalise_project_id(raw: str) -> str:
    return re.sub(r"[^a-z0-9_]", "", raw.strip().lower().replace(" ", "_").replace("-", "_"))


def validate_project_id(pid: str) -> None:
    if not PROJECT_ID_RE.match(pid):
        raise HTTPException(400, "Project ID must be 3-40 characters: lowercase letters, numbers and underscores, "
                                 "starting with a letter and ending with a letter or number.")
    if pid.startswith("_"):
        raise HTTPException(400, "Project IDs can't start with an underscore.")


# --------------------------------------------------------------------------- projects
def public_project(r) -> dict:
    return {
        "id": r["id"],
        "name": r["name"],
        "description": r["description"],
        "default_ttl": r["default_ttl"],
        "apply_default_ttl": r["apply_default_ttl"],
        "created_at": iso(r["created_at"]),
        "imported_from": r["imported_from"],
    }


def public_key(r) -> dict:
    return {
        "id": r["id"],
        "project_id": r["project_id"],
        "name": r["name"],
        "masked": r["masked"],
        "created_at": iso(r["created_at"]),
        "rotated_at": iso(r["rotated_at"]),
        "last_used_at": iso(r["last_used_at"]),
        "revoked": bool(r["revoked_at"]),
    }


async def list_projects() -> list[dict]:
    p = await pool()
    rows = await p.fetch("""
        SELECT p.*, count(k.id) FILTER (WHERE k.revoked_at IS NULL) AS key_count,
               max(k.last_used_at) AS last_used_at
        FROM central_postgres.redis_projects p
        LEFT JOIN central_postgres.redis_api_keys k ON k.project_id = p.id
        GROUP BY p.id ORDER BY p.created_at""")
    return [dict(public_project(r), key_count=r["key_count"], last_used_at=iso(r["last_used_at"])) for r in rows]


async def get_project(project_id: str) -> dict:
    p = await pool()
    r = await p.fetchrow("SELECT * FROM central_postgres.redis_projects WHERE id = $1", project_id)
    if r is None:
        raise HTTPException(404, f"Project '{project_id}' not found")
    return public_project(r)


async def project_exists(project_id: str) -> bool:
    p = await pool()
    return bool(await p.fetchval("SELECT 1 FROM central_postgres.redis_projects WHERE id = $1", project_id))


async def create_project(project_id: str, name: str, description: str) -> tuple[dict, str, dict]:
    pid = normalise_project_id(project_id)
    validate_project_id(pid)
    p = await pool()
    key = generate_key()
    async with p.acquire() as conn, conn.transaction():
        try:
            row = await conn.fetchrow(
                "INSERT INTO central_postgres.redis_projects (id, name, description) VALUES ($1, $2, $3) RETURNING *",
                pid, (name or "").strip()[:120] or pid, (description or "").strip()[:500])
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, f"Project ID '{pid}' is already taken.")
        krow = await conn.fetchrow(
            "INSERT INTO central_postgres.redis_api_keys (id, project_id, name, key_hash, masked) VALUES ($1,$2,$3,$4,$5) RETURNING *",
            new_id("key"), pid, "Default", hash_key(key), mask_key(key))
    return public_project(row), key, public_key(krow)


async def update_project(project_id: str, fields: dict) -> dict:
    allowed = {k: v for k, v in fields.items() if k in {"name", "description", "default_ttl", "apply_default_ttl"} and v is not None}
    if not allowed:
        return await get_project(project_id)
    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(allowed))
    p = await pool()
    row = await p.fetchrow(f"UPDATE central_postgres.redis_projects SET {sets} WHERE id = $1 RETURNING *", project_id, *allowed.values())
    if row is None:
        raise HTTPException(404, f"Project '{project_id}' not found")
    return public_project(row)


async def delete_project(project_id: str) -> None:
    p = await pool()
    hashes = await p.fetch("SELECT key_hash FROM central_postgres.redis_api_keys WHERE project_id = $1", project_id)
    for h in hashes:
        key_cache.evict(h["key_hash"])
    await p.execute("DELETE FROM central_postgres.redis_projects WHERE id = $1", project_id)


# --------------------------------------------------------------------------- api keys
async def list_keys(project_id: str) -> list[dict]:
    p = await pool()
    rows = await p.fetch("SELECT * FROM central_postgres.redis_api_keys WHERE project_id = $1 ORDER BY created_at", project_id)
    return [public_key(r) for r in rows]


async def create_key(project_id: str, name: str) -> tuple[str, dict]:
    p = await pool()
    n = await p.fetchval("SELECT count(*) FROM central_postgres.redis_api_keys WHERE project_id = $1 AND revoked_at IS NULL", project_id)
    if n >= MAX_KEYS_PER_PROJECT:
        raise HTTPException(403, f"A project can have at most {MAX_KEYS_PER_PROJECT} API keys.")
    key = generate_key()
    row = await p.fetchrow(
        "INSERT INTO central_postgres.redis_api_keys (id, project_id, name, key_hash, masked) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        new_id("key"), project_id, (name or "").strip()[:60] or "Untitled key", hash_key(key), mask_key(key))
    return key, public_key(row)


async def rotate_key(project_id: str, key_id: str) -> tuple[str, dict]:
    p = await pool()
    old = await p.fetchrow("SELECT key_hash FROM central_postgres.redis_api_keys WHERE id = $1 AND project_id = $2", key_id, project_id)
    if old is None:
        raise HTTPException(404, "API key not found")
    key_cache.evict(old["key_hash"])
    key = generate_key()
    row = await p.fetchrow("""
        UPDATE central_postgres.redis_api_keys
        SET key_hash = $3, masked = $4, rotated_at = now(), last_used_at = NULL, revoked_at = NULL
        WHERE id = $1 AND project_id = $2 RETURNING *""", key_id, project_id, hash_key(key), mask_key(key))
    return key, public_key(row)


async def delete_key(project_id: str, key_id: str) -> None:
    p = await pool()
    row = await p.fetchrow("SELECT key_hash FROM central_postgres.redis_api_keys WHERE id = $1 AND project_id = $2", key_id, project_id)
    if row is None:
        raise HTTPException(404, "API key not found")
    key_cache.evict(row["key_hash"])
    await p.execute("DELETE FROM central_postgres.redis_api_keys WHERE id = $1", key_id)


# --------------------------------------------------------------------------- tenant auth
class _KeyCache:
    """30 s cache of digest -> (key_id, project_id). Keeps the database off the hot
    path; revocation and rotation evict entries immediately."""

    def __init__(self, ttl: float = 30.0, max_entries: int = 5000):
        self.ttl, self.max = ttl, max_entries
        self.entries: dict[str, tuple[float, tuple[str, str] | None]] = {}

    def get(self, h: str):
        hit = self.entries.get(h)
        if not hit:
            return False, None
        if hit[0] < time.monotonic():
            self.entries.pop(h, None)
            return False, None
        return True, hit[1]

    def put(self, h: str, value) -> None:
        if len(self.entries) >= self.max:
            self.entries.clear()
        self.entries[h] = (time.monotonic() + self.ttl, value)

    def evict(self, h: str) -> None:
        self.entries.pop(h, None)


key_cache = _KeyCache()
_last_used_written: dict[str, float] = {}


async def authorise(project_id: str, raw_key: str | None) -> str | None:
    """Return the key id when `raw_key` may use `project_id` (None for a legacy
    PROJECT_<ID> env key). Raises 401/404 otherwise."""
    if not raw_key:
        raise HTTPException(401, "Missing x-api-key header")
    h = hash_key(raw_key)
    cached, rec = key_cache.get(h)
    if not cached:
        p = await pool()
        row = await p.fetchrow("SELECT id, project_id FROM central_postgres.redis_api_keys WHERE key_hash = $1 AND revoked_at IS NULL", h)
        rec = (row["id"], row["project_id"]) if row else None
        key_cache.put(h, rec)
    if rec and rec[1] == project_id:
        return rec[0]
    legacy = os.environ.get(f"PROJECT_{project_id.upper()}")
    if legacy and hmac.compare_digest(raw_key.encode(), legacy.encode()):
        return None
    if not legacy and not await project_exists(project_id):
        raise HTTPException(404, f"Project '{project_id}' not found")
    raise HTTPException(401, "Invalid API key")


async def touch_key(key_id: str) -> None:
    """last_used_at, written at most once a minute per key."""
    now = time.monotonic()
    if now - _last_used_written.get(key_id, 0.0) < 60:
        return
    _last_used_written[key_id] = now
    try:
        p = await pool()
        await p.execute("UPDATE central_postgres.redis_api_keys SET last_used_at = now() WHERE id = $1", key_id)
    except Exception:  # noqa: BLE001 - never fail a request over bookkeeping
        pass


# --------------------------------------------------------------------------- MongoDB import
def _read_mongo(uri: str, db_name: str) -> tuple[list[dict], list[dict]]:
    try:
        from pymongo import MongoClient
    except ImportError:
        raise HTTPException(500, "pymongo is not installed in this image.")
    cli = MongoClient(uri, serverSelectionTimeoutMS=10000)
    try:
        db = cli[db_name]
        projects = list(db["projects"].find({}, {"_id": 0}))
        keys = list(db["api_keys"].find({}, {"_id": 0}))
    finally:
        cli.close()
    return projects, keys


def _aware(v):
    if isinstance(v, datetime) and v.tzinfo is None:
        return v.replace(tzinfo=timezone.utc)
    return v if isinstance(v, datetime) else None


async def import_from_mongo(uri: str, db_name: str) -> dict:
    """Copy projects and API key digests from the old MongoDB control plane.
    Existing rows are left alone, so running it twice is harmless."""
    try:
        projects, keys = await asyncio.to_thread(_read_mongo, uri, db_name)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Could not read MongoDB: {e}")

    p = await pool()
    added_p = added_k = skipped = 0
    async with p.acquire() as conn, conn.transaction():
        for doc in projects:
            # current schema: {id, name, …}; pre-accounts schema: {project_id, api_key}
            pid = str(doc.get("id") or doc.get("project_id") or "").strip().lower()
            if not pid:
                skipped += 1
                continue
            st = doc.get("settings") or {}
            res = await conn.execute("""
                INSERT INTO central_postgres.redis_projects (id, name, description, default_ttl, apply_default_ttl, created_at, imported_from)
                VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), 'mongodb') ON CONFLICT (id) DO NOTHING""",
                pid, str(doc.get("name") or pid)[:120], str(doc.get("description") or "")[:500],
                int(st.get("default_ttl") or 0), bool(st.get("apply_default_ttl")), _aware(doc.get("created_at")))
            added_p += res.endswith("1")
            legacy_key = str(doc.get("api_key") or "").strip()
            if legacy_key and not doc.get("id"):
                keys.append({"id": new_id("key"), "project_id": pid, "name": "Legacy key",
                             "key_hash": hash_key(legacy_key), "masked": mask_key(legacy_key)})
        for k in keys:
            if not k.get("key_hash") or not k.get("project_id"):
                skipped += 1
                continue
            exists = await conn.fetchval("SELECT 1 FROM central_postgres.redis_projects WHERE id = $1", k["project_id"])
            if not exists:
                skipped += 1
                continue
            res = await conn.execute("""
                INSERT INTO central_postgres.redis_api_keys (id, project_id, name, key_hash, masked, created_at, rotated_at, last_used_at, revoked_at)
                VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8, $9) ON CONFLICT DO NOTHING""",
                str(k.get("id") or new_id("key")), k["project_id"], str(k.get("name") or "Imported key")[:60],
                k["key_hash"], str(k.get("masked") or "sk_live_••••"), _aware(k.get("created_at")),
                _aware(k.get("rotated_at")), _aware(k.get("last_used_at")), _aware(k.get("revoked_at")))
            added_k += res.endswith("1")
    key_cache.entries.clear()
    log.warning("Imported %s Redis project(s) and %s key(s) from MongoDB", added_p, added_k)
    return {"projects_found": len(projects), "projects_added": added_p, "keys_added": added_k, "skipped": skipped}
