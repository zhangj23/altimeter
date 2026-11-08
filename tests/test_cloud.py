"""Cloud escalation + GPU endpoint, against a local mock of Gemini's REST API (no real Gemini call, no quota).
Starts its own fake-model server (never touches :8000).
Run (WSL, repo root): python tests/test_cloud.py   [ALTIMETER_CLOUD_TEST_PORT=8084, mock on PORT-1]"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)

from server import cloud, gpu, worker  # noqa: E402

PORT = int(os.environ.get("ALTIMETER_CLOUD_TEST_PORT", "8084"))
MOCK_PORT = PORT - 1
BASE = f"http://127.0.0.1:{PORT}"
KEY = "TESTKEY_do_not_leak_4242"
SENTINEL = "QQZ_ROWDATA_5150"
BIRD = "formula_1" if "formula_1" in worker.list_dbs() else None


class Mock(BaseHTTPRequestHandler):
    mode = "ok"
    seen: list[dict] = []

    def log_message(self, *_a) -> None:
        pass

    def do_POST(self) -> None:  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        model = self.path.split("/models/")[1].split(":")[0]
        Mock.seen.append({"model": model, "key": self.headers.get("x-goog-api-key"), "body": body})
        if Mock.mode == "503all" or model == "m-quota":
            self.send_response(429 if model == "m-quota" else 503)
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "quota"}}')
            return
        text = json.loads(body)["contents"][0]["parts"][0]["text"]
        sql = "SELECT COUNT(*) FROM budget" if "budget" in text else "SELECT COUNT(*) FROM races WHERE year = 2009"
        out = {"candidates": [{"content": {"parts": [{"text": "thinking", "thought": True},
                                                     {"text": f"```sql\n{sql}\n```"}]}}]}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def ok(msg: str) -> None:
    print(f"[ok] {msg}", flush=True)


def http(method: str, path: str, body: dict | bytes | None = None, ctype: str = "application/json",
         timeout: float = 60) -> tuple[int, dict, str]:
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, json.loads(raw), raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, json.loads(raw or "{}"), raw


def esc(db_id: str, q: str, transmit: bool) -> tuple[int, dict, str]:
    return http("POST", "/api/escalate", {"db_id": db_id, "question": q, "transmit": transmit})


def upload_csv(name: str, data: bytes) -> str:
    b = "----cloudtest"
    body = (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: text/csv\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
    code, out, _ = http("POST", "/api/upload", body, f"multipart/form-data; boundary={b}")
    assert code == 200, out
    return out["db_id"]


def test_units() -> None:
    assert gpu.parse(" 12.34, 56, 4400, 6141") == {"power_w": 12.34, "util_pct": 56.0, "mem_used_mb": 4400.0,
                                                    "mem_total_mb": 6141.0}
    assert gpu.parse("[N/A], 3, 10, 20")["power_w"] is None
    if BIRD:
        p = cloud.build_payload(BIRD, "How many races were held in 2009?")
        text = p["contents"][0]["parts"][0]["text"]
        assert "CREATE TABLE" in text and "examples" not in text and "How many races were held in 2009?" in text
        assert "Hamilton" not in text  # a data value that the local prompt's sample values do contain
    ok("units: nvidia-smi line parsing ([N/A] -> null); payload = DDL + question, no sample values")


def test_escalate(tmp: str) -> str:
    if BIRD:
        q1, q2, q3 = "How many races were held in 2009?", "Which driver won the most races?", "Name every circuit."
        code, prev, raw = esc(BIRD, q1, False)
        assert code == 200 and set(prev) >= {"payload", "bytes", "upload", "note", "cached"}, prev
        assert prev["bytes"] == len(json.dumps(prev["payload"]).encode()) and prev["upload"] is False
        code, out, raw = esc(BIRD, q1, True)
        assert code == 200 and out["source"] == "gemini" and out["model"] == "m-ok", out
        assert out["sql"] == "SELECT COUNT(*) FROM races WHERE year = 2009"
        assert out["result"]["rows"] and out["result"]["error"] is None and isinstance(out["audit"], dict), out
        assert out["bytes_sent"] == out["bytes"] == prev["bytes"]
        sent = [s for s in Mock.seen if s["model"] == "m-ok"][-1]
        assert sent["body"] == json.dumps(prev["payload"]).encode(), "transmitted body != previewed payload"
        assert all(s["key"] == KEY for s in Mock.seen) and [s["model"] for s in Mock.seen[-2:]] == ["m-quota", "m-ok"]
        code, out, _ = esc(BIRD, q1, True)  # within 5 s: served from the cache, nothing sent
        assert code == 200 and out["source"] == "cache" and out["bytes_sent"] == 0, out
        code, out, _ = esc(BIRD, q2, True)  # within 5 s, not cached: rate limited
        assert code == 429 and out["retry_after"] > 0 and out["error"], out
        time.sleep(cloud.MIN_GAP_S + 0.2)
        Mock.mode = "503all"
        code, out, _ = esc(BIRD, q1, True)
        assert code == 200 and out["source"] == "cache" and "503" in out["cloud_error"], out
        time.sleep(cloud.MIN_GAP_S + 0.2)
        code, out, _ = esc(BIRD, q3, True)
        assert code == 503 and out["error"] and out["bytes_sent"] == 0, out
        Mock.mode = "ok"
        ok("escalate (BIRD): preview bytes == exact transmitted body; quota model skipped; SQL run locally + "
           "audited; cache within 5 s; 429 rate limit; Gemini 503 -> cache, else 503 {error}")
    up = upload_csv("budget.csv",f"id,amount,secret\n1,10,{SENTINEL}\n2,20,{SENTINEL}\n".encode())
    code, prev, _ = esc(up, "What is the total amount?", False)
    text = prev["payload"]["contents"][0]["parts"][0]["text"]
    assert code == 200 and prev["upload"] is True and prev["note"] == cloud.UPLOAD_NOTE, prev
    assert "CREATE TABLE" in text and SENTINEL not in text, text
    assert "'10'" not in text and "10," not in text.split("Question:")[0], text
    time.sleep(cloud.MIN_GAP_S + 0.2)
    code, out, _ = esc(up, "What is the total amount?", True)
    assert code == 200 and out["source"] == "gemini" and out["result"]["rows"] == [[2]], out
    cache = open(os.path.join(tmp, "cache.json"), encoding="utf-8").read() if os.path.exists(
        os.path.join(tmp, "cache.json")) else ""
    assert up.split(":", 1)[1] not in cache, "upload id written to the cloud cache"
    ok("escalate (upload): labelled upload, schema only (no row values), answer run on the memdb, not cached")
    for body, want in [({"db_id": "nope", "question": "q", "transmit": True}, 400),
                       ({"db_id": up, "question": " ", "transmit": True}, 400),
                       ({"db_id": up, "question": "x" * 501}, 400)]:
        code, out, _ = http("POST", "/api/escalate", body)
        assert code == want and out["error"], (body, code, out)
    assert http("POST", "/api/escalate", b"{bad")[0] == 422
    ok("escalate validation: unknown db / empty / too long -> 400 {error}; bad JSON -> 422")
    return up


def test_offline(mock: ThreadingHTTPServer) -> None:
    if not BIRD:
        return
    mock.shutdown()
    mock.server_close()
    time.sleep(cloud.MIN_GAP_S + 0.2)
    code, out, _ = esc(BIRD, "How many races were held in 2009?", True)
    assert code == 200 and out["source"] == "cache" and "unreachable" in out["cloud_error"], out
    time.sleep(cloud.MIN_GAP_S + 0.2)
    code, out, _ = esc(BIRD, "Brand new question?", True)
    assert code == 503 and "unreachable" in out["error"], out
    ok("offline: Gemini unreachable -> cached answer, or a clean 503 {error}")


def test_gpu() -> None:
    code, a, _ = http("GET", "/api/gpu")
    code2, b, _ = http("GET", "/api/gpu")
    if code == 200:
        assert set(a) == {"power_w", "util_pct", "mem_used_mb", "mem_total_mb", "ts"}, a
        assert isinstance(a["mem_total_mb"], float) and a["mem_total_mb"] > 0, a
        assert code2 == 200 and (b["ts"] == a["ts"] or b["ts"] - a["ts"] >= 0), (a, b)
        ok(f"/api/gpu: {a}")
    else:
        assert code == 503 and a["error"], a
        ok(f"/api/gpu without nvidia-smi: 503 {a}")


def main() -> None:
    test_units()
    tmp = tempfile.mkdtemp()
    key_file = os.path.join(tmp, "key.txt")
    with open(key_file, "w") as f:
        f.write(KEY + "\n")
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ, PYTHONPATH=ROOT, ALTIMETER_GEMINI_BASE=f"http://127.0.0.1:{MOCK_PORT}/v1beta",
               ALTIMETER_GEMINI_KEY_PATH=key_file, ALTIMETER_GEMINI_MODELS="m-quota,m-ok",
               ALTIMETER_CLOUD_CACHE=os.path.join(tmp, "cache.json"))
    log_path = os.path.join(tmp, "server.log")
    with open(log_path, "wb") as logf:
        proc = subprocess.Popen([sys.executable, "-m", "server.app", "--fake", "--port", str(PORT),
                                 "--host", "127.0.0.1"], cwd=ROOT, env=env, stdout=logf, stderr=logf)
    responses: list[str] = []
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
        real_http = globals()["http"]

        def spy(*a, **k):
            r = real_http(*a, **k)
            responses.append(r[2])
            return r

        globals()["http"] = spy
        test_escalate(tmp)
        test_offline(mock)
        test_gpu()
    finally:
        proc.terminate()
        proc.wait(10)
    log = open(log_path, encoding="utf-8", errors="replace").read()
    cache = open(os.path.join(tmp, "cache.json"), encoding="utf-8").read()
    for where, text in [("server log", log), ("cache file", cache), ("responses", "\n".join(responses))]:
        assert KEY not in text, f"API key leaked into the {where}"
    assert SENTINEL not in log and "Traceback" not in log, log[-2000:]
    ok(f"API key absent from the server log, the cache file and all {len(responses)} responses; no tracebacks")
    print("all cloud tests passed")


if __name__ == "__main__":
    main()
