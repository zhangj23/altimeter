"use strict";

// Band edges on the 0..1 calibrated score. Provisional: replace with the thresholds chosen on held-out data.
const BANDS = [
  { key: "ask", name: "Ask", from: 0, to: 0.5 },
  { key: "caution", name: "Caution", from: 0.5, to: 0.8 },
  { key: "cruise", name: "Cruise", from: 0.8, to: 1 },
];
const SHOW_ROWS = 12;
const PREVIEW_ROWS = 3;
const KEEP_PASSES = 6;
// Dev-only fixture driver (mock.js). Nothing below changes behavior unless the URL has ?mock=1.
const MOCK = new URLSearchParams(location.search).get("mock") === "1";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let ws = null;
let retryMs = 500;
let retryTimer = null;
let pending = null; // {question, db_id, t0, phase}
let tick = null;

/* ---------- instrument ---------- */
function buildTape() {
  for (let i = 0; i <= 10; i++) {
    const t = el("span");
    t.style.left = `calc(${i * 10}% - ${i === 10 ? 1 : 0}px)`;
    $("ticks").append(t);
  }
  for (const b of BANDS) {
    const w = (b.to - b.from) * 100 + "%";
    const seg = el("span", "b-" + b.key);
    seg.style.width = w;
    $("bands").append(seg);
    const name = el("span", null, b.name);
    name.style.width = w;
    $("names").append(name);
  }
}

function bandOf(s) { return BANDS.find((b) => s < b.to) || BANDS[BANDS.length - 1]; }
function bandInk(key) { return key === "caution" ? "var(--caution-ink)" : `var(--${key})`; }

// Park the marker at 0 with no transition (used when a new question starts).
function parkCarriage() {
  const c = $("carriage");
  c.classList.add("snap");
  c.style.transform = "translateX(0)";
  void c.offsetWidth; // commit the jump before transitions come back
  c.classList.remove("snap");
}

/* mode: "idle" (no marker), "hold" (awaiting probe, hollow marker parked), or a score in 0..1 */
function setGauge(score, mode) {
  const needle = $("needle");
  const band = $("band");
  if (mode === "hold") {
    parkCarriage();
    $("value").textContent = "--";
    band.textContent = "Awaiting probe";
    band.className = "awaiting";
    band.style.color = "";
    $("tape").classList.remove("scored");
    needle.className = "needle hold";
    return;
  }
  if (score == null || Number.isNaN(score)) {
    $("value").textContent = "--";
    band.textContent = mode === "noprobe" ? "No probe" : "No reading";
    band.className = "";
    band.style.color = "";
    $("tape").classList.remove("scored");
    needle.className = "needle";
    return;
  }
  const s = Math.min(1, Math.max(0, score));
  const b = bandOf(s);
  $("value").textContent = s.toFixed(2);
  band.textContent = b.name;
  band.className = "";
  band.style.color = bandInk(b.key);
  $("tape").classList.add("scored");
  needle.className = "needle on";
  // Percent of the carriage's own width, which equals the tape width: survives resizes and rotation.
  $("carriage").style.transform = `translateX(${(s * 100).toFixed(2)}%)`;
}

/* ---------- status line and announcements ---------- */
function setStatus(text) { $("status").textContent = text; }
function announce(text) { $("announce").textContent = text; }

function startClock() {
  stopClock();
  const draw = () => {
    if (!pending) return stopClock();
    const s = ((performance.now() - pending.t0) / 1000).toFixed(1);
    setStatus(`Generating SQL · ${s} s`);
  };
  draw();
  tick = setInterval(draw, 100);
}
function stopClock() { if (tick) clearInterval(tick); tick = null; }

function busy(on) {
  $("ask").disabled = on;
  $("ask").textContent = on ? "Asking" : "Ask";
}

/* ---------- boarding pass ---------- */
function fmtSeconds(x) {
  if (x == null) return "n/a";
  return x < 1 ? `${Math.max(1, Math.round(x * 1000))} ms` : `${Number(x).toFixed(2)} s`;
}

function resultTable(columns, rows, limit) {
  const wrap = el("div", "table-wrap");
  const t = el("table");
  const hr = el("tr");
  for (const c of columns || []) hr.append(el("th", null, c));
  const th = el("thead");
  th.append(hr);
  t.append(th);
  const tb = el("tbody");
  for (const row of rows.slice(0, limit)) {
    const tr = el("tr");
    for (const v of row) tr.append(v == null ? el("td", "null", "null") : el("td", null, String(v)));
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(t);
  return wrap;
}

function rowCount(n, capped, shown) {
  let s = capped ? `First ${n} rows (capped)` : `${n} ${n === 1 ? "row" : "rows"}`;
  if (n > shown) s += `, showing ${shown}`;
  return s;
}

/* SQL tokens: whitespace, quoted strings/identifiers, words, numbers, two-char operators, any other char. */
const TOKEN = /\s+|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?|[A-Za-z_][\w$]*|\d+(?:\.\d+)?|<=|>=|<>|!=|\|\||[\s\S]/g;
const tokenize = (sql) => sql.match(TOKEN) || [];
const isSpace = (t) => /^\s+$/.test(t);
const tokKey = (t) => (/^['"`[]/.test(t) ? t : t.toLowerCase()); // keywords/identifiers compare case-insensitively

/* Marks the tokens of `sql` that are not on a longest common subsequence with `other`. */
function diffSegments(sql, other) {
  const a = tokenize(sql);
  const ai = [], ak = [];
  a.forEach((t, i) => { if (!isSpace(t)) { ai.push(i); ak.push(tokKey(t)); } });
  const bk = tokenize(other).filter((t) => !isSpace(t)).map(tokKey);
  const n = ak.length, m = bk.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = ak[i] === bk[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const changed = new Array(a.length).fill(false);
  let i = 0, j = 0;
  while (i < n) {
    if (j < m && ak[i] === bk[j]) { i++; j++; }
    else if (j < m && L[i][j + 1] > L[i + 1][j]) j++;
    else { changed[ai[i]] = true; i++; }
  }
  // Whitespace between two changed tokens joins the highlight so a changed phrase reads as one run.
  for (let k = 1; k < a.length - 1; k++) if (isSpace(a[k]) && changed[k - 1] && changed[k + 1]) changed[k] = true;
  const segs = [];
  a.forEach((t, k) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed[k]) last.text += t;
    else segs.push({ text: t, changed: changed[k] });
  });
  return segs;
}

function sqlBlock(sql, other) {
  const pre = el("pre", "sql");
  if (!sql) { pre.textContent = "(no SQL generated)"; return pre; }
  if (other == null) { pre.textContent = sql; return pre; }
  for (const s of diffSegments(sql, other)) pre.append(s.changed ? el("mark", null, s.text) : document.createTextNode(s.text));
  return pre;
}

const normSql = (s) => (s || "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

function renderReadings(r) {
  const list = r.readings;
  const sec = el("section", "perf readings");
  sec.append(el("h2", null, "Two readings"));
  sec.append(el("p", null, "Samples disagree on the result."));
  const cards = [];
  list.forEach((rd, idx) => {
    const other = list[idx === 0 ? 1 : 0];
    const card = el("div", "reading");
    const head = el("div", "rhead");
    const name = el("div", "rname", `Reading ${rd.label}`);
    if (rd.share != null) name.append(el("span", null, `${Math.round(rd.share * 100)}% of samples`));
    const btn = el("button", "choose", `Choose ${rd.label}`);
    btn.type = "button";
    head.append(name, btn, el("span", "picked", "Chosen"));
    card.append(head);
    const body = el("div", "rbody");
    body.append(sqlBlock(rd.sql, other ? other.sql : null));
    if (rd.error) body.append(el("p", "err", rd.error));
    else if (rd.rows) {
      if (rd.rows.length) body.append(resultTable(rd.columns, rd.rows, PREVIEW_ROWS));
      const total = rd.n_rows != null ? rd.n_rows : rd.rows.length;
      body.append(el("p", "count", rowCount(total, false, Math.min(PREVIEW_ROWS, rd.rows.length))));
    }
    card.append(body);
    const choose = () => {
      if (card.classList.contains("chosen")) return;
      for (const c of cards) {
        c.classList.toggle("chosen", c === card);
        c.classList.toggle("dropped", c !== card);
      }
      announce(`Reading ${rd.label} chosen.`);
    };
    card.addEventListener("click", choose);
    cards.push(card);
    sec.append(card);
  });
  return sec;
}

function renderPass(r) {
  const pass = el("article", "pass");
  const hasReadings = Array.isArray(r.readings) && r.readings.length >= 2;

  const head = el("section");
  head.append(el("p", "q", r.question));
  head.append(el("p", "route", `${r.db_id} · local${r.fake ? " · fake worker" : ""}${r.mock ? " · mock fixture" : ""}`));
  pass.append(head);

  // The greedy SQL is always shown, except when it is identical to one of the readings shown below.
  const greedyShown = hasReadings && r.readings.some((rd) => normSql(rd.sql) === normSql(r.sql));
  if (!greedyShown) {
    const body = el("section", "perf");
    if (hasReadings) body.append(el("p", "tag", "Greedy SQL"));
    body.append(sqlBlock(r.sql, null));
    if (r.error) {
      body.append(el("p", "err", r.error));
    } else if (r.rows) {
      if (r.rows.length) body.append(resultTable(r.columns, r.rows, SHOW_ROWS));
      body.append(el("p", "count", rowCount(r.rows.length, r.rows_capped, SHOW_ROWS)));
    }
    pass.append(body);
  }
  if (hasReadings) pass.append(renderReadings(r));

  const foot = el("section", "perf");
  const dl = el("dl", "facts");
  const nd = needleOf(r);
  const facts = [
    ["Confidence", nd == null ? "--" : nd.toFixed(2)],
    ["Generation", fmtSeconds(r.gen_seconds)],
    ["Execution", fmtSeconds(r.exec_seconds)],
  ];
  if (hasReadings && r.readings_seconds != null) facts.push(["Readings", fmtSeconds(r.readings_seconds)]);
  facts.push(["Tokens", r.n_prompt ? `${r.n_prompt} in · ${r.n_gen} out` : "n/a"], ["Sent", "0 bytes · local"]);
  for (const [k, v] of facts) {
    const pair = el("div");
    pair.append(el("dt", null, k), el("dd", null, v));
    dl.append(pair);
  }
  foot.append(dl);
  pass.append(foot);

  const list = $("passes");
  list.prepend(pass);
  while (list.children.length > KEEP_PASSES) list.lastChild.remove();
}

/* Worker sends probe as {needle, probe, calibrated, ...} or null. The needle is the stacked score. */
function needleOf(r) {
  if (r.probe == null) return null;
  const v = typeof r.probe === "object" ? Number(r.probe.needle) : Number(r.probe);
  return Number.isFinite(v) ? v : null;
}

/* ---------- socket ---------- */
function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "queued") {
    if (pending) {
      pending.phase = "queued";
      const text = m.position <= 1 ? "Next in line" : `Queued · ${m.position - 1} ahead`;
      setStatus(text);
      announce(text);
    }
  } else if (m.type === "working") {
    if (pending) {
      pending.phase = "working";
      pending.t0 = performance.now();
      setGauge(null, "hold");
      startClock();
      announce("Awaiting probe.");
    }
  } else if (m.type === "result") {
    const secs = pending ? ((performance.now() - pending.t0) / 1000).toFixed(1) : null;
    pending = null;
    stopClock();
    busy(false);
    const nd = needleOf(m);
    setGauge(nd, "noprobe");
    const took = secs == null ? "Answered" : `Answered in ${secs} s`;
    setStatus(nd == null ? `${took} · probe not loaded` : took);
    renderPass(m);
    let say = nd == null ? "Answer ready. No probe score." : `Confidence ${nd.toFixed(2)}, ${bandOf(Math.min(1, Math.max(0, nd))).name}.`;
    if (m.error) say += " The query failed.";
    if (Array.isArray(m.readings) && m.readings.length >= 2) say += " Two readings, choose one.";
    announce(say);
  } else if (m.type === "error") {
    pending = null;
    stopClock();
    busy(false);
    setGauge(null);
    setStatus(m.message);
    announce(m.message);
  }
}

function setLink(up) {
  $("radio").classList.toggle("on", !up);
  $("link").textContent = up ? "On local radio" : "No link";
  $("link").classList.toggle("down", !up);
}

function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => { retryMs = 500; setLink(true); };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    setLink(false);
    if (pending) {
      pending = null;
      stopClock();
      busy(false);
      setGauge(null);
      setStatus("Connection dropped before the answer arrived. Ask again.");
      announce("Connection dropped.");
    }
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 4000);
  };
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { retryMs = 500; connect(); }
});

/* ---------- form ---------- */
function fillDbs(dbs) {
  const sel = $("db");
  sel.replaceChildren(...dbs.map((d) => { const o = el("option", null, d); o.value = d; return o; }));
  const saved = (() => { try { return localStorage.getItem("altimeter.db"); } catch { return null; } })();
  if (saved && dbs.includes(saved)) sel.value = saved;
  else if (dbs.includes("formula_1")) sel.value = "formula_1";
}

async function loadDbs() {
  try {
    const r = await fetch("/api/dbs", { cache: "no-store" });
    fillDbs((await r.json()).dbs);
  } catch {
    setStatus("Could not load the database list.");
  }
}

function submit(e) {
  e.preventDefault();
  const question = $("question").value.trim();
  const db_id = $("db").value;
  if (!question || !db_id || pending) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { setStatus("No link to the laptop yet."); connect(); return; }
  try { localStorage.setItem("altimeter.db", db_id); } catch { /* storage unavailable */ }
  pending = { question, db_id, t0: performance.now(), phase: "sent" };
  busy(true);
  setGauge(null, "hold");
  setStatus("Sent");
  announce("Question sent.");
  ws.send(JSON.stringify({ db_id, question }));
}

$("form").addEventListener("submit", submit);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); }
});

buildTape();
setGauge(null);
if (MOCK) {
  const s = document.createElement("script");
  s.src = "mock.js";
  document.body.append(s);
} else {
  loadDbs();
  connect();
}
