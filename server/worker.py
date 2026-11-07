"""Model worker: a separate process that owns the GPU model and answers {db_id, question} over a Pipe.

Opens no network sockets (HF_HUB_OFFLINE is set by altimeter.model; the only I/O is the Pipe + SQLite).
ALTIMETER_FAKE=1 (or fake=True) skips the model and returns a canned SQL that is executed for real.
ALTIMETER_READINGS=auto|always|off: two-readings sampling after the greedy answer (auto = only when the needle
is missing or below readings.ASK_BELOW). Fake mode builds readings from two real queries.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import sqlite3
import time
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

DB_ROOT = Path(os.environ.get("ALTIMETER_DB_ROOT", "~/data/bird_dev/dev_20240627/dev_databases")).expanduser()
MODEL_PATH = str(Path(os.environ.get("ALTIMETER_MODEL", "~/models/Qwen2.5-Coder-3B-Instruct")).expanduser())
PROBE_PATH = Path(os.environ.get("ALTIMETER_PROBE", "~/models/probe.json")).expanduser()
MAX_ROWS = 200
EXEC_TIMEOUT_S = 5.0
FAKE_SQL = "SELECT name FROM sqlite_master WHERE type='table'"
READINGS_N = int(os.environ.get("ALTIMETER_READINGS_N", "6"))


def list_dbs() -> list[str]:
    return sorted(p.name for p in DB_ROOT.iterdir() if (p / f"{p.name}.sqlite").is_file()) if DB_ROOT.is_dir() else []


def db_path(db_id: str) -> str:
    return str(DB_ROOT / db_id / f"{db_id}.sqlite")


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str)):
        return v
    if isinstance(v, bytes):
        return f"<blob {len(v)} bytes>"
    return str(v)


def _columns(path: str, sql: str) -> list[str] | None:
    """Column names without running the query: wrap it with LIMIT 0 (SQLite exits before the scan)."""
    body = sql.strip().rstrip(";")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    deadline = time.time() + 1.0
    con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10_000)
    try:
        cur = con.execute(f"SELECT * FROM ({body}) LIMIT 0")
        return [d[0] for d in cur.description or []]
    except sqlite3.Error:
        return None
    finally:
        con.close()


def execute(db_id: str, sql: str) -> dict[str, Any]:
    from altimeter import sqlexec

    path = db_path(db_id)
    res = sqlexec.run(path, sql, timeout_s=EXEC_TIMEOUT_S, max_rows=MAX_ROWS)
    rows = [[_cell(v) for v in r] for r in res.rows] if res.rows is not None else None
    cols = _columns(path, sql) if rows is not None else None
    if rows is not None and (cols is None or (rows and len(cols) != len(rows[0]))):
        cols = [f"col{i + 1}" for i in range(len(rows[0]) if rows else 0)]
    return {
        "columns": cols,
        "rows": rows,
        "rows_capped": rows is not None and len(rows) >= MAX_ROWS,
        "error": res.error,
        "timed_out": res.timed_out,
        "exec_seconds": round(res.seconds, 4),
    }


def _score(probe: Any, g: Any, question: str, path: str) -> dict[str, Any] | None:
    """Probe score computed BEFORE the SQL runs (validity via compile-only EXPLAIN, no data scanned)."""
    if probe is None:
        return None
    from altimeter.probe import surface_features
    from altimeter.sqlexec import compiles

    hidden = {"last_prompt": g.hs_last_prompt, "last_gen": g.hs_last_gen, "mean_gen": g.hs_mean_gen}[probe.position]
    surf = surface_features(question, g.sql, g.n_prompt, g.n_gen, compiles(path, g.sql))
    h = hidden.float().numpy()
    s = probe.score(h, g.logprob_mean, g.logprob_min, surf)
    out = {"needle": round(s.needle, 4), "probe": round(s.probe, 4), "calibrated": round(s.calibrated, 4),
           "layer": probe.layer, "position": probe.position, **probe.meta}
    t0 = time.perf_counter()
    try:  # the table screen's breakdown; never lose the score over it
        ex = probe.explain(h, g.logprob_mean, g.logprob_min, surf)
        ex["ms"] = round((time.perf_counter() - t0) * 1000, 3)
        out["explain"] = ex
    except Exception as e:  # noqa: BLE001
        out["explain_error"] = f"{type(e).__name__}: {e}"
    return out


def _readings_mode() -> str:
    mode = os.environ.get("ALTIMETER_READINGS", "auto").strip().lower()
    return mode if mode in ("auto", "always", "off") else "auto"


def _fake_samples(path: str) -> list[str]:
    """Fake mode: two different real queries (3 + 2 samples) plus one that errors, so clustering runs for real."""
    a = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 3"
    b = "SELECT COUNT(*) AS n_tables FROM sqlite_master WHERE type='table'"
    return [a, a, b, a, b, "SELECT no_such_column FROM sqlite_master"]


def _readings(model: Any, messages: list[dict[str, str]] | None, path: str, needle: float | None) -> dict[str, Any]:
    """Sample + cluster after the greedy answer. Never raises: a failure here must not lose the answer."""
    from altimeter.readings import ASK_BELOW, choose_readings, cluster

    mode = _readings_mode()
    if mode == "off" or (mode == "auto" and needle is not None and needle >= ASK_BELOW):
        return {"readings": None, "readings_seconds": None, "readings_error": None}
    t0 = time.time()
    try:
        if model is None:
            sqls = _fake_samples(path)
        else:
            import torch

            torch.cuda.empty_cache()
            sqls = model.sample(messages, n=READINGS_N)
        # "always" is for testing: show whatever two clusters exist, gated only on there being two.
        chosen = choose_readings(cluster(path, sqls), None if mode == "always" else needle)
        readings = None if chosen is None else [
            {"label": lab, **{k: c[k] for k in ("sql", "columns", "rows", "n_rows", "share", "error")}}
            for lab, c in zip("AB", chosen)
        ]
        return {"readings": readings, "readings_seconds": round(time.time() - t0, 3), "readings_error": None}
    except Exception as e:  # noqa: BLE001 - e.g. CUDA OOM while sampling
        return {"readings": None, "readings_seconds": round(time.time() - t0, 3),
                "readings_error": f"{type(e).__name__}: {e}"}


def _answer(model: Any, probe: Any, req: dict[str, Any]) -> dict[str, Any]:
    from altimeter.prompting import build_messages

    db_id, question = req["db_id"], req["question"]
    path = db_path(db_id)
    score = None
    messages = None
    if model is None:  # fake mode
        time.sleep(1.0)
        gen = {"sql": FAKE_SQL, "gen_seconds": 1.0, "n_prompt": 0, "n_gen": 0, "logprob_mean": None, "logprob_min": None}
    else:
        messages = build_messages(path, question)
        g = model.generate(messages)
        gen = {
            "sql": g.sql,
            "gen_seconds": round(g.gen_seconds + g.feat_seconds, 3),
            "n_prompt": g.n_prompt,
            "n_gen": g.n_gen,
            "logprob_mean": round(g.logprob_mean, 4),
            "logprob_min": round(g.logprob_min, 4),
        }
        score = _score(probe, g, question, path)  # before execution
        del g
    result = execute(db_id, gen["sql"])  # greedy answer runs before any sampling
    needle = score["needle"] if score else None
    explain = score.pop("explain", None) if score else None
    return {"db_id": db_id, "question": question, **gen, "probe": score, "explain": explain, **result,
            **_readings(model, messages, path, needle), "fake": model is None}


def worker_main(conn: Connection, fake: bool) -> None:
    model = probe = None
    if not fake:
        from altimeter.model import SqlModel

        model = SqlModel(MODEL_PATH)
        if PROBE_PATH.is_file():
            from altimeter.probe import Probe

            probe = Probe(str(PROBE_PATH))
    conn.send({"type": "ready", "fake": fake, "probe": probe is not None})
    while True:
        try:
            req = conn.recv()
        except EOFError:
            return
        if req is None:
            return
        try:
            out = _answer(model, probe, req)
        except Exception as e:  # noqa: BLE001 - report any failure (e.g. CUDA OOM) to the client
            out = {"db_id": req.get("db_id"), "question": req.get("question"), "error": f"{type(e).__name__}: {e}",
                   "sql": None, "columns": None, "rows": None, "probe": None}
        finally:
            if model is not None:
                import torch

                torch.cuda.empty_cache()
        conn.send(out)


class WorkerClient:
    """Parent-side handle. All methods block; call them from a thread, one request at a time."""

    def __init__(self, fake: bool | None = None) -> None:
        self.fake = os.environ.get("ALTIMETER_FAKE") == "1" if fake is None else fake
        self.ready = False
        self._start()

    def _start(self) -> None:
        ctx = mp.get_context("spawn")
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=worker_main, args=(child, self.fake), daemon=True)
        self.proc.start()
        child.close()
        self.ready = False

    def wait_ready(self) -> None:
        if not self.ready:
            msg = self.conn.recv()  # raises EOFError if the worker died while loading
            self.ready = msg.get("type") == "ready"

    def ask(self, db_id: str, question: str) -> dict[str, Any]:
        try:
            self.wait_ready()
            self.conn.send({"db_id": db_id, "question": question})
            return self.conn.recv()
        except (EOFError, BrokenPipeError, OSError) as e:
            self.close()
            self._start()  # worker crashed: restart it so the next question works
            raise RuntimeError(f"model worker crashed ({type(e).__name__}); restarting") from e

    def close(self) -> None:
        try:
            self.conn.send(None)
        except (BrokenPipeError, OSError):
            pass
        self.proc.join(timeout=5)
        if self.proc.is_alive():
            self.proc.kill()
