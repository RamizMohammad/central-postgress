"""Backup & restore endpoints (admin only)."""
from __future__ import annotations

import re
import shutil
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import backup
from ..auth import require_auth
from ..config import settings
from ..db import pools

router = APIRouter(prefix="/api/backup", tags=["backup & restore"], dependencies=[Depends(require_auth)])


@router.get("/status")
async def status():
    pool = await pools.get()
    async with pool.acquire() as conn:
        info = await backup.server_info(conn)
    folder = backup.backup_dir()
    du = shutil.disk_usage(folder)
    job = backup.current_job()
    last = max(backup.jobs.values(), key=lambda j: j.created, default=None)
    return {
        "server": info,
        "tools": backup.tools_status(info["major"]),
        "backup_dir": str(folder),
        "disk": {"free_bytes": du.free, "total_bytes": du.total},
        "auto": {"every_hours": settings.auto_backup_hours, "keep": settings.auto_backup_keep,
                 "next_run": backup.next_auto_run()},
        "upload_max_bytes": settings.upload_max_bytes,
        "job": (job or last).public(len((job or last).lines)) if (job or last) else None,
    }


@router.get("/files")
async def files():
    import asyncio

    return await asyncio.to_thread(backup.list_files)


@router.get("/files/{name}/inspect")
async def inspect(name: str):
    return await backup.inspect(name)


@router.get("/files/{name}")
async def download(name: str):
    path = backup.file_path(name)
    return FileResponse(path, media_type="application/octet-stream", filename=name)


@router.delete("/files/{name}")
async def delete(name: str):
    backup.file_path(name).unlink()
    return {"deleted": name}


@router.post("/upload")
async def upload(request: Request, filename: str = Query(..., max_length=180)):
    """Send the file as the raw request body (not multipart). Streams to disk."""
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", filename.rsplit("/", 1)[-1]).strip(".-") or "backup"
    if base.startswith("uploaded-"):
        base = base[len("uploaded-"):]
    name = f"uploaded-{backup._stamp()}-{base}"[:200]
    folder = backup.backup_dir()
    partial = folder / (name + ".partial")
    size = 0
    try:
        with open(partial, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > settings.upload_max_bytes:
                    raise HTTPException(413, "File is larger than BACKUP_UPLOAD_MAX_GB")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "Empty upload")
        partial.rename(folder / name)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return await backup.inspect(name)


class FullBackup(BaseModel):
    databases: list[str] | None = Field(None, description="Omit for all databases")
    include_roles: bool = True
    include_passwords: bool = True


@router.post("/full", status_code=202)
async def full_backup(body: FullBackup):
    job = backup.start_job(
        "backup", "Full server backup",
        lambda job: backup.run_full_backup(job, body.databases, body.include_roles, body.include_passwords),
    )
    return job.public()


class DbAction(BaseModel):
    name: str
    action: Literal["skip", "create", "replace", "merge"] = "create"
    target: str | None = None


class RestoreBody(BaseModel):
    file: str
    # bundle restore
    roles: bool = True
    passwords: bool = True
    update_existing_roles: bool = False
    databases: list[DbAction] = []
    # single .dump / .sql restore
    target: str | None = None
    action: Literal["create", "replace", "merge"] = "create"


@router.post("/restore", status_code=202)
async def restore(body: RestoreBody):
    path = backup.file_path(body.file)
    if backup.detect_kind(path) == "bundle":
        plan = body.model_dump()
        plan["databases"] = [d.model_dump() for d in body.databases]
        job = backup.start_job("restore", f"Restore {body.file}",
                               lambda job: backup.run_restore_bundle(job, body.file, plan))
    else:
        if not body.target:
            raise HTTPException(400, "target (database name) is required for a single-database file")
        job = backup.start_job("restore", f"Restore {body.file} → {body.target}",
                               lambda job: backup.run_restore_file(job, body.file, body.target, body.action))
    return job.public()


@router.get("/jobs")
async def list_jobs():
    return [j.public(len(j.lines)) for j in sorted(backup.jobs.values(), key=lambda j: j.created, reverse=True)]


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, since: int = 0):
    job = backup.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (the server may have restarted)")
    return job.public(since)
