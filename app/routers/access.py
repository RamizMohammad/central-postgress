"""Who can do what in a database: effective privileges per role and schema,
default privileges for future objects, and object ownership (needed for
migrations). Everything is read live from the catalogs on every request."""
from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import ownership
from ..auth import require_auth
from ..db import pools
from ..sqlutil import ident

router = APIRouter(prefix="/api", tags=["access"], dependencies=[Depends(require_auth)])

_USER_NS = ownership._USER_NS
_ALL = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
_HAS_ALL = " AND ".join("has_table_privilege(r.oid, c.oid, '%s')" % p for p in _ALL)

STATS_SQL = f"""
SELECT r.rolname AS role, n.nspname AS schema,
       count(c.oid) AS tables,
       count(c.oid) FILTER (WHERE c.relowner = r.oid) AS owned,
       count(c.oid) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'SELECT')) AS can_select,
       count(c.oid) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'SELECT') AND has_table_privilege(r.oid, c.oid, 'INSERT')
                              AND has_table_privilege(r.oid, c.oid, 'UPDATE') AND has_table_privilege(r.oid, c.oid, 'DELETE')) AS can_write,
       count(c.oid) FILTER (WHERE {_HAS_ALL}) AS can_all,
       has_schema_privilege(r.oid, n.oid, 'USAGE') AS usage,
       has_schema_privilege(r.oid, n.oid, 'CREATE') AS create
FROM pg_roles r
CROSS JOIN pg_namespace n
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
WHERE r.rolname !~ '^pg_' AND NOT r.rolsuper AND {_USER_NS}
GROUP BY r.rolname, r.oid, n.nspname, n.oid
"""

DEFAULTS_SQL = """
SELECT pg_get_userbyid(d.defaclrole) AS creator, n.nspname AS schema,
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' WHEN 'f' THEN 'functions'
                            WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END AS objects,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
CROSS JOIN LATERAL aclexplode(d.defaclacl) a
GROUP BY 1, 2, 3, 4
ORDER BY 4, 2, 3
"""

DB_SQL = """
SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolcanlogin AS login,
       has_database_privilege(r.oid, current_database(), 'CONNECT') AS connect,
       has_database_privilege(r.oid, current_database(), 'CREATE') AS create,
       EXISTS (SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
               WHERE d.datname = current_database() AND a.grantee = r.oid) AS explicit_grant,
       r.oid = (SELECT datdba FROM pg_database WHERE datname = current_database()) AS is_owner
FROM pg_roles r
WHERE r.rolname !~ '^pg_'
ORDER BY r.rolname
"""


def _level(s: dict) -> str:
    t = s["tables"]
    if t and s["owned"] == t:
        return "owner"
    if t and not s["usage"] and (s["can_select"] or s["can_write"]):
        return "blocked"  # table grants exist but no USAGE on the schema
    if not t:
        return "all" if s["create"] else ("usage" if s["usage"] else "none")
    if s["can_all"] == t:
        return "all"
    if s["can_write"] == t:
        return "write"
    if s["can_select"] == t:
        return "read"
    if s["can_select"] or s["can_write"]:
        return "partial"
    return "none"


@router.get("/db/{db}/access")
async def access(db: str, role: str | None = None):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        db_rows = await conn.fetch(DB_SQL)
        stats = await conn.fetch(STATS_SQL)
        defaults = await conn.fetch(DEFAULTS_SQL)
        schemas = await conn.fetch(f"""
            SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
                   (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS tables
            FROM pg_namespace n WHERE {_USER_NS}
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid AND d.deptype = 'e')
            ORDER BY (n.nspname = 'public') DESC, 1""")
        own = await ownership.audit(conn)
        me = await conn.fetchrow("SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user")

    schema_names = [s["name"] for s in schemas]
    by_role: dict[str, dict] = {}
    for r in db_rows:
        by_role[r["role"]] = {**dict(r), "schemas": {}, "defaults": []}
    for s in stats:
        if s["schema"] in schema_names and s["role"] in by_role:
            d = dict(s)
            d["level"] = _level(d)
            by_role[s["role"]]["schemas"][s["schema"]] = d
    for d in defaults:
        if d["grantee"] in by_role:
            by_role[d["grantee"]]["defaults"].append(dict(d))

    mismatched_by_schema: dict[str, int] = {}
    for o in own["objects"]:
        mismatched_by_schema[o["schema"]] = mismatched_by_schema.get(o["schema"], 0) + 1

    out = []
    for name, r in by_role.items():
        if role and name != role:
            continue
        levels = [s["level"] for s in r["schemas"].values()]
        relevant = (r["superuser"] or r["is_owner"] or r["explicit_grant"] or r["defaults"]
                    or any(l not in ("none", "usage") for l in levels))
        if not relevant and not role:
            continue
        total = sum(s["tables"] for s in r["schemas"].values())
        owned = sum(s["owned"] for s in r["schemas"].values())
        r["tables_total"] = total
        r["tables_owned"] = owned
        # ALTER/DROP needs ownership: superusers can, everyone else only on what they own
        r["can_migrate"] = bool(r["superuser"] or (owned == total and (total or r["is_owner"])))
        out.append(r)

    return {
        "database": db,
        "owner": own["database_owner"],
        "panel_role": me["name"],
        "panel_is_superuser": me["superuser"],
        "schemas": [dict(s, mismatched=mismatched_by_schema.get(s["name"], 0)) for s in schemas],
        "roles": out,
        "defaults": [dict(d) for d in defaults],
        "ownership": {k: own[k] for k in ("target", "mismatched", "by_owner")},
    }


@router.get("/db/{db}/ownership")
async def ownership_audit(db: str, target: str | None = None):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        return await ownership.audit(conn, target or None)


class TransferBody(BaseModel):
    target: str | None = None          # default: the database owner
    make_database_owner: bool = False  # also ALTER DATABASE … OWNER TO target


@router.post("/db/{db}/ownership")
async def ownership_transfer(db: str, body: TransferBody):
    target = (body.target or "").strip() or None
    if body.make_database_owner and target:
        admin = await pools.get()
        async with admin.acquire() as conn:
            if not await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", target):
                raise HTTPException(404, f"Role '{target}' not found")
            try:  # needed on PG < 16 when the panel isn't a superuser
                await conn.execute(f"GRANT {ident(target)} TO current_user")
            except asyncpg.PostgresError:
                pass
            await conn.execute(f"ALTER DATABASE {ident(db)} OWNER TO {ident(target)}")
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        result = await ownership.transfer(conn, target)
        result["remaining"] = (await ownership.audit(conn, result["target"]))["mismatched"]
    return result
