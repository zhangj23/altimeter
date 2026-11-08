"""Model worker: a separate process that owns the GPU model and answers {db_id, question} over a Pipe.

Opens no network sockets (HF_HUB_OFFLINE is set by altimeter.model; the only I/O is the Pipe + SQLite).
ALTIMETER_FAKE=1 (or fake=True) skips the model and returns a canned SQL that is executed for real.
ALTIMETER_READINGS=off|auto|always (default off): two-readings sampling after the greedy answer (auto = only when
the needle is missing or below readings.ASK_BELOW; it adds ~6 sampled generations, ~15 s on the 4050). Fake mode
builds readings from two real queries.
ALTIMETER_LAYERS_PATH (default ~/models/probe_layers.json): per-layer probes (altimeter/layers.py). When the file
exists the result carries "layers": [{"layer", "p", "z", "auroc"}] (+ "layers_synthetic": true for a synthetic
test file), computed before the SQL runs; it is re-read when the file changes. Missing file: no "layers" field.
Every real-model result also has "timing": {"prompt_s","generate_s","features_s","score_s","layers_s","exec_s",
"worker_s"} (seconds) for latency profiling.

Pipe protocol (worker -> parent): {"type":"ready"} once after load + warm-up; per request, zero or more
{"type":"stage","stage":"generating"|"scoring"|"executing"|"sampling"} and then the result dict (no "type").
ALTIMETER_JOB_TIMEOUT (seconds, default 45): WorkerClient.ask kills and restarts a worker that takes longer.
ALTIMETER_STALL_TEST=1: the question "stall test" hangs the worker (only for testing the timeout path).
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
WARMUP = [("california_schools", "How many schools are in Alameda County?"),
          ("formula_1", "How many races were held in 2009?")]
STALL_QUESTION = "stall test"


class JobTimeout(RuntimeError):
    pass


def job_timeout_s() -> float:
    try:
        return float(os.environ.get("ALTIMETER_JOB_TIMEOUT", "45"))
    except ValueError:
        return 45.0


def list_dbs() -> list[str]:
    return sorted(p.name for p in DB_ROOT.iterdir() if (p / f"{p.name}.sqlite").is_file()) if DB_ROOT.is_dir() else []


def db_path(db_id: str) -> str:
    if db_id.startswith("upload:"):  # in-memory upload (server/uploads.py): read-only memdb URI, no file
        from . import uploads

        return uploads.db_path(db_id)
    return str(DB_ROOT / db_id / f"{db_id}.sqlite")


def known_db(db_id: str) -> bool:
    """A BIRD db on disk, or a live upload (gateway process only; touching an upload keeps it alive)."""
    if db_id.startswith("upload:"):
        from .uploads import STORE

        return STORE.touch(db_id)
    return db_id in list_dbs()


_UPLOADS: dict[str, sqlite3.Connection] = {}  # worker process: upload id -> anchor of its memdb copy


def _sync_uploads(req: dict[str, Any]) -> None:
    """Worker side: drop uploads the gateway no longer holds, and load the one this request ships."""
    from . import uploads

    live = req.get("uploads_live")
    if live is not None:
        for uid in [u for u in _UPLOADS if u not in live]:
            _UPLOADS.pop(uid).close()
    up = req.get("upload")
    if up and up["id"] not in _UPLOADS:
        if "tables_sql" not in up:
            raise RuntimeError("upload not loaded in the model worker; ask again")
        _UPLOADS[up["id"]] = uploads.load_export(up)


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
    mode = os.environ.get("ALTIMETER_READINGS", "off").strip().lower()
    return mode if mode in ("auto", "always", "off") else "off"


def _fake_samples(path: str) -> list[str]:
    """Fake mode: two different real queries (3 + 2 samples) plus one that errors, so clustering runs for real."""
    a = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 3"
    b = "SELECT COUNT(*) AS n_tables FROM sqlite_master WHERE type='table'"
    return [a, a, b, a, b, "SELECT no_such_column FROM sqlite_master"]


def _readings(model: Any, messages: list[dict[str, str]] | None, path: str, needle: float | None,
              emit: Any = None) -> dict[str, Any]:
    """Sample + cluster after the greedy answer. Never raises: a failure here must not lose the answer."""
    from altimeter.readings import ASK_BELOW, choose_readings, cluster

    mode = _readings_mode()
    if mode == "off" or (mode == "auto" and needle is not None and needle >= ASK_BELOW):
        return {"readings": None, "readings_seconds": None, "readings_error": None}
    if emit:
        emit("sampling")
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


def _answer(model: Any, probe: Any, req: dict[str, Any], emit: Any = None, layer_src: Any = None) -> dict[str, Any]:
    from altimeter.layers import result_fields
    from altimeter.prompting import build_messages

    emit = emit or (lambda _stage: None)
    t_start = time.perf_counter()
    db_id, question = req["db_id"], req["question"]
    emit("generating")
    if os.environ.get("ALTIMETER_STALL_TEST") == "1" and question.strip().lower() == STALL_QUESTION:
        time.sleep(3600)  # timeout test: the parent has to kill this process
    path = db_path(db_id)
    score = None
    messages = None
    layers: dict[str, Any] = {}
    timing: dict[str, Any] | None = None
    if model is None:  # fake mode
        time.sleep(1.0)
        gen = {"sql": FAKE_SQL, "gen_seconds": 1.0, "n_prompt": 0, "n_gen": 0, "logprob_mean": None, "logprob_min": None}
    else:
        t0 = time.perf_counter()
        messages = build_messages(path, question)
        t_prompt = time.perf_counter() - t0
        g = model.generate(messages)
        gen = {
            "sql": g.sql,
            "gen_seconds": round(g.gen_seconds + g.feat_seconds, 3),
            "n_prompt": g.n_prompt,
            "n_gen": g.n_gen,
            "logprob_mean": round(g.logprob_mean, 4),
            "logprob_min": round(g.logprob_min, 4),
        }
        if probe is not None:
            emit("scoring")
        t0 = time.perf_counter()
        score = _score(probe, g, question, path)  # before execution
        t_score = time.perf_counter() - t0
        t0 = time.perf_counter()
        layers = result_fields(layer_src, {"last_prompt": g.hs_last_prompt, "last_gen": g.hs_last_gen,
                                           "mean_gen": g.hs_mean_gen})  # also before execution
        t_layers = time.perf_counter() - t0
        timing = {"prompt_s": round(t_prompt, 4), "generate_s": round(g.gen_seconds, 3),
                  "features_s": round(g.feat_seconds, 3), "score_s": round(t_score, 4),
                  "layers_s": round(t_layers, 4)}
        del g
    emit("executing")
    result = execute(db_id, gen["sql"])  # greedy answer runs before any sampling
    needle = score["needle"] if score else None
    explain = score.pop("explain", None) if score else None
    readings = _readings(model, messages, path, needle, emit)
    if timing is not None:
        timing["exec_s"] = result["exec_seconds"]
        timing["worker_s"] = round(time.perf_counter() - t_start, 3)
    return {"db_id": db_id, "question": question, **gen, "probe": score, "explain": explain, **layers, **result,
            **readings, "timing": timing, "fake": model is None}


def _warm_up(model: Any, probe: Any) -> list[dict[str, Any]]:
    """1-2 real generations on BIRD dbs, so the first judge's question does not pay the CUDA warm-up."""
    from altimeter.prompting import build_messages

    dbs = set(list_dbs())
    picks = [w for w in WARMUP if w[0] in dbs] or [(d, "How many rows are in the first table?") for d in sorted(dbs)[:1]]
    out = []
    for db_id, q in picks[:2]:
        t0 = time.time()
        try:
            path = db_path(db_id)
            g = model.generate(build_messages(path, q))
            _score(probe, g, q, path)
            execute(db_id, g.sql)
            del g
            out.append({"db_id": db_id, "seconds": round(time.time() - t0, 2)})
        except Exception as e:  # noqa: BLE001 - warm-up is best effort
            out.append({"db_id": db_id, "error": f"{type(e).__name__}: {e}"})
        finally:
            import torch

            torch.cuda.empty_cache()
    return out


def worker_main(conn: Connection, fake: bool) -> None:
    model = probe = layer_src = None
    if not fake:
        from altimeter.layers import LayerSource

        from altimeter.model import SqlModel

        model = SqlModel(MODEL_PATH)
        if PROBE_PATH.is_file():
            from altimeter.probe import Probe

            probe = Probe(str(PROBE_PATH))
        layer_src = LayerSource()
    warm = [] if model is None else _warm_up(model, probe)
    layers_info = None
    if layer_src is not None:
        lp = layer_src.get()
        layers_info = {"path": str(layer_src.path), "loaded": lp is not None, "error": layer_src.error,
                       "n": len(lp.layer_ids) if lp else 0, "synthetic": bool(lp and lp.synthetic)}
    conn.send({"type": "ready", "fake": fake, "probe": probe is not None, "warmup": warm, "layers": layers_info})
    while True:
        try:
            req = conn.recv()
        except EOFError:
            return
        if req is None:
            return
        try:
            _sync_uploads(req)
            out = _answer(model, probe, req, lambda stage: conn.send({"type": "stage", "stage": stage}), layer_src)
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
        self.ready_info: dict[str, Any] | None = None
        self.restarts = 0
        self._start()

    def _start(self) -> None:
        ctx = mp.get_context("spawn")
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=worker_main, args=(child, self.fake), daemon=True)
        self.proc.start()
        child.close()
        self.ready = False
        self.warm_started = time.time()

    def restart(self) -> None:
        """Kill the worker (stuck or crashed) and start a fresh one; it reloads and warms up again."""
        if self.proc.is_alive():
            self.proc.kill()
        self.proc.join(timeout=10)
        self.conn.close()
        self.restarts += 1
        self._start()

    def wait_ready(self) -> None:
        if not self.ready:
            msg = self.conn.recv()  # raises EOFError if the worker died while loading
            self.ready_info = msg
            self.ready = msg.get("type") == "ready"

    def ask(self, db_id: str, question: str, on_stage: Any = None, timeout_s: float | None = None,
            upload: dict[str, Any] | None = None, uploads_live: list[str] | None = None) -> dict[str, Any]:
        """Relays {"type":"stage"} messages to on_stage(stage) and returns the result. Waiting for the worker to
        be ready does not count; past timeout_s (default ALTIMETER_JOB_TIMEOUT) the worker is restarted.
        upload: uploads.Store.export() for an "upload:" db_id; uploads_live: ids the worker may keep."""
        timeout_s = job_timeout_s() if timeout_s is None else timeout_s
        try:
            self.wait_ready()
            self.conn.send({"db_id": db_id, "question": question, "upload": upload, "uploads_live": uploads_live})
            deadline = time.monotonic() + timeout_s
            while True:
                left = deadline - time.monotonic()
                if left <= 0 or not self.conn.poll(left):
                    self.restart()
                    raise JobTimeout(f"job exceeded {timeout_s:g} s; model worker restarted")
                msg = self.conn.recv()
                if isinstance(msg, dict) and msg.get("type") == "stage":
                    if on_stage is not None:
                        on_stage(msg["stage"])
                    continue
                return msg
        except (EOFError, BrokenPipeError, OSError) as e:
            self.restart()  # worker crashed: restart it so the next question works
            raise RuntimeError(f"model worker crashed ({type(e).__name__}); restarting") from e

    def close(self) -> None:
        try:
            self.conn.send(None)
        except (BrokenPipeError, OSError):
            pass
        self.proc.join(timeout=5)
        if self.proc.is_alive():
            self.proc.kill()
