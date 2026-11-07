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
let pending = null; // {question, db_id, t0, phase: sent|queued|working|offline, stage, job_id, queueText}
let tick = null;
let serverStatus = null; // last {type:"status"} from the gateway
let warmT0 = null; // performance.now() when the model started warming

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
function randomId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
// Stable per phone, so the laptop can hand back a question's answer after the socket drops.
const CLIENT = (() => {
  const saved = store.get("altimeter.client");
  if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const id = randomId();
  store.set("altimeter.client", id);
  return id;
})();
let lastJob = Number(store.get("altimeter.lastJob")) || null; // last result this phone rendered

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

const STAGES = { generating: "Generating SQL", scoring: "Scoring confidence", executing: "Running the query", sampling: "Sampling other readings" };
const warming = () => !!(serverStatus && serverStatus.warming);
const warmSecs = () => (warmT0 == null ? 0 : Math.round((performance.now() - warmT0) / 1000));

/* The status line while something is in progress, or null when nothing is (leave the last message). */
function liveText() {
  if (pending) {
    if (pending.phase === "offline") return "Link lost. The laptop keeps your question; reconnecting.";
    if (pending.phase === "working") return `${STAGES[pending.stage] || STAGES.generating} · ${((performance.now() - pending.t0) / 1000).toFixed(1)} s`;
    if (warming()) return `Waiting for the model to warm up · ${warmSecs()} s`;
    return pending.queueText || "Sent";
  }
  if (warming()) return `Warming up the model · ${warmSecs()} s`;
  return null;
}
function refresh() {
  const t = liveText();
  if (t == null) return stopClock();
  setStatus(t);
}
function startClock() {
  if (!tick) tick = setInterval(refresh, 100);
  refresh();
}
function stopClock() { if (tick) clearInterval(tick); tick = null; }

function syncAsk() {
  $("ask").disabled = !!pending || warming();
  $("ask").textContent = pending ? "Asking" : "Ask";
}
function busy() { syncAsk(); }

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

/* SQL with server-provided character spans marked: [{start, end, kind: "aggregate"|"join"}]. */
function hlBlock(sql, spans) {
  const pre = el("pre", "sql");
  let at = 0;
  for (const s of [...(spans || [])].sort((a, b) => a.start - b.start)) {
    if (s.start < at || s.end > sql.length) continue;
    pre.append(document.createTextNode(sql.slice(at, s.start)), el("mark", "hl-" + s.kind, sql.slice(s.start, s.end)));
    at = s.end;
  }
  pre.append(document.createTextNode(sql.slice(at)));
  return pre;
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
    body.append(r.audit && r.audit.flagged && r.sql ? hlBlock(r.sql, r.audit.highlights) : sqlBlock(r.sql, null));
    if (r.error) {
      body.append(el("p", "err", r.error));
    } else if (r.rows) {
      if (r.rows.length) body.append(resultTable(r.columns, r.rows, SHOW_ROWS));
      body.append(el("p", "count", rowCount(r.rows.length, r.rows_capped, SHOW_ROWS)));
    }
    pass.append(body);
  }
  if (hasReadings) pass.append(renderReadings(r));
  if (r.audit && r.audit.flagged) pass.append(renderAudit(r.audit));

  const foot = el("section", "perf");
  const dl = el("dl", "facts");
  const nd = needleOf(r);
  const facts = [
    ["Confidence", nd == null ? "--" : nd.toFixed(2)],
    ["Generation", fmtSeconds(r.gen_seconds)],
    ["Execution", fmtSeconds(r.exec_seconds)],
  ];
  if (hasReadings && r.readings_seconds != null) facts.push(["Readings", fmtSeconds(r.readings_seconds)]);
  if (r.audit) facts.push(["Fan-out check", auditFact(r.audit)]);
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
  if (m.type === "status") {
    const was = warming();
    serverStatus = m;
    if (m.warming) warmT0 = performance.now() - (m.warm_seconds || 0) * 1000;
    else warmT0 = null;
    syncAsk();
    if (m.warming || pending) startClock();
    else if (was) { setStatus("Model ready"); announce("Model ready."); }
  } else if (m.type === "welcome") {
    if (pending && m.job_id == null && !m.replay) {
      // The laptop has no record of it (restarted, or the question waited too long without this phone).
      pending = null;
      stopClock();
      syncAsk();
      setGauge(null);
      setStatus("The laptop lost this question. Ask again.");
      announce("Question lost. Ask again.");
    } else if (pending && m.job_id != null) {
      pending.phase = "sent";
      pending.job_id = m.job_id;
    } else if (!pending && m.job_id != null) {
      // Page reloaded while a question was in flight: pick it back up.
      pending = { question: "", db_id: "", t0: performance.now(), phase: "sent", job_id: m.job_id };
      syncAsk();
      setGauge(null, "hold");
      startClock();
    }
  } else if (m.type === "queued") {
    if (pending) {
      pending.phase = "queued";
      pending.job_id = m.job_id;
      pending.queueText = m.position <= 1 ? "Next in line" : `Queued · ${m.position - 1} ahead`;
      startClock();
      announce(pending.queueText);
    }
  } else if (m.type === "working" || m.type === "stage") {
    if (pending) {
      const fresh = pending.phase !== "working";
      pending.phase = "working";
      pending.job_id = m.job_id;
      if (m.type === "stage") pending.stage = m.stage;
      if (fresh) {
        pending.t0 = performance.now() - (m.elapsed || 0) * 1000;
        setGauge(null, "hold");
        announce("Awaiting probe.");
      }
      startClock();
    }
  } else if (m.type === "result") {
    if (m.job_id != null && m.job_id === lastJob) return; // already rendered (replay after a reconnect)
    if (m.job_id != null) { lastJob = m.job_id; store.set("altimeter.lastJob", String(m.job_id)); }
    const secs = pending && pending.phase === "working" ? ((performance.now() - pending.t0) / 1000).toFixed(1) : null;
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
    if (m.job_id != null) {
      if (m.job_id === lastJob) return;
      lastJob = m.job_id;
      store.set("altimeter.lastJob", String(m.job_id));
    }
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
  const sock = ws;
  sock.onopen = () => {
    retryMs = 500;
    setLink(true);
    sock.send(JSON.stringify({ type: "hello", client: CLIENT, last_job: lastJob }));
  };
  sock.onmessage = onMessage;
  sock.onclose = () => {
    if (sock !== ws) return;
    setLink(false);
    if (pending) {
      pending.phase = "offline"; // the laptop keeps the job; hello on reconnect brings back its state
      startClock();
      announce("Link lost. Reconnecting.");
    }
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 4000);
  };
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { retryMs = 500; connect(); }
});

/* ---------- pre-flight check (fan-out audit) ---------- */
// mock.js replaces this to serve fixtures; otherwise it is plain fetch returning {ok, status, data}.
let apiCall = async (url, body) => {
  const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
  return { ok: r.ok, status: r.status, data: await r.json() };
};
let presets = [];
let activePreset = null;
let checking = null; // {t0, timer}

function fmtFactor(x) {
  const n = Number(x);
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toPrecision(3);
}

function auditFact(a) {
  if (a.flagged) return `Flagged · ${fmtFactor(a.findings[0].factor)}× rows`;
  if (!a.audited) return "No JOIN + aggregate";
  return a.audit_error ? "Incomplete" : "Clear";
}

/* Struck as-written figure, corrected figure, and how far off it was. Animates once when attached. */
function ledger(h, source) {
  const box = el("div", "ledger");
  if (Math.max(h.before_text.length, h.after_text.length) > 6) box.classList.add("long");
  const was = el("div", "col");
  was.append(el("span", "lab", "As written"), el("span", "fig was", h.before_text));
  const now = el("div", "col");
  now.append(el("span", "lab", source === "auditor" ? "Deduplicated" : "Corrected"), el("span", "fig now", h.after_text));
  box.append(was, now);
  if (h.ratio != null && h.ratio !== 1) {
    const hi = h.ratio > 1;
    box.append(el("span", "times", `${fmtFactor(hi ? h.ratio : 1 / h.ratio)}× too ${hi ? "high" : "low"}`));
  }
  box.append(el("span", "what", h.row ? `${h.column} for ${h.row}` : h.column));
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("go")));
  return box;
}

function rewriteBlock(c) {
  const det = el("details", "rewrite");
  det.append(el("summary", null, c.source === "auditor" ? "Suggested rewrite (auditor)" : "Corrected query (written by hand, verified by direct counts)"));
  det.append(sqlBlock(c.sql, null));
  if (c.error) det.append(el("p", "err", c.error));
  else if (c.rows) {
    if (c.rows.length) det.append(resultTable(c.columns, c.rows, 5));
    det.append(el("p", "count", rowCount(c.rows.length, c.rows_capped, 5)));
  }
  return det;
}

/* Copy the corrected SQL. Plain http on the router has no async clipboard, so fall back to execCommand,
   and if that fails too, open the rewrite and select its SQL for the phone's own Copy menu. */
function copyFixButton(c, det) {
  const row = el("div", "fixrow");
  const btn = el("button", "copy", "Copy fixed SQL");
  btn.type = "button";
  const said = el("span", "copied");
  said.setAttribute("aria-live", "polite");
  const done = (text) => {
    said.textContent = text;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { said.textContent = ""; }, 2500);
  };
  const selectIt = () => {
    det.open = true;
    const pre = det.querySelector("pre");
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    pre.scrollIntoView({ block: "nearest" });
    done("Selected. Use your Copy menu.");
  };
  const legacy = () => {
    const ta = el("textarea");
    ta.value = c.sql;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  btn.addEventListener("click", () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(c.sql).then(() => done("Copied"), () => (legacy() ? done("Copied") : selectIt()));
    } else if (legacy()) done("Copied");
    else selectIt();
  });
  row.append(btn, said);
  return row;
}

/* Explanation, "was this intended?" note, copy button. Returns [nodes, rewrite <details> or null]. */
function fixParts(a) {
  const nodes = [el("p", "explain", a.explanation || a.message)];
  if (a.intended) nodes.push(el("p", "intended", a.intended));
  const c = a.corrected;
  const det = c ? rewriteBlock(c) : null;
  if (c && !c.error) nodes.push(copyFixButton(c, det));
  return [nodes, det];
}

/* Audit block inside an Ask answer (only when flagged). */
function renderAudit(a) {
  const sec = el("section", "perf audit");
  sec.append(el("h2", null, "Double counting"));
  if (a.headline && a.corrected) sec.append(ledger(a.headline, a.corrected.source));
  const [nodes, det] = fixParts(a);
  sec.append(...nodes);
  if (det) sec.append(det);
  else sec.append(el("p", "note", "No automatic rewrite for this query shape."));
  return sec;
}

function checklist(items) {
  const ol = el("ol", "checklist");
  for (const [ch, re, cls] of items) {
    const li = el("li");
    li.append(el("span", "ch", ch), el("span", "dots"), el("span", "re" + (cls ? " " + cls : ""), re));
    ol.append(li);
  }
  return ol;
}

function renderCheck(d) {
  const o = d.original || {};
  const sheet = el("article", "sheet");
  let kind, title, sub;
  if (o.error) { kind = "error"; title = "Query does not run"; sub = o.error; }
  else if (d.flagged) { kind = "flagged"; title = "Double counting"; sub = d.db_id; }
  else if (!d.audited) { kind = "clear"; title = "Nothing to audit"; sub = "No JOIN with SUM, AVG or COUNT. This check looks only for double counting."; }
  else if (d.audit_error) { kind = "error"; title = "Audit incomplete"; sub = d.audit_error; }
  else { kind = "clear"; title = "No double counting found"; sub = "The JOINs do not repeat any counted row. Other mistakes are not checked here."; }
  const top = el("section", "v-" + kind);
  const vh = el("div", "verdict");
  vh.append(el("h3", null, title), el("p", null, sub));
  top.append(vh);
  if (d.flagged && d.headline && d.corrected) top.append(ledger(d.headline, d.corrected.source));
  let det = null;
  if (d.flagged) {
    const [nodes, rw] = fixParts(d);
    top.append(...nodes);
    det = rw;
  }
  sheet.append(top);

  const items = [];
  const nrows = o.rows ? o.rows.length : 0;
  items.push([`Runs on ${d.db_id}`, o.error ? "No" : `${rowCount(nrows, o.rows_capped, nrows)} · ${fmtSeconds(o.seconds)}`, o.error ? "bad" : null]);
  if (!o.error) items.push(["JOIN with SUM, AVG or COUNT", d.audited ? "Present" : "None", null]);
  if (d.audited) {
    const f = d.findings[0];
    items.push(["Rows repeated by the JOIN", d.flagged ? `${fmtFactor(f.factor)}× ${f.table === "*" ? "all tables" : f.table}` : d.audit_error ? "Not measured" : "None",
      d.flagged ? "bad" : d.audit_error ? null : "ok"]);
  }
  if (d.flagged) {
    const c = d.corrected;
    items.push(["Corrected query", !c ? "None for this shape" : c.error ? "Fails" : c.source === "auditor" ? "Auditor rewrite runs" : "Hand fix runs",
      c && !c.error ? "ok" : null]);
  }
  items.push(["Check time", fmtSeconds(d.audit_seconds), null]);
  const cl = el("section", "perf");
  cl.append(checklist(items));
  sheet.append(cl);

  const body = el("section", "perf");
  body.append(el("p", "tag", "SQL as written"));
  body.append(d.flagged ? hlBlock(d.sql, d.highlights) : sqlBlock(d.sql, null));
  if (d.flagged && d.highlights && d.highlights.length) {
    body.append(el("p", "note", "Red: the aggregate that counts repeated rows. Yellow: the JOINs in the same query block."));
  }
  if (!o.error && o.rows) {
    if (o.rows.length) body.append(resultTable(o.columns, o.rows, 5));
    body.append(el("p", "count", rowCount(o.rows.length, o.rows_capped, 5)));
  }
  if (det) body.append(det);
  sheet.append(body);
  $("checkOut").replaceChildren(sheet);
}

function renderPresets() {
  const ul = $("presets");
  ul.replaceChildren(...presets.map((p) => {
    const li = el("li");
    const b = el("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(activePreset === p.id));
    b.append(el("span", "pq", p.question), el("span", "ps", p.label), el("span", "pd", p.db_id));
    b.addEventListener("click", () => {
      activePreset = p.id;
      $("checkDb").value = p.db_id;
      $("sql").value = p.sql;
      renderPresets();
      $("checkOut").replaceChildren();
      $("checkStatus").textContent = "";
      $("run").scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
    li.append(b);
    return li;
  }));
  $("presetsHead").hidden = !presets.length;
}

async function loadPresets() {
  try {
    const r = await apiCall("/api/presets");
    presets = r.data.presets || [];
    renderPresets();
  } catch { presets = []; renderPresets(); }
}

function checkBusy(on) {
  $("run").disabled = on;
  $("run").textContent = on ? "Checking" : "Run pre-flight check";
  if (checking) clearInterval(checking.timer);
  checking = null;
  if (on) {
    checking = { t0: performance.now() };
    const draw = () => { $("checkStatus").textContent = `Running the query and the fan-out audit · ${((performance.now() - checking.t0) / 1000).toFixed(1)} s`; };
    draw();
    checking.timer = setInterval(draw, 100);
  }
}

async function runCheck(e) {
  e.preventDefault();
  const sql = $("sql").value.trim();
  const db_id = $("checkDb").value;
  if (!sql || !db_id || checking) return;
  const p = presets.find((x) => x.id === activePreset);
  const body = { db_id, sql };
  if (p && p.db_id === db_id) body.preset = p.id;
  checkBusy(true);
  const t0 = performance.now();
  try {
    const r = await apiCall("/api/check", body);
    checkBusy(false);
    if (!r.ok) { $("checkStatus").textContent = r.data.error || `Check failed (HTTP ${r.status}).`; $("checkOut").replaceChildren(); return; }
    $("checkStatus").textContent = `Checked in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    renderCheck(r.data);
    const d = r.data;
    announce(d.flagged ? `Double counting. ${d.explanation}` + (d.headline ? ` ${d.headline.before_text} becomes ${d.headline.after_text}.` : "")
      : d.original && d.original.error ? "The query does not run." : "No double counting found.");
  } catch {
    checkBusy(false);
    $("checkStatus").textContent = "No link to the laptop. Check again when it reconnects.";
  }
}

function setMode(mode) {
  const check = mode === "check";
  document.body.classList.toggle("check", check);
  $("tabAsk").setAttribute("aria-selected", String(!check));
  $("tabCheck").setAttribute("aria-selected", String(check));
  history.replaceState(null, "", location.pathname + location.search + (check ? "#check" : ""));
}

$("tabAsk").addEventListener("click", () => setMode("ask"));
$("tabCheck").addEventListener("click", () => setMode("check"));
$("checkForm").addEventListener("submit", runCheck);
$("sql").addEventListener("input", () => {
  const p = presets.find((x) => x.id === activePreset);
  if (p && normSql($("sql").value) !== normSql(p.sql)) { activePreset = null; renderPresets(); }
});

/* ---------- form ---------- */
function fillDbs(dbs) {
  const sel = $("db");
  sel.replaceChildren(...dbs.map((d) => { const o = el("option", null, d); o.value = d; return o; }));
  const saved = (() => { try { return localStorage.getItem("altimeter.db"); } catch { return null; } })();
  if (saved && dbs.includes(saved)) sel.value = saved;
  else if (dbs.includes("formula_1")) sel.value = "formula_1";
  $("checkDb").replaceChildren(...dbs.map((d) => { const o = el("option", null, d); o.value = d; return o; }));
  $("checkDb").value = dbs.includes("codebase_community") ? "codebase_community" : sel.value;
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
  if (!question || !db_id || pending || warming()) return;
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
setMode(location.hash === "#check" ? "check" : "ask");
if (MOCK) {
  const s = document.createElement("script");
  s.src = "mock.js";
  document.body.append(s);
} else {
  loadDbs();
  loadPresets();
  connect();
}
