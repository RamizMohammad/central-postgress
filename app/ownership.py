"""Object ownership inside one database.

Postgres only lets an object's OWNER (or a superuser) ALTER/DROP it — no GRANT
changes that. So when tables are created by the panel's own login (SQL console,
New table, or a restore with "don't restore owners"), an app that connects as
the database owner can read and write them but cannot migrate them:

    ALTER TABLE users ADD COLUMN …  ->  must be owner of table users

The rule this panel follows: **everything in a database belongs to the
database's owner.** This module finds objects that break the rule and
transfers them, one ALTER … OWNER TO per object (never REASSIGN OWNED, which
would also move the old role's objects in other databases).
"""
from __future__ import annotations

import asyncpg

from .sqlutil import ident

_SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')"
_USER_NS = f"n.nspname NOT IN {_SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'"

# Objects in user schemas whose owner is not $1. Extension members are skipped
# (they belong to their extension), and so are sequences owned by a column
# (serial/identity): they follow their table automatically.
AUDIT_SQL = f"""
WITH ext AS (
    SELECT classid, objid FROM pg_depend WHERE deptype = 'e'
)
SELECT * FROM (
    SELECT 'schema' AS kind, n.nspname AS schema, n.nspname AS name,
           pg_get_userbyid(n.nspowner) AS owner,
           format('ALTER SCHEMA %I OWNER TO %I', n.nspname, $1::text) AS stmt, 0 AS ord
    FROM pg_namespace n
    WHERE {_USER_NS}
      AND pg_get_userbyid(n.nspowner) NOT IN ($1::text, 'pg_database_owner')
      AND NOT EXISTS (SELECT 1 FROM ext WHERE classid = 'pg_namespace'::regclass AND objid = n.oid)

    UNION ALL
    SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
                          WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' ELSE 'sequence' END,
           n.nspname, c.relname, pg_get_userbyid(c.relowner),
           format('ALTER %s %I.%I OWNER TO %I',
                  CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                                 WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
                  n.nspname, c.relname, $1::text),
           CASE WHEN c.relkind = 'S' THEN 2 ELSE 1 END
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE {_USER_NS}
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND pg_get_userbyid(c.relowner) <> $1::text
      AND NOT EXISTS (SELECT 1 FROM ext WHERE classid = 'pg_class'::regclass AND objid = c.oid)
      AND NOT (c.relkind = 'S' AND EXISTS (
            SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
              AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))

    UNION ALL
    SELECT CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END,
           n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_get_userbyid(p.proowner),
           format('ALTER %s %s OWNER TO %I',
                  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
                  p.oid::regprocedure, $1::text),
           3
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE {_USER_NS}
      AND pg_get_userbyid(p.proowner) <> $1::text
      AND NOT EXISTS (SELECT 1 FROM ext WHERE classid = 'pg_proc'::regclass AND objid = p.oid)

    UNION ALL
    SELECT CASE t.typtype WHEN 'd' THEN 'domain' WHEN 'e' THEN 'enum' WHEN 'r' THEN 'range' ELSE 'type' END,
           n.nspname, t.typname, pg_get_userbyid(t.typowner),
           format('ALTER %s %s OWNER TO %I', CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, t.oid::regtype, $1::text),
           4
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE {_USER_NS}
      AND (t.typtype IN ('d', 'e', 'r')
           OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
      AND pg_get_userbyid(t.typowner) <> $1::text
      AND NOT EXISTS (SELECT 1 FROM ext WHERE classid = 'pg_type'::regclass AND objid = t.oid)
) x
ORDER BY ord, schema, name
"""


async def database_owner(conn: asyncpg.Connection) -> str:
    return await conn.fetchval("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")


async def audit(conn: asyncpg.Connection, target: str | None = None) -> dict:
    """Objects not owned by `target` (default: the database owner)."""
    target = target or await database_owner(conn)
    rows = await conn.fetch(AUDIT_SQL, target)
    by_owner: dict[str, int] = {}
    for r in rows:
        by_owner[r["owner"]] = by_owner.get(r["owner"], 0) + 1
    return {
        "target": target,
        "database_owner": await database_owner(conn),
        "mismatched": len(rows),
        "by_owner": by_owner,
        "objects": [{"kind": r["kind"], "schema": r["schema"], "name": r["name"], "owner": r["owner"], "sql": r["stmt"]} for r in rows],
    }


async def transfer(conn: asyncpg.Connection, target: str | None = None, *, kinds: set[str] | None = None) -> dict:
    """ALTER … OWNER TO `target` for every mismatched object. Each statement runs
    in its own savepoint, so one failure doesn't undo the rest."""
    target = target or await database_owner(conn)
    rows = await conn.fetch(AUDIT_SQL, target)
    done, failed = [], []
    async with conn.transaction():
        for r in rows:
            if kinds and r["kind"] not in kinds:
                continue
            try:
                async with conn.transaction():
                    await conn.execute(r["stmt"])
                done.append(r["stmt"])
            except asyncpg.PostgresError as e:
                failed.append({"sql": r["stmt"], "error": str(e)})
    return {"target": target, "changed": len(done), "failed": failed, "statements": done}


async def give_to_owner(conn: asyncpg.Connection, sql_object: str, kind_word: str = "TABLE") -> str | None:
    """Hand a freshly created object to the database owner (when that isn't us)."""
    owner = await database_owner(conn)
    me = await conn.fetchval("SELECT current_user")
    if owner and owner != me:
        await conn.execute(f"ALTER {kind_word} {sql_object} OWNER TO {ident(owner)}")
        return owner
    return None
