"""Central Redis: the Redis client, tenant keyspace access, and request metrics.

Merged from the standalone central_redis service. Every tenant key is stored as
`{project_id}:{key}`; nothing here reads or writes outside that prefix. Metrics
live under `_m:{project_id}:…` so they can never collide with tenant data.

Listing uses SCAN with a cursor, never KEYS: KEYS is O(N) and blocks the whole
server, so one large project would stall every other client of the instance.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from .config import settings

try:
    import redis.asyncio as aioredis
except ImportError:  # pragma: no cover - requirements.txt installs it
    aioredis = None

# --------------------------------------------------------------------------- client
_client = None
_lock = asyncio.Lock()


def enabled() -> bool:
    return bool(settings.redis_url) and aioredis is not None


async def client():
    """Shared async client (it pools connections internally)."""
    global _client
    if not enabled():
        raise HTTPException(503, "Redis is not configured. Set REDIS_URL in .env (e.g. redis://central-redis:6379/0).")
    if _client is None:
        async with _lock:
            if _client is None:
                _client = aioredis.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=5,
                    socket_timeout=15,
                    health_check_interval=30,
                    max_connections=settings.redis_pool_max,
                )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # noqa: BLE001
            pass
        _client = None


# --------------------------------------------------------------------------- keyspace
SCAN_PAGE = 50
MAX_SCAN_ITERATIONS = 40  # bounds the work when a pattern matches nothing

TYPE_LABELS = {"string": "STR", "list": "LST", "hash": "HSH", "set": "SET", "zset": "ZST", "stream": "STM", "none": "—"}


def namespaced(project_id: str, key: str) -> str:
    return f"{project_id}:{key}"


def strip_namespace(project_id: str, full_key: str) -> str:
    prefix = f"{project_id}:"
    return full_key[len(prefix):] if full_key.startswith(prefix) else full_key


def serialise(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def deserialise(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


async def _memory_usage(r, full_key: str) -> int | None:
    try:
        return await r.memory_usage(full_key)
    except Exception:  # noqa: BLE001 - not available on every Redis-compatible server
        return None


async def scan_keys(r, project_id: str, *, pattern: str = "*", cursor: int = 0,
                    limit: int = SCAN_PAGE, type_filter: str | None = None, sizes: bool = True) -> dict:
    """One page of keys with type, TTL and size. A returned cursor of 0 means done."""
    match = namespaced(project_id, pattern.strip() or "*")
    collected: list[str] = []
    iterations = 0
    while len(collected) < limit and iterations < MAX_SCAN_ITERATIONS:
        iterations += 1
        cursor, batch = await r.scan(cursor=cursor, match=match, count=max(limit * 2, 100))
        collected.extend(batch)
        if cursor == 0:
            break
    collected = collected[:limit]
    if not collected:
        return {"keys": [], "cursor": int(cursor), "done": int(cursor) == 0}

    pipe = r.pipeline(transaction=False)
    for full_key in collected:
        pipe.type(full_key)
        pipe.ttl(full_key)
        if sizes:
            pipe.memory_usage(full_key)
    raw = await pipe.execute(raise_on_error=False)
    step = 3 if sizes else 2

    entries = []
    for i, full_key in enumerate(collected):
        key_type = raw[i * step] or "none"
        ttl = raw[i * step + 1]
        size = raw[i * step + 2] if sizes else None
        if type_filter and key_type != type_filter:
            continue
        entries.append({
            "key": strip_namespace(project_id, full_key),
            "type": key_type,
            "type_label": TYPE_LABELS.get(key_type, str(key_type).upper()[:3]),
            "ttl": None if ttl in (-1, -2) else ttl,
            "persistent": ttl == -1,
            "size": size if isinstance(size, int) else None,
        })
    return {"keys": entries, "cursor": int(cursor), "done": int(cursor) == 0}


async def read_key(r, project_id: str, key: str) -> dict | None:
    """Type-aware read; None when the key does not exist."""
    full_key = namespaced(project_id, key)
    key_type = await r.type(full_key)
    if key_type in (None, "none"):
        return None
    if key_type == "string":
        value: Any = deserialise(await r.get(full_key))
    elif key_type == "list":
        value = [deserialise(v) for v in await r.lrange(full_key, 0, 999)]
    elif key_type == "hash":
        value = {f: deserialise(v) for f, v in (await r.hgetall(full_key)).items()}
    elif key_type == "set":
        value = [deserialise(v) for v in await r.smembers(full_key)]
    elif key_type == "zset":
        value = [{"member": deserialise(m), "score": s} for m, s in await r.zrange(full_key, 0, 999, withscores=True)]
    else:
        value = None
    ttl = await r.ttl(full_key)
    length = None
    if key_type == "list":
        length = await r.llen(full_key)
    return {
        "key": key,
        "type": key_type,
        "type_label": TYPE_LABELS.get(key_type, str(key_type).upper()[:3]),
        "value": value,
        "length": length,
        "ttl": None if ttl in (-1, -2) else ttl,
        "persistent": ttl == -1,
        "size": await _memory_usage(r, full_key),
    }


async def write_key(r, project_id: str, key: str, *, key_type: str, value: Any, ttl: int | None = None) -> None:
    """Replace a key with a value of the given type (deleting first makes type changes safe)."""
    full_key = namespaced(project_id, key)
    pipe = r.pipeline(transaction=True)
    pipe.delete(full_key)
    if key_type == "string":
        pipe.set(full_key, serialise(value))
    elif key_type == "list":
        items = value if isinstance(value, list) else [value]
        if items:
            pipe.rpush(full_key, *[serialise(v) for v in items])
    elif key_type == "hash":
        mapping = value if isinstance(value, dict) else {}
        if mapping:
            pipe.hset(full_key, mapping={f: serialise(v) for f, v in mapping.items()})
    elif key_type == "set":
        items = value if isinstance(value, list) else [value]
        if items:
            pipe.sadd(full_key, *[serialise(v) for v in items])
    else:
        raise HTTPException(400, "type must be one of: string, list, hash, set")
    if ttl and ttl > 0:
        pipe.expire(full_key, ttl)
    await pipe.execute()


async def project_stats(r, project_id: str, sample_limit: int = 5000) -> dict:
    """Key count and approximate memory. Exact up to `sample_limit` keys, then
    extrapolated from a 500-key size sample so big projects stay fast."""
    count = total = measured = 0
    truncated = False
    try:
        async for full_key in r.scan_iter(match=f"{project_id}:*", count=500):
            count += 1
            if measured < 500:
                size = await _memory_usage(r, full_key)
                if size:
                    total += size
                    measured += 1
            if count >= sample_limit:
                truncated = True
                break
    except Exception:  # noqa: BLE001
        pass
    return {
        "keys": count,
        "bytes": int(total / measured * count) if measured else 0,
        "exact": not truncated and measured >= min(count, 500),
        "truncated": truncated,
    }


async def flush_project(r, project_id: str) -> int:
    deleted = 0
    batch: list[str] = []
    async for full_key in r.scan_iter(match=f"{project_id}:*", count=500):
        batch.append(full_key)
        if len(batch) >= 500:
            deleted += await r.delete(*batch)
            batch = []
    if batch:
        deleted += await r.delete(*batch)
    return deleted


async def top_keys_by_size(r, project_id: str, limit: int = 8, scan_limit: int = 2000) -> list[dict]:
    entries: list[dict] = []
    scanned = 0
    try:
        async for full_key in r.scan_iter(match=f"{project_id}:*", count=500):
            scanned += 1
            size = await _memory_usage(r, full_key)
            if size:
                entries.append({"key": strip_namespace(project_id, full_key), "type": await r.type(full_key), "size": size})
            if scanned >= scan_limit:
                break
    except Exception:  # noqa: BLE001
        return []
    entries.sort(key=lambda e: e["size"], reverse=True)
    return entries[:limit]


# --------------------------------------------------------------------------- metrics
LATENCY_BUCKETS_MS = (1, 2, 5, 10, 25, 50, 100, 250, 500, 1000)
RETENTION_SECONDS = 35 * 24 * 3600
RECENT_MAX, ERRORS_MAX = 100, 50
READ_OPS = ("get", "mget", "lrange", "hget", "hgetall", "ttl", "keys", "scan", "smembers")
WRITE_OPS = ("set", "mset", "incr", "expire", "lpush", "rpush", "lpop", "rpop", "hset", "hdel", "delete", "flush", "sadd", "srem")


def _hour_key(project_id: str, moment: datetime) -> str:
    return f"_m:{project_id}:h:{moment.strftime('%Y%m%d%H')}"


def _hours_back(count: int) -> list[datetime]:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return [now - timedelta(hours=o) for o in range(count - 1, -1, -1)]


def _bucket_for(ms: float) -> str:
    for edge in LATENCY_BUCKETS_MS:
        if ms <= edge:
            return str(edge)
    return "inf"


async def record(project_id: str, *, operation: str, method: str, path: str, status: int,
                 duration_ms: float, error: str | None = None) -> None:
    """Best-effort: a metrics failure never fails the request."""
    try:
        r = await client()
        now = datetime.now(timezone.utc)
        hk = _hour_key(project_id, now)
        entry = json.dumps({"t": int(time.time() * 1000), "m": method, "p": path, "o": operation,
                            "s": status, "d": round(duration_ms, 2), "e": error})
        pipe = r.pipeline(transaction=False)
        pipe.hincrby(hk, "req", 1)
        pipe.hincrbyfloat(hk, "dur_sum", duration_ms)
        pipe.hincrby(hk, "dur_cnt", 1)
        pipe.hincrby(hk, f"op:{operation}", 1)
        pipe.hincrby(hk, f"st:{status}", 1)
        pipe.hincrby(hk, f"lat:{_bucket_for(duration_ms)}", 1)
        if status >= 400:
            pipe.hincrby(hk, "err", 1)
        pipe.expire(hk, RETENTION_SECONDS)
        pipe.lpush(f"_m:{project_id}:recent", entry)
        pipe.ltrim(f"_m:{project_id}:recent", 0, RECENT_MAX - 1)
        pipe.expire(f"_m:{project_id}:recent", 7 * 24 * 3600)
        if status >= 400:
            pipe.lpush(f"_m:{project_id}:errors", entry)
            pipe.ltrim(f"_m:{project_id}:errors", 0, ERRORS_MAX - 1)
            pipe.expire(f"_m:{project_id}:errors", 30 * 24 * 3600)
        await pipe.execute()
    except Exception:  # noqa: BLE001
        pass


async def _fetch_hours(r, project_id: str, hours: int) -> list[tuple[datetime, dict]]:
    moments = _hours_back(hours)
    try:
        pipe = r.pipeline(transaction=False)
        for m in moments:
            pipe.hgetall(_hour_key(project_id, m))
        raw = await pipe.execute()
    except Exception:  # noqa: BLE001
        raw = [{} for _ in moments]
    return list(zip(moments, [row or {} for row in raw]))


def _num(bucket: dict, field: str) -> float:
    try:
        return float(bucket.get(field, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


async def series(r, project_id: str, hours: int, group_by_day: bool = False) -> list[dict]:
    points = []
    for moment, b in await _fetch_hours(r, project_id, hours):
        cnt = _num(b, "dur_cnt")
        points.append({
            "at": moment.isoformat(),
            "requests": int(_num(b, "req")),
            "errors": int(_num(b, "err")),
            "reads": int(sum(_num(b, f"op:{o}") for o in READ_OPS)),
            "writes": int(sum(_num(b, f"op:{o}") for o in WRITE_OPS)),
            "avg_ms": round(_num(b, "dur_sum") / cnt, 2) if cnt else 0.0,
        })
    if not group_by_day:
        return points
    days: dict[str, dict] = {}
    for p in points:
        slot = days.setdefault(p["at"][:10], {"at": p["at"][:10], "requests": 0, "errors": 0, "reads": 0, "writes": 0, "_ms": 0.0, "_n": 0})
        for f in ("requests", "errors", "reads", "writes"):
            slot[f] += p[f]
        slot["_ms"] += p["avg_ms"] * p["requests"]
        slot["_n"] += p["requests"]
    out = []
    for slot in days.values():
        n, ms = slot.pop("_n"), slot.pop("_ms")
        slot["avg_ms"] = round(ms / n, 2) if n else 0.0
        out.append(slot)
    return sorted(out, key=lambda p: p["at"])


def percentiles(latency: dict[str, int]) -> dict[str, float]:
    """p50/p95/p99 from histogram buckets (upper bucket edges, so upper bounds)."""
    ordered = [str(e) for e in LATENCY_BUCKETS_MS] + ["inf"]
    counts = [(label, latency.get(label, 0)) for label in ordered]
    total = sum(c for _, c in counts)
    if not total:
        return {"p50": 0.0, "p95": 0.0, "p99": 0.0}
    out = {}
    for name, frac in (("p50", .5), ("p95", .95), ("p99", .99)):
        running = 0
        out[name] = float(LATENCY_BUCKETS_MS[-1])
        for label, c in counts:
            running += c
            if running >= total * frac:
                out[name] = float(LATENCY_BUCKETS_MS[-1] * 2) if label == "inf" else float(label)
                break
    return out


async def summary(r, project_id: str, hours: int) -> dict:
    req = err = 0
    dsum = dcnt = 0.0
    ops: dict[str, int] = {}
    sts: dict[str, int] = {}
    lat: dict[str, int] = {}
    for _, b in await _fetch_hours(r, project_id, hours):
        req += int(_num(b, "req"))
        err += int(_num(b, "err"))
        dsum += _num(b, "dur_sum")
        dcnt += _num(b, "dur_cnt")
        for f, v in b.items():
            n = int(float(v))
            if f.startswith("op:"):
                ops[f[3:]] = ops.get(f[3:], 0) + n
            elif f.startswith("st:"):
                sts[f[3:]] = sts.get(f[3:], 0) + n
            elif f.startswith("lat:"):
                lat[f[4:]] = lat.get(f[4:], 0) + n
    return {
        "requests": req,
        "errors": err,
        "error_rate": round(err / req * 100, 3) if req else 0.0,
        "avg_ms": round(dsum / dcnt, 2) if dcnt else 0.0,
        "operations": dict(sorted(ops.items(), key=lambda kv: kv[1], reverse=True)),
        "statuses": dict(sorted(sts.items())),
        "percentiles": percentiles(lat),
    }


async def _read_list(r, key: str, limit: int) -> list[dict]:
    try:
        raw = await r.lrange(key, 0, limit - 1)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for item in raw:
        try:
            out.append(json.loads(item))
        except (TypeError, ValueError):
            continue
    return out


async def recent(r, project_id: str, limit: int = 20) -> list[dict]:
    return await _read_list(r, f"_m:{project_id}:recent", limit)


async def recent_errors(r, project_id: str, limit: int = 20) -> list[dict]:
    return await _read_list(r, f"_m:{project_id}:errors", limit)


async def purge_metrics(r, project_id: str) -> None:
    try:
        doomed = [f"_m:{project_id}:recent", f"_m:{project_id}:errors"]
        async for k in r.scan_iter(match=f"_m:{project_id}:h:*", count=500):
            doomed.append(k)
        await r.delete(*doomed)
    except Exception:  # noqa: BLE001
        pass
