"""Read-only SQLite execution with a wall-clock timeout, and BIRD-style result comparison."""
from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class ExecResult:
    rows: list[tuple[Any, ...]] | None
    error: str | None
    seconds: float
    timed_out: bool = False


def run(db_path: str, sql: str, timeout_s: float = 10.0, max_rows: int | None = None) -> ExecResult:
    t0 = time.time()
    if not sql.strip():
        return ExecResult(None, "empty SQL", 0.0)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    deadline = t0 + timeout_s
    con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10_000)
    try:
        cur = con.execute(sql)
        rows = cur.fetchmany(max_rows) if max_rows else cur.fetchall()
        return ExecResult(rows, None, time.time() - t0)
    except sqlite3.OperationalError as e:
        timed_out = time.time() > deadline or "interrupted" in str(e)
        return ExecResult(None, "timeout" if timed_out else f"OperationalError: {e}", time.time() - t0, timed_out)
    except Exception as e:  # noqa: BLE001 - any failure means "does not execute"
        return ExecResult(None, f"{type(e).__name__}: {e}", time.time() - t0)
    finally:
        con.close()


def compiles(db_path: str, sql: str) -> bool:
    """True if SQLite can prepare the statement (EXPLAIN compiles it without scanning any data)."""
    if not sql.strip():
        return False
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return False
    try:
        con.execute("EXPLAIN " + sql.strip().rstrip(";"))
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        con.close()


def _norm(v: Any) -> Any:
    if isinstance(v, float):
        return round(v, 4)
    return v


def normalize(rows: list[tuple[Any, ...]]) -> frozenset[tuple[Any, ...]]:
    return frozenset(tuple(_norm(v) for v in r) for r in rows)


def results_match(pred: list[tuple[Any, ...]], gold: list[tuple[Any, ...]]) -> bool:
    """Set equality with floats rounded to 4 dp (BIRD's official metric uses set equality)."""
    return normalize(pred) == normalize(gold)
