"""Gateway: static phone UI, GET /api/dbs, one WebSocket /ws. A single queue consumer feeds the model worker.
Table screen: GET /table (static table.html) + WebSocket /ws/table, which receives every job's events
(queued/working/result/error, each with job {id, db_id, question} and the waiting queue) and a snapshot on connect.

Run (inside WSL, repo root):  python -m server.app [--fake] [--port 8000]
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import os
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .worker import WorkerClient, list_dbs

STATIC = Path(__file__).parent / "static"
MAX_QUESTION_CHARS = 500
_job_ids = itertools.count(1)


@dataclass
class Job:
    ws: WebSocket
    db_id: str
    question: str
    gone: bool = False
    id: int = field(default_factory=lambda: next(_job_ids))

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "db_id": self.db_id, "question": self.question}


class Gateway:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.waiting: list[Job] = []  # mirror of the queue, for position updates
        self.worker: WorkerClient | None = None
        self.tables: set[WebSocket] = set()  # table-screen sockets: receive every job's events
        self.current: Job | None = None
        self.last: dict[str, Any] | None = None  # last result/error broadcast, replayed to new table sockets

    def queue_info(self) -> list[dict[str, Any]]:
        return [j.info() for j in self.waiting if not j.gone]

    def snapshot(self) -> dict[str, Any]:
        return {"type": "snapshot", "queue": self.queue_info(),
                "current": self.current.info() if self.current else None, "last": self.last}

    async def broadcast(self, job: Job, msg: dict[str, Any]) -> None:
        msg = {**msg, "job": job.info(), "queue": self.queue_info()}
        if msg["type"] in ("result", "error"):
            self.last = msg
        socks = list(self.tables)

        async def one(t: WebSocket) -> None:
            try:
                await asyncio.wait_for(t.send_json(msg), 2.0)
            except Exception:  # noqa: BLE001 - slow or gone table screen: drop it
                self.tables.discard(t)

        await asyncio.gather(*(one(t) for t in socks))

    async def send(self, job: Job, msg: dict[str, Any]) -> None:
        if job.gone:
            return
        try:
            await job.ws.send_json(msg)
        except Exception:  # noqa: BLE001 - client went away
            job.gone = True

    async def announce_positions(self) -> None:
        for i, j in enumerate(self.waiting):
            await self.send(j, {"type": "queued", "position": i + 1})

    async def consume(self) -> None:
        assert self.worker is not None
        while True:
            job = await self.queue.get()
            self.waiting.remove(job)
            await self.announce_positions()
            if job.gone:
                continue
            self.current = job
            await self.send(job, {"type": "working"})
            await self.broadcast(job, {"type": "working"})
            try:
                res = await asyncio.to_thread(self.worker.ask, job.db_id, job.question)
                await self.send(job, {"type": "result", **res})
                self.current = None
                await self.broadcast(job, {"type": "result", **res})
            except Exception as e:  # noqa: BLE001
                await self.send(job, {"type": "error", "message": str(e)})
                self.current = None
                await self.broadcast(job, {"type": "error", "message": str(e)})


gw = Gateway()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    gw.worker = WorkerClient()
    task = asyncio.create_task(gw.consume())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    await asyncio.to_thread(gw.worker.close)


app = FastAPI(lifespan=lifespan)


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


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    known = set(list_dbs())
    mine: list[Job] = []
    try:
        while True:
            msg = await ws.receive_json()
            db_id, question = str(msg.get("db_id", "")), str(msg.get("question", "")).strip()
            if db_id not in known:
                await ws.send_json({"type": "error", "message": f"unknown database: {db_id}"})
                continue
            if not question or len(question) > MAX_QUESTION_CHARS:
                await ws.send_json({"type": "error", "message": f"question must be 1-{MAX_QUESTION_CHARS} characters"})
                continue
            job = Job(ws, db_id, question)
            mine.append(job)
            gw.waiting.append(job)
            await ws.send_json({"type": "queued", "position": len(gw.waiting)})
            await gw.queue.put(job)
            await gw.broadcast(job, {"type": "queued", "position": len(gw.waiting)})
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        for j in mine:
            j.gone = True


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
