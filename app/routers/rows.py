"""Row-level CRUD, CSV import/export, and database dumps."""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
from typing import Any, Literal
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .. import catalog
from ..auth import require_auth
from ..config import settings
from ..db import _ssl_mode, pools
from ..sqlutil import ident, qualified

router = APIRouter(prefix="/api/db/{db}", tags=["rows"], dependencies=[Depends(require_auth)])

EDITABLE_KINDS = {"r", "p", "f"}
HAS_CTID = {"r", "p", "m"}

OPS = {
    "eq": "=", "neq": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">=",
}
TEXT_OPS = {"like": "LIKE", "not_like": "NOT LIKE", "ilike": "ILIKE", "contains": "ILIKE"}


def _pg_array(values: list) -> str:
    def el(v):
        if v is None:
            return "NULL"
        if isinstance(v, list):
            return _pg_array(v)
        s = v if isinstance(v, str) else (json.dumps(v) if isinstance(v, dict) else str(v).lower() if isinstance(v, bool) else str(v))
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    return "{" + ",".join(el(v) for v in values) + "}"


def _to_text(value: Any, col: dict) -> str | None:
    """Turn an incoming JSON value into the text form Postgres can cast from."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    base = col["base_type"]
    if isinstance(value, list) and base.endswith("[]"):
        return _pg_array(value)
    return json.dumps(value)


async def _table_meta(conn, schema: str, table: str):
    rel = await catalog.relation(conn, schema, table)
    cols = await catalog.columns(conn, rel["oid"])
    pk = await catalog.primary_key(conn, rel["oid"])
    return rel, cols, {c["name"]: c for c in cols}, pk


def _select_list(cols: list[dict], kind: str) -> str:
    parts = ["ctid::text AS __ctid"] if kind in HAS_CTID else []
    parts += [f"t.{ident(c['name'])}::text AS {ident(c['name'])}" for c in cols]
    return ", ".join(parts)


def _returning(cols: list[dict]) -> str:
    return ", ".join(["ctid::text AS __ctid"] + [f"{ident(c['name'])}::text AS {ident(c['name'])}" for c in cols])


def _where_for_row(key: dict | None, ctid: str | None, pk: list[str], by_name: dict, args: list) -> str:
    if key:
        if not pk:
            raise HTTPException(400, "Table has no primary key; identify the row by ctid")
        missing = [k for k in pk if k not in key]
        if missing:
            raise HTTPException(400, f"Missing primary key value(s): {', '.join(missing)}")
        conds = []
        for k in pk:
            args.append(_to_text(key[k], by_name[k]))
            conds.append(f"{ident(k)} = ${len(args)}::text::{by_name[k]['base_type']}")
        return " AND ".join(conds)
    if ctid:
        if not re.fullmatch(r"\(\d+,\d+\)", ctid):
            raise HTTPException(400, "Invalid ctid")
        args.append(ctid)
        return f"ctid = ${len(args)}::text::tid"
    raise HTTPException(400, "Provide either 'key' (primary key values) or 'ctid'")


# --------------------------------------------------------------------------- read
@router.get("/tables/{schema}/{table}/rows")
async def list_rows(
    db: str,
    schema: str,
    table: str,
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    sort: str | None = None,
    order: Literal["asc", "desc"] = "asc",
    filters: str | None = Query(None, description='JSON list: [{"column":"id","op":"gt","value":"10"}]'),
    q: str | None = Query(None, description="Search text anywhere in the row"),
):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel, cols, by_name, pk = await _table_meta(conn, schema, table)
        args: list = []
        where: list[str] = []

        if filters:
            try:
                flist = json.loads(filters)
                assert isinstance(flist, list)
            except Exception:
                raise HTTPException(400, "filters must be a JSON list")
            for f in flist:
                name, op, val = f.get("column"), f.get("op", "eq"), f.get("value")
                if name not in by_name:
                    raise HTTPException(400, f"Unknown column in filter: {name}")
                c = f"t.{ident(name)}"
                if op == "is_null":
                    where.append(f"{c} IS NULL")
                elif op == "not_null":
                    where.append(f"{c} IS NOT NULL")
                elif op in OPS:
                    args.append(_to_text(val, by_name[name]))
                    where.append(f"{c} {OPS[op]} ${len(args)}::text::{by_name[name]['base_type']}")
                elif op in TEXT_OPS:
                    args.append(f"%{val}%" if op == "contains" else str(val))
                    where.append(f"{c}::text {TEXT_OPS[op]} ${len(args)}")
                elif op == "in":
                    items = val if isinstance(val, list) else [x.strip() for x in str(val).split(",")]
                    args.append([str(x) for x in items])
                    where.append(f"{c}::text = ANY(${len(args)}::text[])")
                else:
                    raise HTTPException(400, f"Unknown filter op: {op}")
        if q:
            args.append(f"%{q}%")
            where.append(f"t::text ILIKE ${len(args)}")

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        tbl = qualified(schema, table)

        if sort:
            if sort not in by_name:
                raise HTTPException(400, f"Unknown sort column: {sort}")
            order_sql = f" ORDER BY t.{ident(sort)} {order.upper()} NULLS LAST"
        elif pk:
            order_sql = " ORDER BY " + ", ".join(f"t.{ident(k)}" for k in pk)
        else:
            order_sql = ""

        sql = f"SELECT {_select_list(cols, rel['kind'])} FROM {tbl} t{where_sql}{order_sql} LIMIT {limit} OFFSET {offset}"
        t0 = time.perf_counter()
        rows = await conn.fetch(sql, *args)
        ms = round((time.perf_counter() - t0) * 1000, 1)

        estimate = await conn.fetchval("SELECT GREATEST(reltuples, 0)::bigint FROM pg_class WHERE oid = $1", rel["oid"])
        if not where and estimate and estimate > 100_000:
            total, exact = estimate, False
        else:
            total = await conn.fetchval(f"SELECT count(*) FROM {tbl} t{where_sql}", *args)
            exact = True

    return {
        "columns": [
            {k: c[k] for k in ("name", "type", "base_type", "category", "nullable", "default", "identity", "generated", "primary_key")}
            for c in cols
        ],
        "primary_key": pk,
        "editable": rel["kind"] in EDITABLE_KINDS,
        "kind": rel["kind"],
        "rows": [dict(r) for r in rows],
        "total": total,
        "total_exact": exact,
        "limit": limit,
        "offset": offset,
        "duration_ms": ms,
    }


# --------------------------------------------------------------------------- write
class InsertBody(BaseModel):
    values: dict[str, Any] = {}


@router.post("/tables/{schema}/{table}/rows", status_code=201)
async def insert_row(db: str, schema: str, table: str, body: InsertBody):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel, cols, by_name, _ = await _table_meta(conn, schema, table)
        if rel["kind"] not in EDITABLE_KINDS:
            raise HTTPException(400, "This relation is not editable")
        names, params, args = [], [], []
        for k, v in body.values.items():
            if k not in by_name:
                raise HTTPException(400, f"Unknown column: {k}")
            args.append(_to_text(v, by_name[k]))
            names.append(ident(k))
            params.append(f"${len(args)}::text::{by_name[k]['base_type']}")
        tbl = qualified(schema, table)
        if names:
            sql = f"INSERT INTO {tbl} ({', '.join(names)}) VALUES ({', '.join(params)}) RETURNING {_returning(cols)}"
        else:
            sql = f"INSERT INTO {tbl} DEFAULT VALUES RETURNING {_returning(cols)}"
        row = await conn.fetchrow(sql, *args)
    return dict(row)


class UpdateBody(BaseModel):
    key: dict[str, Any] | None = None
    ctid: str | None = None
    values: dict[str, Any]


@router.patch("/tables/{schema}/{table}/rows")
async def update_row(db: str, schema: str, table: str, body: UpdateBody):
    if not body.values:
        raise HTTPException(400, "Nothing to update")
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel, cols, by_name, pk = await _table_meta(conn, schema, table)
        if rel["kind"] not in EDITABLE_KINDS:
            raise HTTPException(400, "This relation is not editable")
        args: list = []
        sets = []
        for k, v in body.values.items():
            if k not in by_name:
                raise HTTPException(400, f"Unknown column: {k}")
            args.append(_to_text(v, by_name[k]))
            sets.append(f"{ident(k)} = ${len(args)}::text::{by_name[k]['base_type']}")
        where = _where_for_row(body.key, body.ctid, pk, by_name, args)
        sql = f"UPDATE {qualified(schema, table)} SET {', '.join(sets)} WHERE {where} RETURNING {_returning(cols)}"
        async with conn.transaction():
            rows = await conn.fetch(sql, *args)
            if len(rows) > 1:
                raise HTTPException(409, "Update matched more than one row; nothing was changed")
    if not rows:
        raise HTTPException(404, "Row not found (it may have been changed or deleted)")
    return dict(rows[0])


class DeleteBody(BaseModel):
    keys: list[dict[str, Any]] = []
    ctids: list[str] = []


@router.delete("/tables/{schema}/{table}/rows")
async def delete_rows(db: str, schema: str, table: str, body: DeleteBody):
    if not body.keys and not body.ctids:
        raise HTTPException(400, "Nothing to delete")
    deleted = 0
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel, cols, by_name, pk = await _table_meta(conn, schema, table)
        if rel["kind"] not in EDITABLE_KINDS:
            raise HTTPException(400, "This relation is not editable")
        tbl = qualified(schema, table)
        async with conn.transaction():
            for key in body.keys:
                args: list = []
                where = _where_for_row(key, None, pk, by_name, args)
                deleted += int((await conn.execute(f"DELETE FROM {tbl} WHERE {where}", *args)).split()[-1])
            for ctid in body.ctids:
                args = []
                where = _where_for_row(None, ctid, pk, by_name, args)
                deleted += int((await conn.execute(f"DELETE FROM {tbl} WHERE {where}", *args)).split()[-1])
    return {"deleted": deleted}


# --------------------------------------------------------------------------- CSV
@router.get("/tables/{schema}/{table}/export")
async def export_csv(db: str, schema: str, table: str):
    pool = await pools.get(db)
    fd, path = tempfile.mkstemp(suffix=".csv")
    os.close(fd)
    try:
        async with pool.acquire() as conn:
            await catalog.relation(conn, schema, table)
            await conn.copy_from_query(
                f"SELECT * FROM {qualified(schema, table)}", output=path, format="csv", header=True
            )
    except Exception:
        os.unlink(path)
        raise
    return FileResponse(
        path,
        media_type="text/csv",
        filename=f"{db}.{schema}.{table}.csv",
        background=BackgroundTask(os.unlink, path),
    )


@router.post("/tables/{schema}/{table}/import")
async def import_csv(
    db: str,
    schema: str,
    table: str,
    file: UploadFile = File(...),
    header: bool = Form(True),
    delimiter: str = Form(","),
    truncate_first: bool = Form(False),
):
    if len(delimiter) != 1:
        raise HTTPException(400, "Delimiter must be one character")
    fd, path = tempfile.mkstemp(suffix=".csv")
    try:
        with os.fdopen(fd, "wb") as out:
            shutil.copyfileobj(file.file, out)
        pool = await pools.get(db)
        async with pool.acquire() as conn:
            rel, cols, by_name, _ = await _table_meta(conn, schema, table)
            columns = None
            if header:
                import csv

                with open(path, newline="", encoding="utf-8-sig") as f:
                    first = next(csv.reader(f, delimiter=delimiter), None)
                if not first:
                    raise HTTPException(400, "The file is empty")
                columns = [h.strip() for h in first]
                unknown = [h for h in columns if h not in by_name]
                if unknown:
                    raise HTTPException(400, f"CSV header has columns the table doesn't: {', '.join(unknown)}")
            async with conn.transaction():
                if truncate_first:
                    await conn.execute(f"TRUNCATE {qualified(schema, table)}")
                status = await conn.copy_to_table(
                    table, schema_name=schema, source=path, columns=columns,
                    format="csv", header=header, delimiter=delimiter,
                )
    finally:
        if os.path.exists(path):
            os.unlink(path)
    return {"status": status, "imported": int(status.split()[-1])}


# --------------------------------------------------------------------------- dump
dump_router = APIRouter(prefix="/api", tags=["backup"], dependencies=[Depends(require_auth)])


@dump_router.get("/databases/{name}/dump")
async def dump_database(name: str, format: Literal["plain", "custom"] = "plain", schema_only: bool = False):
    """Stream a pg_dump of a database (needs pg_dump in the image; the Dockerfile installs it)."""
    if not shutil.which("pg_dump"):
        raise HTTPException(501, "pg_dump is not installed on this server (use the Docker image)")
    u = urlparse(settings.database_url)
    env = os.environ.copy()
    env.update(
        PGHOST=u.hostname or "localhost",
        PGPORT=str(u.port or 5432),
        PGUSER=unquote(u.username or ""),
        PGPASSWORD=unquote(u.password or ""),
        PGDATABASE=name,
    )
    ssl = _ssl_mode(settings.database_url)
    env["PGSSLMODE"] = "disable" if ssl is False else (ssl or "prefer")
    args = ["pg_dump", "--no-owner", "--no-privileges", "-F", "c" if format == "custom" else "p"]
    if schema_only:
        args.append("--schema-only")
    proc = await asyncio.create_subprocess_exec(
        *args, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    first = await proc.stdout.read(65536)
    if not first:
        err = (await proc.stderr.read()).decode(errors="replace")
        await proc.wait()
        raise HTTPException(500, f"pg_dump failed: {err.strip() or 'no output'}")

    async def stream():
        yield first
        while chunk := await proc.stdout.read(65536):
            yield chunk
        await proc.wait()

    ext = "dump" if format == "custom" else "sql"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        stream(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}-{stamp}.{ext}"'},
    )
