"""GPU proof for the table screen: GET /api/gpu -> {power_w, util_pct, mem_used_mb, mem_total_mb, ts}.

One nvidia-smi query (first GPU), cached CACHE_S so any number of pollers cost one process every 0.5 s.
nvidia-smi missing or failing -> 503 {error}. A field the driver reports as [N/A] is null. ts: Unix seconds of
the sample.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

CACHE_S = 0.5
QUERY = "power.draw,utilization.gpu,memory.used,memory.total"
FIELDS = ("power_w", "util_pct", "mem_used_mb", "mem_total_mb")
WSL_SMI = "/usr/lib/wsl/lib/nvidia-smi"

router = APIRouter()
_cache: tuple[float, int, dict[str, Any]] | None = None  # (monotonic time, status, body)
_lock: asyncio.Lock | None = None


def _num(s: str) -> float | None:
    try:
        return round(float(s.strip()), 2)
    except ValueError:
        return None  # "[N/A]", "[Not Supported]"


def parse(line: str) -> dict[str, Any]:
    vals = line.split(",")
    if len(vals) != len(FIELDS):
        raise ValueError("unexpected nvidia-smi output")
    return dict(zip(FIELDS, (_num(v) for v in vals)))


def sample() -> tuple[int, dict[str, Any]]:
    exe = shutil.which("nvidia-smi") or (WSL_SMI if os.path.exists(WSL_SMI) else None)
    if exe is None:
        return 503, {"error": "nvidia-smi is not available"}
    try:
        out = subprocess.run([exe, f"--query-gpu={QUERY}", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=3.0)
    except (OSError, subprocess.TimeoutExpired):
        return 503, {"error": "nvidia-smi did not answer"}
    lines = [ln for ln in out.stdout.splitlines() if ln.strip()]
    if out.returncode != 0 or not lines:
        return 503, {"error": "nvidia-smi failed"}
    try:
        return 200, {**parse(lines[0]), "ts": round(time.time(), 3)}
    except ValueError:
        return 503, {"error": "nvidia-smi output not understood"}


@router.get("/api/gpu")
async def api_gpu() -> Any:
    global _cache, _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:  # concurrent pollers share one nvidia-smi run
        if _cache is None or time.monotonic() - _cache[0] > CACHE_S:
            status, body = await asyncio.to_thread(sample)
            _cache = (time.monotonic(), status, body)
        _, status, body = _cache
    return body if status == 200 else JSONResponse(body, status_code=status)
