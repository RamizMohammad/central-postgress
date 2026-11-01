"""Panel API for Central Redis: server status, projects, data browser, API keys,
usage and the console. Same authentication as the rest of the panel."""
from __future__ import annotations

import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import redis_control as ctl
from .. import redis_core as rc
from ..auth import require_auth
from ..config import settings
from .redis_api import OPERATION_GROUPS, OPERATIONS, run_operation

router = APIRouter(prefix="/api/redis", tags=["Central Redis (panel)"], dependencies=[Depends(require_auth)])

RANGE_HOURS = {"24h": 24, "7d": 24 * 7, "30d": 24 * 30}


def _base(request: Request, project_id: str) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/redis/{project_id}"


# --------------------------------------------------------------------------- server
_INFO_FIELDS = (
    "redis_version", "redis_mode", "os", "uptime_in_seconds", "connected_clients", "blocked_clients",
    "used_memory", "used_memory_human", "used_memory_peak", "used_memory_peak_human", "maxmemory",
    "maxmemory_human", "maxmemory_policy", "mem_fragmentation_ratio", "total_connections_received",
    "total_commands_processed", "instantaneous_ops_per_sec", "keyspace_hits", "keyspace_misses",
    "expired_keys", "evicted_keys", "rejected_connections", "role", "connected_slaves",
    "aof_enabled", "rdb_last_save_time", "rdb_changes_since_last_save", "rdb_last_bgsave_status",
)


@router.get("/status")
async def status():
    if not rc.enabled():
        return {"enabled": False, "connected": False, "error": "REDIS_URL is not set"}
    try:
        r = await rc.client()
        t0 = time.perf_counter()
        await r.ping()
        ping_ms = round((time.perf_counter() - t0) * 1000, 2)
        info = await r.info()
        dbsize = await r.dbsize()
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "connected": False, "error": str(e)}
    hits, misses = info.get("keyspace_hits", 0), info.get("keyspace_misses", 0)
    return {
        "enabled": True,
        "connected": True,
        "ping_ms": ping_ms,
        "dbsize": dbsize,
        "hit_rate": round(hits / (hits + misses) * 100, 2) if hits + misses else None,
        "info": {k: info.get(k) for k in _INFO_FIELDS if k in info},
        "keyspace": {k: v for k, v in info.items() if k.startswith("db") and isinstance(v, dict)},
        "url_host": settings.redis_url.split("@")[-1].split("/")[0],
    }


# --------------------------------------------------------------------------- projects
class CreateProject(BaseModel):
    project_id: str
    name: str = ""
    description: str = ""


class UpdateProject(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    default_ttl: Optional[int] = Field(default=None, ge=0)
    apply_default_ttl: Optional[bool] = None


@router.get("/projects")
async def list_projects(request: Request, stats: bool = True):
    projects = await ctl.list_projects()
    if stats and rc.enabled():
        r = await rc.client()
        for p in projects:
            try:
                s = await rc.project_stats(r, p["id"], sample_limit=2000)
                u = await rc.summary(r, p["id"], hours=24)
            except Exception:  # noqa: BLE001
                s, u = {"keys": None, "bytes": None}, {"requests": None, "errors": None}
            p.update(keys=s["keys"], bytes=s["bytes"], requests_24h=u["requests"], errors_24h=u["errors"])
    for p in projects:
        p["base_url"] = _base(request, p["id"])
    return projects


@router.post("/projects", status_code=201)
async def create_project(body: CreateProject, request: Request):
    project, key, key_rec = await ctl.create_project(body.project_id, body.name, body.description)
    project["base_url"] = _base(request, project["id"])
    return {"project": project, "api_key": key, "key": key_rec}


@router.get("/projects/{project_id}")
async def get_project(project_id: str, request: Request):
    project = await ctl.get_project(project_id)
    project["base_url"] = _base(request, project_id)
    r = await rc.client()
    project["stats"] = await rc.project_stats(r, project_id)
    project["usage_24h"] = await rc.summary(r, project_id, 24)
    return project


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, body: UpdateProject):
    fields = body.model_dump()
    if fields.get("name") is not None:
        fields["name"] = fields["name"].strip()[:120] or project_id
    if fields.get("description") is not None:
        fields["description"] = fields["description"].strip()[:500]
    return await ctl.update_project(project_id, fields)


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str):
    await ctl.get_project(project_id)
    deleted = 0
    if rc.enabled():
        r = await rc.client()
        deleted = await rc.flush_project(r, project_id)
        await rc.purge_metrics(r, project_id)
    await ctl.delete_project(project_id)
    return {"ok": True, "keys_deleted": deleted}


@router.post("/projects/{project_id}/flush")
async def flush_project(project_id: str):
    await ctl.get_project(project_id)
    return {"ok": True, "deleted": await rc.flush_project(await rc.client(), project_id)}


# --------------------------------------------------------------------------- data browser
class WriteKey(BaseModel):
    type: str = "string"
    value: Any = None
    ttl: Optional[int] = Field(default=None, ge=0)


class TtlBody(BaseModel):
    ttl: Optional[int] = Field(default=None, ge=1, description="Seconds; null removes the expiry")


@router.get("/projects/{project_id}/browse")
async def browse(project_id: str, pattern: str = Query("*"), cursor: int = Query(0, ge=0),
                 limit: int = Query(50, ge=1, le=500), type: Optional[str] = Query(None)):
    await ctl.get_project(project_id)
    return await rc.scan_keys(await rc.client(), project_id, pattern=pattern, cursor=cursor, limit=limit,
                              type_filter=type if type and type != "all" else None)


@router.get("/projects/{project_id}/keys/{key:path}")
async def read_key(project_id: str, key: str):
    entry = await rc.read_key(await rc.client(), project_id, key)
    if entry is None:
        raise HTTPException(404, f"Key '{key}' not found")
    return entry


@router.put("/projects/{project_id}/keys/{key:path}")
async def write_key(project_id: str, key: str, body: WriteKey):
    project = await ctl.get_project(project_id)
    if not key.strip():
        raise HTTPException(400, "Key name is required")
    ttl = body.ttl
    if not ttl and project["apply_default_ttl"] and project["default_ttl"]:
        ttl = project["default_ttl"]
    r = await rc.client()
    await rc.write_key(r, project_id, key, key_type=body.type, value=body.value, ttl=ttl)
    return await rc.read_key(r, project_id, key)


@router.post("/projects/{project_id}/ttl/{key:path}")
async def set_ttl(project_id: str, key: str, body: TtlBody):
    r = await rc.client()
    full = rc.namespaced(project_id, key)
    ok = await (r.expire(full, body.ttl) if body.ttl else r.persist(full))
    return {"ok": bool(ok) or not body.ttl, "ttl": await r.ttl(full)}


@router.delete("/projects/{project_id}/keys/{key:path}")
async def delete_key(project_id: str, key: str):
    return {"ok": True, "deleted": bool(await (await rc.client()).delete(rc.namespaced(project_id, key)))}


# --------------------------------------------------------------------------- api keys
class NewKey(BaseModel):
    name: str = "Untitled key"


@router.get("/projects/{project_id}/api-keys")
async def list_api_keys(project_id: str):
    return await ctl.list_keys(project_id)


@router.post("/projects/{project_id}/api-keys", status_code=201)
async def create_api_key(project_id: str, body: NewKey):
    await ctl.get_project(project_id)
    key, rec = await ctl.create_key(project_id, body.name)
    return {"api_key": key, "key": rec}


@router.post("/projects/{project_id}/api-keys/{key_id}/rotate")
async def rotate_api_key(project_id: str, key_id: str):
    key, rec = await ctl.rotate_key(project_id, key_id)
    return {"api_key": key, "key": rec}


@router.delete("/projects/{project_id}/api-keys/{key_id}")
async def delete_api_key(project_id: str, key_id: str):
    await ctl.delete_key(project_id, key_id)
    return {"ok": True}


# --------------------------------------------------------------------------- usage
@router.get("/projects/{project_id}/usage")
async def usage(project_id: str, range: str = Query("24h")):
    await ctl.get_project(project_id)
    hours = RANGE_HOURS.get(range, 24)
    r = await rc.client()
    return {
        "range": range,
        "summary": await rc.summary(r, project_id, hours),
        "series": await rc.series(r, project_id, hours, group_by_day=hours > 48),
        "top_keys": await rc.top_keys_by_size(r, project_id),
        "errors": await rc.recent_errors(r, project_id, 20),
        "recent": await rc.recent(r, project_id, 30),
    }


# --------------------------------------------------------------------------- console
class ConsoleBody(BaseModel):
    operation: str
    key: str = ""
    field: str = ""
    body: dict[str, Any] = Field(default_factory=dict)


@router.get("/console/operations")
async def console_operations():
    return {"groups": OPERATION_GROUPS,
            "specs": {k: {"method": m, "path": p, "needs_key": n} for k, (m, p, n) in OPERATIONS.items()}}


@router.post("/projects/{project_id}/console")
async def console(project_id: str, body: ConsoleBody):
    """Runs an operation exactly as the public API would, without needing a key."""
    await ctl.get_project(project_id)
    spec = OPERATIONS.get(body.operation)
    if not spec:
        raise HTTPException(400, f"Unknown operation '{body.operation}'")
    method, template, needs_key = spec
    key = body.key.strip()
    if needs_key and not key:
        raise HTTPException(400, f"'{body.operation}' needs a key")
    path = template.replace("{key}", key).replace("{field}", body.field.strip())
    t0 = time.perf_counter()
    try:
        result, code = await run_operation(body.operation, project_id, key, body.field.strip(), body.body), 200
    except HTTPException as e:
        result, code = {"detail": e.detail}, e.status_code
    except Exception as e:  # noqa: BLE001 - show the Redis error in the console
        result, code = {"detail": str(e)}, 500
    ms = (time.perf_counter() - t0) * 1000
    await rc.record(project_id, operation=body.operation, method=method, path=path, status=code,
                    duration_ms=ms, error=result.get("detail") if code >= 400 and isinstance(result, dict) else None)
    return {"status": code, "duration_ms": round(ms, 2), "method": method, "path": f"/redis/{project_id}{path}", "result": result}


# --------------------------------------------------------------------------- import
class ImportBody(BaseModel):
    mongodb_uri: str = ""
    database: str = "central_redis"


@router.post("/import")
async def import_mongo(body: ImportBody):
    uri = body.mongodb_uri.strip() or settings.redis_import_mongodb_uri
    if not uri:
        raise HTTPException(400, "Paste the old service's MONGODB_URI (or set REDIS_IMPORT_MONGODB_URI in .env).")
    return await ctl.import_from_mongo(uri, body.database.strip() or "central_redis")
