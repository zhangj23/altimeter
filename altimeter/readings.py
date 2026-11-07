"""Two readings: execute sampled SQLs, cluster them by result, and decide whether to show two answers.

Clusters are keyed on the normalized result set (sqlexec.normalize: set of rows, floats to 4 dp), so two
differently-written SQLs that return the same answer are one reading. Samples that error form no cluster.
"""
from __future__ import annotations

import sqlite3
import time
from collections import Counter
from typing import Any

from . import sqlexec

# Placeholder until the stacked score is calibrated: below this needle the UI is in the "Ask" band.
ASK_BELOW = 0.5
MAX_TOP_SHARE = 0.6   # show readings only if the most common answer has < 60% of samples
MIN_SECOND = 2        # ... and the runner-up answer came up at least twice
MAX_FETCH = 10_000    # rows fetched per sample for comparison; n_rows saturates here
PREVIEW_ROWS = 3


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str)):
        return v
    if isinstance(v, bytes):
        return f"<blob {len(v)} bytes>"
    return str(v)


def _columns(db_path: str, sql: str) -> list[str] | None:
    """Column names without scanning: wrap with LIMIT 0."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    deadline = time.time() + 1.0
    con.set_progress_handler(lambda: 1 if time.time() > deadline else 0, 10_000)
    try:
        cur = con.execute(f"SELECT * FROM ({sql.strip().rstrip(';')}) LIMIT 0")
        return [d[0] for d in cur.description or []]
    except sqlite3.Error:
        return None
    finally:
        con.close()


def cluster(db_path: str, sqls: list[str], timeout_s: float = 2.0) -> list[dict[str, Any]]:
    """Execute each SQL read-only and group by result. Sorted by size (desc), ties by first appearance.

    Each cluster: {sql, share, n_samples, columns, rows (first 3, JSON-safe), n_rows, error}.
    share is out of ALL samples (errored ones included). error is always None (errors form no cluster).
    """
    n = len(sqls)
    groups: dict[frozenset[tuple[Any, ...]], dict[str, Any]] = {}
    for sql in sqls:
        res = sqlexec.run(db_path, sql, timeout_s=timeout_s, max_rows=MAX_FETCH)
        if res.rows is None:
            continue
        key = sqlexec.normalize(res.rows)
        g = groups.setdefault(key, {"sqls": [], "first_rows": {}})
        g["sqls"].append(sql)
        g["first_rows"].setdefault(sql, res.rows)
    out: list[dict[str, Any]] = []
    for g in groups.values():
        rep = Counter(g["sqls"]).most_common(1)[0][0]  # Counter keeps first-seen order on ties
        rows = g["first_rows"][rep]
        cols = _columns(db_path, rep)
        if cols is not None and rows and len(cols) != len(rows[0]):
            cols = None
        out.append({
            "sql": rep,
            "share": round(len(g["sqls"]) / n, 4) if n else 0.0,
            "n_samples": len(g["sqls"]),
            "columns": cols,
            "rows": [[_cell(v) for v in r] for r in rows[:PREVIEW_ROWS]],
            "n_rows": len(rows),
            "error": None,
        })
    out.sort(key=lambda c: -c["n_samples"])  # stable: ties keep first-appearance order
    return out


def choose_readings(clusters: list[dict[str, Any]], needle: float | None) -> list[dict[str, Any]] | None:
    """Top two clusters when the gauge is low (or absent) AND the samples genuinely disagree; else None."""
    if needle is not None and needle >= ASK_BELOW:
        return None
    if len(clusters) < 2 or clusters[0]["share"] >= MAX_TOP_SHARE or clusters[1]["n_samples"] < MIN_SECOND:
        return None
    return clusters[:2]
