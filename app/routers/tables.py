"""Schema-level management: schemas, extensions, tables, columns, indexes, constraints."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import catalog
from ..auth import require_auth
from ..db import pools
from ..sqlutil import check_expr, check_type, ident, literal, qualified, to_json_value

router = APIRouter(prefix="/api/db/{db}", tags=["schema"], dependencies=[Depends(require_auth)])

FK_ACTIONS = {"NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"}
INDEX_METHODS = {"btree", "hash", "gin", "gist", "brin", "spgist"}


def _rows(records) -> list[dict]:
    return [{k: to_json_value(v) for k, v in dict(r).items()} for r in records]


def _fk_action(a: str | None) -> str:
    a = (a or "NO ACTION").upper().strip()
    if a not in FK_ACTIONS:
        raise HTTPException(400, f"Invalid foreign key action: {a}")
    return a


# --------------------------------------------------------------------------- schemas
@router.get("/schemas")
async def list_schemas(db: str, include_system: bool = False):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
                   (SELECT count(*) FROM pg_class c
                    WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS tables,
                   obj_description(n.oid, 'pg_namespace') AS comment
            FROM pg_namespace n
            WHERE $1 OR (n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
            ORDER BY n.nspname = 'public' DESC, n.nspname
            """,
            include_system,
        )
    return _rows(rows)


class CreateSchema(BaseModel):
    name: str = Field(min_length=1, max_length=63)
    owner: str | None = None


@router.post("/schemas", status_code=201)
async def create_schema(db: str, body: CreateSchema):
    sql = f"CREATE SCHEMA {ident(body.name)}"
    if body.owner:
        sql += f" AUTHORIZATION {ident(body.owner)}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"name": body.name}


class AlterSchema(BaseModel):
    new_name: str | None = None
    owner: str | None = None


@router.patch("/schemas/{schema}")
async def alter_schema(db: str, schema: str, body: AlterSchema):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        if body.owner:
            await conn.execute(f"ALTER SCHEMA {ident(schema)} OWNER TO {ident(body.owner)}")
        if body.new_name and body.new_name != schema:
            await conn.execute(f"ALTER SCHEMA {ident(schema)} RENAME TO {ident(body.new_name)}")
    return {"name": body.new_name or schema}


@router.delete("/schemas/{schema}")
async def drop_schema(db: str, schema: str, cascade: bool = False):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(f"DROP SCHEMA {ident(schema)}{' CASCADE' if cascade else ''}")
    return {"dropped": schema}


# --------------------------------------------------------------------------- extensions
@router.get("/extensions")
async def list_extensions(db: str):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT a.name, a.default_version, e.extversion AS installed_version,
                   n.nspname AS schema, a.comment
            FROM pg_available_extensions a
            LEFT JOIN pg_extension e ON e.extname = a.name
            LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
            ORDER BY e.extversion IS NULL, a.name
            """
        )
    return _rows(rows)


class CreateExtension(BaseModel):
    name: str
    schema_name: str | None = Field(None, alias="schema")
    model_config = {"populate_by_name": True}


@router.post("/extensions", status_code=201)
async def create_extension(db: str, body: CreateExtension):
    sql = f"CREATE EXTENSION IF NOT EXISTS {ident(body.name)}"
    if body.schema_name:
        sql += f" SCHEMA {ident(body.schema_name)}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"name": body.name}


@router.delete("/extensions/{name}")
async def drop_extension(db: str, name: str, cascade: bool = False):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(f"DROP EXTENSION {ident(name)}{' CASCADE' if cascade else ''}")
    return {"dropped": name}


# --------------------------------------------------------------------------- tables
@router.get("/tables")
async def list_tables(db: str, schema: str = "public"):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.relname AS name, c.relkind::text AS kind,
                   CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END AS size_bytes,
                   GREATEST(c.reltuples, 0)::bigint AS row_estimate,
                   obj_description(c.oid, 'pg_class') AS comment
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
              AND NOT c.relispartition
            ORDER BY c.relname
            """,
            schema,
        )
    return _rows(rows)


class ForeignRef(BaseModel):
    schema_name: str = Field("public", alias="schema")
    table: str
    column: str
    on_delete: str | None = None
    on_update: str | None = None
    model_config = {"populate_by_name": True}


class ColumnDef(BaseModel):
    name: str = Field(min_length=1, max_length=63)
    type: str
    nullable: bool = True
    default: str | None = None
    primary_key: bool = False
    unique: bool = False
    identity: bool = False
    check: str | None = None
    references: ForeignRef | None = None
    comment: str | None = None


def _column_sql(c: ColumnDef, inline_pk: bool) -> str:
    parts = [ident(c.name), check_type(c.type)]
    if c.identity:
        parts.append("GENERATED BY DEFAULT AS IDENTITY")
    if inline_pk and c.primary_key:
        parts.append("PRIMARY KEY")
    elif not c.nullable:
        parts.append("NOT NULL")
    if c.default not in (None, "") and not c.identity:
        parts.append("DEFAULT " + check_expr(c.default, "default"))
    if c.unique and not (inline_pk and c.primary_key):
        parts.append("UNIQUE")
    if c.check:
        parts.append(f"CHECK ({check_expr(c.check, 'check')})")
    if c.references:
        r = c.references
        parts.append(f"REFERENCES {qualified(r.schema_name, r.table)} ({ident(r.column)})")
        parts.append(f"ON DELETE {_fk_action(r.on_delete)} ON UPDATE {_fk_action(r.on_update)}")
    return " ".join(parts)


class CreateTable(BaseModel):
    schema_name: str = Field("public", alias="schema")
    name: str = Field(min_length=1, max_length=63)
    columns: list[ColumnDef] = Field(min_length=1)
    if_not_exists: bool = False
    comment: str | None = None
    model_config = {"populate_by_name": True}


def build_create_table(body: CreateTable) -> list[str]:
    pk_cols = [c.name for c in body.columns if c.primary_key]
    inline_pk = len(pk_cols) == 1
    defs = [_column_sql(c, inline_pk) for c in body.columns]
    if len(pk_cols) > 1:
        defs.append("PRIMARY KEY (" + ", ".join(ident(n) for n in pk_cols) + ")")
    tbl = qualified(body.schema_name, body.name)
    stmts = [
        f"CREATE TABLE {'IF NOT EXISTS ' if body.if_not_exists else ''}{tbl} (\n  "
        + ",\n  ".join(defs)
        + "\n)"
    ]
    if body.comment:
        stmts.append(f"COMMENT ON TABLE {tbl} IS {literal(body.comment)}")
    for c in body.columns:
        if c.comment:
            stmts.append(f"COMMENT ON COLUMN {tbl}.{ident(c.name)} IS {literal(c.comment)}")
    return stmts


@router.post("/tables/preview")
async def preview_create_table(db: str, body: CreateTable):
    """Return the SQL that `POST /tables` would run, without running it."""
    return {"sql": ";\n".join(build_create_table(body)) + ";"}


@router.post("/tables", status_code=201)
async def create_table(db: str, body: CreateTable):
    stmts = build_create_table(body)
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        async with conn.transaction():
            for s in stmts:
                await conn.execute(s)
    return {"schema": body.schema_name, "name": body.name, "sql": ";\n".join(stmts) + ";"}


@router.get("/tables/{schema}/{table}")
async def table_detail(db: str, schema: str, table: str):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel = await catalog.relation(conn, schema, table)
        oid = rel["oid"]
        cols = await catalog.columns(conn, oid)
        pk = await catalog.primary_key(conn, oid)
        indexes = await conn.fetch(
            """
            SELECT ic.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
                   i.indisunique AS is_unique, i.indisprimary AS is_primary,
                   am.amname AS method, pg_relation_size(i.indexrelid) AS size_bytes,
                   EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid
                           AND k.conrelid = i.indrelid) AS backs_constraint
            FROM pg_index i
            JOIN pg_class ic ON ic.oid = i.indexrelid
            JOIN pg_am am ON am.oid = ic.relam
            WHERE i.indrelid = $1
            ORDER BY i.indisprimary DESC, ic.relname
            """,
            oid,
        )
        constraints = await conn.fetch(
            """
            SELECT conname AS name, contype::text AS type, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint WHERE conrelid = $1
            ORDER BY contype, conname
            """,
            oid,
        )
        referenced_by = await conn.fetch(
            """
            SELECT conname AS name, conrelid::regclass::text AS from_table,
                   pg_get_constraintdef(oid) AS definition
            FROM pg_constraint WHERE confrelid = $1 AND contype = 'f'
            """,
            oid,
        )
        stats = await conn.fetchrow(
            """
            SELECT CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END AS total_bytes,
                   CASE WHEN c.relkind IN ('r','p','m') THEN pg_relation_size(c.oid) END AS table_bytes,
                   CASE WHEN c.relkind IN ('r','p','m') THEN pg_indexes_size(c.oid) END AS index_bytes,
                   GREATEST(c.reltuples, 0)::bigint AS row_estimate,
                   pg_get_userbyid(c.relowner) AS owner,
                   obj_description(c.oid, 'pg_class') AS comment,
                   s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
            FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE c.oid = $1
            """,
            oid,
        )
        view_def = None
        if rel["kind"] in ("v", "m"):
            view_def = await conn.fetchval("SELECT pg_get_viewdef($1, true)", oid)

    # Build a readable CREATE statement from the catalog
    tbl = qualified(schema, table)
    if view_def is not None:
        kw = "MATERIALIZED VIEW" if rel["kind"] == "m" else "VIEW"
        ddl = f"CREATE {kw} {tbl} AS\n{view_def}"
    else:
        lines = []
        for c in cols:
            line = f"  {ident(c['name'])} {c['type']}"
            if c["identity"] == "a":
                line += " GENERATED ALWAYS AS IDENTITY"
            elif c["identity"] == "d":
                line += " GENERATED BY DEFAULT AS IDENTITY"
            if c["generated"] == "s":
                line += f" GENERATED ALWAYS AS ({c['default']}) STORED"
            elif c["default"] is not None:
                line += f" DEFAULT {c['default']}"
            if not c["nullable"]:
                line += " NOT NULL"
            lines.append(line)
        for k in constraints:
            if k["type"] != "n":  # PG18 lists NOT NULL constraints separately
                lines.append(f"  CONSTRAINT {ident(k['name'])} {k['definition']}")
        ddl = f"CREATE TABLE {tbl} (\n" + ",\n".join(lines) + "\n);"
        for ix in indexes:
            if not ix["backs_constraint"]:
                ddl += f"\n{ix['definition']};"

    return {
        "schema": schema,
        "name": table,
        "kind": rel["kind"],
        "columns": _rows(cols),
        "primary_key": pk,
        "indexes": _rows(indexes),
        "constraints": _rows([k for k in constraints if k["type"] != "n"]),
        "referenced_by": _rows(referenced_by),
        "stats": {k: to_json_value(v) for k, v in dict(stats).items()},
        "ddl": ddl,
    }


class AlterTable(BaseModel):
    new_name: str | None = None
    new_schema: str | None = None
    owner: str | None = None
    comment: str | None = None


_KIND_WORD = {"r": "TABLE", "p": "TABLE", "v": "VIEW", "m": "MATERIALIZED VIEW", "f": "FOREIGN TABLE"}


@router.patch("/tables/{schema}/{table}")
async def alter_table(db: str, schema: str, table: str, body: AlterTable):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel = await catalog.relation(conn, schema, table)
        kw = _KIND_WORD.get(rel["kind"], "TABLE")
        tbl = qualified(schema, table)
        async with conn.transaction():
            if body.comment is not None:
                val = literal(body.comment) if body.comment else "NULL"
                await conn.execute(f"COMMENT ON {kw} {tbl} IS {val}")
            if body.owner:
                await conn.execute(f"ALTER {kw} {tbl} OWNER TO {ident(body.owner)}")
            if body.new_name and body.new_name != table:
                await conn.execute(f"ALTER {kw} {tbl} RENAME TO {ident(body.new_name)}")
                table = body.new_name
                tbl = qualified(schema, table)
            if body.new_schema and body.new_schema != schema:
                await conn.execute(f"ALTER {kw} {tbl} SET SCHEMA {ident(body.new_schema)}")
                schema = body.new_schema
    return {"schema": schema, "name": table}


@router.delete("/tables/{schema}/{table}")
async def drop_table(db: str, schema: str, table: str, cascade: bool = False):
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        rel = await catalog.relation(conn, schema, table)
        kw = _KIND_WORD.get(rel["kind"], "TABLE")
        await conn.execute(f"DROP {kw} {qualified(schema, table)}{' CASCADE' if cascade else ''}")
    return {"dropped": f"{schema}.{table}"}


class TruncateBody(BaseModel):
    restart_identity: bool = False
    cascade: bool = False


@router.post("/tables/{schema}/{table}/truncate")
async def truncate_table(db: str, schema: str, table: str, body: TruncateBody):
    sql = f"TRUNCATE {qualified(schema, table)}"
    if body.restart_identity:
        sql += " RESTART IDENTITY"
    if body.cascade:
        sql += " CASCADE"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"ok": True}


@router.post("/tables/{schema}/{table}/maintenance")
async def maintenance(db: str, schema: str, table: str, action: Literal["vacuum", "analyze", "vacuum_analyze", "refresh"]):
    tbl = qualified(schema, table)
    sql = {
        "vacuum": f"VACUUM {tbl}",
        "analyze": f"ANALYZE {tbl}",
        "vacuum_analyze": f"VACUUM (ANALYZE) {tbl}",
        "refresh": f"REFRESH MATERIALIZED VIEW {tbl}",
    }[action]
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"ok": True, "sql": sql}


# --------------------------------------------------------------------------- columns
@router.post("/tables/{schema}/{table}/columns", status_code=201)
async def add_column(db: str, schema: str, table: str, body: ColumnDef):
    sql = f"ALTER TABLE {qualified(schema, table)} ADD COLUMN {_column_sql(body, inline_pk=True)}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(sql)
            if body.comment:
                await conn.execute(
                    f"COMMENT ON COLUMN {qualified(schema, table)}.{ident(body.name)} IS {literal(body.comment)}"
                )
    return {"sql": sql}


class AlterColumn(BaseModel):
    new_name: str | None = None
    type: str | None = None
    using: str | None = None
    nullable: bool | None = None
    default: str | None = None
    drop_default: bool = False
    comment: str | None = None


@router.patch("/tables/{schema}/{table}/columns/{column}")
async def alter_column(db: str, schema: str, table: str, column: str, body: AlterColumn):
    tbl = qualified(schema, table)
    col = ident(column)
    stmts = []
    if body.type:
        s = f"ALTER TABLE {tbl} ALTER COLUMN {col} TYPE {check_type(body.type)}"
        if body.using:
            s += f" USING {check_expr(body.using, 'USING expression')}"
        stmts.append(s)
    if body.drop_default:
        stmts.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} DROP DEFAULT")
    elif body.default not in (None, ""):
        stmts.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} SET DEFAULT {check_expr(body.default, 'default')}")
    if body.nullable is True:
        stmts.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} DROP NOT NULL")
    elif body.nullable is False:
        stmts.append(f"ALTER TABLE {tbl} ALTER COLUMN {col} SET NOT NULL")
    if body.comment is not None:
        val = literal(body.comment) if body.comment else "NULL"
        stmts.append(f"COMMENT ON COLUMN {tbl}.{col} IS {val}")
    if body.new_name and body.new_name != column:
        stmts.append(f"ALTER TABLE {tbl} RENAME COLUMN {col} TO {ident(body.new_name)}")
    if not stmts:
        raise HTTPException(400, "Nothing to change")
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        async with conn.transaction():
            for s in stmts:
                await conn.execute(s)
    return {"sql": ";\n".join(stmts) + ";"}


@router.delete("/tables/{schema}/{table}/columns/{column}")
async def drop_column(db: str, schema: str, table: str, column: str, cascade: bool = False):
    sql = f"ALTER TABLE {qualified(schema, table)} DROP COLUMN {ident(column)}{' CASCADE' if cascade else ''}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"sql": sql}


# --------------------------------------------------------------------------- indexes
class CreateIndex(BaseModel):
    name: str | None = None
    columns: list[str] = Field(min_length=1)
    unique: bool = False
    method: str = "btree"
    concurrently: bool = False
    where: str | None = None


@router.post("/tables/{schema}/{table}/indexes", status_code=201)
async def create_index(db: str, schema: str, table: str, body: CreateIndex):
    method = body.method.lower()
    if method not in INDEX_METHODS:
        raise HTTPException(400, f"Unknown index method {body.method}")
    name = body.name or f"{table}_{'_'.join(body.columns)}_{'key' if body.unique else 'idx'}"[:63]
    sql = (
        f"CREATE {'UNIQUE ' if body.unique else ''}INDEX {'CONCURRENTLY ' if body.concurrently else ''}"
        f"{ident(name)} ON {qualified(schema, table)} USING {method} ("
        + ", ".join(ident(c) for c in body.columns)
        + ")"
    )
    if body.where:
        sql += f" WHERE {check_expr(body.where, 'WHERE clause')}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"name": name, "sql": sql}


@router.delete("/indexes/{schema}/{index}")
async def drop_index(db: str, schema: str, index: str):
    sql = f"DROP INDEX {qualified(schema, index)}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"sql": sql}


# --------------------------------------------------------------------------- constraints
class CreateConstraint(BaseModel):
    type: Literal["primary_key", "unique", "check", "foreign_key"]
    name: str | None = None
    columns: list[str] = []
    expression: str | None = None
    ref_schema: str = "public"
    ref_table: str | None = None
    ref_columns: list[str] = []
    on_delete: str | None = None
    on_update: str | None = None


@router.post("/tables/{schema}/{table}/constraints", status_code=201)
async def add_constraint(db: str, schema: str, table: str, body: CreateConstraint):
    cols = ", ".join(ident(c) for c in body.columns)
    if body.type in ("primary_key", "unique", "foreign_key") and not body.columns:
        raise HTTPException(400, "Pick at least one column")
    if body.type == "primary_key":
        spec = f"PRIMARY KEY ({cols})"
    elif body.type == "unique":
        spec = f"UNIQUE ({cols})"
    elif body.type == "check":
        spec = f"CHECK ({check_expr(body.expression or '', 'check expression')})"
    else:
        if not body.ref_table or len(body.ref_columns) != len(body.columns):
            raise HTTPException(400, "Foreign key needs a referenced table and the same number of columns")
        spec = (
            f"FOREIGN KEY ({cols}) REFERENCES {qualified(body.ref_schema, body.ref_table)} ("
            + ", ".join(ident(c) for c in body.ref_columns)
            + f") ON DELETE {_fk_action(body.on_delete)} ON UPDATE {_fk_action(body.on_update)}"
        )
    name = f"CONSTRAINT {ident(body.name)} " if body.name else ""
    sql = f"ALTER TABLE {qualified(schema, table)} ADD {name}{spec}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"sql": sql}


@router.delete("/tables/{schema}/{table}/constraints/{name}")
async def drop_constraint(db: str, schema: str, table: str, name: str, cascade: bool = False):
    sql = f"ALTER TABLE {qualified(schema, table)} DROP CONSTRAINT {ident(name)}{' CASCADE' if cascade else ''}"
    pool = await pools.get(db)
    async with pool.acquire() as conn:
        await conn.execute(sql)
    return {"sql": sql}
