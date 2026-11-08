"""Gateway: static phone UI, GET /api/dbs, GET /api/status, one WebSocket /ws. A single queue consumer feeds the
model worker. Table screen: GET /table (static table.html) + WebSocket /ws/table.

Phone socket /ws (client -> server):
  {type:"hello", client, last_job}   first message on every connect. client: stable id the phone keeps;
                                     last_job: id of the last result/error it rendered (or null).
  {db_id, question}                  ask. One pending question per client.
Server -> phone (job_id on every job message):
  {type:"welcome", client, job_id, replay}  reply to hello. job_id: this client's pending job or null;
                                     replay: true when the last result follows because the phone missed it.
  {type:"status", ready, warming, warm_seconds, queue, fake, probe, restarts}  after hello and on every change.
  {type:"queued", job_id, position}  {type:"working", job_id, elapsed}  {type:"stage", job_id, stage, elapsed}
  {type:"result", job_id, ...answer}  {type:"error", job_id?, message}
  stage is "generating" | "scoring" | "executing" | "sampling" (sampling only when two-readings run).
  result carries, when ~/models/probe_layers.json (or ALTIMETER_LAYERS_PATH) exists, per-layer probe scores
  computed before the SQL runs: "layers": [{"layer": int, "p": float, "z": float, "auroc": [pt, lo, hi] | null}]
  sorted by layer, plus "layers_synthetic": true for a synthetic test file; "layers_error": str if scoring failed.
  "explain" (table breakdown) has stack_terms, stack_intercept, probe_terms, model_card (see altimeter/probe.py).
The gateway remembers each client's pending job and last result for 15 min, so a phone that drops its socket
mid-job gets the queue position / stage / finished result again when it reconnects with the same client id.

Table socket /ws/table receives a snapshot on connect, then every job's events, each with
job {id, db_id, question} and the waiting queue: queued / working / stage {stage} / result / error.
A table "result" is the phone's result dict unchanged (same "layers", "layers_synthetic", "explain", "timing").
Pre-flight checks are broadcast too, after each successful POST /api/check, with exactly this shape:
  {"type": "check", "job": {"id": int, "db_id": str, "question": str (only for a preset)},
   "check": <the /api/check response object, unchanged>}
Check ids come from the same counter as job ids, so they never collide.

Uploads (server/uploads.py; memory only, never logged): POST /api/upload multipart, one .sqlite/.db or 1-8 .csv,
<=10 MB total, <=200k rows and <=50 columns per table -> {db_id: "upload:<id>", kind, tables: [{name, rows}],
expires_in_s} or 400 {error}. GET /api/upload/<id> (same shape, 404 when gone), DELETE /api/upload/<id>.
"upload:<id>" works in /api/schema, /api/check and the /ws ask; such answers carry "calibrated": false and
"calibration_note". 15 min idle TTL, at most 8 live (oldest evicted). Uploads are not listed in /api/dbs.

Run (inside WSL, repo root):  python -m server.app [--fake] [--port 8000]
ALTIMETER_JOB_TIMEOUT (seconds, default 45): a job running longer gets an error and the worker restarts.
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from altimeter.sqlexec import connect_guarded

from .preflight import annotate, check_listeners, router as preflight_router
from .uploads import CALIBRATION_NOTE, MAX_BYTES, PREFIX, STORE, UploadError, is_upload, parse_multipart
from .worker import JobTimeout, WorkerClient, db_path, known_db, list_dbs

STATIC = Path(__file__).parent / "static"
MAX_QUESTION_CHARS = 500
CLIENT_TTL_S = 15 * 60  # forget a client's last result after this
STALE_JOB_S = 60.0  # skip a queued job whose phone has been gone this long
TIMEOUT_MESSAGE = "The model took too long; try a shorter question."
CLIENT_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_job_ids = itertools.count(1)


def log(msg: str) -> None:
    print(f"[altimeter] {time.strftime('%H:%M:%S')} {msg}", flush=True)


@dataclass
class Client:
    id: str
    ws: WebSocket | None = None
    job: Job | None = None  # pending: queued or running
    stage: str | None = None
    started: float | None = None  # monotonic time the pending job started running
    last: dict[str, Any] | None = None  # last result/error message for a job (has job_id)
    last_at: float = 0.0
    left_at: float | None = None  # when the socket closed (None while connected)
    seen: float = field(default_factory=time.time)


@dataclass
class Job:
    client: Client
    db_id: str
    question: str
    id: int = field(default_factory=lambda: next(_job_ids))

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "db_id": self.db_id, "question": self.question}


class Gateway:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.waiting: list[Job] = []  # mirror of the queue, for position updates
        self.worker: WorkerClient | None = None
        self.tables: set[WebSocket] = set()  # table-screen sockets: receive every job's events
        self.clients: dict[str, Client] = {}
        self.current: Job | None = None
        self.last: dict[str, Any] | None = None  # last result/error broadcast, replayed to new table sockets

    # ---- state ----
    def queue_info(self) -> list[dict[str, Any]]:
        return [j.info() for j in self.waiting]

    def snapshot(self) -> dict[str, Any]:
        return {"type": "snapshot", "queue": self.queue_info(),
                "current": self.current.info() if self.current else None, "last": self.last}

    def status(self) -> dict[str, Any]:
        w = self.worker
        ready = bool(w and w.ready)
        info = (w.ready_info or {}) if w else {}
        return {"ready": ready, "warming": not ready,
                "warm_seconds": None if ready or not w else round(time.time() - w.warm_started, 1),
                "queue": len(self.waiting) + (1 if self.current else 0),
                "fake": bool(w and w.fake), "probe": info.get("probe") if ready else None,
                "restarts": w.restarts if w else 0, "layers": info.get("layers") if ready else None}

    def attach(self, cid: str, ws: WebSocket) -> Client:
        now = time.time()
        for k in [k for k, c in self.clients.items()
                  if c.job is None and c.ws is None and now - max(c.seen, c.last_at) > CLIENT_TTL_S]:
            del self.clients[k]
        if not CLIENT_ID.match(cid):
            cid = secrets.token_hex(8)
        c = self.clients.setdefault(cid, Client(cid))
        c.ws, c.left_at, c.seen = ws, None, now
        return c

    def detach(self, c: Client, ws: WebSocket) -> None:
        if c.ws is ws:
            c.ws, c.left_at = None, time.time()

    # ---- sending ----
    async def send_tables(self, msg: dict[str, Any]) -> None:
        async def one(t: WebSocket) -> None:
            try:
                await asyncio.wait_for(t.send_json(msg), 2.0)
            except Exception:  # noqa: BLE001 - slow or gone table screen: drop it
                self.tables.discard(t)

        await asyncio.gather(*(one(t) for t in list(self.tables)))

    async def broadcast(self, job: Job, msg: dict[str, Any]) -> None:
        msg = {**msg, "job": job.info(), "queue": self.queue_info()}
        if msg["type"] in ("result", "error"):
            self.last = msg
        await self.send_tables(msg)

    async def to_client(self, c: Client, msg: dict[str, Any]) -> None:
        ws = c.ws
        if ws is None:
            return
        try:
            await asyncio.wait_for(ws.send_json(msg), 5.0)
        except Exception:  # noqa: BLE001 - phone went away; it gets the state again on reconnect
            self.detach(c, ws)

    async def send(self, job: Job, msg: dict[str, Any]) -> None:
        c = job.client
        msg = {**msg, "job_id": job.id}
        if msg["type"] in ("result", "error"):
            c.last, c.last_at, c.job, c.stage, c.started = msg, time.time(), None, None, None
        await self.to_client(c, msg)

    async def push_status(self) -> None:
        st = {"type": "status", **self.status()}
        await asyncio.gather(*(self.to_client(c, st) for c in list(self.clients.values()) if c.ws))

    async def announce_positions(self) -> None:
        for i, j in enumerate(self.waiting):
            await self.send(j, {"type": "queued", "position": i + 1})

    async def resume(self, c: Client, last_job: Any) -> None:
        """Reply to hello: what this client is waiting for, then replay whatever it missed."""
        fresh = c.last is not None and time.time() - c.last_at < CLIENT_TTL_S
        replay = c.job is None and fresh and c.last.get("job_id") != last_job
        await self.to_client(c, {"type": "welcome", "client": c.id, "job_id": c.job.id if c.job else None,
                                 "replay": replay})
        await self.to_client(c, {"type": "status", **self.status()})
        j = c.job
        if j is not None and j in self.waiting:
            await self.to_client(c, {"type": "queued", "job_id": j.id, "position": self.waiting.index(j) + 1})
        elif j is not None and self.current is j:
            elapsed = round(time.monotonic() - (c.started or time.monotonic()), 2)
            await self.to_client(c, {"type": "working", "job_id": j.id, "elapsed": elapsed})
            if c.stage:
                await self.to_client(c, {"type": "stage", "job_id": j.id, "stage": c.stage, "elapsed": elapsed})
        elif replay and c.last is not None:
            await self.to_client(c, c.last)

    async def submit(self, c: Client, db_id: str, question: str) -> None:
        job = Job(c, db_id, question)
        c.job, c.stage, c.started = job, None, None
        self.waiting.append(job)
        await self.send(job, {"type": "queued", "position": len(self.waiting)})
        await self.queue.put(job)
        await self.broadcast(job, {"type": "queued", "position": len(self.waiting)})

    # ---- consumer ----
    async def warm(self) -> None:
        assert self.worker is not None
        while not self.worker.ready:
            await self.push_status()
            try:
                await asyncio.to_thread(self.worker.wait_ready)
            except (EOFError, OSError) as e:
                log(f"worker died while loading ({type(e).__name__}); restarting")
                await asyncio.to_thread(self.worker.restart)
                await asyncio.sleep(1.0)
                continue
            info = self.worker.ready_info or {}
            log(f"worker ready after {time.time() - self.worker.warm_started:.1f} s "
                f"(fake={info.get('fake')}, probe={info.get('probe')}, warmup={info.get('warmup')})")
        await self.push_status()

    async def stage(self, job: Job, stage: str) -> None:
        c = job.client
        if c.job is job:
            c.stage = stage
        elapsed = round(time.monotonic() - (c.started or time.monotonic()), 2)
        await self.send(job, {"type": "stage", "stage": stage, "elapsed": elapsed})
        await self.broadcast(job, {"type": "stage", "stage": stage})

    async def run(self, job: Job) -> None:
        assert self.worker is not None
        loop = asyncio.get_running_loop()
        staged: list[Any] = []

        def on_stage(stage: str) -> None:  # worker thread -> event loop
            staged.append(asyncio.run_coroutine_threadsafe(self.stage(job, stage), loop))

        try:
            upload, pid = None, self.worker.proc.pid
            if is_upload(job.db_id):  # the worker is another process: ship it the tables once per worker
                upload = await asyncio.to_thread(STORE.export, job.db_id, pid)
                if upload is None:
                    raise RuntimeError("This upload expired; upload the file again.")
            res = await asyncio.to_thread(self.worker.ask, job.db_id, job.question, on_stage, None, upload,
                                          STORE.ids())
            if upload is not None and not res.get("error"):
                STORE.mark_sent(job.db_id, pid)
            for f in staged:  # every stage message goes out before the result
                await asyncio.wrap_future(f)
            res = await asyncio.to_thread(annotate, res)  # pre-flight fan-out audit of the model's SQL
            if upload is not None:  # the needle was calibrated on BIRD dev only
                res["calibrated"], res["calibration_note"] = False, CALIBRATION_NOTE
            self.current = None
            await self.send(job, {"type": "result", **res})
            await self.broadcast(job, {"type": "result", **res})
        except JobTimeout as e:
            log(f"job {job.id} timed out ({e}); db={job.db_id} question={job.question[:80]!r}")
            self.current = None
            await self.send(job, {"type": "error", "message": TIMEOUT_MESSAGE, "timeout": True})
            await self.broadcast(job, {"type": "error", "message": TIMEOUT_MESSAGE, "timeout": True})
        except Exception as e:  # noqa: BLE001
            log(f"job {job.id} failed: {type(e).__name__}: {e}")
            self.current = None
            await self.send(job, {"type": "error", "message": str(e)})
            await self.broadcast(job, {"type": "error", "message": str(e)})

    async def consume(self) -> None:
        assert self.worker is not None
        while True:
            await self.warm()  # no-op once ready; after a timeout restart this waits for the reload
            job = await self.queue.get()
            self.waiting.remove(job)
            await self.announce_positions()
            c = job.client
            if c.ws is None and c.left_at is not None and time.time() - c.left_at > STALE_JOB_S:
                log(f"job {job.id} skipped: its phone left {time.time() - c.left_at:.0f} s ago")
                c.job = None
                continue
            self.current = job
            c.started = time.monotonic()
            await self.send(job, {"type": "working", "elapsed": 0.0})
            await self.broadcast(job, {"type": "working"})
            await self.run(job)


gw = Gateway()


async def _on_check(out: dict[str, Any], preset: dict[str, Any] | None) -> None:
    job: dict[str, Any] = {"id": next(_job_ids), "db_id": out.get("db_id")}
    if preset:
        job["question"] = preset["question"]
    await gw.send_tables({"type": "check", "job": job, "check": out})


async def _sweep_uploads() -> None:
    while True:  # idle uploads expire even when nobody touches the store
        await asyncio.sleep(30)
        STORE.sweep()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    gw.worker = WorkerClient()
    check_listeners.append(_on_check)
    task = asyncio.create_task(gw.consume())
    sweeper = asyncio.create_task(_sweep_uploads())
    yield
    sweeper.cancel()
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    await asyncio.to_thread(gw.worker.close)


app = FastAPI(lifespan=lifespan)
app.include_router(preflight_router)


@app.middleware("http")
async def cache_headers(request: Request, call_next: Any) -> Any:
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/fonts/"):
        resp.headers["Cache-Control"] = "public, max-age=604800, immutable"
    elif not path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"  # revalidate via ETag; plain http has no service worker
    else:
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/dbs")
def dbs() -> dict[str, Any]:
    return {"dbs": list_dbs(), "fake": bool(gw.worker and gw.worker.fake)}


_schemas: dict[str, dict[str, Any]] = {}
COUNT_TIMEOUT_S = 2.0


def _read_schema(db_id: str) -> dict[str, Any]:
    con = connect_guarded(db_path(db_id))
    try:
        names = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")]
        info = {t: con.execute(f'PRAGMA table_info("{t.replace(chr(34), chr(34) * 2)}")').fetchall() for t in names}
        tables = []
        for t in names:
            q = t.replace('"', '""')
            fks: dict[str, str] = {}
            for fk in con.execute(f'PRAGMA foreign_key_list("{q}")').fetchall():
                ref, frm, to = fk[2], fk[3], fk[4]
                if to is None:  # references the parent's primary key
                    to = next((c[1] for c in info.get(ref, []) if c[5]), None)
                fks.setdefault(frm, f"{ref}.{to}" if to else ref)
            deadline = time.time() + COUNT_TIMEOUT_S
            con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10_000)
            try:
                rows: int | None = con.execute(f'SELECT COUNT(*) FROM "{q}"').fetchone()[0]
            except sqlite3.Error:
                rows = None  # slow table: skip the count
            con.set_progress_handler(None, 0)
            cols = [{"name": c[1], "type": c[2] or "", "pk": bool(c[5]), "fk": fks.get(c[1])} for c in info[t]]
            tables.append({"name": t, "rows": rows, "columns": cols})
        return {"db_id": db_id, "tables": tables}
    finally:
        con.close()


@app.get("/api/schema")
def schema(db_id: str = "") -> Any:
    if is_upload(db_id):  # never cached: it can expire
        if not STORE.touch(db_id):
            return JSONResponse({"error": f"unknown or expired upload: {db_id}"}, status_code=404)
        return {**_read_schema(db_id), "calibrated": False, "calibration_note": CALIBRATION_NOTE}
    if db_id not in list_dbs():
        return JSONResponse({"error": f"unknown database: {db_id}"}, status_code=404)
    if db_id not in _schemas:
        _schemas[db_id] = _read_schema(db_id)
    return _schemas[db_id]


UPLOAD_BODY_LIMIT = MAX_BYTES + 256 * 1024  # files + multipart framing


@app.post("/api/upload")
async def upload(request: Request) -> Any:
    """Multipart: one .sqlite/.db file, or 1-8 .csv files. -> same shape as GET /api/upload/<id>. 400 + {error}."""
    body, seen = bytearray(), 0
    async for chunk in request.stream():  # an oversize body is read and discarded (not stored), so the client
        seen += len(chunk)                # gets the 400 instead of a reset connection; give up past 64 MB
        if seen <= UPLOAD_BODY_LIMIT:
            body += chunk
        elif seen > 64 * 1024 * 1024:
            break
    if seen > UPLOAD_BODY_LIMIT:
        return JSONResponse({"error": f"upload is over the {MAX_BYTES // (1024 * 1024)} MB limit"}, status_code=400)
    try:
        files = parse_multipart(request.headers.get("content-type", ""), bytes(body))
        del body
        db_id = await asyncio.to_thread(STORE.add, files)
    except UploadError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except (sqlite3.Error, MemoryError) as e:
        return JSONResponse({"error": f"could not load the upload ({type(e).__name__}: {e})"}, status_code=400)
    info = await asyncio.to_thread(STORE.info, db_id)
    log(f"upload stored: {len(info['tables']) if info else 0} tables")  # never the name, id or contents
    return info


def _upload_db_id(uid: str) -> str:
    return uid if is_upload(uid) else PREFIX + uid


@app.get("/api/upload/{uid}")
def upload_info(uid: str) -> Any:
    info = STORE.info(_upload_db_id(uid))
    if info is None:
        return JSONResponse({"error": "unknown or expired upload"}, status_code=404)
    return info


@app.delete("/api/upload/{uid}")
def upload_delete(uid: str) -> dict[str, Any]:
    return {"deleted": STORE.remove(_upload_db_id(uid))}


@app.get("/api/status")
def status() -> dict[str, Any]:
    return gw.status()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    client: Client | None = None
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "hello":
                if client is not None:
                    gw.detach(client, ws)
                client = gw.attach(str(msg.get("client") or ""), ws)
                await gw.resume(client, msg.get("last_job"))
                continue
            if client is None:  # a page from before hello existed: anonymous client for this socket
                client = gw.attach("", ws)
            db_id, question = str(msg.get("db_id", "")), str(msg.get("question", "")).strip()
            if not known_db(db_id):
                await ws.send_json({"type": "error", "message": f"unknown database: {db_id}"})
                continue
            if not question or len(question) > MAX_QUESTION_CHARS:
                await ws.send_json({"type": "error", "message": f"question must be 1-{MAX_QUESTION_CHARS} characters"})
                continue
            if client.job is not None:
                await ws.send_json({"type": "error", "message": "Your last question is still in flight."})
                continue
            await gw.submit(client, db_id, question)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if client is not None:
            gw.detach(client, ws)


@app.websocket("/ws/table")
async def ws_table(ws: WebSocket) -> None:
    await ws.accept()
    try:
        await ws.send_json(gw.snapshot())
        gw.tables.add(ws)
        while True:
            await ws.receive_text()  # nothing to read; this only notices the disconnect
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        gw.tables.discard(ws)


@app.get("/table")
def table() -> FileResponse:
    return FileResponse(STATIC / "table.html")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--fake", action="store_true", help="no GPU: canned SQL, executed for real")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    if args.fake:
        os.environ["ALTIMETER_FAKE"] = "1"
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
