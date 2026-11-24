"""Full-server backup and restore.

A *bundle* is one uncompressed .tar file (the dumps inside are already
compressed):

    manifest.json          what's inside, source server, per-database metadata
    roles.json             roles/users with attributes, password hashes,
                           memberships and per-role settings
    databases/001.dump     pg_dump custom format, one per database
    databases/002.dump     ...
    README.txt             how to restore by hand without the panel

Restoring on a fresh server: roles first, then each database is created with
its original owner/encoding/locale and filled with pg_restore (streamed straight
from the tar, nothing is extracted to disk). Afterwards database-level grants
and settings are re-applied. The `postgres` database carries the panel's own
metadata (API keys), so restoring it brings your app keys back too.

Long-running work happens in background *jobs* the panel polls for progress.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import io
import json
import logging
import os
import re
import secrets
import shutil
import tarfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import unquote, urlparse

import asyncpg
from fastapi import HTTPException

from . import appkeys
from . import ownership
from .config import settings
from .db import _ssl_mode, pools
from .sqlutil import ident, literal, to_json_value

log = logging.getLogger("central-postgres.backup")

BUNDLE_FORMAT = "central-postgres-backup/1"
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")


# --------------------------------------------------------------------------- storage
def backup_dir() -> Path:
    """BACKUP_DIR, falling back to ./backups when it isn't writable (local dev)."""
    for candidate in (Path(settings.backup_dir), Path.cwd() / "backups"):
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / f".probe-{os.getpid()}"
            probe.write_bytes(b"")
            probe.unlink()
            return candidate
        except OSError:
            continue
    raise HTTPException(500, f"Backup folder {settings.backup_dir} is not writable")


def file_path(name: str) -> Path:
    if not SAFE_NAME.match(name or "") or name.endswith(".partial"):
        raise HTTPException(400, "Invalid file name")
    p = backup_dir() / name
    if not p.is_file():
        raise HTTPException(404, f"Backup '{name}' not found")
    return p


def detect_kind(path: Path) -> str:
    with open(path, "rb") as f:
        head = f.read(512)
    if head.startswith(b"PGDMP"):
        return "dump"
    if len(head) >= 262 and head[257:262] == b"ustar":
        return "bundle"
    return "sql"


def _stamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


# --------------------------------------------------------------------------- pg tools
def pg_env(database: str) -> dict:
    u = urlparse(settings.database_url)
    env = os.environ.copy()
    env.update(
        PGHOST=u.hostname or "localhost",
        PGPORT=str(u.port or 5432),
        PGUSER=unquote(u.username or ""),
        PGPASSWORD=unquote(u.password or ""),
        PGDATABASE=database,
        PGAPPNAME="central-postgres-backup",
        PGCONNECT_TIMEOUT="15",
    )
    ssl = _ssl_mode(settings.database_url)
    env["PGSSLMODE"] = "disable" if ssl is False else (ssl or "prefer")
    return env


def _tool_major(tool: str) -> int | None:
    path = shutil.which(tool)
    if not path:
        return None
    import subprocess

    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"PostgreSQL\)\s+(\d+)", out) or re.search(r"(\d+)\.\d+", out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


def tools_status(server_major: int | None) -> dict:
    tools = {t: _tool_major(t) for t in ("pg_dump", "pg_restore", "psql")}
    missing = [t for t, v in tools.items() if v is None]
    ok, message = True, ""
    if missing:
        ok = False
        message = f"Missing on this server: {', '.join(missing)}. Rebuild the Docker image (it installs the PostgreSQL client)."
    elif server_major and tools["pg_dump"] < server_major:
        ok = False
        message = (f"pg_dump {tools['pg_dump']} is older than the database server ({server_major}). "
                   f"Rebuild with --build-arg PG_MAJOR={server_major}.")
    return {"ok": ok, "message": message, "versions": tools}


async def server_info(conn: asyncpg.Connection) -> dict:
    r = await conn.fetchrow(
        """SELECT current_setting('server_version') AS version,
                  current_setting('server_version_num')::int AS num,
                  current_user AS me,
                  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
                  (SELECT rolname FROM pg_roles WHERE oid = 10) AS bootstrap"""
    )
    return {"version": r["version"], "num": r["num"], "major": r["num"] // 10000,
            "user": r["me"], "superuser": r["superuser"], "bootstrap": r["bootstrap"]}


# --------------------------------------------------------------------------- jobs
@dataclass
class Job:
    id: str
    kind: str
    title: str
    status: str = "queued"  # queued | running | done | failed
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    lines: list[str] = field(default_factory=list)
    step: str = ""
    done: int = 0
    total: int = 0
    warnings: int = 0
    result: dict = field(default_factory=dict)
    error: str | None = None

    def log(self, msg: str, warn: bool = False) -> None:
        if warn:
            self.warnings += 1
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        self.lines.append(f"{stamp}  {'⚠ ' if warn else ''}{msg}")
        if len(self.lines) > 4000:
            del self.lines[:500]

    def public(self, since: int = 0) -> dict:
        return {
            "id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
            "created": self.created, "started": self.started, "finished": self.finished,
            "step": self.step, "done": self.done, "total": self.total, "warnings": self.warnings,
            "result": self.result, "error": self.error,
            "log": self.lines[since:], "log_offset": len(self.lines),
        }


jobs: dict[str, Job] = {}
_job_lock = asyncio.Lock()


def current_job() -> Job | None:
    for j in jobs.values():
        if j.status in ("queued", "running"):
            return j
    return None


def start_job(kind: str, title: str, fn: Callable[[Job], Awaitable[None]]) -> Job:
    running = current_job()
    if running:
        raise HTTPException(409, f"Another job is running: {running.title}")
    job = Job(id=secrets.token_hex(6), kind=kind, title=title)
    jobs[job.id] = job
    for old in sorted(jobs.values(), key=lambda j: j.created)[:-25]:
        jobs.pop(old.id, None)

    async def runner():
        async with _job_lock:
            job.status, job.started = "running", time.time()
            try:
                await fn(job)
                job.status = "done"
                job.log(f"Finished with {job.warnings} warning(s)." if job.warnings else "Finished.")
            except HTTPException as e:
                job.status, job.error = "failed", str(e.detail)
                job.log(f"FAILED: {e.detail}")
            except Exception as e:  # noqa: BLE001
                log.exception("job %s failed", job.id)
                job.status, job.error = "failed", f"{e.__class__.__name__}: {e}"
                job.log(f"FAILED: {job.error}")
            finally:
                job.finished = time.time()
                job.step = ""

    asyncio.create_task(runner())
    return job


# --------------------------------------------------------------------------- subprocess helper
async def run_tool(job: Job, args: list[str], database: str, stdin_file=None,
                   quiet_patterns: tuple[str, ...] = ()) -> tuple[int, int]:
    """Run pg_dump/pg_restore/psql, stream stderr into the job log.
    Returns (exit code, number of error lines)."""
    proc = await asyncio.create_subprocess_exec(
        *args, env=pg_env(database),
        stdin=asyncio.subprocess.PIPE if stdin_file is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    errors = 0
    shown = 0

    async def pump_stdin():
        try:
            while True:
                chunk = await asyncio.to_thread(stdin_file.read, 1024 * 1024)
                if not chunk:
                    break
                proc.stdin.write(chunk)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    async def read_stderr():
        nonlocal errors, shown
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if not text or any(p in text for p in quiet_patterns):
                continue
            is_err = "error" in text.lower()
            errors += is_err
            if shown < 300:
                job.log(text, warn=is_err)
                shown += 1
            elif shown == 300:
                job.log("… more messages hidden", warn=False)
                shown += 1

    async def drain_stdout():
        while await proc.stdout.read(65536):
            pass

    tasks = [read_stderr(), drain_stdout()]
    if stdin_file is not None:
        tasks.append(pump_stdin())
    await asyncio.gather(*tasks)
    return await proc.wait(), errors


# --------------------------------------------------------------------------- inventory
async def _databases(conn: asyncpg.Connection, num: int) -> list[dict]:
    loc = ("d.datlocprovider::text AS provider, "
           + ("d.datlocale" if num >= 170000 else "d.daticulocale") + " AS icu_locale"
           if num >= 150000 else "'c' AS provider, NULL::text AS icu_locale")
    rows = await conn.fetch(
        f"""
        SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
               pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collate, d.datctype AS ctype,
               {loc}, d.datconnlimit AS connection_limit,
               shobj_description(d.oid, 'pg_database') AS comment,
               CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size_bytes,
               COALESCE((SELECT json_agg(json_build_object(
                           'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                           'privilege', a.privilege_type, 'grantable', a.is_grantable))
                         FROM aclexplode(d.datacl) a
                         WHERE a.grantee <> d.datdba), '[]'::json)::text AS acl,
               (d.datacl IS NOT NULL) AS has_acl,
               COALESCE((SELECT s.setconfig FROM pg_db_role_setting s
                         WHERE s.setdatabase = d.oid AND s.setrole = 0), '{{}}') AS settings
        FROM pg_database d
        WHERE NOT d.datistemplate AND d.datallowconn
        ORDER BY d.datname
        """
    )
    out = []
    for r in rows:
        d = dict(r)
        d["acl"] = json.loads(d["acl"])
        d["settings"] = list(d["settings"] or [])
        out.append(d)
    return out


async def _roles(conn: asyncpg.Connection, with_passwords: bool) -> dict:
    pw = "a.rolpassword" if with_passwords else "NULL::text"
    join = "LEFT JOIN pg_authid a ON a.oid = r.oid" if with_passwords else ""
    roles = await conn.fetch(
        f"""
        SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolinherit AS inherit,
               r.rolcreaterole AS createrole, r.rolcreatedb AS createdb, r.rolcanlogin AS login,
               r.rolreplication AS replication, r.rolbypassrls AS bypassrls,
               r.rolconnlimit AS connection_limit, r.rolvaliduntil AS valid_until,
               {pw} AS password, shobj_description(r.oid, 'pg_authid') AS comment
        FROM pg_roles r {join}
        WHERE r.rolname !~ '^pg_'
        ORDER BY r.rolname
        """
    )
    members = await conn.fetch(
        """
        SELECT g.rolname AS role, m.rolname AS member, am.admin_option
        FROM pg_auth_members am
        JOIN pg_roles g ON g.oid = am.roleid
        JOIN pg_roles m ON m.oid = am.member
        WHERE m.rolname !~ '^pg_'
        ORDER BY 1, 2
        """
    )
    role_settings = await conn.fetch(
        """
        SELECT r.rolname AS role, d.datname AS database, s.setconfig AS settings
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid = s.setrole
        LEFT JOIN pg_database d ON d.oid = s.setdatabase
        WHERE s.setrole <> 0 AND r.rolname !~ '^pg_'
        """
    )
    return {
        "roles": [{k: to_json_value(v) for k, v in dict(r).items()} for r in roles],
        "memberships": [dict(m) for m in members],
        "settings": [{"role": s["role"], "database": s["database"], "settings": list(s["settings"])} for s in role_settings],
    }


# --------------------------------------------------------------------------- backup
README_TXT = """central-postgres full-server backup
====================================

Restore it from the panel: Backups -> Upload backup -> Restore.

By hand, without the panel:
  1. tar -xf {name}
  2. Recreate roles from roles.json (names, attributes, password hashes —
     PASSWORD 'SCRAM-SHA-256$...' accepts the stored hash as-is).
  3. For each entry in manifest.json "databases":
       createdb -T template0 -O <owner> -E <encoding> <name>
       pg_restore -d <name> databases/<file>
"""


async def run_full_backup(job: Job, databases: list[str] | None, include_roles: bool,
                          include_passwords: bool, prefix: str = "backup") -> None:
    pool = await pools.get()
    async with pool.acquire() as conn:
        info = await server_info(conn)
        tools = tools_status(info["major"])
        if not tools["ok"]:
            raise HTTPException(501, tools["message"])
        all_dbs = await _databases(conn, info["num"])
        if include_passwords and not info["superuser"]:
            job.log("Connected user is not a superuser: password hashes can't be read, roles are saved without passwords.", warn=True)
            include_passwords = False
        roles = await _roles(conn, include_passwords) if include_roles else None

    selected = [d for d in all_dbs if databases is None or d["name"] in databases]
    skipped = [d["name"] for d in all_dbs if d not in selected]
    no_access = [d["name"] for d in selected if d["size_bytes"] is None]
    if no_access:
        raise HTTPException(403, f"No CONNECT privilege on: {', '.join(no_access)}")
    if not selected:
        raise HTTPException(400, "Nothing selected to back up")

    job.total = len(selected) + 1
    job.log(f"Source: PostgreSQL {info['version']} as {info['user']}"
            f"{' (superuser)' if info['superuser'] else ''}; pg_dump {tools['versions']['pg_dump']}")
    if skipped:
        job.log(f"Not included: {', '.join(skipped)}")

    folder = backup_dir()
    work = folder / f".work-{job.id}"
    work.mkdir(exist_ok=True)
    name = f"{prefix}-{_stamp()}.tar"
    partial = folder / (name + ".partial")
    manifest: dict[str, Any] = {
        "format": BUNDLE_FORMAT,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": {"server_version": info["version"], "server_major": info["major"], "user": info["user"],
                   "superuser": info["superuser"], "bootstrap_role": info["bootstrap"],
                   "pg_dump": tools["versions"]["pg_dump"]},
        "includes_roles": include_roles,
        "includes_passwords": bool(include_roles and include_passwords),
        "databases": [],
    }
    try:
        tar = await asyncio.to_thread(tarfile.open, partial, "w", format=tarfile.PAX_FORMAT)
        try:
            if roles is not None:
                job.step = "Roles"
                data = json.dumps(roles, indent=2).encode()
                await asyncio.to_thread(_tar_bytes, tar, "roles.json", data)
                job.log(f"Saved {len(roles['roles'])} roles and {len(roles['memberships'])} memberships"
                        f"{' with password hashes' if include_passwords else ''}.")
            job.done = 1
            for i, d in enumerate(selected, start=1):
                job.step = f"Dumping {d['name']}"
                arc = f"databases/{i:03d}.dump"
                tmp = work / f"{i:03d}.dump"
                job.log(f"Dumping {d['name']} ({_fmt_bytes(d['size_bytes'])})…")
                t0 = time.time()
                code, _ = await run_tool(job, ["pg_dump", "--no-password", "-Fc", "-Z", "6", "-f", str(tmp)], d["name"])
                if code != 0:
                    raise HTTPException(500, f"pg_dump failed for {d['name']} (exit {code})")
                size = tmp.stat().st_size
                await asyncio.to_thread(tar.add, str(tmp), arcname=arc)
                tmp.unlink()
                entry = {k: d[k] for k in ("name", "owner", "encoding", "collate", "ctype", "provider", "icu_locale",
                                           "connection_limit", "comment", "acl", "has_acl", "settings", "size_bytes")}
                entry.update(file=arc, dump_bytes=size)
                manifest["databases"].append(entry)
                job.log(f"  {d['name']}: {_fmt_bytes(size)} compressed in {time.time() - t0:.1f}s")
                job.done = i + 1
            await asyncio.to_thread(_tar_bytes, tar, "README.txt", README_TXT.format(name=name).encode())
            await asyncio.to_thread(_tar_bytes, tar, "manifest.json", json.dumps(manifest, indent=2, default=str).encode())
        finally:
            await asyncio.to_thread(tar.close)
        partial.rename(folder / name)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    size = (folder / name).stat().st_size
    job.result = {"file": name, "size_bytes": size, "databases": len(selected)}
    job.log(f"Backup saved as {name} ({_fmt_bytes(size)}).")


def _tar_bytes(tar: tarfile.TarFile, arcname: str, data: bytes) -> None:
    ti = tarfile.TarInfo(arcname)
    ti.size = len(data)
    ti.mtime = int(time.time())
    ti.mode = 0o600
    tar.addfile(ti, io.BytesIO(data))


def _fmt_bytes(n) -> str:
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


# --------------------------------------------------------------------------- reading bundles
def read_bundle_meta(path: Path) -> tuple[dict, dict | None]:
    with tarfile.open(path, "r:") as tar:
        try:
            manifest = json.load(tar.extractfile("manifest.json"))
        except KeyError:
            raise HTTPException(400, "This .tar is not a central-postgres backup (no manifest.json)")
        if manifest.get("format") != BUNDLE_FORMAT:
            raise HTTPException(400, f"Unsupported backup format: {manifest.get('format')}")
        roles = None
        if manifest.get("includes_roles"):
            roles = json.load(tar.extractfile("roles.json"))
    return manifest, roles


def list_files() -> list[dict]:
    out = []
    for p in sorted(backup_dir().iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not p.is_file() or p.name.startswith(".") or p.name.endswith(".partial"):
            continue
        st = p.stat()
        entry: dict[str, Any] = {"name": p.name, "size_bytes": st.st_size,
                                 "modified": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat()}
        try:
            kind = detect_kind(p)
            entry["kind"] = kind
            if kind == "bundle":
                m, _ = read_bundle_meta(p)
                entry.update(created_at=m["created_at"], source=m["source"],
                             databases=[d["name"] for d in m["databases"]],
                             includes_roles=m["includes_roles"], includes_passwords=m["includes_passwords"])
        except HTTPException as e:
            entry["kind"], entry["error"] = "unknown", e.detail
        except Exception as e:  # corrupt / truncated
            entry["kind"], entry["error"] = "unknown", str(e)
        out.append(entry)
    return out


async def inspect(name: str) -> dict:
    path = file_path(name)
    kind = detect_kind(path)
    pool = await pools.get()
    async with pool.acquire() as conn:
        info = await server_info(conn)
        existing_dbs = {r["datname"] for r in await conn.fetch("SELECT datname FROM pg_database")}
        existing_roles = {r["rolname"] for r in await conn.fetch("SELECT rolname FROM pg_roles")}
    target = {"server_version": info["version"], "server_major": info["major"], "user": info["user"],
              "superuser": info["superuser"], "protected": sorted(settings.protected_databases),
              "default_database": settings.default_database,
              "tools": tools_status(info["major"])}
    out: dict[str, Any] = {"name": name, "kind": kind, "size_bytes": path.stat().st_size, "target": target}
    if kind != "bundle":
        guess = re.sub(r"(-\d{8}-\d{6})?\.(dump|sql|backup)$", "", re.sub(r"^uploaded-\d{8}-\d{6}-", "", name))
        out["suggested_database"] = guess or "restored"
        out["exists"] = sorted(existing_dbs)
        return out
    manifest, roles = await asyncio.to_thread(read_bundle_meta, path)
    out["manifest"] = {k: v for k, v in manifest.items() if k != "databases"}
    out["databases"] = [
        {**{k: d.get(k) for k in ("name", "owner", "encoding", "size_bytes", "dump_bytes", "comment")},
         "exists": d["name"] in existing_dbs,
         "protected": d["name"] in settings.protected_databases or d["name"] == settings.default_database}
        for d in manifest["databases"]
    ]
    if roles:
        skip = {info["user"], info["bootstrap"]}
        out["roles"] = [
            {"name": r["name"], "login": r["login"], "superuser": r["superuser"],
             "has_password": bool(r.get("password")), "md5_password": bool((r.get("password") or "").startswith("md5")),
             "exists": r["name"] in existing_roles,
             "skipped": r["name"] in skip}
            for r in roles["roles"]
        ]
    return out


# --------------------------------------------------------------------------- restore
def _settings_sql(configs: list[str]) -> list[tuple[str, str]]:
    out = []
    for c in configs:
        k, sep, v = c.partition("=")
        if sep and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", k):
            out.append((k, v))
    return out


async def _restore_roles(job: Job, conn: asyncpg.Connection, roles: dict, info: dict,
                         passwords: bool, update_existing: bool) -> set[str]:
    """Create/update roles. Returns the set of role names that exist afterwards."""
    skip = {info["user"], info["bootstrap"]}
    existing = {r["rolname"] for r in await conn.fetch("SELECT rolname FROM pg_roles")}
    scram_only = (await conn.fetchval("SHOW password_encryption")) == "scram-sha-256"
    md5_roles: list[str] = []
    created = updated = 0
    for r in roles["roles"]:
        name = r["name"]
        if name in skip:
            job.log(f"Role {name}: kept as is (it's the admin role on this server)")
            continue
        is_new = name not in existing
        if not is_new and not update_existing:
            continue
        try:
            if is_new:
                await conn.execute(f"CREATE ROLE {ident(name)}")
                existing.add(name)
            opts = [
                "LOGIN" if r["login"] else "NOLOGIN",
                "INHERIT" if r["inherit"] else "NOINHERIT",
                "CREATEDB" if r["createdb"] else "NOCREATEDB",
                "CREATEROLE" if r["createrole"] else "NOCREATEROLE",
                f"CONNECTION LIMIT {int(r['connection_limit'])}",
            ]
            if info["superuser"]:
                opts += ["SUPERUSER" if r["superuser"] else "NOSUPERUSER",
                         "REPLICATION" if r["replication"] else "NOREPLICATION",
                         "BYPASSRLS" if r["bypassrls"] else "NOBYPASSRLS"]
            elif r["superuser"] or r["replication"] or r["bypassrls"]:
                job.log(f"Role {name}: SUPERUSER/REPLICATION/BYPASSRLS not restored (this server's admin isn't a superuser)", warn=True)
            opts.append(f"VALID UNTIL {literal(str(r['valid_until']))}" if r.get("valid_until") else "VALID UNTIL 'infinity'")
            if passwords and r.get("password"):
                opts.append(f"PASSWORD {literal(r['password'])}")
                if r["password"].startswith("md5") and scram_only:
                    md5_roles.append(name)
            await conn.execute(f"ALTER ROLE {ident(name)} WITH " + " ".join(opts))
            if r.get("comment"):
                await conn.execute(f"COMMENT ON ROLE {ident(name)} IS {literal(r['comment'])}")
            created += is_new
            updated += not is_new
        except asyncpg.PostgresError as e:
            job.log(f"Role {name}: {e}", warn=True)
    job.log(f"Roles: {created} created, {updated} updated.")
    if md5_roles:
        job.log(f"These roles have old MD5 password hashes: {', '.join(md5_roles)}. They can only log in if "
                "pg_hba.conf allows 'md5' auth; otherwise reset their passwords on the Roles page.", warn=True)

    for m in roles.get("memberships", []):
        if m["member"] in skip and m["role"] in skip:
            continue
        if m["role"] not in existing and not m["role"].startswith("pg_"):
            continue
        try:
            await conn.execute(f"GRANT {ident(m['role'])} TO {ident(m['member'])}"
                               + (" WITH ADMIN OPTION" if m["admin_option"] else ""))
        except asyncpg.PostgresError as e:
            job.log(f"Membership {m['member']} → {m['role']}: {e}", warn=True)

    for s in roles.get("settings", []):
        if s["database"] or s["role"] in skip or s["role"] not in existing:
            continue  # per-database ones are applied after the database exists
        for k, v in _settings_sql(s["settings"]):
            try:
                await conn.execute(f"ALTER ROLE {ident(s['role'])} SET {k} = {literal(v)}")
            except asyncpg.PostgresError as e:
                job.log(f"Setting {k} for {s['role']}: {e}", warn=True)
    return existing


async def _create_database(job: Job, conn: asyncpg.Connection, target: str, d: dict,
                           owner_ok: bool, target_num: int) -> None:
    base = f"CREATE DATABASE {ident(target)}"
    if owner_ok:
        base += f" OWNER {ident(d['owner'])}"
    base += f" TEMPLATE template0 ENCODING {literal(d['encoding'])}"
    attempts = []
    loc = f" LC_COLLATE {literal(d['collate'])} LC_CTYPE {literal(d['ctype'])}"
    if d.get("provider") == "i" and d.get("icu_locale") and target_num >= 150000:
        icu_kw = "LOCALE" if target_num >= 170000 else "ICU_LOCALE"
        attempts.append(base + loc + f" LOCALE_PROVIDER icu {icu_kw} {literal(d['icu_locale'])}")
    attempts += [base + loc, base]
    last = None
    for i, sql in enumerate(attempts):
        try:
            await conn.execute(sql)
            if i == len(attempts) - 1 and len(attempts) > 1:
                job.log(f"{target}: original locale ({d['collate']}) not available here; used the server default", warn=True)
            return
        except asyncpg.PostgresError as e:
            last = e
            if "already exists" in str(e):
                raise
    raise last


async def _post_restore_database(job: Job, conn: asyncpg.Connection, target: str, d: dict,
                                 roles_present: set[str], roles: dict | None) -> None:
    q = ident(target)
    stmts: list[str] = []
    if d.get("comment"):
        stmts.append(f"COMMENT ON DATABASE {q} IS {literal(d['comment'])}")
    if d.get("connection_limit", -1) not in (-1, None):
        stmts.append(f"ALTER DATABASE {q} CONNECTION LIMIT {int(d['connection_limit'])}")
    for k, v in _settings_sql(d.get("settings") or []):
        stmts.append(f"ALTER DATABASE {q} SET {k} = {literal(v)}")
    if d.get("has_acl"):
        privs: dict[tuple[str, bool], list[str]] = {}
        for a in d.get("acl") or []:
            if a["grantee"] != "PUBLIC" and a["grantee"] not in roles_present:
                continue
            privs.setdefault((a["grantee"], a["grantable"]), []).append(a["privilege"])
        if not any(g == "PUBLIC" for g, _ in privs):
            stmts.append(f"REVOKE ALL ON DATABASE {q} FROM PUBLIC")
        for (grantee, grantable), pl in privs.items():
            who = "PUBLIC" if grantee == "PUBLIC" else ident(grantee)
            stmts.append(f"GRANT {', '.join(sorted(set(pl)))} ON DATABASE {q} TO {who}"
                         + (" WITH GRANT OPTION" if grantable else ""))
    for s in (roles or {}).get("settings", []):
        if s["database"] == d["name"] and s["role"] in roles_present:
            for k, v in _settings_sql(s["settings"]):
                stmts.append(f"ALTER ROLE {ident(s['role'])} IN DATABASE {q} SET {k} = {literal(v)}")
    for st in stmts:
        try:
            await conn.execute(st)
        except asyncpg.PostgresError as e:
            job.log(f"{target}: {st[:80]}… — {e}", warn=True)


# pg_restore noise that isn't a real problem on a fresh database
_RESTORE_QUIET = ("schema \"public\" already exists", "must be owner of schema public",
                  "must be owner of extension", "warning: errors ignored on restore")


async def run_restore_bundle(job: Job, name: str, plan: dict) -> None:
    path = file_path(name)
    manifest, roles = await asyncio.to_thread(read_bundle_meta, path)
    by_name = {d["name"]: d for d in manifest["databases"]}
    actions = [a for a in plan.get("databases", []) if a.get("action", "skip") != "skip"]
    for a in actions:
        if a["name"] not in by_name:
            raise HTTPException(400, f"'{a['name']}' is not in this backup")

    async with (await pools.get()).acquire() as conn:
        info = await server_info(conn)
    tools = tools_status(info["major"])
    if not tools["ok"] and "Missing" in tools["message"]:
        raise HTTPException(501, tools["message"])
    job.log(f"Restoring {name} (from PostgreSQL {manifest['source']['server_version']}, "
            f"{manifest['created_at'][:19].replace('T', ' ')} UTC) into PostgreSQL {info['version']} as {info['user']}")
    job.total = len(actions) + (1 if plan.get("roles") and roles else 0)

    roles_present: set[str]
    async with (await pools.get()).acquire() as conn:
        if plan.get("roles") and roles:
            job.step = "Roles"
            roles_present = await _restore_roles(job, conn, roles, info, bool(plan.get("passwords", True)),
                                                 bool(plan.get("update_existing_roles", False)))
            job.done += 1
        else:
            roles_present = {r["rolname"] for r in await conn.fetch("SELECT rolname FROM pg_roles")}

    restore_owners = bool(plan.get("roles")) or bool(plan.get("keep_owners", True))
    for a in actions:
        d = by_name[a["name"]]
        target = (a.get("target") or d["name"]).strip()
        action = a["action"]
        job.step = f"Restoring {target}"
        protected = target in settings.protected_databases or target == settings.default_database
        async with (await pools.get()).acquire() as conn:
            exists = bool(await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", target))
            if action == "create" and exists:
                job.log(f"{target}: already exists — skipped (choose Replace or Merge to restore into it)", warn=True)
                job.done += 1
                continue
            if action == "merge" and not exists:
                action = "create"
            if action == "replace":
                if protected:
                    job.log(f"{target}: protected, can't be dropped — merging into it instead", warn=True)
                    action = "merge"
                elif exists:
                    job.log(f"{target}: dropping existing database…")
                    await pools.close(target)
                    await conn.execute(f"DROP DATABASE {ident(target)} WITH (FORCE)")
                    exists = False
                action = "create" if action == "replace" else action
            if action == "create":
                owner_ok = d["owner"] in roles_present
                if not owner_ok:
                    job.log(f"{target}: owner {d['owner']} doesn't exist here; you will own it", warn=True)
                await _create_database(job, conn, target, d, owner_ok, info["num"])
                job.log(f"{target}: created")
        await pools.close(target)

        args = ["pg_restore", "--no-password", "-d", target]
        if action == "merge":
            args += ["--clean", "--if-exists"]
        if not restore_owners:
            args += ["--no-owner", "--no-privileges"]
        job.log(f"{target}: loading data ({_fmt_bytes(d.get('dump_bytes'))} compressed)…")
        t0 = time.time()
        tar = await asyncio.to_thread(tarfile.open, path, "r:")
        try:
            member = tar.extractfile(d["file"])
            code, errors = await run_tool(job, args, target, stdin_file=member, quiet_patterns=_RESTORE_QUIET)
        finally:
            await asyncio.to_thread(tar.close)
        if code not in (0, 1):
            job.log(f"{target}: pg_restore exited with {code}", warn=True)
        job.log(f"{target}: done in {time.time() - t0:.1f}s" + (f" ({errors} error message(s) above)" if errors else ""))

        async with (await pools.get()).acquire() as conn:
            if d["owner"] in roles_present and action != "merge":
                try:
                    await conn.execute(f"ALTER DATABASE {ident(target)} OWNER TO {ident(d['owner'])}")
                except asyncpg.PostgresError as e:
                    job.log(f"{target}: owner — {e}", warn=True)
            await _post_restore_database(job, conn, target, d, roles_present, roles)
        if not restore_owners:
            # --no-owner made the panel's login own everything; hand it to the database owner
            try:
                async with (await pools.get(target)).acquire() as tconn:
                    res = await ownership.transfer(tconn)
                if res["changed"]:
                    job.log(f"{target}: {res['changed']} object(s) now owned by {res['target']}")
                for f in res["failed"][:5]:
                    job.log(f"{target}: {f['sql']} — {f['error']}", warn=True)
            except asyncpg.PostgresError as e:
                job.log(f"{target}: ownership — {e}", warn=True)
        job.done += 1

    _reset_caches()
    job.result = {"databases": [a.get("target") or a["name"] for a in actions]}


async def run_restore_file(job: Job, name: str, target: str, action: str) -> None:
    """Restore a single-database .dump (pg_dump -Fc) or .sql file."""
    path = file_path(name)
    kind = detect_kind(path)
    if kind == "bundle":
        raise HTTPException(400, "This is a full backup; use the bundle restore")
    target = target.strip()
    if not target:
        raise HTTPException(400, "Pick a target database")
    job.total = 1
    protected = target in settings.protected_databases or target == settings.default_database
    async with (await pools.get()).acquire() as conn:
        exists = bool(await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", target))
        if action == "replace" and exists:
            if protected:
                raise HTTPException(400, f"'{target}' is protected and can't be dropped; use Merge")
            await pools.close(target)
            await conn.execute(f"DROP DATABASE {ident(target)} WITH (FORCE)")
            exists = False
            job.log(f"{target}: dropped")
        if not exists:
            await conn.execute(f"CREATE DATABASE {ident(target)}")
            job.log(f"{target}: created")
        elif action == "create":
            raise HTTPException(400, f"Database '{target}' already exists; choose Replace or Merge")
    await pools.close(target)
    job.step = f"Restoring {target}"
    t0 = time.time()
    with open(path, "rb") as f:
        if kind == "dump":
            args = ["pg_restore", "--no-password", "-d", target]
            if exists:
                args += ["--clean", "--if-exists"]
            code, errors = await run_tool(job, args, target, stdin_file=f, quiet_patterns=_RESTORE_QUIET)
        else:
            args = ["psql", "--no-password", "-X", "-q", "-v", "ON_ERROR_STOP=0", "-d", target, "-f", "-"]
            code, errors = await run_tool(job, args, target, stdin_file=f)
    job.log(f"{target}: done in {time.time() - t0:.1f}s" + (f" ({errors} error message(s) above)" if errors else ""))
    job.done = 1
    _reset_caches()
    job.result = {"databases": [target]}


def _reset_caches() -> None:
    appkeys._cache.clear()
    appkeys._meta_ready = False


# --------------------------------------------------------------------------- automatic backups
_next_auto: float | None = None


def next_auto_run() -> float | None:
    return _next_auto


def prune_auto(keep: int) -> list[str]:
    files = sorted((p for p in backup_dir().glob("auto-*.tar")), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    for p in files[keep:]:
        p.unlink(missing_ok=True)
        removed.append(p.name)
    return removed


async def auto_backup_loop() -> None:
    global _next_auto
    interval = settings.auto_backup_hours * 3600
    while True:
        _next_auto = time.time() + interval
        await asyncio.sleep(interval)
        if current_job():
            log.warning("Auto backup skipped: another job is running")
            continue

        async def work(job: Job):
            await run_full_backup(job, None, True, True, prefix="auto")
            removed = prune_auto(settings.auto_backup_keep)
            if removed:
                job.log(f"Removed old automatic backups: {', '.join(removed)}")

        try:
            start_job("auto-backup", "Automatic full backup", work)
        except HTTPException:
            pass
