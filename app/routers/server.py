"""Server-level management: overview, databases, roles, privileges."""
from __future__ import annotations

import secrets
from typing import Literal
from urllib.parse import quote, urlparse

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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
                   CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                        THEN pg_database_size(d.datname) END AS size_bytes
            FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1
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
        "databases": _rows(dbs),
        "total_size_bytes": sum(r["size_bytes"] or 0 for r in dbs),
        "activity": _rows(activity),
        "panel_pools": pools.open_databases(),
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


@router.patch("/databases/{name}")
async def alter_database(name: str, body: RenameDatabase):
    if name in settings.protected_databases and body.new_name:
        raise HTTPException(400, f"'{name}' is protected and cannot be renamed")
    pool = await pools.get()
    async with pool.acquire() as conn:
        if body.owner:
            await conn.execute(f"ALTER DATABASE {ident(name)} OWNER TO {ident(body.owner)}")
        if body.comment is not None:
            val = literal(body.comment) if body.comment else "NULL"
            await conn.execute(f"COMMENT ON DATABASE {ident(name)} IS {val}")
        if body.new_name and body.new_name != name:
            await pools.close(name)
            await conn.execute(f"ALTER DATABASE {ident(name)} RENAME TO {ident(body.new_name)}")
    return {"name": body.new_name or name}


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
class GrantBody(BaseModel):
    role: str
    level: Literal["read", "write", "all", "none"] = "read"
    schema_name: str = Field("public", alias="schema")

    model_config = {"populate_by_name": True}


@router.post("/db/{db}/grant")
async def grant_access(db: str, body: GrantBody):
    """Give a role read / write / full access to every table in a schema (now and future)."""
    r, s, d = ident(body.role), ident(body.schema_name), ident(db)
    table_privs = {"read": "SELECT", "write": "SELECT, INSERT, UPDATE, DELETE", "all": "ALL PRIVILEGES"}
    seq_privs = {"read": "SELECT", "write": "USAGE, SELECT", "all": "ALL PRIVILEGES"}
    stmts: list[str] = []
    if body.level == "none":
        stmts += [
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} REVOKE ALL ON TABLES FROM {r}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} REVOKE ALL ON SEQUENCES FROM {r}",
            f"REVOKE ALL ON ALL TABLES IN SCHEMA {s} FROM {r}",
            f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA {s} FROM {r}",
            f"REVOKE ALL ON SCHEMA {s} FROM {r}",
        ]
    else:
        stmts += [
            f"GRANT CONNECT ON DATABASE {d} TO {r}",
            f"GRANT USAGE{', CREATE' if body.level == 'all' else ''} ON SCHEMA {s} TO {r}",
            f"GRANT {table_privs[body.level]} ON ALL TABLES IN SCHEMA {s} TO {r}",
            f"GRANT {seq_privs[body.level]} ON ALL SEQUENCES IN SCHEMA {s} TO {r}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT {table_privs[body.level]} ON TABLES TO {r}",
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT {seq_privs[body.level]} ON SEQUENCES TO {r}",
        ]
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        async with conn.transaction():
            for st in stmts:
                await conn.execute(st)
    return {"ok": True, "statements": stmts}


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
