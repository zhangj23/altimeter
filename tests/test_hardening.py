"""Robustness + security checks for the server side (SQL guard, uploads, WebSocket, worker errors).
Unit checks run in-process; the rest start their own fake-model server (never touches :8000).
Run (WSL, repo root): python tests/test_hardening.py   [ALTIMETER_HARDEN_PORT=8082]"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)

from altimeter import prompting, sqlexec  # noqa: E402
from server import uploads, worker  # noqa: E402

PORT = int(os.environ.get("ALTIMETER_HARDEN_PORT", "8082"))
BASE = f"http://127.0.0.1:{PORT}"
BIRD = "formula_1" if "formula_1" in worker.list_dbs() else None
SENTINEL = "ZQX_SENTINEL_7781"

ATTACKS = {  # sql -> substring the error must contain (None: any error)
    "SELECT 1; DELETE FROM {t}": "one statement",
    "DELETE FROM {t}": "readonly",
    "WITH x AS (SELECT 1) DELETE FROM {t}": "readonly",
    "CREATE TEMP TABLE z AS SELECT 1": "not authorized",
    "CREATE TEMP VIEW z AS SELECT 1": "not authorized",
    "CREATE VIRTUAL TABLE temp.f USING fts4(x)": None,
    "ATTACH DATABASE '/tmp/x.db' AS x": "not authorized",
    "PRAGMA writable_schema=1": "not authorized",
    "SELECT * FROM pragma_database_list": "not authorized",  # would leak the db file path
    "SELECT load_extension('/tmp/x.so')": "not authorized",
    "SELECT fts3_tokenizer('simple')": "not authorized",  # returns a raw pointer
    "VACUUM INTO '/tmp/alt_leak.db'": None,
}
BOMBS = [  # must fail fast (timeout or size guard) without eating memory
    "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT count(*) FROM r",
    "SELECT zeroblob(900000000) FROM (VALUES (1), (2), (3), (4))",
    "SELECT zeroblob(200000000) FROM (VALUES (1), (2), (3), (4))",
    "SELECT length(replace(hex(zeroblob(400000000)), '0', 'aa'))",
    "WITH RECURSIVE r(s, n) AS (SELECT 'x', 0 UNION ALL SELECT s || s, n + 1 FROM r WHERE n < 30) SELECT s FROM r",
    "SELECT printf('%.*c', 900000000, 'x')",
]


def ok(msg: str) -> None:
    print(f"[ok] {msg}", flush=True)


def _memdb(csv: bytes) -> tuple[uploads.Store, str]:
    st = uploads.Store(ttl_s=60, max_live=8)
    return st, st.add([("t.csv", csv)])


def _rss_mb() -> int:
    import resource

    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024


# ---- in-process --------------------------------------------------------------------------------------------
def test_sql_guard() -> None:
    st, db_id = _memdb(b"a,b\n1,x\n2,y\n")
    paths = [("upload", uploads.db_path(db_id))] + ([("bird", worker.db_path(BIRD))] if BIRD else [])
    for label, path in paths:
        table = "t" if label == "upload" else "races"
        for sql, want in ATTACKS.items():
            r = sqlexec.run(path, sql.replace("{t}", table), 2.0, 200)
            assert r.rows is None and r.error, (label, sql, r)
            assert want is None or want in r.error, (label, sql, r.error)
        assert not os.path.exists("/tmp/alt_leak.db")
        r = sqlexec.run(path, f"SELECT * FROM pragma_table_info('{table}')", 2.0, 200)
        assert r.rows, r  # the whitelisted schema pragmas still work
        r = sqlexec.run(path, "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x FROM r",
                        5.0, 200)
        assert r.rows is not None and len(r.rows) == 200  # unbounded rows stop at the cap
        rss0 = _rss_mb()
        for sql in BOMBS:
            t0 = time.time()
            r = sqlexec.run(path, sql, 5.0, 200)
            assert r.rows is None and (r.timed_out or "too large" in (r.error or "")), (sql, r.error)
            assert time.time() - t0 < 7.0, sql
        assert _rss_mb() - rss0 < 1200, _rss_mb() - rss0  # peak, one value + its copy at most
        if label == "bird":
            t0 = time.time()
            r = sqlexec.run(path, "SELECT count(*) FROM results a, results b, results c", 5.0, 200)
            assert r.timed_out and time.time() - t0 < 6.0, r
    # wrapped column lookup goes through the same authorizer
    assert worker._columns(paths[0][1], "SELECT load_extension('x')") is None
    assert worker._columns(paths[0][1], "SELECT a, b FROM t") == ["a", "b"]
    st.remove(db_id)
    ok(f"SQL guard on {', '.join(p[0] for p in paths)}: {len(ATTACKS)} write/attach/pragma/extension attacks "
       f"refused; {len(BOMBS)} recursive/zeroblob/string bombs stop in <7 s within the memory limit")


def test_csv_edges() -> None:
    cols, types, rows = uploads.parse_csv("bom.csv", b"\xef\xbb\xbfid,name\n1,a\n")
    assert cols == ["id", "name"], cols
    cols, _, rows = uploads.parse_csv("u16.csv", "id\tname\n1\tZo\u00eb\n".encode("utf-16"))
    assert cols == ["id", "name"] and rows == [["1", "Zo\u00eb"]], (cols, rows)
    cols, _, rows = uploads.parse_csv("l1.csv", "id,city\n1,M\u00fcnchen\n".encode("latin-1"))
    assert rows[0][1] == "M\u00fcnchen"
    cols, _, _ = uploads.parse_csv("dup.csv", b"a,a,,select,From,\"we\"\"ird\",1x\nx,y,z,w,v,u,t\n")
    assert len(set(cols)) == len(cols) and "select_" in cols and "from_" in cols and "c_1x" in cols, cols
    _, _, rows = uploads.parse_csv("q.csv", b'id,note\n1,"line one\nline two, with comma"\n2,"say ""hi"""\n')
    assert rows == [["1", "line one\nline two, with comma"], ["2", 'say "hi"']], rows
    for name, data, want in [
        ("huge.csv", b"a,b\n1," + b"x" * 200_000 + b"\n", "not a readable CSV"),
        ("nul.csv", b"a,b\n1,\x00\n", "not a readable CSV"),
        ("rows.csv", b"a\n" + b"1\n" * (uploads.MAX_ROWS + 5), "rows; the limit"),
        ("empty.csv", b"   \n", "empty"),
    ]:
        try:
            uploads.parse_csv(name, data)
            raise AssertionError(f"{name} accepted")
        except uploads.UploadError as e:
            assert want in str(e), (name, str(e))
    t0 = time.time()
    for data in (b",'a" * 21_000, b"'x' ,\"y\"; " * 6000):  # csv.Sniffer is quadratic on these
        try:
            uploads.parse_csv("slow.csv", data + b"\n")
        except uploads.UploadError:
            pass
    assert time.time() - t0 < 3.0, time.time() - t0
    ok("CSV edges: BOM, UTF-16, latin-1, duplicate/blank/keyword/digit headers, quoted newlines; huge cell, NUL, "
       f"too many rows, empty rejected; pathological sniffer input in {time.time() - t0:.2f} s")


def test_sqlite_edges() -> None:
    def make(ddl: list[str], rows: int = 0) -> bytes:
        d = tempfile.mkdtemp()
        p = os.path.join(d, "x.sqlite")
        con = sqlite3.connect(p)
        for s in ddl:
            con.execute(s)
        for i in range(rows):
            con.execute('INSERT INTO "we""ird name" VALUES (?, ?)', (i, f"v{i}"))
        con.commit()
        con.close()
        return open(p, "rb").read()

    st = uploads.Store()
    bomb = make(["CREATE TABLE g (a INTEGER, b BLOB GENERATED ALWAYS AS (zeroblob(900000000)) VIRTUAL)",
                 "INSERT INTO g (a) VALUES (1)"])
    for data, want in [(bomb, "generated columns"),
                       (b"SQLite format 3\x00" + b"\x00" * 200, ""),
                       (b"PK\x03\x04" + b"\x00" * 200, "bad header")]:
        try:
            st.add([("x.sqlite", data)])
            raise AssertionError(f"accepted ({want})")
        except uploads.UploadError as e:
            assert want in str(e), str(e)
    db_id = st.add([("w.sqlite", make(['CREATE TABLE "we""ird name" (id INTEGER, "col ""q""" TEXT)'], 5))])
    text = prompting.schema_text(uploads.db_path(db_id))  # quotes in names no longer break the prompt
    assert 'examples: [\'v0\'' in text, text
    st.remove(db_id)
    ok("SQLite uploads: virtual generated-column bomb, corrupt and non-SQLite files rejected; quoted names work")


def test_schema_cap() -> None:
    for d in worker.list_dbs():
        n = len(prompting.schema_text(worker.db_path(d)))
        assert n <= prompting.MAX_SCHEMA_CHARS, (d, n)
    wide = [(f"t{i}.csv", (",".join(f"column_number_{j}" for j in range(50)) + "\n" +
                           ",".join("v" * 40 + str(j) for j in range(50)) + "\n").encode()) for i in range(8)]
    try:
        uploads.Store().add(wide)
        raise AssertionError("wide upload accepted")
    except uploads.UploadError as e:
        assert "too large for the local model" in str(e), str(e)
    st, db_id = _memdb(b"a,b\n1,2\n")
    old = prompting.MAX_SCHEMA_CHARS
    prompting.MAX_SCHEMA_CHARS = 10  # the worker re-checks before generating
    try:
        worker._answer(None, None, {"db_id": db_id, "question": "q"})
        raise AssertionError("worker accepted an oversized schema")
    except worker.UserError as e:
        assert worker.error_message(e).startswith("This database's schema is too large"), e
    finally:
        prompting.MAX_SCHEMA_CHARS = old
        st.remove(db_id)
    ok(f"schema cap: every BIRD schema fits {prompting.MAX_SCHEMA_CHARS:,} chars; 8 x 50-column upload refused "
       "at upload; worker refuses before generating")


def test_error_text() -> None:
    from server.app import public_error, scrub

    msg = public_error("FileNotFoundError: [Errno 2] No such file: '/home/zhangj50/data/bird/x.sqlite' "
                       "and C:\\Users\\Jzgam\\x.json and ~/models/probe.json")
    assert "/home" not in msg and "Users" not in msg and "~/" not in msg and msg.count("<path>") == 3, msg
    assert public_error("OperationalError: near \"/\": syntax error") == "OperationalError: near \"/\": syntax error"
    res = scrub({"error": "x /mnt/c/secret/a.py", "readings_error": "/tmp/q", "rows": ["/home/keep"],
                 "audit": {"audit_error": "/home/u/f", "fanout_error": None}})
    assert res["error"] == "x <path>" and res["readings_error"] == "<path>" and res["rows"] == ["/home/keep"]
    assert res["audit"]["audit_error"] == "<path>" and res["audit"]["fanout_error"] is None
    oom = RuntimeError("CUDA out of memory. Tried to allocate 20.00 MiB")
    assert worker.error_message(oom) == worker.OOM_MESSAGE
    assert worker.error_message(ValueError("bad")) == "ValueError: bad"
    ok("error text: paths scrubbed from every *error field, SQL text untouched, CUDA OOM in plain words")


def test_consumer_survives() -> None:
    """A job that raises anything, and a consumer-level failure, never stop the queue."""
    from server import app as appmod

    class FakeWorker:
        ready, ready_info, fake, restarts = True, {}, True, 0
        proc = types.SimpleNamespace(pid=1)
        calls = 0

        def ask(self, db_id, question, on_stage=None, timeout_s=None, upload=None, uploads_live=None):
            FakeWorker.calls += 1
            if question == "boom":
                raise ValueError("/home/zhangj50/secret.py exploded")
            return {"db_id": db_id, "question": question, "sql": "SELECT 1", "rows": [[1]], "columns": ["1"],
                    "error": None}

        def wait_ready(self):
            pass

    async def go() -> list:
        gw = appmod.Gateway()
        gw.worker = FakeWorker()
        real_warm, flaky = gw.warm, {"n": 0}

        async def warm() -> None:
            flaky["n"] += 1
            if flaky["n"] == 2:
                raise OSError("consumer-level failure")
            await real_warm()

        gw.warm = warm  # type: ignore[method-assign]
        task = asyncio.create_task(gw.consume())
        clients = [appmod.Client(f"client{i:04d}") for i in range(3)]
        await gw.submit(clients[0], "nodb", "boom")
        for _ in range(100):
            if clients[0].last:
                break
            await asyncio.sleep(0.05)
        await gw.submit(clients[1], "nodb", "after a failure")
        await gw.submit(clients[2], "nodb", "and another")
        for _ in range(200):
            if clients[2].last:
                break
            await asyncio.sleep(0.05)
        task.cancel()
        return [c.last for c in clients]

    lasts = asyncio.run(go())
    assert lasts[0]["type"] == "error" and lasts[0]["message"] == appmod.FAILED_MESSAGE, lasts[0]
    assert lasts[1] and lasts[1]["type"] == "result" and lasts[2] and lasts[2]["type"] == "result", lasts
    ok("consumer: a raising job gets a generic error (no path); a consumer-level failure is logged and the next "
       "jobs still run")


def test_refuse() -> None:
    from server import app as appmod

    gw = appmod.Gateway()
    c = appmod.Client("clientaaaa")
    gw.waiting = [appmod.Job(c, "d", "q", ip="10.0.0.5") for _ in range(appmod.MAX_PENDING_PER_IP)]
    assert gw.refuse("10.0.0.5") == appmod.BUSY_MESSAGE and gw.refuse("10.0.0.6") is None
    gw.waiting = [appmod.Job(c, "d", "q", ip="127.0.0.1") for _ in range(appmod.MAX_PENDING_PER_IP)]
    assert gw.refuse("127.0.0.1") is None  # tunnel / laptop tabs: loopback is exempt by default
    gw.waiting = [appmod.Job(c, "d", "q", ip=f"10.0.1.{i}") for i in range(appmod.MAX_QUEUE)]
    assert gw.refuse("10.0.0.7") == appmod.QUEUE_FULL_MESSAGE
    ok(f"queue caps: {appmod.MAX_PENDING_PER_IP} pending per address, {appmod.MAX_QUEUE} waiting in total")


# ---- live fake server ----------------------------------------------------------------------------------------
def http(method: str, path: str, body: bytes | None = None, ctype: str = "application/json",
         timeout: float = 60) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, data=body, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"{}")
        except ValueError:
            return e.code, {"raw": raw[:200].decode("utf-8", "replace")}


def upload(files: list[tuple[str, bytes]]) -> tuple[int, dict]:
    b = "----harden" + os.urandom(6).hex()
    parts = []
    for fn, data in files:
        parts.append(f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\n'
                     f"Content-Type: application/octet-stream\r\n\r\n".encode() + data + b"\r\n")
    return http("POST", "/api/upload", b"".join(parts) + f"--{b}--\r\n".encode(), f"multipart/form-data; boundary={b}")


def check(db_id: str, sql: str) -> tuple[int, dict, float]:
    t0 = time.time()
    code, out = http("POST", "/api/check", json.dumps({"db_id": db_id, "sql": sql}).encode())
    return code, out, time.time() - t0


def test_http(db_id: str) -> None:
    targets = [db_id] + ([BIRD] if BIRD else [])
    for target in targets:
        for sql in BOMBS[:4]:
            code, out, dt = check(target, sql)
            assert code == 200 and out["original"]["rows"] is None and out["original"]["error"], (sql, out)
            assert dt < 20, (sql, dt)
        code, out, _ = check(target, "ATTACH DATABASE '/tmp/x.db' AS x")
        assert code == 200 and "not authorized" in out["original"]["error"], out
    try:  # refused from the Content-Length header; the client may see the 413 or a reset while still sending
        code, out = http("POST", "/api/check", b'{"db_id":"x","sql":"' + b"a" * (2 * 1024 * 1024) + b'"}')
        assert code == 413 and out.get("error"), (code, out)
    except (urllib.error.URLError, ConnectionError):
        pass
    code, out = http("POST", "/api/check", b"not json")
    assert code == 422, code
    assert http("GET", "/api/status")[0] == 200
    import threading

    codes: list[int] = []
    burst = [threading.Thread(target=lambda: codes.append(check(db_id, BOMBS[0])[0])) for _ in range(6)]
    for t in burst:
        t.start()
    time.sleep(1.0)
    t0 = time.time()
    assert http("GET", "/api/status")[0] == 200 and time.time() - t0 < 1.0, time.time() - t0
    res = asyncio.run(_ask_once(db_id))  # the answer queue still runs during the burst
    assert res["type"] == "result" and not res.get("error"), res
    for t in burst:
        t.join(60)
    assert codes == [200] * 6, codes
    ok(f"/api/check on {', '.join(targets)}: bombs return a clean error in <20 s, ATTACH refused; "
       "2 MB body -> 413; bad JSON -> 422; 6 concurrent 5 s bombs queue behind 2 slots while status and "
       "a phone answer still go through")


async def _ask_once(db_id: str) -> dict:
    import websockets

    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as ws:
        await ws.send(json.dumps({"type": "hello", "client": "hardening99", "last_job": None}))
        await ws.send(json.dumps({"db_id": db_id, "question": "during a burst"}))
        return await _recv_until(ws, ("result", "error"))


def test_upload_http() -> None:
    code, out = upload([("x.sqlite", b"SQLite format 3\x00" + os.urandom(4096))])
    assert code == 400 and out.get("error"), out
    code, out = upload([("u16.csv", "id,name\n1,Zo\u00eb\n".encode("utf-16"))])
    assert code == 200 and out["tables"] == [{"name": "u16", "rows": 1}], out
    code, out = upload([("../../etc/passwd.csv", b"a\n1\n")])
    assert code == 200 and out["tables"][0]["name"] == "passwd", out
    assert http("GET", "/api/upload/AAAAAAAAAAAAAAAAAAAAAA")[0] == 404
    assert http("GET", "/api/upload/..%2F..%2Fetc")[0] == 404
    assert http("GET", "/api/schema?db_id=upload:short")[0] == 404
    ok("uploads over HTTP: corrupt SQLite -> 400, UTF-16 CSV loads, path-like filename sanitized, "
       "guessed/bad ids -> 404")


async def _recv_until(ws, types_: tuple[str, ...], timeout: float = 60) -> dict:
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg["type"] in types_:
            return msg


async def _ws_checks(db_id: str) -> None:
    import websockets

    url = f"ws://127.0.0.1:{PORT}/ws"
    async with websockets.connect(url) as ws:  # malformed frames: answered, socket stays open
        await ws.send(json.dumps({"type": "hello", "client": "hardening01", "last_job": None}))
        await _recv_until(ws, ("welcome",))
        for bad in (b"\x00\x01binary", "not json {", "[1, 2, 3]", json.dumps({"x": "y" * 20_000}),
                    json.dumps({"db_id": {"nested": [1]}, "question": "q"}),
                    json.dumps({"db_id": db_id, "question": "x" * 501})):
            await ws.send(bad)
        errors = 0
        while errors < 5:  # 5 errors (the list is ignored), then the socket must still work
            errors += (await _recv_until(ws, ("error",)))["type"] == "error"
        await ws.send(json.dumps({"db_id": db_id, "question": "still alive?"}))
        res = await _recv_until(ws, ("result", "error"))
        assert res["type"] == "result" and not res.get("error"), res
    try:  # 2 MB frame: over ws_max_size; the server closes that socket only
        async with websockets.connect(url, max_size=None) as ws:
            await ws.send("x" * (2 * 1024 * 1024))
            await asyncio.wait_for(ws.recv(), 10)
    except websockets.ConnectionClosed:
        pass
    # disconnect mid-job, reconnect with the same client id: the result is replayed
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "hello", "client": "hardening02", "last_job": None}))
        await ws.send(json.dumps({"db_id": db_id, "question": "drop me"}))
        q = await _recv_until(ws, ("queued", "working"))
    await asyncio.sleep(2.5)
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "hello", "client": "hardening02", "last_job": None}))
        res = await _recv_until(ws, ("result", "error"))
        assert res["type"] == "result" and res["job_id"] == q["job_id"], res
    # many sockets from one address: at most MAX_PENDING_PER_IP pending, the rest refused, all others served
    socks = [await websockets.connect(url) for _ in range(6)]
    try:
        for i, s in enumerate(socks):
            await s.send(json.dumps({"type": "hello", "client": f"hardening1{i}", "last_job": None}))
            await _recv_until(s, ("welcome",))
        for s in socks:
            await s.send(json.dumps({"db_id": db_id, "question": "flood"}))
        first = [await _recv_until(s, ("queued", "error")) for s in socks]
        refused = [m for m in first if m["type"] == "error"]
        assert len(refused) == 3 and all("already has questions" in m["message"] for m in refused), first
        served = [await _recv_until(s, ("result",), 60) for s, m in zip(socks, first) if m["type"] == "queued"]
        assert len(served) == 3
    finally:
        for s in socks:
            await s.close()


async def _quiet_check(db_id: str) -> None:
    import websockets

    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/table") as t:
        assert json.loads(await asyncio.wait_for(t.recv(), 10))["type"] == "snapshot"
        body = {"db_id": db_id, "sql": "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", "quiet": True}
        code, out = await asyncio.to_thread(http, "POST", "/api/check", json.dumps(body).encode())
        assert code == 200 and out["original"]["rows"] == [[1]], out
        try:
            msg = json.loads(await asyncio.wait_for(t.recv(), 2.0))
            raise AssertionError(f"quiet check was broadcast: {msg}")
        except asyncio.TimeoutError:
            pass
        body["quiet"] = False
        code, _ = await asyncio.to_thread(http, "POST", "/api/check", json.dumps(body).encode())
        msg = json.loads(await asyncio.wait_for(t.recv(), 10))
        assert code == 200 and msg["type"] == "check" and msg["check"]["sql"] == body["sql"], msg


def test_quiet_check(db_id: str) -> None:
    asyncio.run(_quiet_check(db_id))
    ok("/api/check quiet: true answers without a table broadcast; default still broadcasts")


def test_ws(db_id: str) -> None:
    asyncio.run(_ws_checks(db_id))
    ok("WebSocket: binary/invalid/oversize/nested messages answered with an error and the socket keeps working; "
       "2 MB frame closes only that socket; mid-job disconnect gets the result on reconnect; 6 sockets from one "
       "address -> 3 queued + served, 3 refused")


def main() -> None:
    test_sql_guard()
    test_csv_edges()
    test_sqlite_edges()
    test_schema_cap()
    test_error_text()
    test_consumer_survives()
    test_refuse()
    log_path = os.path.join(tempfile.mkdtemp(), "server.log")
    env = dict(os.environ, PYTHONPATH=ROOT, ALTIMETER_IP_CAP_EXEMPT="")  # the test client is loopback
    with open(log_path, "wb") as logf:
        proc = subprocess.Popen([sys.executable, "-m", "server.app", "--fake", "--port", str(PORT),
                                 "--host", "127.0.0.1"], cwd=ROOT, env=env, stdout=logf, stderr=logf)
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
        code, out = upload([(f"{SENTINEL}_budget.csv", f"id,secret\n1,{SENTINEL}\n2,{SENTINEL}x\n".encode())])
        assert code == 200, out
        db_id = out["db_id"]
        test_http(db_id)
        test_upload_http()
        test_quiet_check(db_id)
        test_ws(db_id)
        assert http("GET", "/api/status")[1]["ready"]
    finally:
        proc.terminate()
        proc.wait(10)
    log = open(log_path, encoding="utf-8", errors="replace").read()
    assert SENTINEL.lower() not in log.lower(), "upload name/contents reached the server log"
    assert db_id.split(":", 1)[1] not in log, "upload id reached the server log"
    assert "Traceback" not in log, log[-3000:]
    ok("server log: no upload name, contents or id, and no tracebacks after all of the above")
    print("all hardening tests passed")


if __name__ == "__main__":
    main()
