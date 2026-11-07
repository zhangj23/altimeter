"""Fan-out auditor checks + survey over cleaned BIRD dev gold. Run: python tests/test_auditor.py"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from altimeter.auditor import audit, has_join_aggregate  # noqa: E402
from altimeter.sqlexec import run  # noqa: E402

DATA = os.path.expanduser("~/data")
DBS = f"{DATA}/bird_dev/dev_20240627/dev_databases"
OLD = f"{DATA}/bird_dev/dev_20240627/dev.json"
NEW = f"{DATA}/bird_dev_20251106/data/dev_20251106-00000-of-00001.json"


def db_path(db_id: str) -> str:
    return f"{DBS}/{db_id}/{db_id}.sqlite"


def hero() -> None:
    old = next(q for q in json.load(open(OLD)) if q["question_id"] == 571)
    new = next(q for q in json.load(open(NEW)) if q["question_id"] == 571)
    db = db_path(old["db_id"])
    old_val = run(db, old["SQL"]).rows
    new_val = run(db, new["SQL"]).rows
    counts = run(db, "SELECT (SELECT COUNT(*) FROM posts WHERE OwnerUserId = 24), "
                     "(SELECT COUNT(*) FROM votes WHERE UserId = 24)").rows
    print(f"[1] old #571 gold value={old_val}  cleaned gold value={new_val}  posts,votes for user 24={counts}")
    r = audit(db, old["SQL"])
    print(f"[1] old gold audit: flagged={r.flagged} findings={r.findings}\n    message={r.message}\n"
          f"    suggested={r.suggested_sql}")
    assert r.flagged and r.error is None
    assert r.findings[0]["table"] == "posts" and r.findings[0]["factor"] == 8.0
    assert r.suggested_sql is not None
    sug = run(db, r.suggested_sql).rows
    print(f"[1] suggested value={sug}")
    assert sug is not None and abs(sug[0][0] - new_val[0][0]) < 1e-9 and abs(new_val[0][0] - 0.375) < 1e-9

    r2 = audit(db, new["SQL"])
    print(f"[2] cleaned gold audit: flagged={r2.flagged} message={r2.message} error={r2.error}")
    assert not r2.flagged


def many_side() -> None:
    db = db_path("codebase_community")
    cases = [
        # one row per comment: COUNT/SUM over the many side is exact
        "SELECT COUNT(T2.Id) FROM posts AS T1 INNER JOIN comments AS T2 ON T2.PostId = T1.Id WHERE T1.OwnerUserId = 24",
        "SELECT SUM(T2.Score) FROM posts AS T1 INNER JOIN comments AS T2 ON T2.PostId = T1.Id WHERE T1.OwnerUserId = 24",
        # per-group: each post row lands in exactly one group, comments counted once each
        "SELECT T1.Id, COUNT(T2.Id) FROM posts AS T1 INNER JOIN comments AS T2 ON T2.PostId = T1.Id "
        "WHERE T1.OwnerUserId = 24 GROUP BY T1.Id",
        # many-to-one: posts joined to their owner user, SUM over posts
        "SELECT SUM(T1.ViewCount) FROM posts AS T1 INNER JOIN users AS T2 ON T1.OwnerUserId = T2.Id "
        "WHERE T2.DisplayName = 'csgillespie'",
        # BIRD q569 pattern: COUNT of the one-side key over a 1:N join counts the votes (joined rows)
        "SELECT COUNT(T1.Id) FROM posts AS T1 INNER JOIN votes AS T2 ON T1.Id = T2.PostId "
        "WHERE T1.Title LIKE '%data visualization%'",
        # conditional count: columns only select rows, the counted unit is the joined row
        "SELECT SUM(CASE WHEN T1.Reputation > 100 THEN 1 ELSE 0 END) FROM users AS T1 "
        "INNER JOIN posts AS T2 ON T1.Id = T2.OwnerUserId",
    ]
    for sql in cases:
        r = audit(db, sql)
        print(f"[3] flagged={r.flagged} msg={r.message} err={r.error} :: {sql[:90]}")
        assert not r.flagged and r.error is None
    # the inverse: SUM over the "one" side repeated by comments must flag
    bad = ("SELECT SUM(T1.ViewCount) FROM posts AS T1 INNER JOIN comments AS T2 ON T2.PostId = T1.Id "
           "WHERE T1.OwnerUserId = 24")
    r = audit(db, bad)
    print(f"[3] one-side SUM: flagged={r.flagged} {r.message}")
    assert r.flagged
    assert not audit(db, "SELEC broken FROM").flagged
    assert not audit(db, "SELECT nope FROM no_such_table AS a JOIN posts AS b ON 1 ").flagged


def survey() -> None:
    qs = [q for q in json.load(open(NEW)) if has_join_aggregate(q["SQL"])]
    times: list[float] = []
    flagged: list[dict] = []
    errors: list[tuple[int, str]] = []
    for q in qs:
        t0 = time.time()
        r = audit(db_path(q["db_id"]), q["SQL"])
        times.append(time.time() - t0)
        if r.error:
            errors.append((q["question_id"], r.error))
        if r.flagged:
            flagged.append({"question_id": q["question_id"], "db_id": q["db_id"], "findings": r.findings,
                            "suggested": r.suggested_sql is not None})
    times.sort()
    print(f"[4] cleaned BIRD dev gold with JOIN+aggregate: {len(qs)}; flagged {len(flagged)}/{len(qs)}; "
          f"errors {len(errors)}; runtime p50={statistics.median(times):.3f}s max={times[-1]:.3f}s "
          f"total={sum(times):.1f}s; with suggestion {sum(f['suggested'] for f in flagged)}")
    for qid, e in errors:
        print(f"    error q{qid}: {e[:120]}")
    for f in flagged:
        f0 = f["findings"][0]
        print(f"    flagged q{f['question_id']} {f['db_id']}: {f0['aggregate']} on {f0['table']} "
              f"x{f0['factor']} ({f0['joined_rows']}/{f0['distinct_rows']})")
    out = os.environ.get("AUDIT_SURVEY_OUT")
    if out:
        json.dump(flagged, open(out, "w"), indent=1)


if __name__ == "__main__":
    hero()
    many_side()
    survey()
    print("ALL CHECKS PASSED")
