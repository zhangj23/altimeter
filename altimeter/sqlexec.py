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


# Process-wide cap on SQLite's own heap (PRAGMA hard_heap_limit, SQLite >= 3.31): a query like
# SELECT zeroblob(900000000) FROM (VALUES (1), (2)) then fails with MemoryError instead of exhausting RAM.
# Uploads' in-memory databases (<= 8 x ~10 MB files) count toward it too; 256 MB leaves room for them.
HEAP_LIMIT_BYTES = 256 * 1024 * 1024
# Python-side cap on one result: fetching stops with an error past this many (approximate) bytes.
MAX_RESULT_BYTES = 64 * 1024 * 1024
TOO_LARGE = "result too large"


def apply_heap_limit() -> None:
    """Set the hard heap limit for this process (idempotent; a no-op on SQLite builds without the pragma)."""
    try:
        con = sqlite3.connect(":memory:")
        try:
            con.execute(f"PRAGMA hard_heap_limit={HEAP_LIMIT_BYTES}")
        finally:
            con.close()
    except sqlite3.Error:
        pass


apply_heap_limit()

SAFE_PRAGMAS = {"table_info", "table_xinfo", "foreign_key_list", "index_list", "index_info", "index_xinfo"}

DENY_FUNCTIONS = {"load_extension", "fts3_tokenizer"}
_DENY_ACTIONS = {getattr(sqlite3, n) for n in (
    "SQLITE_ATTACH", "SQLITE_DETACH", "SQLITE_CREATE_VTABLE", "SQLITE_DROP_VTABLE", "SQLITE_CREATE_TEMP_TABLE",
    "SQLITE_CREATE_TEMP_VIEW", "SQLITE_CREATE_TEMP_TRIGGER", "SQLITE_CREATE_TEMP_INDEX") if hasattr(sqlite3, n)}


def _authorizer(action: int, arg1: str | None, arg2: str | None, db: str | None, src: str | None) -> int:
    """Untrusted SQL guard (pasted queries, model output): read-only DB already blocks writes; this also blocks
    ATTACH/DETACH (opening other files), load_extension, fts3_tokenizer (leaks a pointer), temp objects and
    virtual tables (the read-only flag does not cover the temp schema), and any PRAGMA outside a whitelist."""
    if action in _DENY_ACTIONS:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and (arg1 or "").lower() not in SAFE_PRAGMAS:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() in DENY_FUNCTIONS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def connect_guarded(db_path: str) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, check_same_thread=False)
    con.set_authorizer(_authorizer)
    return con


def _size(row: tuple[Any, ...]) -> int:
    return sum(len(v) if isinstance(v, (str, bytes)) else 8 for v in row) + 16


def _fetch(cur: sqlite3.Cursor, max_rows: int | None, max_bytes: int) -> list[tuple[Any, ...]] | None:
    """Rows up to max_rows; None once they pass max_bytes (a memory guard, not a result cap)."""
    rows: list[tuple[Any, ...]] = []
    total = 0
    if max_rows is not None and max_rows <= 0:
        return rows
    for r in cur:  # row by row, so one huge value stops the fetch before the next is copied
        total += _size(r)
        if total > max_bytes:
            return None
        rows.append(r)
        if max_rows is not None and len(rows) >= max_rows:
            break
    return rows


def run(db_path: str, sql: str, timeout_s: float = 10.0, max_rows: int | None = None,
        max_bytes: int = MAX_RESULT_BYTES) -> ExecResult:
    t0 = time.time()
    if not sql.strip():
        return ExecResult(None, "empty SQL", 0.0)
    try:
        con = connect_guarded(db_path)
    except sqlite3.Error as e:
        return ExecResult(None, f"{type(e).__name__}: {e}", time.time() - t0)
    deadline = t0 + timeout_s
    con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10_000)
    try:
        cur = con.execute(sql)
        rows = _fetch(cur, max_rows or None, max_bytes)
        if rows is None:
            return ExecResult(None, TOO_LARGE, time.time() - t0)
        return ExecResult(rows, None, time.time() - t0)
    except sqlite3.OperationalError as e:
        timed_out = time.time() > deadline or "interrupted" in str(e)
        return ExecResult(None, "timeout" if timed_out else f"OperationalError: {e}", time.time() - t0, timed_out)
    except MemoryError:  # SQLite's hard heap limit, or a huge value on the Python side
        return ExecResult(None, f"{TOO_LARGE} (memory limit)", time.time() - t0)
    except Exception as e:  # noqa: BLE001 - any failure means "does not execute"
        return ExecResult(None, f"{type(e).__name__}: {e}", time.time() - t0)
    finally:
        con.close()


def compiles(db_path: str, sql: str) -> bool:
    """True if SQLite can prepare the statement (EXPLAIN compiles it without scanning any data)."""
    if not sql.strip():
        return False
    try:
        con = connect_guarded(db_path)
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
