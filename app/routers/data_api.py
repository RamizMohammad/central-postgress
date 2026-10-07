"""Public data API for external applications (/v1).

Authenticate with an app key:  Authorization: Bearer cpk_...   (or X-API-Key)
Every query runs as the key's own Postgres role inside the key's database.
"""
from __future__ import annotations

import datetime as dt
import decimal
import hmac
import json
import re
import time
from typing import Any, Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Security
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .. import appkeys
from ..sqlutil import to_json_value

_bearer = HTTPBearer(auto_error=False, description="App key, e.g. cpk_ab12cd34ef_…")
_header = APIKeyHeader(name="X-API-Key", auto_error=False, description="App key (alternative to Bearer)")


async def app_key(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None = Security(_bearer),
    header: str | None = Security(_header),
) -> appkeys.AppKey:
    raw = (bearer.credentials if bearer else None) or header
    parsed = appkeys.parse_key(raw or "")
    if not parsed:
        raise HTTPException(401, "Missing or malformed app key (expected 'Authorization: Bearer cpk_…')",
                            headers={"WWW-Authenticate": "Bearer"})
    key_id, full = parsed
    key = await appkeys.lookup(key_id)
    if key is None or not hmac.compare_digest(key.secret_hash, appkeys.hash_key(full)):
        raise HTTPException(401, "Invalid app key", headers={"WWW-Authenticate": "Bearer"})
    if key.revoked_at:
        raise HTTPException(401, "This app key has been revoked")
    if key.expires_at and key.expires_at < dt.datetime.now(dt.timezone.utc):
        raise HTTPException(401, "This app key has expired")
    ip = appkeys.client_ip(request)
    if not appkeys.ip_allowed(ip, key.allowed_ips):
        raise HTTPException(403, f"Requests from {ip} are not allowed for this key")
    appkeys.check_rate(key)
    await appkeys.touch(key.id, ip)
    return key


router = APIRouter(prefix="/v1", tags=["data API (app keys)"])


# --------------------------------------------------------------------------- param coercion
_READ_ONLY_START = re.compile(r"^\s*(\(\s*)*(select|values|table|show|explain)\b", re.IGNORECASE)

_INT = {"int2", "int4", "int8", "oid"}
_FLOAT = {"float4", "float8"}
_TEXT = {"text", "varchar", "bpchar", "name", "char", "citext", "xml"}


def _bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in {"true", "t", "1", "yes", "y", "on"}:
        return True
    if s in {"false", "f", "0", "no", "n", "off"}:
        return False
    raise ValueError(f"not a boolean: {v!r}")


def _dt(v, aware: bool):
    d = v if isinstance(v, dt.datetime) else dt.datetime.fromisoformat(str(v).replace(" ", "T", 1))
    if aware:
        return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).replace(tzinfo=None) if d.tzinfo else d


def _scalar(v: Any, t: str):
    if v is None:
        return None
    if t in _INT:
        if isinstance(v, bool):
            raise ValueError("expected an integer, got a boolean")
        if isinstance(v, float) and not v.is_integer():
            raise ValueError(f"expected an integer, got {v}")
        return int(v)
    if t in _FLOAT:
        return float(v)
    if t == "numeric":
        return decimal.Decimal(str(v))
    if t == "bool":
        return _bool(v)
    if t in {"json", "jsonb"}:
        return v if isinstance(v, str) else json.dumps(v)
    if t == "date":
        return dt.date.fromisoformat(str(v)[:10])
    if t == "timestamp":
        return _dt(v, aware=False)
    if t == "timestamptz":
        return _dt(v, aware=True)
    if t == "time":
        return dt.time.fromisoformat(str(v))
    if t == "interval":
        return dt.timedelta(seconds=float(v))
    if t == "bytea":
        s = str(v)
        return bytes.fromhex(s[2:] if s.startswith("\\x") else s)
    if t in _TEXT or t in {"uuid", "inet", "cidr", "macaddr"}:
        return v if isinstance(v, str) else (json.dumps(v) if isinstance(v, (dict, list)) else str(v))
    return v


def coerce_params(params: list, types) -> list:
    if len(params) != len(types):
        raise HTTPException(400, f"The query has {len(types)} parameter(s) but {len(params)} value(s) were sent")
    out = []
    for i, (v, t) in enumerate(zip(params, types), start=1):
        try:
            if t.kind == "array":
                if v is None:
                    out.append(None)
                    continue
                if not isinstance(v, list):
                    raise ValueError("expected a JSON array")
                elem = t.name[1:] if t.name.startswith("_") else t.name
                out.append([_scalar(x, elem) for x in v])
            else:
                out.append(_scalar(v, t.name))
        except (ValueError, TypeError, decimal.InvalidOperation) as e:
            raise HTTPException(400, f"Parameter ${i} ({t.name}): {e}")
    return out


# --------------------------------------------------------------------------- execution
class QueryBody(BaseModel):
    sql: str = Field(min_length=1, description="ONE SQL statement. Use $1, $2… placeholders for values.")
    params: list[Any] = Field(default_factory=list, description="Values for $1, $2…, in order")
    limit: int | None = Field(None, ge=1, description="Max rows to return (capped by the key's max_rows)")
    row_format: Literal["objects", "arrays"] = "objects"


class TxBody(BaseModel):
    statements: list[QueryBody] = Field(min_length=1, max_length=100)


def _pg_error(e: asyncpg.PostgresError, index: int | None = None) -> HTTPException:
    status = 403 if getattr(e, "sqlstate", "") == "42501" else 400
    detail: dict[str, Any] = {"error": getattr(e, "message", None) or str(e), "pg_code": getattr(e, "sqlstate", None)}
    for attr in ("detail", "hint", "position"):
        if getattr(e, attr, None):
            detail[attr] = getattr(e, attr)
    if index is not None:
        detail["statement"] = index
    return HTTPException(status, detail)


async def _run(conn: asyncpg.Connection, q: QueryBody, key: appkeys.AppKey) -> dict:
    t0 = time.perf_counter()
    try:
        stmt = await conn.prepare(q.sql)
    except asyncpg.PostgresSyntaxError as e:
        if "multiple commands" in str(e):
            raise HTTPException(400, "Send one statement per query (use /v1/transaction for several)")
        raise
    args = coerce_params(q.params, stmt.get_parameters())
    limit = min(q.limit or key.max_rows, key.max_rows)
    attrs = stmt.get_attributes()
    try:
        if attrs and _READ_ONLY_START.match(q.sql):
            # stream only what we return (big SELECTs don't load fully into memory)
            cur = await stmt.cursor(*args)
            records = await cur.fetch(limit + 1)
        else:
            # INSERT/UPDATE/DELETE … RETURNING and commands: run to completion
            records = await stmt.fetch(*args)
    except asyncpg.DataError as e:
        raise HTTPException(400, f"Bad parameter value: {e}")
    truncated = len(records) > limit
    records = records[:limit]
    names = [a.name for a in attrs]
    if q.row_format == "arrays":
        rows = [[to_json_value(v) for v in r] for r in records]
    else:
        rows = [{n: to_json_value(v) for n, v in zip(names, r)} for r in records]
    status = stmt.get_statusmsg() or (f"SELECT {len(records)}" if attrs else "OK")
    if attrs and status.startswith("FETCH"):
        status = f"SELECT {len(records)}"
    affected = None
    parts = status.split()
    if parts and parts[0] in {"INSERT", "UPDATE", "DELETE", "MERGE", "COPY"} and parts[-1].isdigit():
        affected = int(parts[-1])
    return {
        "command": parts[0] if parts else None,
        "columns": [{"name": a.name, "type": a.type.name} for a in attrs],
        "rows": rows,
        "row_count": len(records),
        "rows_affected": affected,
        "truncated": truncated,
        "duration_ms": round((time.perf_counter() - t0) * 1000, 2),
    }


@router.get("/me")
async def whoami(key: appkeys.AppKey = Depends(app_key)):
    """What this key can do."""
    return {
        "key_id": key.id,
        "name": key.name,
        "database": key.database,
        "access": key.access,
        "schemas": key.schemas,
        "max_rows": key.max_rows,
        "rate_limit_per_min": key.rate_limit_per_min,
        "expires_at": to_json_value(key.expires_at),
    }


@router.post("/query")
async def query(body: QueryBody, key: appkeys.AppKey = Depends(app_key)):
    """Run one SQL statement with parameters and get rows back as JSON."""
    pool = await appkeys.key_pool(key)
    async with pool.acquire() as conn:
        try:
            async with conn.transaction(readonly=key.access == "read"):
                return await _run(conn, body, key)
        except asyncpg.PostgresError as e:
            raise _pg_error(e)


@router.post("/transaction")
async def transaction(body: TxBody, key: appkeys.AppKey = Depends(app_key)):
    """Run several statements atomically: all succeed, or none are applied."""
    pool = await appkeys.key_pool(key)
    results = []
    async with pool.acquire() as conn:
        i = 0
        try:
            async with conn.transaction(readonly=key.access == "read"):
                for i, q in enumerate(body.statements):
                    results.append(await _run(conn, q, key))
        except asyncpg.PostgresError as e:
            raise _pg_error(e, index=i)
        except HTTPException as e:
            if isinstance(e.detail, str):
                e.detail = {"error": e.detail, "statement": i}
            raise
    return {"results": results, "committed": True}


@router.get("/tables")
async def tables(key: appkeys.AppKey = Depends(app_key)):
    """Tables/views this key can see, with their columns."""
    pool = await appkeys.key_pool(key)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable = 'YES' AS nullable,
                   c.column_default
            FROM information_schema.columns c
            WHERE c.table_schema = ANY($1::text[])
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
            """,
            key.schemas,
        )
        privs = await conn.fetch(
            """
            SELECT n.nspname AS schema, c.relname AS name,
                   has_table_privilege(c.oid, 'SELECT') AS can_select,
                   has_table_privilege(c.oid, 'INSERT') AS can_insert,
                   has_table_privilege(c.oid, 'UPDATE') AS can_update,
                   has_table_privilege(c.oid, 'DELETE') AS can_delete
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f')
            """,
            key.schemas,
        )
    out: dict[tuple, dict] = {}
    for p in privs:
        out[(p["schema"], p["name"])] = {
            "schema": p["schema"], "name": p["name"],
            "privileges": [k[4:] for k in ("can_select", "can_insert", "can_update", "can_delete") if p[k]],
            "columns": [],
        }
    for r in rows:
        t = out.get((r["table_schema"], r["table_name"]))
        if t is not None:
            t["columns"].append({"name": r["column_name"], "type": r["data_type"],
                                 "nullable": r["nullable"], "default": r["column_default"]})
    return [t for t in out.values() if t["privileges"]]
