"""Import-your-own-database: uploads held only in memory, keyed by a random id, never logged or sent anywhere.

Each upload lives in an in-process SQLite memdb (vfs=memdb, name "/altimeter_upload_<id>"), kept alive by one
read-write anchor connection. Every other connection opens it read-only through db_path(), whose value is shaped so
the existing f"file:{path}?mode=ro" openers (sqlexec.connect_guarded with its authorizer, prompting, readings,
the auditor) all get vfs=memdb + mode=ro. The model worker is a separate process: the gateway ships it the tables
once (export() -> load_export()), and the worker builds its own memdb under the same name.

Only the stdlib: no pandas, no python-multipart. A .sqlite upload touches disk once, as a temp file in a private
mkdtemp() directory that is removed right after the backup into memory. CSVs never touch disk.
"""
from __future__ import annotations

import csv
import io
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from altimeter import sqlexec  # noqa: F401 - importing it sets SQLite's process-wide heap limit

PREFIX = "upload:"
MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 200_000
MAX_COLS = 50
MAX_CSV_FILES = 8
INFER_ROWS = 1000
SNIFF_CHARS = 8192
TTL_S = 15 * 60
MAX_LIVE = 8
SQLITE_MAGIC = b"SQLite format 3\x00"
UID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
CALIBRATION_NOTE = "Needle not calibrated for uploaded data"
# Bare words the model would otherwise have to quote; a sanitized name equal to one of these gets a trailing "_".
RESERVED = set("""abort action add after all alter analyze and as asc attach autoincrement before begin between by
cascade case cast check collate column commit conflict constraint create cross current current_date current_time
current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape
except exclusive exists explain fail filter for foreign from full glob group having if ignore immediate in index
indexed initially inner insert instead intersect into is isnull join key left like limit match natural no not
notnull null of offset on or order outer over plan pragma primary query raise recursive references regexp reindex
release rename replace restrict right rollback row rows savepoint select set table temp temporary then to
transaction trigger union unique update using vacuum values view virtual when where window with without""".split())


class UploadError(ValueError):
    """A rejected upload; the message is shown to the user as-is (400)."""


def is_upload(db_id: str) -> bool:
    return db_id.startswith(PREFIX)


def upload_id(db_id: str) -> str:
    uid = db_id[len(PREFIX):] if is_upload(db_id) else db_id
    if not UID.match(uid):
        raise UploadError("bad upload id")
    return uid


def _mem_name(uid: str) -> str:
    return f"/altimeter_upload_{uid}"


def db_path(db_id: str) -> str:
    """Path for the f"file:{path}?mode=ro" openers. The trailing "&_" turns their "?mode=ro" into an ignored
    parameter ("_?mode"), so this string's own vfs=memdb&mode=ro applies: read-only, in memory, no file."""
    return f"{_mem_name(upload_id(db_id))}?vfs=memdb&mode=ro&_"


def _anchor(uid: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{_mem_name(uid)}?vfs=memdb", uri=True, check_same_thread=False,
                           isolation_level=None)


def _qi(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


# ---- names ----------------------------------------------------------------------------------------------------
def sanitize(name: str, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower())
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = fallback
    if s[0].isdigit():
        s = f"t_{s}" if fallback.startswith("table") else f"c_{s}"
    if s.startswith("sqlite_"):
        s = f"t_{s}"
    if s in RESERVED:
        s += "_"
    return s[:60]


def _dedupe(names: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for n in names:
        cand, k = n, 2
        while cand in seen:
            cand, k = f"{n}_{k}", k + 1
        seen.add(cand)
        out.append(cand)
    return out


# ---- CSV ------------------------------------------------------------------------------------------------------
_INT = re.compile(r"^[+-]?(0|[1-9][0-9]*)$")  # "007" stays TEXT (ids, zip codes)
_REAL = re.compile(r"^[+-]?((0|[1-9][0-9]*)(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$")


def _decode(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):  # Excel "Unicode text" / UTF-16 exports
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError:
            pass
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def _infer(values: list[str]) -> str:
    vals = [v.strip() for v in values if v.strip()]
    if not vals:
        return "TEXT"
    if all(_INT.match(v) for v in vals):
        return "INTEGER"
    if all(_REAL.match(v) for v in vals):
        return "REAL"
    return "TEXT"


def parse_csv(filename: str, data: bytes) -> tuple[list[str], list[str], list[list[str | None]]]:
    """-> (column names, declared types, rows). Empty cells become NULL."""
    text = _decode(data)
    if not text.strip():
        raise UploadError(f"{filename}: the file is empty")
    sample = text[:SNIFF_CHARS]  # csv.Sniffer is quadratic (and holds the GIL): 24 KB of ",'a" took 1.9 s
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text, newline=""), dialect)
    rows: list[list[str]] = []
    try:
        for r in reader:
            if any(c.strip() for c in r):
                rows.append(r)
                if len(rows) > MAX_ROWS + 1:  # stop early: a 10 MB file of tiny rows is millions of lists
                    raise UploadError(f"{filename}: more than {MAX_ROWS:,} rows; the limit is {MAX_ROWS:,}")
    except csv.Error as e:
        raise UploadError(f"{filename}: not a readable CSV ({e})") from None
    if not rows:
        raise UploadError(f"{filename}: no rows")
    width = len(rows[0])
    has_header = True  # the sniffer's guess misfires on all-text tables; trust it only if row 1 has a number
    if any(_REAL.match(c.strip()) for c in rows[0]):
        try:
            has_header = csv.Sniffer().has_header(sample)
        except csv.Error:
            pass
    header = rows[0] if has_header else [f"col{i + 1}" for i in range(width)]
    body = rows[1:] if has_header else rows
    if width > MAX_COLS:
        raise UploadError(f"{filename}: {width} columns; the limit is {MAX_COLS}")
    if len(body) > MAX_ROWS:
        raise UploadError(f"{filename}: {len(body):,} rows; the limit is {MAX_ROWS:,}")
    out: list[list[str | None]] = []
    for i, r in enumerate(body):
        if len(r) > width:
            if any(c.strip() for c in r[width:]):
                raise UploadError(f"{filename}: row {i + 1 + has_header} has {len(r)} cells; the header has {width}")
            r = r[:width]
        elif len(r) < width:
            r = r + [""] * (width - len(r))
        out.append(r)  # type: ignore[arg-type]
    cols = _dedupe([sanitize(h, f"col{i + 1}") for i, h in enumerate(header)])
    types = [_infer([r[j] or "" for r in out[:INFER_ROWS]]) for j in range(width)]
    for r in out:
        for j, v in enumerate(r):
            v = v.strip() if types[j] != "TEXT" else v
            r[j] = v if v != "" else None
    return cols, types, out


def load_csvs(files: list[tuple[str, bytes]], uid: str) -> sqlite3.Connection:
    if not 1 <= len(files) <= MAX_CSV_FILES:
        raise UploadError(f"upload 1-{MAX_CSV_FILES} CSV files")
    names = _dedupe([sanitize(os.path.splitext(fn)[0], f"table{i + 1}") for i, (fn, _) in enumerate(files)])
    parsed = [parse_csv(fn, data) for fn, data in files]
    con = _anchor(uid)
    try:
        con.execute("BEGIN")
        for name, (cols, types, rows) in zip(names, parsed):
            ddl = ", ".join(f"{_qi(c)} {t}" for c, t in zip(cols, types))
            con.execute(f"CREATE TABLE {_qi(name)} ({ddl})")
            con.executemany(f"INSERT INTO {_qi(name)} VALUES ({', '.join('?' * len(cols))})", rows)
        con.execute("COMMIT")
    except BaseException:
        con.close()
        raise
    return con


# ---- .sqlite --------------------------------------------------------------------------------------------------
def load_sqlite(data: bytes, uid: str) -> sqlite3.Connection:
    if len(data) < 100 or not data.startswith(SQLITE_MAGIC):
        raise UploadError("not a SQLite database (bad header)")
    if data[18:20] == b"\x02\x02":  # WAL mode: the -wal file is not here; read it as a rollback-journal db
        data = data[:18] + b"\x01\x01" + data[20:]
    tmpdir = tempfile.mkdtemp(prefix="alt_")  # 0700, removed below whatever happens
    con = _anchor(uid)
    try:
        path = os.path.join(tmpdir, "u.sqlite")
        with open(path, "wb") as f:
            f.write(data)
        src = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
        try:
            src.backup(con)
        except sqlite3.DatabaseError as e:
            raise UploadError(f"not a readable SQLite database ({e})") from None
        finally:
            src.close()
    except BaseException:
        con.close()
        raise
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    try:
        _clean_sqlite(con)
    except BaseException:
        con.close()
        raise
    return con


def _clean_sqlite(con: sqlite3.Connection) -> None:
    try:
        ok = con.execute("PRAGMA integrity_check(1)").fetchone()
    except sqlite3.DatabaseError as e:
        raise UploadError(f"database failed integrity_check ({e})") from None
    if not ok or ok[0] != "ok":
        raise UploadError("database failed integrity_check")
    objs = con.execute("SELECT type, name, sql FROM sqlite_master").fetchall()
    if any((sql or "").lstrip().upper().startswith("CREATE VIRTUAL") for _, _, sql in objs):
        raise UploadError("virtual tables (FTS, R-tree, ...) are not supported")
    for typ, name, _ in objs:
        if typ in ("trigger", "view"):
            con.execute(f"DROP {typ.upper()} IF EXISTS {_qi(name)}")
    tables = _table_names(con)
    if not tables:
        raise UploadError("the database has no tables")
    for t in tables:
        xinfo = con.execute(f"PRAGMA table_xinfo({_qi(t)})").fetchall()
        if any(c[6] in (2, 3) for c in xinfo):  # computed on read: an expression could build huge values
            raise UploadError(f"table {t}: generated columns are not supported")
        ncols = len(xinfo)
        if ncols > MAX_COLS:
            raise UploadError(f"table {t}: {ncols} columns; the limit is {MAX_COLS}")
        n = con.execute(f"SELECT COUNT(*) FROM {_qi(t)}").fetchone()[0]
        if n > MAX_ROWS:
            raise UploadError(f"table {t}: {n:,} rows; the limit is {MAX_ROWS:,}")


def _check_schema_size(uid: str) -> None:
    """Refuse an upload whose prompt schema the local model could not take (see prompting.MAX_SCHEMA_CHARS)."""
    from altimeter.prompting import MAX_SCHEMA_CHARS, schema_text

    n = len(schema_text(db_path(PREFIX + uid)))
    if n > MAX_SCHEMA_CHARS:
        raise UploadError(f"the schema is too large for the local model ({n:,} characters with sample values; "
                          f"the limit is {MAX_SCHEMA_CHARS:,}); upload fewer or narrower tables")


def _table_names(con: sqlite3.Connection) -> list[str]:
    return [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")]


# ---- worker hand-off ------------------------------------------------------------------------------------------
def load_export(payload: dict[str, Any]) -> sqlite3.Connection:
    """Worker side: rebuild an upload from export() under the same memdb name. Returns the anchor to keep open."""
    uid = upload_id(payload["id"])
    con = _anchor(uid)
    con.execute("BEGIN")
    for sql in payload["tables_sql"]:
        con.execute(sql)
    for name, ncols, rows in payload["rows"]:
        con.executemany(f"INSERT INTO {_qi(name)} VALUES ({', '.join('?' * ncols)})", rows)
    for sql in payload["index_sql"]:
        con.execute(sql)
    con.execute("COMMIT")
    return con


# ---- store ----------------------------------------------------------------------------------------------------
@dataclass
class Entry:
    uid: str
    con: sqlite3.Connection  # the anchor: keeps the memdb alive; closed on eviction
    kind: str
    created: float
    used: float
    lock: threading.Lock = field(default_factory=threading.Lock)
    sent_to: set[int] = field(default_factory=set)  # worker pids that already hold a copy


class Store:
    def __init__(self, ttl_s: float = TTL_S, max_live: int = MAX_LIVE) -> None:
        self.ttl_s, self.max_live = ttl_s, max_live
        self._lock = threading.Lock()
        self._entries: dict[str, Entry] = {}

    def _drop(self, uid: str) -> None:
        e = self._entries.pop(uid, None)
        if e is not None:
            with e.lock:
                e.con.close()

    def sweep(self) -> None:
        now = time.monotonic()
        with self._lock:
            for uid in [u for u, e in self._entries.items() if now - e.used > self.ttl_s]:
                self._drop(uid)

    def add(self, files: list[tuple[str, bytes]]) -> str:
        """files: [(filename, bytes)]. Raises UploadError. Returns the db_id "upload:<id>"."""
        if not files:
            raise UploadError("no file in the upload")
        total = sum(len(d) for _, d in files)
        if total > MAX_BYTES:
            raise UploadError(f"upload is {total / 1e6:.1f} MB; the limit is {MAX_BYTES // (1024 * 1024)} MB")
        exts = {os.path.splitext(fn)[1].lower() for fn, _ in files}
        uid = secrets.token_urlsafe(16)
        if exts <= {".sqlite", ".db", ".sqlite3"}:
            if len(files) != 1:
                raise UploadError("upload one .sqlite/.db file, or 1-8 .csv files")
            con, kind = load_sqlite(files[0][1], uid), "sqlite"
        elif exts == {".csv"}:
            con, kind = load_csvs(files, uid), "csv"
        else:
            raise UploadError("upload one .sqlite/.db file, or 1-8 .csv files")
        try:
            _check_schema_size(uid)
        except BaseException:
            con.close()
            raise
        self.sweep()
        now = time.monotonic()
        with self._lock:
            while len(self._entries) >= self.max_live:
                self._drop(min(self._entries.values(), key=lambda e: e.used).uid)
            self._entries[uid] = Entry(uid, con, kind, now, now)
        return PREFIX + uid

    def touch(self, db_id: str) -> bool:
        """True if db_id is a live upload (and marks it used)."""
        if not is_upload(db_id):
            return False
        try:
            uid = upload_id(db_id)
        except UploadError:
            return False
        self.sweep()
        with self._lock:
            e = self._entries.get(uid)
            if e is None:
                return False
            e.used = time.monotonic()
            return True

    def remove(self, db_id: str) -> bool:
        try:
            uid = upload_id(db_id)
        except UploadError:
            return False
        with self._lock:
            found = uid in self._entries
            self._drop(uid)
        return found

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._entries)

    def info(self, db_id: str) -> dict[str, Any] | None:
        if not self.touch(db_id):
            return None
        uid = upload_id(db_id)
        with self._lock:
            e = self._entries.get(uid)
        if e is None:
            return None
        with e.lock:
            tables = [{"name": t, "rows": e.con.execute(f"SELECT COUNT(*) FROM {_qi(t)}").fetchone()[0]}
                      for t in _table_names(e.con)]
        return {"db_id": PREFIX + uid, "kind": e.kind, "tables": tables,
                "expires_in_s": max(0, round(self.ttl_s - (time.monotonic() - e.used)))}

    def export(self, db_id: str, worker_pid: int) -> dict[str, Any] | None:
        """What the model worker needs for this upload: just {"id"} if that worker already has it, else the
        tables. None if the upload expired."""
        if not self.touch(db_id):
            return None
        uid = upload_id(db_id)
        with self._lock:
            e = self._entries.get(uid)
        if e is None:
            return None
        if worker_pid in e.sent_to:
            return {"id": uid}
        with e.lock:
            master = e.con.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL "
                                   "AND name NOT LIKE 'sqlite_%' ORDER BY rowid").fetchall()
            tables = [(n, s) for t, n, s in master if t == "table"]
            rows = []
            for name, _ in tables:
                cur = e.con.execute(f"SELECT * FROM {_qi(name)}")
                rows.append((name, len(cur.description), cur.fetchall()))
        return {"id": uid, "tables_sql": [s for _, s in tables], "rows": rows,
                "index_sql": [s for t, _, s in master if t == "index"]}

    def mark_sent(self, db_id: str, worker_pid: int) -> None:
        with self._lock:
            e = self._entries.get(upload_id(db_id))
            if e is not None:
                e.sent_to.add(worker_pid)


STORE = Store()


# ---- multipart (no python-multipart in the venv) --------------------------------------------------------------
def parse_multipart(content_type: str, body: bytes) -> list[tuple[str, bytes]]:
    """-> [(filename, bytes)] for every part that carries a filename. Exact bytes, no line-ending changes."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not (content_type or "").lower().startswith("multipart/form-data") or not m:
        raise UploadError("send multipart/form-data with the file(s)")
    delim = b"--" + m.group(1).encode("latin-1")
    out = []
    for part in body.split(delim)[1:]:
        if part.startswith(b"--"):
            break
        part = part[2:] if part.startswith(b"\r\n") else part
        head, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]
        disp = next((ln for ln in head.decode("utf-8", "replace").split("\r\n")
                     if ln.lower().startswith("content-disposition")), "")
        fm = re.search(r'filename="([^"]*)"', disp)
        if fm is None or not fm.group(1):
            continue
        fn = re.split(r"[\\/]", fm.group(1))[-1]
        out.append((fn, content))
    return out
