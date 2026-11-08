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
const W = { time: 5, db: 18, reading: 4, band: 7, status: 12, detail: 13 }; // same cell counts as the grid in board.css
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
  let t = text || "";
  if (t.length > width) t = t.slice(0, width - 1) + "…"; // a cut value says so
  if (opts.right) t = t.padStart(width, " ");
  for (let i = 0; i < width; i++) setCell(field.children[i], (t[i] || "").trim(), i * STAGGER, opts.cycle !== false, opts.instant);
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
  tally(r);
  const f = (k) => r.el.querySelector(`.f[data-k="${k}"]`);
  setMono(f("time"), hhmm(r.at), W.time, { instant });
  setMono(f("db"), String(r.db || "").startsWith("upload:") ? "uploaded data" : r.db, W.db, { instant });
  setQuestion(f("q"), r.question, instant);
  const b = r.reading == null || r.uncal ? null : bandOf(r.reading); // uploads: the bands are not calibrated for them
  setMono(f("reading"), r.reading == null ? "" : r.reading.toFixed(2), W.reading, { instant, cls: b ? b.key : "" });
  setMono(f("band"), b ? b.name : r.uncal && r.reading != null ? "UNCAL" : "", W.band, { instant, cls: b ? b.key : r.uncal ? "dim" : "" });
  setMono(f("status"), r.status, W.status, { instant, cls: r.cls });
  setMono(f("detail"), r.detail, W.detail, { instant, cls: r.cls });
  f("detail").title = r.detailFull || "";
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
// Ways to write one headline number, most exact first: the server's text, then shorter roundings.
// 25,096,044 -> 25096044, 25.1M, 25M; 116.6527 -> 116.7, 117; 0.375 stays. Never rounds into the integer part.
function forms(v, text) {
  const out = []; // one entry per rounding step, repeats kept, so both sides of the arrow step together
  const add = (t) => { if (t) out.push(t); };
  if (text != null) { add(String(text)); add(String(text).replace(/,/g, "")); }
  const x = v == null ? NaN : Number(v);
  if (!Number.isFinite(x)) return out;
  const a = Math.abs(x);
  if (a >= 1e4) {
    const [d, u] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
    // keep trailing zeros so both sides show the same precision (36.0M → 31.5M, not 36M → 31.5M)
    for (const p of [2, 1, 0]) { const y = (x / d).toFixed(p); if (Math.abs(+y) < 1000) add(y + u); }
  } else {
    const intDigits = a >= 1 ? Math.floor(Math.log10(a)) + 1 : 0;
    for (const p of [4, 3, 2, 1]) if (p >= intDigits) add(x.toPrecision(p));
  }
  return out;
}
// before → after in W.detail cells: both sides at the same rounding step, the most exact that fits.
function beforeAfter(h) {
  if (!h || h.before_text == null || h.after_text == null) return "";
  const A = forms(h.before, h.before_text), B = forms(h.after, h.after_text);
  for (let k = 0; k < Math.max(A.length, B.length); k++) {
    const t = `${A[Math.min(k, A.length - 1)]} → ${B[Math.min(k, B.length - 1)]}`;
    if (t.length <= W.detail) return t;
  }
  const half = Math.floor((W.detail - 3) / 2);
  const cut = (t) => (t.length <= half ? t : t.slice(0, half - 1) + "…");
  return `${cut(A[A.length - 1])} → ${cut(B[B.length - 1])}`;
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
    r.detailFull = c.headline ? `${c.headline.before_text} → ${c.headline.after_text}` : "";
  } else if (failed) { r.status = "UNCHECKED"; r.cls = "dim"; r.detail = ""; }
  else { r.status = "CLEAR"; r.cls = "cruise"; r.detail = ""; }
  paint(r);
}

function onSnapshot(m) {
  if (m.last && m.last.job) (m.last.type === "check" ? onCheck : onJob)(m.last);
  if (m.current) { const r = upsert(m.current.id, "job", m.current); if (r.status !== "LANDED") { r.status = "IN FLIGHT"; r.cls = ""; paint(r); } }
  for (const q of m.queue || []) { const r = upsert(q.id, "job", q); if (!r.status) { r.status = "QUEUED"; r.cls = "dim"; paint(r); } }
}

/* ---------- counters: kept apart from the rows, which are trimmed to KEEP ---------- */
const landed = new Map(); // id -> answer seconds (null when unknown)
const flaggedIds = new Set();
function tally(r) {
  if (r.status === "LANDED") landed.set(r.id, r.seconds); else landed.delete(r.id);
  if (r.flagged) flaggedIds.add(r.id); else flaggedIds.delete(r.id);
}
function counters(instant) {
  const secs = [...landed.values()].filter((s) => s != null).sort((a, b) => a - b);
  const med = secs.length ? (secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[secs.length / 2 - 1] + secs[secs.length / 2]) / 2) : null;
  setMono($("c-answered"), String(landed.size), 3, { instant, right: true });
  setMono($("c-flagged"), String(flaggedIds.size), 3, { instant, right: true });
  setMono($("c-median"), med == null ? "" : `${med.toFixed(med < 100 ? 1 : 0)} s`, 6, { instant, right: true });
}

function handle(m) {
  if (m.type !== "snapshot" || m.last || m.current || (m.queue || []).length) attractRow(false);
  if (m.type === "snapshot") onSnapshot(m);
  else if (m.type === "check") onCheck(m);
  else if (m.job) onJob(m);
  counters();
  attractRow(true);
}

/* ---------- before the first question: one row saying where to ask (only when the address works from a phone) ---------- */
const LOOPBACK = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/;
const ATTRACT_Q = "Ask from a phone"; // beside the address in the database column
let attract = null;
function attractRow(on) {
  if (on && !attract && !rows.size && !LOOPBACK.test(location.hostname)) {
    attract = el("div", "row attract");
    const time = el("div", "f"), db = el("div", "f"), q = el("div", "f q"), rd = el("div", "f"), band = el("div", "f"), st = el("div", "f"), det = el("div", "f");
    attract.append(time, db, q, rd, band, st, det);
    rowsEl.prepend(attract);
    while (rowsEl.children.length > VISIBLE) rowsEl.lastChild.remove();
    setMono(time, "", W.time, { instant: true });
    setMono(db, location.host, W.db); // the address a phone opens
    setQuestion(q, ATTRACT_Q);
    for (const [f, w] of [[rd, W.reading], [band, W.band], [det, W.detail]]) setMono(f, "", w, { instant: true });
    setMono(st, "BOARDING", W.status, { cls: "cruise" });
  } else if (!on && attract) { attract.remove(); attract = null; fillBlank(); }
}

/* ---------- socket: a lost link says so in the header and greys the board until it is back ---------- */
let ws = null, retry = 1000;
function setLink(up) {
  document.body.classList.toggle("stale", !up);
  setMono($("link"), up ? "" : "NO LINK", 7, { cls: "ask", instant: up });
}
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/table`);
  ws.onopen = () => { retry = 1000; setLink(true); };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { setLink(false); setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") connect(); });
fillBlank();
counters(true);
setMono($("link"), "", 7, { instant: true });
connect();

// Questions are cut to the column by measuring Poppins; refit once it has loaded and whenever the width changes.
const refit = () => {
  for (const r of rows.values()) if (r.el.isConnected) setQuestion(r.el.querySelector(".f.q"), r.question, true);
  if (attract) setQuestion(attract.querySelector(".f.q"), ATTRACT_Q, true);
};
if (document.fonts) document.fonts.load("500 20px Poppins").then(refit, () => {});
let resizeT = null;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(refit, 120);
});
// Re-flap every visible cell from blank, using the rows already on the board (for checking the effect).
window.board = {
  reflap() {
    for (const c of document.querySelectorAll(".c")) { c.dataset.ch = ""; c.textContent = ""; c._tok = null; }
    for (const r of rows.values()) if (r.el.isConnected) paint(r);
    counters();
  },
};
