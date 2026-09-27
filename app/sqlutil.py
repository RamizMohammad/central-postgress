"""Helpers for building SQL safely.

Values always go through query parameters. Identifiers (database, schema,
table, column names) cannot be parameters in Postgres, so they are quoted
with `ident()`. Column types typed by the user are checked against a
whitelist-shaped regex before being interpolated.
"""
from __future__ import annotations

import datetime as dt
import decimal
import ipaddress
import json
import math
import re
import uuid

from fastapi import HTTPException

MAX_IDENT = 63

_TYPE_RE = re.compile(
    r"""^
    (?:[a-z_][a-z0-9_]*\.)?                 # optional schema
    [a-z_][a-z0-9_]*                        # base name
    (?:\ [a-z_][a-z0-9_]*)*                 # multi-word: double precision, character varying
    (?:\s*\(\s*\d+\s*(?:,\s*-?\d+\s*)?\))?  # (n) or (p,s)
    (?:\ with(?:out)?\ time\ zone)?         # timestamp ... with time zone
    (?:\s*\[\s*\d*\s*\])*                   # array dimensions
    $""",
    re.IGNORECASE | re.VERBOSE,
)

_FORBIDDEN_IN_EXPR = re.compile(r";|--|/\*")


def ident(name: str) -> str:
    """Quote an SQL identifier."""
    if not isinstance(name, str) or name == "":
        raise HTTPException(400, "Name must not be empty")
    if "\x00" in name:
        raise HTTPException(400, "Name contains a NUL byte")
    if len(name.encode()) > MAX_IDENT:
        raise HTTPException(400, f"Name '{name[:20]}…' is longer than {MAX_IDENT} bytes")
    return '"' + name.replace('"', '""') + '"'


def qualified(schema: str, name: str) -> str:
    return f"{ident(schema)}.{ident(name)}"


def literal(value: str) -> str:
    """Quote a string literal (only for places Postgres does not accept params, e.g. PASSWORD)."""
    if "\x00" in value:
        raise HTTPException(400, "Value contains a NUL byte")
    return "'" + value.replace("'", "''") + "'"


def check_type(type_name: str) -> str:
    t = (type_name or "").strip()
    t = re.sub(r"\s+", " ", t)
    if not t or not _TYPE_RE.match(t):
        raise HTTPException(400, f"Invalid column type: {type_name!r}")
    return t


def check_expr(expr: str, what: str = "expression") -> str:
    """Light sanity check for raw SQL expressions (DEFAULT, USING, CHECK).

    Only authenticated admins reach this (they also have the SQL console),
    so this is about catching mistakes, not a security boundary.
    """
    e = (expr or "").strip()
    if not e:
        raise HTTPException(400, f"Empty {what}")
    if _FORBIDDEN_IN_EXPR.search(e):
        raise HTTPException(400, f"{what} may not contain ';' or comments")
    return e


def to_json_value(v):
    """Make an asyncpg value JSON-serialisable for the SQL console."""
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, (uuid.UUID, ipaddress._BaseAddress, ipaddress._BaseNetwork)):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "\\x" + bytes(v).hex()
    if isinstance(v, (list, tuple)):
        return [to_json_value(x) for x in v]
    if isinstance(v, dict):
        return {str(k): to_json_value(x) for k, x in v.items()}
    try:
        json.dumps(v)
        return v
    except TypeError:
        return str(v)
