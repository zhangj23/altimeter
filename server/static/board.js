// Departures board: one row per job or pre-flight check, newest first, fed by /ws/table (see server/app.py).
// Every value on the board comes from the messages; the only client-side numbers are wall-clock times.
"use strict";

const BANDS = [ // same edges as app.js / table.js
  { key: "ask", name: "Ask", from: 0, to: 0.5 },
  { key: "caution", name: "Caution", from: 0.5, to: 0.8 },
  { key: "cruise", name: "Cruise", from: 0.8, to: 1 },
];
const bandOf = (s) => BANDS.find((b) => s < b.to) || BANDS[BANDS.length - 1];
const VISIBLE = 12;
const KEEP = 40;
const STEP = 150;     // ms per flap, same as --step
const STAGGER = 15;   // ms between neighbouring cells
const W = { time: 5, db: 18, reading: 4, band: 7, status: 12, detail: 10 };
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

const $ = (id) => document.getElementById(id);
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/* ---------- split-flap cells ---------- */
function intermediate(target) {
  const pool = /\d/.test(target) ? DIGITS : /[A-Za-z]/.test(target) ? LETTERS : null;
  return pool ? pool[Math.floor(Math.random() * pool.length)] : target;
}

// Flip one cell to `ch`. A cycling cell passes through two intermediate characters first.
function setCell(cell, ch, delay, cycle, instant) {
  if (cell.dataset.ch === ch) return;
  cell.dataset.ch = ch;
  const token = {};
  cell._tok = token;
  if (instant || reduced()) { cell.textContent = ch; return; }
  const seq = cycle && ch.trim() ? [intermediate(ch), intermediate(ch), ch] : [ch];
  let i = 0;
  const step = () => {
    if (cell._tok !== token) return;
    cell.classList.remove("flip");
    void cell.offsetWidth; // restart the animation
    cell.classList.add("flip");
    const next = seq[i++];
    setTimeout(() => { if (cell._tok === token) cell.textContent = next; }, STEP / 2);
    if (i < seq.length) setTimeout(step, STEP);
  };
  setTimeout(step, delay);
}

// Fixed-width monospace field: `width` cells, text left-aligned, padded with blank cells.
function setMono(field, text, width, opts = {}) {
  while (field.children.length < width) field.append(el("span", "c"));
  while (field.children.length > width) field.lastChild.remove();
  const t = (text || "").slice(0, width);
  for (let i = 0; i < width; i++) setCell(field.children[i], t[i] || "", i * STAGGER, opts.cycle !== false, opts.instant);
  field.className = "f " + (opts.cls || "");
}

// Proportional (Poppins) field for the question: one cell per character, cut to the column width.
let measure = null;
function fitQuestion(field, text) {
  if (!measure) measure = document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(field);
  const probe = field.firstChild || field.appendChild(el("span", "c"));
  const ps = getComputedStyle(probe);
  measure.font = `${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`;
  const pad = parseFloat(ps.paddingLeft) + parseFloat(ps.paddingRight);
  const minW = parseFloat(ps.minWidth) || 0;
  const gap = parseFloat(cs.columnGap || cs.gap) || 0;
  const avail = field.clientWidth;
  let used = 0, n = 0;
  for (const ch of text) {
    const w = Math.max(minW, measure.measureText(ch).width + pad) + (n ? gap : 0);
    if (used + w > avail) break;
    used += w; n++;
  }
  return n < text.length ? text.slice(0, Math.max(0, n - 1)).trimEnd() + "…" : text;
}
function setQuestion(field, text, instant) {
  const t = fitQuestion(field, (text || "").replace(/\s+/g, " ").trim());
  while (field.children.length < t.length) field.append(el("span", "c"));
  while (field.children.length > t.length) field.lastChild.remove();
  for (let i = 0; i < t.length; i++) setCell(field.children[i], t[i], i * STAGGER, false, instant);
}

/* ---------- rows ---------- */
const rows = new Map();   // id -> row
const order = [];         // ids, newest first
const rowsEl = $("rows");

// Blank rows keep the board at VISIBLE rows before the session fills it.
function fillBlank() {
  while (rowsEl.children.length < VISIBLE) {
    const e = el("div", "row empty");
    for (const k of ["time", "db", "q", "reading", "band", "status", "detail"]) {
      const f = el("div", "f" + (k === "q" ? " q" : ""));
      if (k !== "q") setMono(f, "", W[k], { instant: true });
      e.append(f);
    }
    rowsEl.append(e);
  }
  while (rowsEl.children.length > VISIBLE && rowsEl.lastChild.classList.contains("empty")) rowsEl.lastChild.remove();
}

function newRow(id, kind, job) {
  const r = { id, kind, at: new Date(), db: job.db_id || "", question: job.question || "", startedAt: null,
              reading: null, band: null, status: "", detail: "", cls: "", flagged: false, seconds: null, el: el("div", "row") };
  for (const k of ["time", "db", "q", "reading", "band", "status", "detail"]) {
    const f = el("div", "f" + (k === "q" ? " q" : ""));
    f.dataset.k = k;
    r.el.append(f);
  }
  rows.set(id, r);
  order.unshift(id);
  rowsEl.prepend(r.el);
  while (rowsEl.children.length > VISIBLE) rowsEl.lastChild.remove();
  fillBlank();
  while (order.length > KEEP) rows.delete(order.pop());
  return r;
}

function paint(r, instant) {
  const f = (k) => r.el.querySelector(`.f[data-k="${k}"]`);
  setMono(f("time"), hhmm(r.at), W.time, { instant });
  setMono(f("db"), String(r.db || "").startsWith("upload:") ? "uploaded data" : r.db, W.db, { instant });
  setQuestion(f("q"), r.question, instant);
  const b = r.reading == null || r.uncal ? null : bandOf(r.reading); // uploads: the bands are not calibrated for them
  setMono(f("reading"), r.reading == null ? "" : r.reading.toFixed(2), W.reading, { instant, cls: b ? b.key : "" });
  setMono(f("band"), b ? b.name : r.uncal && r.reading != null ? "UNCAL" : "", W.band, { instant, cls: b ? b.key : r.uncal ? "dim" : "" });
  setMono(f("status"), r.status, W.status, { instant, cls: r.cls });
  setMono(f("detail"), r.detail, W.detail, { instant, cls: r.cls });
}

function upsert(id, kind, job) {
  const r = rows.get(id) || newRow(id, kind, job);
  if (job && job.db_id) r.db = job.db_id;
  if (job && job.question) r.question = job.question;
  return r;
}

const needleOf = (m) => {
  if (!m || m.probe == null) return null;
  const v = typeof m.probe === "object" ? Number(m.probe.needle) : Number(m.probe);
  return Number.isFinite(v) ? v : null;
};
const fmtS = (s) => (s == null ? "" : `${s.toFixed(1)} s`);
// A number in at most 4 characters where possible: 355, 3.35, 117, 0.38.
const fmtShort = (v, text) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return text == null ? "" : String(text);
  if (Number.isInteger(x) && Math.abs(x) < 1e6) return String(x);
  return Math.abs(x) >= 100 ? String(Math.round(x)) : String(Number(x.toPrecision(3)));
};
// before → after; the server's own text when it fits, else a shortened pair.
function beforeAfter(h) {
  if (!h || h.before_text == null || h.after_text == null) return "";
  const full = `${h.before_text} → ${h.after_text}`;
  return full.length <= W.detail ? full : `${fmtShort(h.before, h.before_text)} → ${fmtShort(h.after, h.after_text)}`;
}

function answerSeconds(r, m) {
  if (r.startedAt != null) return (performance.now() - r.startedAt) / 1000;
  const t = m.timing;
  if (t && Number.isFinite(t.worker_s)) return t.worker_s;
  if (Number.isFinite(m.gen_seconds)) return m.gen_seconds + (Number.isFinite(m.exec_seconds) ? m.exec_seconds : 0);
  return null;
}

/* ---------- message handling ---------- */
function onJob(m) {
  const job = m.job;
  if (!job) return;
  for (const q of m.queue || []) {
    const r = upsert(q.id, "job", q);
    if (!r.status) { r.status = "QUEUED"; r.cls = "dim"; paint(r); }
  }
  const r = upsert(job.id, "job", job);
  if (m.type === "queued") { r.status = "QUEUED"; r.cls = "dim"; }
  else if (m.type === "working" || m.type === "stage") {
    if (r.startedAt == null) r.startedAt = performance.now() - 1000 * (Number(m.elapsed) || 0);
    r.status = "IN FLIGHT"; r.cls = "";
  } else if (m.type === "result") {
    if (r.seconds == null) r.seconds = answerSeconds(r, m);
    r.reading = needleOf(m);
    r.uncal = m.calibrated === false;
    r.status = "LANDED"; r.cls = ""; r.detail = fmtS(r.seconds);
    r.flagged = !!(m.audit && m.audit.flagged);
  } else if (m.type === "error") { r.status = "FAILED"; r.cls = "ask"; r.detail = ""; }
  paint(r);
}

function onCheck(m) {
  const job = m.job || {}, c = m.check || {};
  const r = upsert(job.id, "check", { db_id: job.db_id || c.db_id, question: job.question || (c.sql || "").replace(/\s+/g, " ") });
  const failed = c.parses === false || !!c.audit_error || c.message === "audit incomplete";
  r.flagged = !!c.flagged;
  if (r.flagged) {
    r.status = "DOUBLE COUNT"; r.cls = "ask";
    r.detail = beforeAfter(c.headline);
  } else if (failed) { r.status = "UNCHECKED"; r.cls = "dim"; r.detail = ""; }
  else { r.status = "CLEAR"; r.cls = "cruise"; r.detail = ""; }
  paint(r);
}

function onSnapshot(m) {
  if (m.last && m.last.job) (m.last.type === "check" ? onCheck : onJob)(m.last);
  if (m.current) { const r = upsert(m.current.id, "job", m.current); if (r.status !== "LANDED") { r.status = "IN FLIGHT"; r.cls = ""; paint(r); } }
  for (const q of m.queue || []) { const r = upsert(q.id, "job", q); if (!r.status) { r.status = "QUEUED"; r.cls = "dim"; paint(r); } }
}

/* ---------- counters ---------- */
function counters(instant) {
  const all = [...rows.values()];
  const answered = all.filter((r) => r.status === "LANDED");
  const flagged = all.filter((r) => r.flagged).length;
  const secs = answered.map((r) => r.seconds).filter((s) => s != null).sort((a, b) => a - b);
  const med = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
  setMono($("c-answered"), String(answered.length), 3, { instant });
  setMono($("c-flagged"), String(flagged), 3, { instant });
  setMono($("c-median"), fmtS(med), 6, { instant });
}

function handle(m) {
  if (m.type === "snapshot") onSnapshot(m);
  else if (m.type === "check") onCheck(m);
  else if (m.job) onJob(m);
  counters();
}

/* ---------- socket ---------- */
let ws = null, retry = 1000;
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/table`);
  ws.onopen = () => { retry = 1000; };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") connect(); });
connect();
fillBlank();
counters(true);

let resizeT = null;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { for (const r of rows.values()) if (r.el.isConnected) setQuestion(r.el.querySelector(".f.q"), r.question, true); }, 120);
});

// Re-flap every visible cell from blank, using the rows already on the board (for checking the effect).
window.board = {
  reflap() {
    for (const c of document.querySelectorAll(".c")) { c.dataset.ch = ""; c.textContent = ""; c._tok = null; }
    for (const r of rows.values()) if (r.el.isConnected) paint(r);
    counters();
  },
};
