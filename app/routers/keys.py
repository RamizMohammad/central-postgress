"""Admin endpoints for app keys (create / list / re-sync / revoke)."""
from __future__ import annotations

import datetime as dt
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import appkeys
from ..auth import require_auth
from ..config import settings
from ..db import pools
from ..sqlutil import ident, literal, to_json_value

router = APIRouter(prefix="/api/keys", tags=["app keys"], dependencies=[Depends(require_auth)])

_PUBLIC_COLS = """id, name, database, role_name, access, schemas, allowed_ips, rate_limit_per_min,
                  max_rows, expires_at, created_at, last_used_at, last_used_ip, use_count, revoked_at"""


def _row(r) -> dict:
    d = {k: to_json_value(v) for k, v in dict(r).items()}
    d["prefix"] = f"{appkeys.KEY_PREFIX}{r['id']}_…"
    now = dt.datetime.now(dt.timezone.utc)
    if r["revoked_at"]:
        d["status"] = "revoked"
    elif r["expires_at"] and r["expires_at"] < now:
        d["status"] = "expired"
    else:
        d["status"] = "active"
    return d


@router.get("")
async def list_keys(include_revoked: bool = False):
    pool = await appkeys.meta_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_PUBLIC_COLS} FROM central_postgres.api_keys "
            "WHERE $1 OR revoked_at IS NULL ORDER BY created_at DESC",
            include_revoked,
        )
    return [_row(r) for r in rows]


class CreateKey(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    database: str
    access: Literal["read", "write", "full"] = "read"
    schemas: list[str] = ["public"]
    allowed_ips: list[str] = []
    expires_in_days: int | None = Field(None, ge=1, le=3650)
    rate_limit_per_min: int = Field(600, ge=0, le=100_000)
    max_rows: int = Field(10_000, ge=1, le=100_000)


@router.post("", status_code=201)
async def create_key(body: CreateKey):
    schemas = [s.strip() for s in body.schemas if s.strip()] or ["public"]
    ips = appkeys.normalise_ips(body.allowed_ips)
    if body.database in {"template0", "template1"}:
        raise HTTPException(400, "Pick a real database")

    admin = await pools.get(settings.meta_database)
    async with admin.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", body.database):
            raise HTTPException(404, f"Database '{body.database}' not found")

    key_id, full_key = appkeys.new_key()
    role = f"cpk_{key_id}"
    async with admin.acquire() as conn:
        await conn.execute(
            f"CREATE ROLE {ident(role)} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE "
            f"CONNECTION LIMIT {settings.app_key_pool_max + 2} "
            f"PASSWORD {literal(appkeys.role_password(role))}"
        )
        await conn.execute(f"COMMENT ON ROLE {ident(role)} IS {literal('central-postgres app key: ' + body.name)}")
    try:
        others = await appkeys.active_keys_for(body.database)
        warnings = await appkeys.apply_grants(
            role, body.database, body.access, schemas, [k.role_name for k in others if k.access == "full"])
        expires = (
            dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=body.expires_in_days)
            if body.expires_in_days else None
        )
        meta = await appkeys.meta_pool()
        async with meta.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                INSERT INTO central_postgres.api_keys
                    (id, name, secret_hash, database, role_name, access, schemas, allowed_ips,
                     rate_limit_per_min, max_rows, expires_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING {_PUBLIC_COLS}
                """,
                key_id, body.name, appkeys.hash_key(full_key), body.database, role, body.access,
                schemas, ips, body.rate_limit_per_min, body.max_rows, expires,
            )
    except Exception:
        # don't leave an orphan role behind
        try:
            await appkeys.drop_key_role(appkeys.AppKey(
                id=key_id, name=body.name, secret_hash="", database=body.database, role_name=role,
                access=body.access, schemas=schemas, allowed_ips=ips, rate_limit_per_min=0,
                max_rows=0, expires_at=None, revoked_at=None))
        except Exception:
            pass
        raise

    if body.access == "full" and others:
        # let the database's existing keys see tables this new key will create
        warnings += await appkeys.sync_database(body.database)

    out = _row(row)
    out["key"] = full_key  # shown once, never stored
    out["warnings"] = warnings
    return out


class UpdateKey(BaseModel):
    name: str | None = None
    allowed_ips: list[str] | None = None
    rate_limit_per_min: int | None = Field(None, ge=0, le=100_000)
    max_rows: int | None = Field(None, ge=1, le=100_000)
    expires_in_days: int | None = Field(None, ge=0, le=3650, description="0 = never expires")


@router.patch("/{key_id}")
async def update_key(key_id: str, body: UpdateKey):
    sets, args = [], [key_id]
    if body.name:
        args.append(body.name); sets.append(f"name = ${len(args)}")
    if body.allowed_ips is not None:
        args.append(appkeys.normalise_ips(body.allowed_ips)); sets.append(f"allowed_ips = ${len(args)}")
    if body.rate_limit_per_min is not None:
        args.append(body.rate_limit_per_min); sets.append(f"rate_limit_per_min = ${len(args)}")
    if body.max_rows is not None:
        args.append(body.max_rows); sets.append(f"max_rows = ${len(args)}")
    if body.expires_in_days is not None:
        args.append(None if body.expires_in_days == 0 else
                    dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=body.expires_in_days))
        sets.append(f"expires_at = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Nothing to change")
    pool = await appkeys.meta_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"UPDATE central_postgres.api_keys SET {', '.join(sets)} WHERE id = $1 RETURNING {_PUBLIC_COLS}", *args
        )
    if not row:
        raise HTTPException(404, "Key not found")
    appkeys.forget(key_id)
    return _row(row)


@router.post("/{key_id}/sync")
async def sync_key(key_id: str):
    """Re-apply grants (e.g. after you added tables owned by another role, or new schemas)."""
    key = await appkeys.lookup(key_id)
    appkeys.forget(key_id)
    if not key or key.revoked_at:
        raise HTTPException(404, "Key not found or revoked")
    warnings = await appkeys.sync_database(key.database)
    return {"ok": True, "warnings": warnings}


@router.delete("/{key_id}")
async def revoke_key(key_id: str):
    appkeys.forget(key_id)
    key = await appkeys.lookup(key_id)
    if not key:
        raise HTTPException(404, "Key not found")
    pool = await appkeys.meta_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE central_postgres.api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1", key_id
        )
    appkeys.forget(key_id)
    try:
        warnings = await appkeys.drop_key_role(key)
    except asyncpg.PostgresError as e:
        warnings = [str(e)]
    return {"revoked": key_id, "warnings": warnings}
