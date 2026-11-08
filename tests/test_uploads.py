"""Import-your-own-database checks. Starts its own fake-model server (never touches :8000).
Run (WSL, repo root): python tests/test_uploads.py   [ALTIMETER_TEST_PORT=8017]"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)

from server import uploads  # noqa: E402

PORT = int(os.environ.get("ALTIMETER_TEST_PORT", "8017"))
BASE = f"http://127.0.0.1:{PORT}"
SPIDER_DB = os.path.expanduser("~/data/spider_data/database/concert_singer/concert_singer.sqlite")

BUDGET_CSV = b"budget_id,category,amount\n1,Food,100\n2,Travel,250.5\n3,Rent,900\n"
EXPENSE_CSV = (b"expense id;budget_id;cost;note\n1;1;20;lunch\n2;1;30;\n3;1;10;snacks\n"
               b"4;2;200;train\n5;2;40.25;taxi\n6;3;900;march\n")
FANOUT_SQL = ("SELECT b.category, SUM(b.amount) AS budget, SUM(e.cost) AS spent FROM budget b "
              "JOIN expense e ON e.budget_id = b.budget_id GROUP BY b.category")
CLEAN_SQL = "SELECT category, amount FROM budget ORDER BY budget_id"


def multipart(files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = "----altimeterTest7d1b"
    out = b""
    for name, data in files:
        out += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                "Content-Type: application/octet-stream\r\n\r\n").encode() + data + b"\r\n"
    return out + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def http(method: str, path: str, body: bytes | None = None, ctype: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def upload(files: list[tuple[str, bytes]]) -> tuple[int, dict]:
    body, ctype = multipart(files)
    return http("POST", "/api/upload", body, ctype)


def check(db_id: str, sql: str) -> dict:
    code, out = http("POST", "/api/check", json.dumps({"db_id": db_id, "sql": sql}).encode(), "application/json")
    assert code == 200, (code, out)
    return out


# ---- in-process --------------------------------------------------------------------------------------------
def test_multipart_exact_bytes() -> None:
    blob = uploads.SQLITE_MAGIC + b"\r\n--x\r\n\x00\xff" * 50
    body, ctype = multipart([("a.sqlite", blob), ("dir\\b.csv", b"x,y\r\n1,2\r\n")])
    got = uploads.parse_multipart(ctype, body)
    assert got == [("a.sqlite", blob), ("b.csv", b"x,y\r\n1,2\r\n")], got
    print("[ok] multipart keeps exact bytes, strips client paths")


def test_csv_inference() -> None:
    cols, types, rows = uploads.parse_csv("e.csv", EXPENSE_CSV)
    assert cols == ["expense_id", "budget_id", "cost", "note"] and types == ["INTEGER", "INTEGER", "REAL", "TEXT"]
    assert rows[1][3] is None  # empty cell -> NULL
    cols, types, _ = uploads.parse_csv("z.csv", b"Zip,Order,Select,2x\n02139,1,a,b\n10001,2,c,d\n")
    assert cols == ["zip", "order_", "select_", "c_2x"] and types[0] == "TEXT", (cols, types)
    print("[ok] CSV: delimiter sniffed, types inferred, names sanitized, zip codes stay TEXT")


def test_expiry() -> None:
    st = uploads.Store(ttl_s=0.3, max_live=8)
    db_id = st.add([("t.csv", b"a,b\n1,2\n")])
    path = uploads.db_path(db_id)
    assert st.touch(db_id) and st.info(db_id)["tables"] == [{"name": "t", "rows": 1}]
    time.sleep(0.5)
    assert not st.touch(db_id) and st.info(db_id) is None and db_id.split(":")[1] not in st.ids()
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)  # memdb freed with its anchor: empty now
    assert con.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0
    con.close()
    st2 = uploads.Store(ttl_s=60, max_live=2)
    ids = [st2.add([(f"t{i}.csv", b"a\n1\n")]) for i in range(3)]
    assert not st2.touch(ids[0]) and st2.touch(ids[1]) and st2.touch(ids[2])
    print("[ok] expiry: idle upload dropped after TTL and its memory freed; oldest evicted past max_live")


# ---- HTTP (own server on PORT) ---------------------------------------------------------------------------
def test_csv_fanout() -> str:
    code, out = upload([("Budget.csv", BUDGET_CSV), ("expense.csv", EXPENSE_CSV)])
    assert code == 200, out
    db_id = out["db_id"]
    assert db_id.startswith("upload:") and out["tables"] == [{"name": "budget", "rows": 3},
                                                             {"name": "expense", "rows": 6}], out
    assert 0 < out["expires_in_s"] <= 900
    code, info = http("GET", f"/api/upload/{db_id.split(':')[1]}")
    assert code == 200 and info["tables"] == out["tables"]
    code, sch = http("GET", f"/api/schema?db_id={db_id}")
    assert code == 200 and sch["calibrated"] is False, sch
    assert [c["type"] for c in sch["tables"][1]["columns"]] == ["INTEGER", "INTEGER", "REAL", "TEXT"]
    r = check(db_id, FANOUT_SQL)
    assert r["flagged"] and r["findings"][0]["table"] == "budget", r
    food = next(row for row in r["original"]["rows"] if row[0] == "Food")
    assert food[1] == 300, food  # 100 budget counted once per expense row (3)
    fixed = None
    if r["corrected"]:  # the auditor offers a rewrite only for some shapes; flagging is what matters here
        assert not r["corrected"].get("error"), r["corrected"]
        fixed = next(row for row in r["corrected"]["rows"] if row[0] == "Food")
        assert fixed[1] == 100, fixed
    c = check(db_id, CLEAN_SQL)
    assert not c["flagged"] and c["original"]["rows"][1] == ["Travel", 250.5], c
    print(f"[ok] CSV upload: {out['tables']}; auditor flags budget fan-out (Food 300; rewrite: {fixed and fixed[1]})\n"
          f"     message: {r['message']}")
    return db_id


def test_guards(db_id: str) -> None:
    for sql in ("ATTACH DATABASE '/tmp/altimeter_attach.db' AS x", "DELETE FROM budget",
                "INSERT INTO budget VALUES (9, 'x', 1)", "DROP TABLE expense", "PRAGMA writable_schema = 1"):
        err = check(db_id, sql)["original"]["error"]
        assert err and ("not authorized" in err or "readonly" in err), (sql, err)
    assert not os.path.exists("/tmp/altimeter_attach.db")
    assert check(db_id, "SELECT COUNT(*) FROM budget")["original"]["rows"] == [[3]]
    code, out = http("POST", "/api/check", json.dumps({"db_id": "upload:nope_nope_nope", "sql": "SELECT 1"}).encode(),
                     "application/json")
    assert code == 400, out
    print("[ok] ATTACH / DELETE / INSERT / DROP / PRAGMA refused on an upload; unknown upload id -> 400")


def test_sqlite_upload() -> None:
    tmp = tempfile.mkdtemp()
    try:
        path = os.path.join(tmp, "concert.sqlite")
        shutil.copy(SPIDER_DB, path)
        con = sqlite3.connect(path)
        con.execute("CREATE VIEW v_singer AS SELECT name FROM singer")
        con.execute("CREATE TRIGGER t_ins AFTER INSERT ON singer BEGIN DELETE FROM concert; END")
        con.commit()
        expect = {t: con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for (t,) in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        con.close()
        data = open(path, "rb").read()
    finally:
        shutil.rmtree(tmp)
    code, out = upload([("concert_singer.sqlite", data)])
    assert code == 200, out
    assert {t["name"]: t["rows"] for t in out["tables"]} == expect, (out, expect)
    left = check(out["db_id"], "SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger')")
    assert left["original"]["rows"] == [], left
    r = check(out["db_id"], "SELECT COUNT(*) FROM singer AS s JOIN singer_in_concert AS sc ON s.singer_id = sc.singer_id")
    assert r["original"]["error"] is None
    print(f"[ok] .sqlite upload (Spider concert_singer): {expect}; view + trigger dropped")


def test_rejections() -> None:
    cases = [
        ([("big.csv", b"a,b\n" + b"1,2\n" * (11 * 1024 * 1024 // 4))], "MB"),
        ([("bad.sqlite", b"this is not a database at all" * 10)], "bad header"),
        ([("corrupt.sqlite", uploads.SQLITE_MAGIC + b"\x10\x00" + b"\xff" * 4000)], "SQLite"),
        ([("wide.csv", (",".join(f"c{i}" for i in range(51)) + "\n" + ",".join("1" * 51) + "\n").encode())], "50"),
        ([("a.csv", b"x\n1\n"), ("b.sqlite", b"x")], ".csv"),
        ([("notes.txt", b"hello")], ".csv"),
        ([(f"t{i}.csv", b"x\n1\n") for i in range(9)], "1-8"),
        ([("ragged.csv", b"a,b\n1,2,3\n")], "cells"),
    ]
    for files, needle in cases:
        code, out = upload(files)
        assert code == 400 and needle in out.get("error", ""), (files[0][0], code, out)
    code, out = http("POST", "/api/upload", b"plain", "text/plain")
    assert code == 400, out
    print(f"[ok] {len(cases) + 1} bad uploads rejected with 400 + message (oversize, bad header, corrupt, "
          "wide, mixed, wrong type, too many files, ragged, not multipart)")


def test_max_live() -> None:
    first = upload([("first.csv", b"a\n1\n")])[1]["db_id"]
    for i in range(8):
        assert upload([(f"t{i}.csv", b"a\n1\n")])[0] == 200
    assert http("GET", f"/api/upload/{first}")[0] == 404
    assert http("GET", f"/api/schema?db_id={first}")[0] == 404
    print("[ok] 9th upload evicts the oldest (404 afterwards)")


async def _ask(db_id: str) -> dict:
    import websockets

    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as ws:
        await ws.send(json.dumps({"type": "hello", "client": "uploadtest01", "last_job": None}))
        await ws.send(json.dumps({"db_id": db_id, "question": "List the tables"}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 60))
            if msg["type"] in ("result", "error"):
                return msg


def test_ask(db_id: str) -> None:
    for _ in range(2):  # second ask reuses the worker's copy
        res = asyncio.run(_ask(db_id))
        assert res["type"] == "result" and not res.get("error"), res
        assert res["calibrated"] is False and res["calibration_note"] == uploads.CALIBRATION_NOTE
        assert sorted(r[0] for r in res["rows"]) == ["budget", "expense"], res["rows"]
    print("[ok] Test flight on an upload: worker runs SQL on its copy; result carries calibrated=false")


def main() -> None:
    test_multipart_exact_bytes()
    test_csv_inference()
    test_expiry()
    env = dict(os.environ, PYTHONPATH=ROOT)
    proc = subprocess.Popen([sys.executable, "-m", "server.app", "--fake", "--port", str(PORT),
                             "--host", "127.0.0.1"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                if http("GET", "/api/status")[1].get("ready"):
                    break
            except (urllib.error.URLError, ConnectionError):
                pass
            time.sleep(0.5)
        else:
            raise SystemExit("test server did not become ready")
        db_id = test_csv_fanout()
        test_guards(db_id)
        test_ask(db_id)
        test_sqlite_upload()
        test_rejections()
        test_max_live()
    finally:
        proc.terminate()
        proc.wait(10)
    print("all upload tests passed")


if __name__ == "__main__":
    main()
