"""Catalog lookups shared by the table and row endpoints."""
from __future__ import annotations

import asyncpg
from fastapi import HTTPException

from .sqlutil import qualified


async def relation(conn: asyncpg.Connection, schema: str, table: str) -> asyncpg.Record:
    row = await conn.fetchrow(
        """
        SELECT c.oid, c.relkind::text AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
        """,
        schema,
        table,
    )
    if row is None:
        raise HTTPException(404, f"Table {qualified(schema, table)} not found")
    return row


async def columns(conn: asyncpg.Connection, oid: int) -> list[dict]:
    rows = await conn.fetch(
        """
        SELECT a.attnum AS position,
               a.attname AS name,
               format_type(a.atttypid, a.atttypmod) AS type,
               format_type(a.atttypid, NULL) AS base_type,
               t.typcategory::text AS category,
               NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS default,
               a.attidentity::text AS identity,
               a.attgenerated::text AS generated,
               col_description(a.attrelid, a.attnum) AS comment,
               COALESCE(a.attnum = ANY(pk.indkey), false) AS primary_key
        FROM pg_attribute a
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_index pk ON pk.indrelid = a.attrelid AND pk.indisprimary
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
        """,
        oid,
    )
    return [dict(r) for r in rows]


async def primary_key(conn: asyncpg.Connection, oid: int) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT a.attname
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        WHERE i.indrelid = $1 AND i.indisprimary
        ORDER BY k.ord
        """,
        oid,
    )
    return [r["attname"] for r in rows]
