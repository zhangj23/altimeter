"""Cloud escalation (opt-in): send the schema + question, never a data row, to Gemini; run its SQL locally.

POST /api/escalate {db_id, question, transmit: false} -> {payload, bytes, model, db_id, upload, note, cached}
  payload: the exact JSON body that would be POSTed to Gemini's generateContent (bytes = its UTF-8 length).
  Its one text part is the local prompt template filled with the database's CREATE TABLE statements (the same
  tables, order and DDL as the local prompt, without the sample values) and the question. Zero data rows.
POST /api/escalate {db_id, question, transmit: true} ->
  {sql, source: "gemini" | "cache", model, result: {columns, rows, rows_capped, error, timed_out, exec_seconds},
   audit, bytes, bytes_sent, upload, note, error?}
  The returned SQL runs locally through the same read-only executor (5 s, 200 rows) and the fan-out auditor.
  bytes_sent is 0 when the answer came from the cache (nothing left the machine). Gemini unreachable / quota
  exhausted -> the cached answer for the same (db_id, question) if there is one, else 503 {error}.
  At most one transmit per MIN_GAP_S seconds (all phones together): 429 {error, retry_after} unless cached.
Errors are {error} with 400 (bad request), 429, 503.

The API key is read from KEY_PATH at call time and only ever placed in the x-goog-api-key request header: never
logged, printed, returned or written to the cache. Uploaded databases may be escalated (schema only, labelled
"upload": true); their answers are not cached on disk.
Env: ALTIMETER_GEMINI_KEY_PATH, ALTIMETER_GEMINI_MODELS (comma list, tried in order on quota errors),
ALTIMETER_GEMINI_BASE (tests point it at a local mock), ALTIMETER_CLOUD_CACHE (default ~/altimeter_cloud_cache.json).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from altimeter.prompting import TEMPLATE, extract_sql
from altimeter.sqlexec import connect_guarded

from .uploads import is_upload
from .worker import db_path, execute, known_db

TIMEOUT_S = 15.0
MIN_GAP_S = 5.0
MAX_QUESTION_CHARS = 500
DEFAULT_MODELS = "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3-flash-preview"
UPLOAD_NOTE = "Uploaded database: only its CREATE TABLE statements are sent, no rows."
BIRD_NOTE = "Only the CREATE TABLE statements and the question are sent, no rows."

router = APIRouter()
_lock = threading.Lock()
_last_transmit = 0.0


def key_path() -> Path:
    return Path(os.environ.get("ALTIMETER_GEMINI_KEY_PATH", "/mnt/c/Users/Jzgam/gemini_key.txt"))


def base_url() -> str:
    return os.environ.get("ALTIMETER_GEMINI_BASE", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")


def models() -> list[str]:
    return [m.strip() for m in os.environ.get("ALTIMETER_GEMINI_MODELS", DEFAULT_MODELS).split(",") if m.strip()]


def cache_path() -> Path:
    return Path(os.environ.get("ALTIMETER_CLOUD_CACHE", "~/altimeter_cloud_cache.json")).expanduser()


# ---- payload ---------------------------------------------------------------------------------------------
def schema_ddl(path: str) -> str:
    """CREATE TABLE statements, same tables and order as prompting.schema_text, no sample values."""
    con = connect_guarded(path)
    try:
        rows = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                           "ORDER BY rowid").fetchall()
    finally:
        con.close()
    return "\n".join((r[0] or "").strip() + ";" for r in rows)


def build_payload(db_id: str, question: str) -> dict[str, Any]:
    prompt = TEMPLATE.format(schema=schema_ddl(db_path(db_id)), question=question.strip())
    return {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0}}


def payload_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload).encode("utf-8")


# ---- cache -----------------------------------------------------------------------------------------------
def _cache_key(db_id: str, question: str) -> str:
    return db_id + "\n" + re.sub(r"\s+", " ", question.strip().lower())


def _cache_load() -> dict[str, Any]:
    try:
        d = json.loads(cache_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def cache_get(db_id: str, question: str) -> dict[str, Any] | None:
    hit = _cache_load().get(_cache_key(db_id, question))
    return hit if isinstance(hit, dict) and isinstance(hit.get("sql"), str) else None


def cache_put(db_id: str, question: str, entry: dict[str, Any]) -> None:
    if is_upload(db_id):  # upload ids are private and short-lived: nothing about them goes to disk
        return
    with _lock:
        d = _cache_load()
        d[_cache_key(db_id, question)] = entry
        p = cache_path()
        tmp = p.with_suffix(p.suffix + ".tmp")
        try:
            tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
            os.replace(tmp, p)
        except OSError:
            pass


# ---- Gemini ----------------------------------------------------------------------------------------------
class CloudError(RuntimeError):
    """Gemini could not answer; the message is safe to show (no key, no URL with secrets)."""


def _post(model: str, body: bytes, key: str, timeout_s: float) -> dict[str, Any]:
    req = urllib.request.Request(f"{base_url()}/models/{model}:generateContent", data=body, method="POST",
                                 headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        return json.loads(r.read())


def ask_gemini(body: bytes) -> tuple[str, str]:
    """-> (sql, model). Tries each model in order on quota/overload errors, within TIMEOUT_S overall."""
    try:
        key = key_path().read_text(encoding="utf-8").strip()
    except OSError:
        raise CloudError("no Gemini API key on this machine") from None
    if not key:
        raise CloudError("no Gemini API key on this machine")
    deadline = time.monotonic() + TIMEOUT_S
    last = "Gemini did not answer"
    for model in models():
        left = deadline - time.monotonic()
        if left <= 0.5:
            break
        try:
            r = _post(model, body, key, left)
        except urllib.error.HTTPError as e:
            last = f"Gemini returned HTTP {e.code}" + (" (quota or rate limit)" if e.code == 429 else "")
            if e.code in (429, 500, 503, 404):
                continue  # next model
            raise CloudError(last) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CloudError("Gemini is unreachable (offline?)") from None
        except ValueError:
            last = "Gemini sent an unreadable reply"
            continue
        try:
            parts = r["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
        except (KeyError, IndexError, TypeError):
            last = "Gemini returned no answer"
            continue
        sql = extract_sql(text) if text else ""
        if sql:
            return sql, model
        last = "Gemini returned no SQL"
    raise CloudError(last)


# ---- local run of the cloud's SQL ------------------------------------------------------------------------
def run_locally(db_id: str, sql: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    from .preflight import annotate

    result = execute(db_id, sql)
    res = annotate({"db_id": db_id, "sql": sql, **result})
    return result, res.get("audit")


def _reserve_transmit() -> float:
    """0 if this call may transmit now (and records it), else the seconds to wait."""
    global _last_transmit
    with _lock:
        now = time.monotonic()
        wait = _last_transmit + MIN_GAP_S - now
        if wait > 0:
            return wait
        _last_transmit = now
        return 0.0


def escalate(db_id: str, question: str, transmit: bool) -> tuple[int, dict[str, Any]]:
    """-> (status, body). Blocking: call from a thread."""
    payload = build_payload(db_id, question)
    raw = payload_bytes(payload)
    upload = is_upload(db_id)
    base = {"db_id": db_id, "bytes": len(raw), "upload": upload, "note": UPLOAD_NOTE if upload else BIRD_NOTE}
    cached = cache_get(db_id, question)
    if not transmit:
        return 200, {"payload": payload, **base, "model": models()[0] if models() else None,
                     "cached": cached is not None}
    wait = _reserve_transmit()
    source, err = "gemini", None
    if wait > 0:
        if cached is None:
            return 429, {"error": f"one cloud call every {MIN_GAP_S:g} s; try again in {wait:.0f} s",
                         "retry_after": round(wait, 1), **base}
        source = "cache"
    else:
        try:
            sql, model = ask_gemini(raw)
            cache_put(db_id, question, {"sql": sql, "model": model, "ts": round(time.time())})
        except CloudError as e:
            if cached is None:
                return 503, {"error": str(e), "bytes_sent": 0, **base}
            source, err = "cache", str(e)
    if source == "cache":
        assert cached is not None
        sql, model = cached["sql"], cached.get("model")
    result, audit = run_locally(db_id, sql)
    out = {"sql": sql, "source": source, "model": model, "result": result, "audit": audit,
           "bytes_sent": len(raw) if source == "gemini" else 0, **base}
    if err:
        out["cloud_error"] = err  # why the cached answer was used
    return 200, out


class EscalateIn(BaseModel):
    db_id: str
    question: str
    transmit: bool = False


@router.post("/api/escalate")
async def api_escalate(body: EscalateIn) -> Any:
    q = body.question.strip()
    if not known_db(body.db_id):
        return JSONResponse({"error": f"unknown database: {body.db_id[:80]}"}, status_code=400)
    if not q or len(q) > MAX_QUESTION_CHARS:
        return JSONResponse({"error": f"question must be 1-{MAX_QUESTION_CHARS} characters"}, status_code=400)
    try:
        status, out = await asyncio.to_thread(escalate, body.db_id, q, body.transmit)
    except Exception as e:  # noqa: BLE001 - never a traceback (or anything near the key) to the client
        print(f"[altimeter] escalate failed: {type(e).__name__}", flush=True)
        return JSONResponse({"error": "the cloud request failed on the server"}, status_code=500)
    return out if status == 200 else JSONResponse(out, status_code=status)
