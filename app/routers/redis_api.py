"""Central Redis tenant API, now served by central-postgres.

    https://postgres.mohammadramiz.in/redis/{project_id}/get/{key}
    header:  x-api-key: sk_live_…      (Authorization: Bearer sk_live_… also works)

Endpoints, request bodies and responses are identical to the old standalone
service — only the base URL gained the `/redis` prefix.
"""
from __future__ import annotations

from typing import Annotated, Any, Callable, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field

from .. import redis_control as ctl
from .. import redis_core as rc


class _ErrorCapturingRoute(APIRoute):
    """Remembers an HTTPException's detail so the metrics middleware can log it."""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def wrapped(request: Request):
            try:
                return await handler(request)
            except HTTPException as e:
                request.state.redis_error = str(e.detail)
                raise
        return wrapped


router = APIRouter(prefix="/redis", tags=["Central Redis (sk_live_ keys)"], route_class=_ErrorCapturingRoute)


async def tenant(request: Request, project_id: str,
                 x_api_key: Optional[str] = Header(None, description="Project API key (sk_live_…)"),
                 authorization: Optional[str] = Header(None, include_in_schema=False)) -> str:
    raw = x_api_key
    if not raw and authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    key_id = await ctl.authorise(project_id, raw)
    request.state.redis_project = project_id
    request.state.redis_key_id = key_id
    return project_id


# --------------------------------------------------------------------------- bodies
class SetBody(BaseModel):
    value: Any
    ttl: Optional[int] = Field(default=None, ge=1)


class MSetBody(BaseModel):
    pairs: dict[str, Any]
    ttl: Optional[int] = Field(default=None, ge=1)


class ExpireBody(BaseModel):
    ttl: int = Field(ge=1)


class PushBody(BaseModel):
    values: list[Any]


class HSetBody(BaseModel):
    mapping: dict[str, Any]


class MembersBody(BaseModel):
    members: list[Any]


class IncrBody(BaseModel):
    by: int = 1


# --------------------------------------------------------------------------- shared operations
# Used by both the public routes below and the panel's console, so the two can
# never drift apart.
OPERATIONS: dict[str, tuple[str, str, bool]] = {
    # name: (http method, path template, needs key)
    "get": ("GET", "/get/{key}", True),
    "set": ("POST", "/set/{key}", True),
    "delete": ("DELETE", "/delete/{key}", True),
    "expire": ("POST", "/expire/{key}", True),
    "ttl": ("GET", "/ttl/{key}", True),
    "incr": ("POST", "/incr/{key}", True),
    "mset": ("POST", "/mset", False),
    "mget": ("POST", "/mget", False),
    "lpush": ("POST", "/lpush/{key}", True),
    "rpush": ("POST", "/rpush/{key}", True),
    "lrange": ("GET", "/lrange/{key}", True),
    "lpop": ("DELETE", "/lpop/{key}", True),
    "rpop": ("DELETE", "/rpop/{key}", True),
    "hset": ("POST", "/hset/{key}", True),
    "hget": ("GET", "/hget/{key}/{field}", True),
    "hgetall": ("GET", "/hgetall/{key}", True),
    "hdel": ("DELETE", "/hdel/{key}/{field}", True),
    "sadd": ("POST", "/sadd/{key}", True),
    "smembers": ("GET", "/smembers/{key}", True),
    "srem": ("POST", "/srem/{key}", True),
    "keys": ("GET", "/keys", False),
    "scan": ("GET", "/scan", False),
    "flush": ("DELETE", "/flush", False),
}
OPERATION_GROUPS = {
    "Strings": ["get", "set", "delete", "expire", "ttl", "incr", "mset", "mget"],
    "Lists": ["lpush", "rpush", "lrange", "lpop", "rpop"],
    "Hashes": ["hset", "hget", "hgetall", "hdel"],
    "Sets": ["sadd", "smembers", "srem"],
    "Keys": ["keys", "scan", "flush"],
}


def _need(cond, message: str) -> None:
    if not cond:
        raise HTTPException(400, message)


async def run_operation(op: str, project_id: str, key: str = "", field: str = "", body: dict | None = None) -> Any:
    r = await rc.client()
    body = body or {}
    ns = lambda k: rc.namespaced(project_id, k)  # noqa: E731
    ser, de = rc.serialise, rc.deserialise

    if op == "get":
        raw = await r.get(ns(key))
        return {"key": key, "value": de(raw), "exists": raw is not None}
    if op == "set":
        ttl = body.get("ttl")
        if ttl:
            await r.setex(ns(key), int(ttl), ser(body.get("value")))
        else:
            await r.set(ns(key), ser(body.get("value")))
        return {"ok": True, "key": key, "ttl": ttl}
    if op == "delete":
        return {"ok": True, "deleted": (await r.delete(ns(key))) > 0}
    if op == "expire":
        return {"ok": bool(await r.expire(ns(key), int(body.get("ttl") or 60)))}
    if op == "ttl":
        return {"key": key, "ttl": await r.ttl(ns(key))}
    if op == "incr":
        try:
            return {"key": key, "value": await r.incrby(ns(key), int(body.get("by", 1)))}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(409, f"Key '{key}' does not hold an integer") from exc
    if op == "mset":
        pairs = body.get("pairs") or {}
        if not pairs:
            return {"ok": True, "count": 0}
        mapping = {ns(k): ser(v) for k, v in pairs.items()}
        pipe = r.pipeline(transaction=False)
        pipe.mset(mapping)
        if body.get("ttl"):
            for fk in mapping:
                pipe.expire(fk, int(body["ttl"]))
        await pipe.execute()
        return {"ok": True, "count": len(mapping)}
    if op == "mget":
        keys = body.get("keys") or []
        if not keys:
            return {"result": {}}
        values = await r.mget([ns(k) for k in keys])
        return {"result": {k: de(v) for k, v in zip(keys, values)}}
    if op in {"lpush", "rpush"}:
        values = body.get("values") or []
        _need(values, "values must not be empty")
        push = r.lpush if op == "lpush" else r.rpush
        return {"ok": True, "length": await push(ns(key), *[ser(v) for v in values])}
    if op == "lrange":
        values = await r.lrange(ns(key), int(body.get("start", 0)), int(body.get("end", -1)))
        return {"key": key, "values": [de(v) for v in values]}
    if op in {"lpop", "rpop"}:
        pop = r.lpop if op == "lpop" else r.rpop
        return {"value": de(await pop(ns(key)))}
    if op == "hset":
        mapping = body.get("mapping") or {}
        _need(mapping, "mapping must not be empty")
        await r.hset(ns(key), mapping={f: ser(v) for f, v in mapping.items()})
        return {"ok": True, "fields": len(mapping)}
    if op == "hget":
        value = await r.hget(ns(key), field)
        return {"field": field, "value": de(value), "exists": value is not None}
    if op == "hgetall":
        return {"key": key, "value": {f: de(v) for f, v in (await r.hgetall(ns(key))).items()}}
    if op == "hdel":
        return {"ok": True, "deleted": (await r.hdel(ns(key), field)) > 0}
    if op in {"sadd", "srem"}:
        members = body.get("members") or []
        _need(members, "members must not be empty")
        call = r.sadd if op == "sadd" else r.srem
        n = await call(ns(key), *[ser(m) for m in members])
        return {"ok": True, ("added" if op == "sadd" else "removed"): n}
    if op == "smembers":
        return {"key": key, "members": [de(m) for m in await r.smembers(ns(key))]}
    if op in {"keys", "scan"}:
        limit = int(body.get("limit") or (200 if op == "keys" else 50))
        res = await rc.scan_keys(r, project_id, pattern=str(body.get("pattern") or "*"),
                                 cursor=int(body.get("cursor") or 0), limit=min(max(limit, 1), 1000),
                                 sizes=op == "scan")
        if op == "keys":
            return {"project": project_id, "keys": [e["key"] for e in res["keys"]], "count": len(res["keys"]),
                    "cursor": res["cursor"], "done": res["done"]}
        return res
    if op == "flush":
        return {"ok": True, "deleted": await rc.flush_project(r, project_id)}
    raise HTTPException(400, f"Unknown operation '{op}'")


# --------------------------------------------------------------------------- public routes
P = Depends(tenant)


@router.get("/{project_id}/get/{key:path}")
async def get_value(key: str, project_id: str = P):
    return await run_operation("get", project_id, key)


@router.post("/{project_id}/set/{key:path}")
async def set_value(key: str, body: SetBody, project_id: str = P):
    return await run_operation("set", project_id, key, body=body.model_dump())


@router.delete("/{project_id}/delete/{key:path}")
async def delete_value(key: str, project_id: str = P):
    return await run_operation("delete", project_id, key)


@router.post("/{project_id}/expire/{key:path}")
async def set_expiry(key: str, body: ExpireBody, project_id: str = P):
    return await run_operation("expire", project_id, key, body=body.model_dump())


@router.get("/{project_id}/ttl/{key:path}")
async def get_ttl(key: str, project_id: str = P):
    return await run_operation("ttl", project_id, key)


@router.post("/{project_id}/incr/{key:path}")
async def increment(key: str, body: IncrBody, project_id: str = P):
    return await run_operation("incr", project_id, key, body=body.model_dump())


@router.post("/{project_id}/mset")
async def multi_set(body: MSetBody, project_id: str = P):
    return await run_operation("mset", project_id, body=body.model_dump())


@router.post("/{project_id}/mget")
async def multi_get(keys: Annotated[list[str], Body(...)], project_id: str = P):
    return await run_operation("mget", project_id, body={"keys": keys})


@router.post("/{project_id}/lpush/{key:path}")
async def list_push_left(key: str, body: PushBody, project_id: str = P):
    return await run_operation("lpush", project_id, key, body=body.model_dump())


@router.post("/{project_id}/rpush/{key:path}")
async def list_push_right(key: str, body: PushBody, project_id: str = P):
    return await run_operation("rpush", project_id, key, body=body.model_dump())


@router.get("/{project_id}/lrange/{key:path}")
async def list_range(key: str, start: int = 0, end: int = -1, project_id: str = P):
    return await run_operation("lrange", project_id, key, body={"start": start, "end": end})


@router.delete("/{project_id}/lpop/{key:path}")
async def list_pop_left(key: str, project_id: str = P):
    return await run_operation("lpop", project_id, key)


@router.delete("/{project_id}/rpop/{key:path}")
async def list_pop_right(key: str, project_id: str = P):
    return await run_operation("rpop", project_id, key)


@router.post("/{project_id}/hset/{key:path}")
async def hash_set(key: str, body: HSetBody, project_id: str = P):
    return await run_operation("hset", project_id, key, body=body.model_dump())


@router.get("/{project_id}/hget/{key}/{field}")
async def hash_get(key: str, field: str, project_id: str = P):
    return await run_operation("hget", project_id, key, field)


@router.get("/{project_id}/hgetall/{key:path}")
async def hash_get_all(key: str, project_id: str = P):
    return await run_operation("hgetall", project_id, key)


@router.delete("/{project_id}/hdel/{key}/{field}")
async def hash_delete(key: str, field: str, project_id: str = P):
    return await run_operation("hdel", project_id, key, field)


@router.post("/{project_id}/sadd/{key:path}")
async def set_add(key: str, body: MembersBody, project_id: str = P):
    return await run_operation("sadd", project_id, key, body=body.model_dump())


@router.get("/{project_id}/smembers/{key:path}")
async def set_members(key: str, project_id: str = P):
    return await run_operation("smembers", project_id, key)


@router.post("/{project_id}/srem/{key:path}")
async def set_remove(key: str, body: MembersBody, project_id: str = P):
    return await run_operation("srem", project_id, key, body=body.model_dump())


@router.get("/{project_id}/keys")
async def list_keys(project_id: str = P, pattern: str = Query("*"), cursor: int = Query(0, ge=0),
                    limit: int = Query(200, ge=1, le=1000)):
    """Paginated with SCAN: pass the returned `cursor` back until `done` is true."""
    return await run_operation("keys", project_id, body={"pattern": pattern, "cursor": cursor, "limit": limit})


@router.get("/{project_id}/scan")
async def scan_detailed(project_id: str = P, pattern: str = Query("*"), cursor: int = Query(0, ge=0),
                        limit: int = Query(50, ge=1, le=500)):
    """Like /keys, plus type, TTL and size for each key."""
    return await run_operation("scan", project_id, body={"pattern": pattern, "cursor": cursor, "limit": limit})


@router.delete("/{project_id}/flush")
async def flush(project_id: str = P):
    return await run_operation("flush", project_id)
