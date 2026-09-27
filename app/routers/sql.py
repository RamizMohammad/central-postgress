"""Free-form SQL console."""
from __future__ import annotations

import time

import asyncpg
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..auth import require_auth
from ..db import pools
from ..sqlutil import to_json_value

router = APIRouter(prefix="/api", tags=["sql"], dependencies=[Depends(require_auth)])


class SqlBody(BaseModel):
    sql: str = Field(min_length=1)
    limit: int = Field(1000, ge=1, le=50_000)


@router.post("/db/{db}/sql")
async def run_sql(db: str, body: SqlBody):
    """Run SQL against a database.

    A single statement that returns rows gives back columns + rows (capped at
    `limit`). Several statements separated by ';' run as one script (no rows
    returned, only the final status). Runs in autocommit mode, so CREATE
    DATABASE / VACUUM etc. work too.
    """
    pool = await pools.get(db)
    t0 = time.perf_counter()
    async with pool.acquire() as conn:
        try:
            stmt = await conn.prepare(body.sql)
        except asyncpg.PostgresSyntaxError as e:
            if "multiple commands" not in str(e):
                raise
            status = await conn.execute(body.sql)  # simple-query protocol handles scripts
            return {
                "kind": "script",
                "status": status,
                "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
            }

        attrs = stmt.get_attributes()
        if not attrs:
            status = await conn.execute(body.sql)
            return {
                "kind": "command",
                "status": status,
                "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
            }

        async with conn.transaction():
            cur = await stmt.cursor()
            records = await cur.fetch(body.limit + 1)
        truncated = len(records) > body.limit
        records = records[: body.limit]
        return {
            "kind": "rows",
            "columns": [{"name": a.name, "type": a.type.name} for a in attrs],
            "rows": [[to_json_value(v) for v in r] for r in records],
            "row_count": len(records),
            "truncated": truncated,
            "status": stmt.get_statusmsg(),
            "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
        }


@router.post("/connections/{pid}/terminate")
async def terminate(pid: int):
    pool = await pools.get()
    async with pool.acquire() as conn:
        ok = await conn.fetchval("SELECT pg_terminate_backend($1)", pid)
    return {"terminated": bool(ok)}
