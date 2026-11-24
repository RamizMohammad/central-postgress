"""Server-level management: overview, databases, roles, privileges."""
from __future__ import annotations

import secrets
from typing import Literal
from urllib.parse import quote, urlparse

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import ownership
from ..auth import require_auth
from ..config import settings
from ..db import pools
from ..sqlutil import ident, literal, to_json_value

router = APIRouter(prefix="/api", tags=["server"], dependencies=[Depends(require_auth)])


def _rows(records) -> list[dict]:
    return [{k: to_json_value(v) for k, v in dict(r).items()} for r in records]


# --------------------------------------------------------------------------- overview
@router.get("/overview")
async def overview():
    pool = await pools.get()
    async with pool.acquire() as conn:
        info = await conn.fetchrow(
            """
            SELECT version() AS version,
                   current_setting('server_version') AS server_version,
                   current_user AS current_user,
                   current_database() AS current_database,
                   pg_postmaster_start_time() AS started_at,
                   current_setting('max_connections')::int AS max_connections,
                   (SELECT count(*) FROM pg_stat_activity) AS connections,
                   r.rolsuper AS is_superuser, r.rolcreatedb AS can_create_db,
                   r.rolcreaterole AS can_create_role
            FROM pg_roles r WHERE r.rolname = current_user
            """
        )
        dbs = await conn.fetch(
            """
            SELECT d.datname AS name,
                   pg_get_userbyid(d.datdba) AS owner,
                   CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                        THEN pg_database_size(d.datname) END AS size_bytes,
                   coalesce(s.numbackends, 0) AS connections
            FROM pg_database d
            LEFT JOIN pg_stat_database s ON s.datid = d.oid
            WHERE NOT d.datistemplate ORDER BY 1
            """
        )
        stats = await conn.fetchrow(
            """
            SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2)::float8 AS cache_hit_pct,
                   sum(xact_commit)::bigint AS commits,
                   sum(xact_rollback)::bigint AS rollbacks,
                   sum(deadlocks)::bigint AS deadlocks,
                   sum(temp_bytes)::bigint AS temp_bytes,
                   current_setting('shared_buffers') AS shared_buffers,
                   (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active,
                   (SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in%') AS idle_in_tx,
                   (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') AS idle
            FROM pg_stat_database
            """
        )
        activity = await conn.fetch(
            """
            SELECT pid, datname, usename, application_name, state, client_addr::text AS client_addr,
                   backend_start, state_change, left(query, 300) AS query
            FROM pg_stat_activity
            WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
            ORDER BY backend_start DESC LIMIT 100
            """
        )
    return {
        "server": {k: to_json_value(v) for k, v in dict(info).items()},
        "stats": {k: to_json_value(v) for k, v in dict(stats).items()},
        "databases": _rows(dbs),
        "total_size_bytes": sum(r["size_bytes"] or 0 for r in dbs),
        "activity": _rows(activity),
        "panel_pools": pools.open_databases(),
    }


@router.get("/connection-info")
async def connection_info():
    """Non-secret connection facts for the panel's Connection guide."""
    parsed = urlparse(settings.database_url)
    pool = await pools.get()
    async with pool.acquire() as conn:
        version = await conn.fetchval("SHOW server_version")
    return {
        "server_version": (version or "").split(" ")[0],
        "host": parsed.hostname,
        "port": parsed.port or 5432,
        "user": parsed.username,
        "database": settings.default_database,
        "public_host": settings.public_db_host,
        "public_port": settings.public_db_port,
    }


# --------------------------------------------------------------------------- databases
@router.get("/databases")
async def list_databases():
    pool = await pools.get()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT d.datname AS name,
                   pg_get_userbyid(d.datdba) AS owner,
                   pg_encoding_to_char(d.encoding) AS encoding,
                   d.datcollate AS collation,
                   has_database_privilege(d.datname, 'CONNECT') AS can_connect,
                   CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                        THEN pg_database_size(d.datname) END AS size_bytes,
                   (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections,
                   shobj_description(d.oid, 'pg_database') AS comment
            FROM pg_database d
            WHERE NOT d.datistemplate
            ORDER BY d.datname
            """
        )
    out = _rows(rows)
    for r in out:
        r["protected"] = r["name"] in settings.protected_databases
        r["is_default"] = r["name"] == settings.default_database
    return out


class CreateDatabase(BaseModel):
    name: str = Field(min_length=1, max_length=63)
    owner: str | None = None
    create_user: bool = False
    user_name: str | None = None
    user_password: str | None = None
    template: str | None = None
    encoding: str | None = None
    comment: str | None = None


def _connection_url(user: str, password: str, database: str) -> str:
    parsed = urlparse(settings.database_url)
    host = settings.public_db_host or parsed.hostname or "localhost"
    port = settings.public_db_port or (str(parsed.port) if parsed.port else "5432")
    return f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}/{quote(database, safe='')}"


@router.post("/databases", status_code=201)
async def create_database(body: CreateDatabase):
    pool = await pools.get()
    owner = body.owner or None
    created_user = None
    async with pool.acquire() as conn:
        if body.create_user:
            user = body.user_name or body.name
            password = body.user_password or secrets.token_urlsafe(24)
            await conn.execute(f"CREATE ROLE {ident(user)} LOGIN PASSWORD {literal(password)}")
            created_user = {"name": user, "password": password}
            owner = user
        if owner:
            # Needed on PG < 16 so the admin may create a database owned by that role.
            try:
                await conn.execute(f"GRANT {ident(owner)} TO current_user")
            except asyncpg.PostgresError:
                pass
        sql = f"CREATE DATABASE {ident(body.name)}"
        if owner:
            sql += f" OWNER {ident(owner)}"
        if body.template:
            sql += f" TEMPLATE {ident(body.template)}"
        if body.encoding:
            sql += f" ENCODING {literal(body.encoding)}"
        try:
            await conn.execute(sql)
        except asyncpg.PostgresError:
            if created_user:  # roll back the role we just made
                try:
                    await conn.execute(f"DROP ROLE {ident(created_user['name'])}")
                except asyncpg.PostgresError:
                    pass
            raise
        if body.comment:
            await conn.execute(f"COMMENT ON DATABASE {ident(body.name)} IS {literal(body.comment)}")

    result: dict = {"name": body.name, "owner": owner}
    if created_user:
        result["user"] = created_user
        result["connection_url"] = _connection_url(created_user["name"], created_user["password"], body.name)
    return result


class RenameDatabase(BaseModel):
    new_name: str | None = None
    owner: str | None = None
    comment: str | None = None
    transfer_objects: bool = True  # with `owner`: also hand every table, view, sequence… to the new owner


@router.patch("/databases/{name}")
async def alter_database(name: str, body: RenameDatabase):
    if name in settings.protected_databases and body.new_name:
        raise HTTPException(400, f"'{name}' is protected and cannot be renamed")
    pool = await pools.get()
    transferred = None
    async with pool.acquire() as conn:
        if body.owner:
            try:  # needed on PG < 16 when the panel isn't a superuser
                await conn.execute(f"GRANT {ident(body.owner)} TO current_user")
            except asyncpg.PostgresError:
                pass
            await conn.execute(f"ALTER DATABASE {ident(name)} OWNER TO {ident(body.owner)}")
            if body.transfer_objects:
                async with (await pools.get(name)).acquire() as dbconn:
                    transferred = await ownership.transfer(dbconn, body.owner)
        if body.comment is not None:
            val = literal(body.comment) if body.comment else "NULL"
            await conn.execute(f"COMMENT ON DATABASE {ident(name)} IS {val}")
        if body.new_name and body.new_name != name:
            await pools.close(name)
            await conn.execute(f"ALTER DATABASE {ident(name)} RENAME TO {ident(body.new_name)}")
    return {"name": body.new_name or name, "transferred": transferred}


@router.delete("/databases/{name}")
async def drop_database(name: str, drop_owner: bool = False, force: bool = True):
    if name in settings.protected_databases:
        raise HTTPException(400, f"'{name}' is protected and cannot be dropped")
    await pools.close(name)
    pool = await pools.get()
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1", name
        )
        if owner is None:
            raise HTTPException(404, f"Database '{name}' not found")
        me = await conn.fetchval("SELECT current_user")
        sql = f"DROP DATABASE {ident(name)}"
        try:
            await conn.execute(sql + (" WITH (FORCE)" if force else ""))
        except asyncpg.PostgresSyntaxError:
            await conn.execute(sql)  # Postgres < 13 has no WITH (FORCE)
        dropped_role = None
        if drop_owner and owner != me:
            try:
                await conn.execute(f"DROP ROLE {ident(owner)}")
                dropped_role = owner
            except asyncpg.PostgresError as e:
                return {"dropped": name, "owner_not_dropped": owner, "reason": str(e)}
    return {"dropped": name, "dropped_role": dropped_role}


# --------------------------------------------------------------------------- roles
@router.get("/roles")
async def list_roles():
    pool = await pools.get()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolcreatedb AS createdb,
                   r.rolcreaterole AS createrole, r.rolcanlogin AS login,
                   r.rolconnlimit AS connection_limit, r.rolvaliduntil AS valid_until,
                   r.rolname = current_user AS is_current,
                   ARRAY(SELECT b.rolname FROM pg_auth_members m
                         JOIN pg_roles b ON m.roleid = b.oid
                         WHERE m.member = r.oid ORDER BY 1) AS member_of,
                   ARRAY(SELECT d.datname FROM pg_database d
                         WHERE d.datdba = r.oid ORDER BY 1) AS owns_databases
            FROM pg_roles r
            WHERE r.rolname !~ '^pg_'
            ORDER BY r.rolname
            """
        )
    return _rows(rows)


class CreateRole(BaseModel):
    name: str = Field(min_length=1, max_length=63)
    password: str | None = None
    login: bool = True
    createdb: bool = False
    createrole: bool = False
    connection_limit: int | None = None
    member_of: list[str] = []


@router.post("/roles", status_code=201)
async def create_role(body: CreateRole):
    generated = None
    password = body.password
    if body.login and not password:
        password = generated = secrets.token_urlsafe(24)
    parts = [f"CREATE ROLE {ident(body.name)}"]
    parts.append("LOGIN" if body.login else "NOLOGIN")
    parts.append("CREATEDB" if body.createdb else "NOCREATEDB")
    parts.append("CREATEROLE" if body.createrole else "NOCREATEROLE")
    if body.connection_limit is not None:
        parts.append(f"CONNECTION LIMIT {int(body.connection_limit)}")
    if password:
        parts.append(f"PASSWORD {literal(password)}")
    pool = await pools.get()
    async with pool.acquire() as conn:
        await conn.execute(" ".join(parts))
        for group in body.member_of:
            await conn.execute(f"GRANT {ident(group)} TO {ident(body.name)}")
    return {"name": body.name, "generated_password": generated}


class AlterRole(BaseModel):
    new_name: str | None = None
    password: str | None = None
    generate_password: bool = False
    login: bool | None = None
    createdb: bool | None = None
    createrole: bool | None = None
    connection_limit: int | None = None


@router.patch("/roles/{name}")
async def alter_role(name: str, body: AlterRole):
    opts = []
    generated = None
    if body.generate_password:
        body.password = generated = secrets.token_urlsafe(24)
    if body.password:
        opts.append(f"PASSWORD {literal(body.password)}")
    if body.login is not None:
        opts.append("LOGIN" if body.login else "NOLOGIN")
    if body.createdb is not None:
        opts.append("CREATEDB" if body.createdb else "NOCREATEDB")
    if body.createrole is not None:
        opts.append("CREATEROLE" if body.createrole else "NOCREATEROLE")
    if body.connection_limit is not None:
        opts.append(f"CONNECTION LIMIT {int(body.connection_limit)}")
    pool = await pools.get()
    async with pool.acquire() as conn:
        if opts:
            await conn.execute(f"ALTER ROLE {ident(name)} " + " ".join(opts))
        if body.new_name and body.new_name != name:
            await conn.execute(f"ALTER ROLE {ident(name)} RENAME TO {ident(body.new_name)}")
    return {"name": body.new_name or name, "generated_password": generated}


@router.delete("/roles/{name}")
async def drop_role(name: str):
    pool = await pools.get()
    async with pool.acquire() as conn:
        if name == await conn.fetchval("SELECT current_user"):
            raise HTTPException(400, "You cannot drop the role the panel is connected as")
        await conn.execute(f"DROP ROLE {ident(name)}")
    return {"dropped": name}


# --------------------------------------------------------------------------- privileges
TABLE_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")


class GrantBody(BaseModel):
    role: str
    level: Literal["read", "write", "all", "none", "owner", "custom"] = "read"
    schema_name: str = Field("public", alias="schema")
    # --- "custom" only -------------------------------------------------------
    privileges: list[str] = []            # subset of TABLE_PRIVILEGES
    tables: list[str] | None = None       # None = every table in the schema (and future ones)
    sequences: bool = True                # USAGE, SELECT (+ UPDATE when writing) on sequences
    functions: bool = False               # EXECUTE on all functions in the schema
    schema_create: bool = False           # CREATE on the schema (can make new tables)
    temp: bool = False                    # TEMPORARY on the database
    future: bool = True                   # same privileges on tables created later
    grant_option: bool = False            # role may pass these privileges on
    # --- any level -------------------------------------------------------------
    dry_run: bool = False                 # return the SQL without running it

    model_config = {"populate_by_name": True}


@router.post("/db/{db}/grant")
async def grant_access(db: str, body: GrantBody):
    """Set a role's access to a schema: preset levels (read / write / all), a
    custom mix of privileges and tables, revoke, or full ownership. Grants also
    cover tables created later — by the panel or by the database owner (e.g. an
    app's migrations). `dry_run` returns the statements without running them."""
    if body.level == "owner":
        async with (await pools.get(db)).acquire() as conn:
            plan = await ownership.audit(conn, body.role)
        stmts = [f"ALTER DATABASE {ident(db)} OWNER TO {ident(body.role)}"] + [o["sql"] for o in plan["objects"]]
        if body.dry_run:
            return {"ok": True, "dry_run": True, "statements": stmts}
        admin = await pools.get()
        async with admin.acquire() as conn:
            try:
                await conn.execute(f"GRANT {ident(body.role)} TO current_user")
            except asyncpg.PostgresError:
                pass
            await conn.execute(stmts[0])
        async with (await pools.get(db)).acquire() as conn:
            res = await ownership.transfer(conn, body.role)
        return {"ok": not res["failed"], "statements": stmts[:1] + res["statements"], "failed": res["failed"]}

    r, s, d = ident(body.role), ident(body.schema_name), ident(db)
    presets = {"read": ["SELECT"], "write": ["SELECT", "INSERT", "UPDATE", "DELETE"], "all": list(TABLE_PRIVILEGES)}
    if body.level == "custom":
        privs = [p.upper() for p in body.privileges]
        bad = [p for p in privs if p not in TABLE_PRIVILEGES]
        if bad:
            raise HTTPException(400, f"Unknown privilege(s): {', '.join(bad)}")
        privs = [p for p in TABLE_PRIVILEGES if p in privs]  # canonical order, no duplicates
        tables, sequences, functions = body.tables, body.sequences, body.functions
        schema_create, temp, future, wgo = body.schema_create, body.temp, body.future, body.grant_option
    else:
        privs = presets.get(body.level, [])
        tables, sequences, functions = None, True, body.level == "all"
        schema_create, temp, future, wgo = body.level == "all", False, True, False
    table_privs = "ALL PRIVILEGES" if privs == list(TABLE_PRIVILEGES) else ", ".join(privs)
    writes = any(p in privs for p in ("INSERT", "UPDATE", "DELETE"))
    seq_privs = ("USAGE, SELECT, UPDATE" if writes else "USAGE, SELECT") if privs else ""
    w = " WITH GRANT OPTION" if wgo else ""

    pool = await pools.get(db)
    async with pool.acquire() as conn:
        me, owner = await conn.fetchrow(
            "SELECT current_user, pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()")
        # Default privileges only apply to objects created by the named role, so
        # cover both creators: the panel itself and the database owner.
        creators = [c for c in dict.fromkeys([me, owner]) if c and c != body.role]
        owned = {row["relname"] for row in await conn.fetch(
            """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') AND pg_get_userbyid(c.relowner) = $2""",
            body.schema_name, body.role)}
        if tables is not None:
            existing = {row["relname"] for row in await conn.fetch(
                """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')""", body.schema_name)}
            missing = [t for t in tables if t not in existing]
            if missing:
                raise HTTPException(404, f"Not found in {body.schema_name}: {', '.join(missing)}")
            if not tables:
                raise HTTPException(400, "Pick at least one table, or choose 'All tables'")

        def defaults(action: str) -> list[str]:
            out = []
            for c in creators:
                pre = f"ALTER DEFAULT PRIVILEGES FOR ROLE {ident(c)} IN SCHEMA {s}"
                if action == "revoke":
                    out += [f"{pre} REVOKE ALL ON TABLES FROM {r}", f"{pre} REVOKE ALL ON SEQUENCES FROM {r}",
                            f"{pre} REVOKE ALL ON FUNCTIONS FROM {r}"]
                else:
                    if privs:
                        out.append(f"{pre} GRANT {table_privs} ON TABLES TO {r}{w}")
                        if sequences:
                            out.append(f"{pre} GRANT {seq_privs} ON SEQUENCES TO {r}{w}")
                    if functions:
                        out.append(f"{pre} GRANT EXECUTE ON FUNCTIONS TO {r}{w}")
            return out

        stmts: list[str] = []
        if body.level == "none":
            if owned:
                raise HTTPException(400, f"{body.role} owns {len(owned)} object(s) in {body.schema_name}; transfer them to another role first.")
            stmts += defaults("revoke") + [
                f"REVOKE ALL ON ALL TABLES IN SCHEMA {s} FROM {r}",
                f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA {s} FROM {r}",
                f"REVOKE ALL ON SCHEMA {s} FROM {r}",
                f"REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE {d} FROM {r}",
            ]
        else:
            stmts.append(f"GRANT CONNECT{', TEMPORARY' if temp else ''} ON DATABASE {d} TO {r}")
            if not temp and body.level == "custom":
                stmts.append(f"REVOKE TEMPORARY ON DATABASE {d} FROM {r}")
            stmts.append(f"GRANT USAGE{', CREATE' if schema_create else ''} ON SCHEMA {s} TO {r}")
            if not schema_create and not owned:
                stmts.append(f"REVOKE CREATE ON SCHEMA {s} FROM {r}")
            if tables is None:
                # replace whatever the role had (so lowering a level takes effect), unless it owns things here
                if not owned:
                    stmts += [f"REVOKE ALL ON ALL TABLES IN SCHEMA {s} FROM {r}",
                              f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA {s} FROM {r}"]
                if privs:
                    stmts.append(f"GRANT {table_privs} ON ALL TABLES IN SCHEMA {s} TO {r}{w}")
                    if sequences:
                        stmts.append(f"GRANT {seq_privs} ON ALL SEQUENCES IN SCHEMA {s} TO {r}{w}")
            else:
                for t in tables:
                    q = f"{s}.{ident(t)}"
                    if t not in owned:
                        stmts.append(f"REVOKE ALL ON TABLE {q} FROM {r}")
                    if privs:
                        stmts.append(f"GRANT {table_privs} ON TABLE {q} TO {r}{w}")
                if sequences and privs:
                    # only the sequences behind the chosen tables' serial/identity columns
                    seqs = await conn.fetch(
                        """SELECT DISTINCT sq.relname FROM pg_depend dp
                           JOIN pg_class sq ON sq.oid = dp.objid AND sq.relkind = 'S'
                           JOIN pg_class tb ON tb.oid = dp.refobjid
                           JOIN pg_namespace n ON n.oid = tb.relnamespace
                           WHERE dp.deptype IN ('a', 'i') AND n.nspname = $1 AND tb.relname = ANY($2::text[])""",
                        body.schema_name, tables)
                    for sq in seqs:
                        stmts.append(f"GRANT {seq_privs} ON SEQUENCE {s}.{ident(sq['relname'])} TO {r}{w}")
            if functions:
                stmts.append(f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {s} TO {r}{w}")
            if tables is None:
                stmts += defaults("revoke")
                if future:
                    stmts += defaults("grant")

        if body.dry_run:
            return {"ok": True, "dry_run": True, "statements": stmts}
        async with conn.transaction():
            for st in stmts:
                await conn.execute(st)
    note = None
    if body.role == owner and body.level != "custom":
        note = (f"{body.role} owns this database. Grants don't let it ALTER tables owned by other roles — "
                "use the 'Owner' level (or Access → Transfer ownership) so migrations work.")
    return {"ok": True, "statements": stmts, "note": note}


@router.get("/db/{db}/privileges")
async def table_privileges(db: str, schema: str = "public"):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT grantee, table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
            FROM information_schema.role_table_grants
            WHERE table_schema = $1
            GROUP BY grantee, table_name
            ORDER BY grantee, table_name
            """,
            schema,
        )
    return _rows(rows)
