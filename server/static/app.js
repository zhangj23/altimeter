"use strict";

// Band edges on the 0..1 calibrated score. Provisional: replace with the thresholds chosen on held-out data.
const BANDS = [
  { key: "ask", name: "Ask", from: 0, to: 0.5 },
  { key: "caution", name: "Caution", from: 0.5, to: 0.8 },
  { key: "cruise", name: "Cruise", from: 0.8, to: 1 },
];
const PREVIEW_ROWS = 3;
const KEEP_MESSAGES = 24;
// Dev-only fixture driver (mock.js). Nothing below changes behavior unless the URL has ?mock=1.
const MOCK = new URLSearchParams(location.search).get("mock") === "1";
// Empty-thread suggestions: questions whose landing is known from our own runs.
const SUGGEST = [
  ["How many badges has the user csgillespie obtained?", "codebase_community"],
  ["What's Lewis Hamilton's reference name?", "formula_1"],
  ["What is the rate of drivers completing all the laps in the 2008 Australian Grand Prix?", "formula_1"],
];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const REDUCED = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const smoothScroll = () => (REDUCED() ? "auto" : "smooth");

let ws = null;
let retryMs = 500;
let retryTimer = null;
let pending = null; // {question, db_id, t0, phase: sent|queued|working|offline, stage, job_id, queueText, card}
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

/* ---------- dial ---------- */
// The scale sweeps 270 degrees: 0 at bottom-left (-135) to 1 at bottom-right (+135). The gap holds the drum window.
const SWEEP_FROM = -135, SWEEP = 270;
const angleOf = (s) => SWEEP_FROM + SWEEP * s;
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function polar(s, r) {
  const a = (angleOf(s) * Math.PI) / 180;
  return [150 + r * Math.sin(a), 150 - r * Math.cos(a)];
}
function arcPath(s0, s1, r) {
  const [x0, y0] = polar(s0, r), [x1, y1] = polar(s1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${SWEEP * (s1 - s0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function bandOf(s) { return BANDS.find((b) => s < b.to) || BANDS[BANDS.length - 1]; }
const clamp01 = (s) => Math.min(1, Math.max(0, s));

/* A round altimeter: SVG face plus an HTML drum counter in the window. Returns {root, set(score, mode)}. */
function makeDial() {
  const root = el("div", "dial idle");
  root.setAttribute("aria-hidden", "true");
  const svg = svgEl("svg", { viewBox: "0 0 300 300" });
  svg.append(svgEl("circle", { class: "face", cx: 150, cy: 150, r: 146 }),
    svgEl("circle", { class: "bezel", cx: 150, cy: 150, r: 143 }),
    svgEl("circle", { class: "bezel-edge", cx: 150, cy: 150, r: 147 }),
    svgEl("circle", { class: "bezel-edge", cx: 150, cy: 150, r: 139 }));
  const gap = 0.004;
  for (const b of BANDS) svg.append(svgEl("path", { class: "arc arc-" + b.key, d: arcPath(b.from + gap, b.to - gap, 123) }));
  for (let i = 0; i <= 50; i++) {
    const s = i / 50, major = i % 5 === 0;
    const [x1, y1] = polar(s, 116), [x2, y2] = polar(s, major ? 100 : 108);
    svg.append(svgEl("line", { class: major ? "tick-major" : "tick-minor", x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2) }));
  }
  for (const [s, label] of [[0, "0"], [0.5, ".5"], [0.8, ".8"], [1, "1"]]) {
    const [x, y] = polar(s, 80);
    const t = svgEl("text", { class: "num", x: x.toFixed(2), y: y.toFixed(2) });
    t.textContent = label;
    svg.append(t);
  }
  svg.append(svgEl("rect", { class: "window", x: 84, y: 186, width: 132, height: 48 }));
  const needle = svgEl("g", { class: "needle" });
  needle.append(svgEl("polygon", { class: "needle-body", points: "150,40 146.8,142 146.8,176 153.2,176 153.2,142" }),
    svgEl("circle", { class: "hub", cx: 150, cy: 150, r: 6.5 }));
  const wobble = svgEl("g", { class: "wobble" });
  wobble.append(needle);
  svg.append(wobble);
  root.append(svg);
  // Drum: digit, point, digit, digit; the point never moves.
  const drum = el("div", "drum blank");
  for (let k = 0; k < 4; k++) {
    if (k === 1) { drum.append(el("span", "dot", ".")); continue; }
    const slot = el("span", "slot");
    const reel = el("span", "reel");
    for (const ch of "0123456789-") reel.append(el("span", null, ch));
    slot.append(reel);
    drum.append(slot);
  }
  root.append(drum);
  const reels = drum.querySelectorAll(".reel");

  function setDrum(text, snap) {
    drum.classList.toggle("blank", text == null);
    drum.classList.toggle("snap", !!snap);
    if (snap) void drum.offsetWidth;
    const chars = (text || "-.--").split("");
    [chars[0], chars[2], chars[3]].forEach((ch, i) => {
      const k = ch === "-" ? 10 : Number(ch);
      reels[i].style.transform = `translateY(${(0.55 - k).toFixed(2)}em)`;
    });
    if (snap) { void drum.offsetWidth; drum.classList.remove("snap"); }
  }
  function point(s, snap) {
    if (snap) { needle.classList.add("snap"); void needle.getBoundingClientRect(); }
    needle.style.transform = `rotate(${angleOf(s).toFixed(2)}deg)`;
    if (snap) { void needle.getBoundingClientRect(); needle.classList.remove("snap"); }
  }
  /* mode: "idle" (no reading), "hold" (awaiting probe: hollow needle parked at 0), or a score in 0..1 */
  function set(score, mode) {
    if (mode === "hold") { root.className = "dial hold"; point(0, true); setDrum(null, true); return; }
    if (score == null || Number.isNaN(score)) { root.className = "dial idle"; point(0, false); setDrum(null, false); return; }
    const s = clamp01(score);
    root.className = "dial scored";
    point(s, false);
    setDrum(s.toFixed(2), false);
  }
  return { root, set };
}

/* ---------- status line and announcements ---------- */
function setStatus(text, clock, err) {
  $("statusText").textContent = text || "";
  $("clock").textContent = clock || "";
  $("status").classList.toggle("err", !!err);
  $("status").classList.toggle("on", !!text);
}
function announce(text) { $("announce").textContent = text; }

const STAGES = { generating: "Generating SQL", scoring: "Scoring confidence", executing: "Running the query", sampling: "Sampling other readings" };
const warming = () => !!(serverStatus && serverStatus.warming);
const warmSecs = () => (warmT0 == null ? 0 : Math.round((performance.now() - warmT0) / 1000));

/* What the pending reply card says while the laptop works: [text, clock], or null when nothing is in progress. */
function liveText() {
  if (pending) {
    if (pending.phase === "offline") return ["Link lost. The laptop keeps your question; reconnecting.", ""];
    if (pending.phase === "working") return [STAGES[pending.stage] || STAGES.generating, `${((performance.now() - pending.t0) / 1000).toFixed(1)} s`];
    if (warming()) return ["Waiting for the model to warm up", `${warmSecs()} s`];
    return [pending.queueText || "Sent", ""];
  }
  if (warming()) return ["Warming up the model", `${warmSecs()} s`];
  return null;
}
function refresh() {
  const t = liveText();
  if (t == null) return stopClock();
  if (pending && pending.card) { pending.card.stage(t[0], t[1]); setStatus(""); }
  else setStatus(t[0], t[1]);
}
function startClock() {
  if (!tick) tick = setInterval(refresh, 100);
  refresh();
}
function stopClock() { if (tick) clearInterval(tick); tick = null; }

function syncAsk() {
  $("ask").disabled = !!pending || warming();
  $("ask").textContent = pending ? "In flight" : "Run test flight";
}

/* ---------- runs (test flights), newest on top ---------- */
function clearSuggestions() { const s = $("runs").querySelector(".suggest"); if (s) s.remove(); }

function renderSuggestions(dbs) {
  if ($("runs").children.length) return;
  const box = el("div", "suggest");
  box.append(el("p", null, "Three questions to try"));
  for (const [q, db] of SUGGEST) {
    if (dbs && !dbs.includes(db)) continue;
    const b = el("button");
    b.type = "button";
    b.append(document.createTextNode(q), el("small", null, db));
    b.addEventListener("click", () => {
      if ($("db").querySelector(`option[value="${db}"]`)) $("db").value = db;
      $("question").value = q;
      $("flight").requestSubmit();
    });
    box.append(b);
  }
  $("runs").append(box);
}

/* A run: header (question, database; one line with score and band once collapsed) and the instrument card,
   whose dial holds in the awaiting pattern with the stage line until fill() or fail() replaces it. */
function newRun(question, db_id) {
  clearSuggestions();
  const list = $("runs");
  for (const old of list.querySelectorAll(".run.done")) old.classList.add("collapsed");
  const run = el("article", "run");
  const head = el("div", "head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", "true");
  const q = el("div", "q", question);
  q.append(el("small", null, db_id));
  const sum = el("div", "sum");
  head.append(q, sum);
  const toggle = () => {
    if (!run.classList.contains("done")) return;
    const c = run.classList.toggle("collapsed");
    head.setAttribute("aria-expanded", String(!c));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  const card = el("div", "body reply");
  const top = el("section", "reading-row");
  const dial = makeDial();
  const read = el("div", "read");
  const stage = el("div", "stage");
  const stageText = el("b", null, "Awaiting probe");
  const stageLine = el("span", null, "");
  const clock = el("span", "clock", "");
  stage.append(stageText, stageLine, document.createTextNode(" "), clock);
  read.append(stage);
  top.append(dial.root, read);
  card.append(top);
  run.append(head, card);
  list.prepend(run);
  while (list.children.length > KEEP_MESSAGES) list.lastChild.remove();
  dial.set(null, "hold");
  return {
    node: run, card, dial, read,
    stage(text, time) { stageLine.textContent = text; clock.textContent = time; },
    summary(score, band) {
      sum.replaceChildren(el("span", null, score), el("small", null, band));
      run.classList.add("done");
    },
    fail(message) {
      dial.set(null);
      stage.remove();
      read.append(el("p", "err", message));
      sum.replaceChildren(el("small", null, "Failed"));
      run.classList.add("done");
    },
  };
}

/* ---------- answer rendering ---------- */
function fmtSeconds(x) {
  if (x == null) return "n/a";
  return x < 1 ? `${Math.max(1, Math.round(x * 1000))} ms` : `${Number(x).toFixed(2)} s`;
}
function fmtCell(v) {
  if (v == null) return "null";
  if (typeof v === "number" && !Number.isInteger(v)) return String(+v.toFixed(4));
  return String(v);
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
    for (const v of row) tr.append(v == null ? el("td", "null", "null") : el("td", null, fmtCell(v)));
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

/* The answer in one line: a single cell becomes the figure with its column; otherwise the row count. */
function answerLine(r) {
  if (r.error) return el("p", "err", r.error);
  if (!r.rows) return el("p", "ans text", "No result.");
  if (!r.rows.length) return el("p", "ans text", "No rows match.");
  const cols = r.columns || [];
  if (r.rows.length === 1 && r.rows[0].length === 1) {
    const p = el("p", "ans");
    p.append(el("b", null, fmtCell(r.rows[0][0])), el("span", null, cols[0] || ""));
    return p;
  }
  const p = el("p", "ans text", `${rowCount(r.rows.length, r.rows_capped, r.rows.length)}, ${cols.length} ${cols.length === 1 ? "column" : "columns"}`);
  return p;
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

/* Two lines of SQL until tapped; the whole block is always one tap away. */
function collapsible(pre) {
  const box = el("div", "sqlbox clamped");
  box.setAttribute("role", "button");
  box.tabIndex = 0;
  box.setAttribute("aria-expanded", "false");
  const more = el("span", "more", "Show all SQL");
  box.append(pre, more);
  const toggle = () => {
    const open = box.classList.toggle("clamped");
    box.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? "Show all SQL" : "Show less";
  };
  box.addEventListener("click", (e) => { if (!getSelection().toString()) { e.stopPropagation(); toggle(); } });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  requestAnimationFrame(() => { if (pre.scrollHeight <= pre.clientHeight + 2) { box.classList.remove("clamped"); more.remove(); box.removeAttribute("role"); box.tabIndex = -1; } });
  return box;
}

const normSql = (s) => (s || "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();

function renderReadings(r) {
  const list = r.readings;
  const sec = el("section", "readings");
  sec.append(el("h2", null, "Two readings"));
  sec.append(el("p", null, "Samples disagree on the result."));
  const cards = [];
  list.forEach((rd, idx) => {
    const other = list[idx === 0 ? 1 : 0];
    const card = el("div", "reading");
    const head = el("div", "rhead");
    const name = el("div", "rname", `Reading ${rd.label}`);
    if (rd.share != null) name.append(el("span", null, `${Math.round(rd.share * 100)}% of samples`));
    const btn = el("button", "choose outline", `Choose ${rd.label}`);
    btn.type = "button";
    head.append(name, btn, el("span", "picked", "Chosen"));
    card.append(head);
    const body = el("div", "rbody");
    body.append(collapsible(sqlBlock(rd.sql, other ? other.sql : null)));
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

/* ---------- why: the logistic regression behind the needle ---------- */
const sgn = (x, d) => (x < 0 ? "−" : "+") + Math.abs(x).toFixed(d);
const neg = (x, d) => (x < 0 ? "−" : "") + Math.abs(x).toFixed(d);
const fmtInt = (n) => Number(n).toLocaleString("en-US");
function termLabel(name, ex) {
  const d = ex.d != null ? fmtInt(ex.d) : "[TBD]";
  const L = ex.layer != null ? ex.layer : "[TBD]";
  return {
    probe: `Internals (layer ${L})`,
    logprob_mean: "Mean token log-prob of the SQL",
    logprob_min: "Lowest token log-prob",
    question_chars: "Question length (characters)",
    sql_chars: "SQL length (characters)",
    n_joins: "Joins",
    n_aggregates: "Aggregates",
    n_subqueries: "Subqueries",
    n_prompt: "Prompt tokens",
    n_gen: "Generated tokens",
    executes: "Compiles and runs",
  }[name] || name;
}
const GROUP_ORDER = ["Internals", "Token confidence", "Size", "Compiles"];
const GROUP_OF = { probe: "Internals", logprob_mean: "Token confidence", logprob_min: "Token confidence", executes: "Compiles" };
const groupOf = (t) => t.group || GROUP_OF[t.name] || "Size";

/* Four signed bars (the stack's groups) and the sum; every weight behind a second tap. */
function renderWhy(r) {
  const ex = r.explain;
  if (!ex || ex.needle == null) return null;
  const det = el("details", "why");
  const sum = el("summary", null, `Why ${ex.needle.toFixed(2)}`);
  sum.append(el("span", null, "Logistic regression"));
  det.append(sum);
  const terms = Array.isArray(ex.stack_terms) && ex.stack_terms.length ? ex.stack_terms : null;
  const baseline = ex.intercept != null ? ex.intercept : ex.stack_ref;
  let groups;
  if (terms) {
    const acc = {};
    for (const t of terms) acc[groupOf(t)] = (acc[groupOf(t)] || 0) + t.contribution;
    groups = GROUP_ORDER.filter((g) => g in acc).map((g) => ({ name: g, value: acc[g] }));
  } else {
    groups = (ex.groups || []).map((g) => ({ name: g.name, value: g.value }));
  }
  const label = (g) => (g === "Internals" ? termLabel("probe", ex) : g);
  const maxAbs = Math.max(1e-9, ...groups.map((g) => Math.abs(g.value)));
  const ul = el("ul", "terms");
  for (const g of groups) {
    const li = el("li");
    li.append(el("span", "n", label(g.name)), el("span", "c " + (g.value >= 0 ? "up" : "down"), sgn(g.value, 2)));
    const track = el("span", "track");
    const bar = el("i", g.value >= 0 ? "up" : "down");
    const w = (Math.abs(g.value) / maxAbs) * 50;
    bar.style.left = (g.value >= 0 ? 50 : 50 - w) + "%";
    bar.style.width = w + "%";
    const zero = el("em");
    zero.style.left = "50%";
    track.append(bar, zero);
    li.append(track);
    ul.append(li);
  }
  if (baseline != null) {
    const li = el("li", "base");
    li.append(el("span", "n", "Baseline"), el("span", "c", sgn(baseline, 2)));
    ul.append(li);
  }
  const tot = el("li", "sum");
  tot.append(el("span", "n", "Sum"), el("span", "c", `${neg(ex.logit, 2)} → ${ex.needle.toFixed(2)}`));
  ul.append(tot);
  det.append(ul);

  const all = el("details", "weights");
  all.append(el("summary", null, "All weights"));
  const table = el("table");
  const head = el("tr");
  head.append(el("th", null, "Input"), el("th", null, terms ? "Weight" : ""), el("th", null, "Contribution"));
  table.append(head);
  const row = (name, weight, contribution) => {
    const tr = el("tr");
    tr.append(el("td", null, name), el("td", "w", weight), el("td", "w " + (contribution >= 0 ? "up" : "down"), sgn(contribution, 2)));
    table.append(tr);
  };
  if (baseline != null) row("Baseline", "", baseline);
  for (const t of terms || ex.features || []) row(termLabel(t.name, ex), terms ? neg(t.weight, 2) : "", terms ? t.contribution : t.contrib);
  all.append(table);
  det.append(all);
  if (ex.synthetic) det.append(el("p", "err", "Synthetic test probe: random weights, not evidence."));
  return det;
}

/* Worker sends probe as {needle, probe, calibrated, ...} or null. The needle is the stacked score. */
function needleOf(r) {
  if (r.probe == null) return null;
  const v = typeof r.probe === "object" ? Number(r.probe.needle) : Number(r.probe);
  return Number.isFinite(v) ? v : null;
}

/* Fill a reply card with the answer: reading, answer line, table, SQL, why, readings, audit. */
function fillReply(card, r, secs) {
  const nd = needleOf(r);
  const hasReadings = Array.isArray(r.readings) && r.readings.length >= 2;
  const read = card.read;
  read.replaceChildren();
  if (nd == null) {
    read.append(el("span", "bandname", "No probe"), el("b", null, "--"));
    card.summary("--", "No probe");
  } else {
    const b = bandOf(clamp01(nd));
    const name = el("span", "bandname", b.name);
    name.style.color = `var(--${b.key})`;
    read.append(name, el("b", null, clamp01(nd).toFixed(2)));
    card.summary(clamp01(nd).toFixed(2), b.name);
  }
  const meta = el("span", "meta");
  const took = secs != null ? `${secs} s` : fmtSeconds(r.gen_seconds);
  meta.append(el("span", null, `Local · ${took} · 0 bytes sent`));
  if (r.audit && r.audit.flagged) meta.append(el("span", null, `Double counting, ${fmtFactor(r.audit.findings[0].factor)}× rows`));
  if (r.fake) meta.append(el("span", null, "Fake worker"));
  if (r.mock) meta.append(el("span", null, "Mock fixture"));
  read.append(meta);
  card.dial.set(nd, "noprobe");

  const greedyShown = hasReadings && r.readings.some((rd) => normSql(rd.sql) === normSql(r.sql));
  const body = el("section");
  if (!greedyShown) {
    body.append(answerLine(r));
    if (!r.error && r.rows && r.rows.length && !(r.rows.length === 1 && r.rows[0].length === 1)) {
      body.append(resultTable(r.columns, r.rows, PREVIEW_ROWS));
      body.append(el("p", "count", rowCount(r.rows.length, r.rows_capped, Math.min(PREVIEW_ROWS, r.rows.length))));
    }
    const sqlNode = r.audit && r.audit.flagged && r.sql ? hlBlock(r.sql, r.audit.highlights) : sqlBlock(r.sql, null);
    const box = collapsible(sqlNode);
    box.style.marginTop = "10px";
    body.append(box);
  }
  const why = renderWhy(r);
  if (why) { why.style.marginTop = greedyShown ? "0" : "12px"; body.append(why); }
  if (body.children.length) card.card.append(body);
  if (hasReadings) card.card.append(renderReadings(r));
  if (r.audit && r.audit.flagged) card.card.append(renderAudit(r.audit));
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
    else if (was) { setStatus("Model ready"); announce("Model ready."); setTimeout(() => { if (!pending && !warming()) setStatus(""); }, 4000); }
  } else if (m.type === "welcome") {
    if (pending && m.job_id == null && !m.replay) {
      // The laptop has no record of it (restarted, or the question waited too long without this phone).
      const card = pending.card;
      pending = null;
      stopClock();
      syncAsk();
      if (card) card.fail("The laptop lost this question. Ask again.");
      announce("Question lost. Ask again.");
    } else if (pending && m.job_id != null) {
      pending.phase = "sent";
      pending.job_id = m.job_id;
    } else if (!pending && m.job_id != null) {
      // Page reloaded while a question was in flight: pick it back up (the laptop keeps the question text).
      pending = { question: "", db_id: "", t0: performance.now(), phase: "sent", job_id: m.job_id, card: newRun("Test flight in progress", "") };
      syncAsk();
      startClock();
    }
  } else if (m.type === "queued") {
    if (pending) {
      pending.phase = "queued";
      pending.job_id = m.job_id;
      pending.queueText = m.position <= 1 ? "Next in line" : `Queued, ${m.position - 1} ahead`;
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
        announce("Awaiting probe.");
      }
      startClock();
    }
  } else if (m.type === "result") {
    if (m.job_id != null && m.job_id === lastJob) return; // already rendered (replay after a reconnect)
    if (m.job_id != null) { lastJob = m.job_id; store.set("altimeter.lastJob", String(m.job_id)); }
    const secs = pending && pending.phase === "working" ? ((performance.now() - pending.t0) / 1000).toFixed(1) : null;
    const card = (pending && pending.card) || newRun(m.question || "Test flight", m.db_id || "");
    pending = null;
    stopClock();
    syncAsk();
    setStatus("");
    fillReply(card, m, secs);
    const nd = needleOf(m);
    let say = nd == null ? "Answer ready. No probe score." : `Confidence ${nd.toFixed(2)}, ${bandOf(clamp01(nd)).name}.`;
    if (m.error) say += " The query failed.";
    if (Array.isArray(m.readings) && m.readings.length >= 2) say += " Two readings, choose one.";
    announce(say);
  } else if (m.type === "error") {
    if (m.job_id != null) {
      if (m.job_id === lastJob) return;
      lastJob = m.job_id;
      store.set("altimeter.lastJob", String(m.job_id));
    }
    const card = pending && pending.card;
    pending = null;
    stopClock();
    syncAsk();
    if (card) card.fail(m.message);
    else setStatus(m.message, "", true);
    announce(m.message);
  }
}

function setLink(up) {
  $("radio").classList.toggle("on", !up);
  $("link").textContent = up ? "Local link" : "No link";
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
  if (a.flagged) return `Flagged, ${fmtFactor(a.findings[0].factor)}× rows`;
  if (!a.audited) return "No JOIN + aggregate";
  return a.audit_error ? "Incomplete" : "Clear";
}

/* How far off the as-written figure was: a multiple from 2x, a percentage below that (same rule as the table). */
function ratioWords(ratio) {
  const r = Number(ratio);
  if (ratio == null || !Number.isFinite(r) || r <= 0 || r === 1) return null;
  const hi = r > 1;
  if (hi && r >= 2) return `${fmtFactor(r)}× too high`;
  if (!hi && r <= 0.5) return `${fmtFactor(1 / r)}× too low`;
  return `${Math.round(Math.abs(r - 1) * 100)}% too ${hi ? "high" : "low"}`;
}

/* Struck as-written figure, corrected figure, and how far off it was. Animates once when attached. */
function ledger(h) {
  const box = el("div", "ledger");
  if (Math.max(h.before_text.length, h.after_text.length) > 6) box.classList.add("long");
  const was = el("div", "col");
  was.append(el("span", "lab", "As written"), el("span", "fig was", h.before_text));
  const now = el("div", "col");
  now.append(el("span", "lab", "Corrected"), el("span", "fig now", h.after_text));
  box.append(was, now);
  const rw = ratioWords(h.ratio);
  if (rw) box.append(el("span", "times", rw));
  box.append(el("span", "what", h.row ? `${h.column} for ${h.row}` : h.column));
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("go")));
  return box;
}

function rewriteBlock(c) {
  const det = el("details", "rewrite");
  det.append(el("summary", null, c.source === "auditor" ? "Corrected SQL (auditor rewrite)" : "Corrected SQL (hand-written, checked against the raw tables)"));
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
  const btn = el("button", "copy outline", "Copy corrected SQL");
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

/* Audit block inside an answer (only when flagged). */
function renderAudit(a) {
  const sec = el("section", "audit");
  sec.append(el("h2", null, "Double counting"));
  if (a.headline && a.corrected) sec.append(ledger(a.headline));
  const [nodes, det] = fixParts(a);
  sec.append(...nodes);
  if (det) sec.append(det);
  else sec.append(el("p", "note", "No automatic rewrite for this query."));
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
  else if (!d.audited) { kind = "clear"; title = "Nothing to check"; sub = "No JOIN feeds a SUM, AVG or COUNT, so nothing can be double counted."; }
  else if (d.audit_error) { kind = "error"; title = "Audit incomplete"; sub = d.audit_error; }
  else { kind = "clear"; title = "No double counting found"; sub = "No JOIN repeats a counted row. Other mistakes are not checked."; }
  const top = el("section", "v-" + kind);
  const vh = el("div", "verdict");
  vh.append(el("h3", null, title), el("p", null, sub));
  top.append(vh);
  if (d.flagged && d.headline && d.corrected) top.append(ledger(d.headline));
  let det = null;
  if (d.flagged) {
    const [nodes, rw] = fixParts(d);
    top.append(...nodes);
    det = rw;
  }
  sheet.append(top);

  const items = [];
  const nrows = o.rows ? o.rows.length : 0;
  items.push([`Runs on ${d.db_id}`, o.error ? "No" : `${rowCount(nrows, o.rows_capped, nrows)}, ${fmtSeconds(o.seconds)}`, o.error ? "bad" : null]);
  if (!o.error) items.push(["JOIN with SUM, AVG or COUNT", d.audited ? "Present" : "None", null]);
  if (d.audited) {
    const f = d.findings[0];
    items.push(["Rows repeated by the JOIN", d.flagged ? `${fmtFactor(f.factor)}× ${f.table === "*" ? "all tables" : f.table}` : d.audit_error ? "Not measured" : "None",
      d.flagged ? "bad" : d.audit_error ? null : "ok"]);
  }
  if (d.flagged) {
    const c = d.corrected;
    items.push(["Corrected query", !c ? "None" : c.error ? "Does not run" : c.source === "auditor" ? "Runs (auditor rewrite)" : "Runs (hand-written)",
      c && !c.error ? "ok" : c ? "bad" : null]);
  }
  items.push(["Check time", fmtSeconds(d.audit_seconds), null]);
  const cl = el("section");
  cl.append(checklist(items));
  sheet.append(cl);

  const body = el("section");
  body.append(el("p", "tag", "SQL as written"));
  body.append(d.flagged ? hlBlock(d.sql, d.highlights) : sqlBlock(d.sql, null));
  if (d.flagged && d.highlights && d.highlights.length) {
    body.append(el("p", "note", "Red: the aggregate. Yellow: the JOINs that repeat its rows."));
  }
  if (!o.error && o.rows) {
    if (o.rows.length) body.append(resultTable(o.columns, o.rows, 5));
    body.append(el("p", "count", rowCount(o.rows.length, o.rows_capped, 5)));
  }
  if (det) body.append(det);
  sheet.append(body);
  $("checkOut").replaceChildren(sheet);
  requestAnimationFrame(() => sheet.scrollIntoView({ block: "start", behavior: smoothScroll() }));
}

function renderPresets() {
  const ul = $("presets");
  ul.replaceChildren(...presets.map((p) => {
    const li = el("li");
    const b = el("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(activePreset === p.id));
    const ps = el("span", "ps", p.label);
    ps.append(el("span", null, ` · ${p.db_id}`));
    b.append(el("span", "pq", p.question), ps);
    b.addEventListener("click", () => {
      activePreset = p.id;
      $("checkDb").value = p.db_id;
      $("sql").value = p.sql;
      renderPresets();
      $("checkOut").replaceChildren();
      setCheckStatus("");
      $("run").scrollIntoView({ block: "end", behavior: smoothScroll() });
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

function setCheckStatus(text, clock) {
  $("checkText").textContent = text;
  $("checkClock").textContent = clock || "";
}

function checkBusy(on) {
  $("run").disabled = on;
  $("run").textContent = on ? "Checking" : "Run pre-flight check";
  if (checking) clearInterval(checking.timer);
  checking = null;
  if (on) {
    checking = { t0: performance.now() };
    const draw = () => setCheckStatus("Running the query and counting its JOINs", `${((performance.now() - checking.t0) / 1000).toFixed(1)} s`);
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
    if (!r.ok) { setCheckStatus(r.data.error || `Check failed (HTTP ${r.status}).`); $("checkOut").replaceChildren(); return; }
    setCheckStatus("Checked", `${((performance.now() - t0) / 1000).toFixed(1)} s`);
    renderCheck(r.data);
    const d = r.data;
    announce(d.flagged ? `Double counting. ${d.explanation}` + (d.headline ? ` ${d.headline.before_text} becomes ${d.headline.after_text}.` : "")
      : d.original && d.original.error ? "The query does not run." : "No double counting found.");
  } catch {
    checkBusy(false);
    setCheckStatus("No link to the laptop. Try again once it reconnects.");
  }
}

function setMode(mode) {
  const test = mode === "test";
  document.body.classList.toggle("test", test);
  $("tabTest").setAttribute("aria-selected", String(test));
  $("tabCheck").setAttribute("aria-selected", String(!test));
  history.replaceState(null, "", location.pathname + location.search + (test ? "#test" : ""));
}

$("tabTest").addEventListener("click", () => setMode("test"));
$("tabCheck").addEventListener("click", () => setMode("check"));
$("checkForm").addEventListener("submit", runCheck);
$("sql").addEventListener("input", () => {
  const p = presets.find((x) => x.id === activePreset);
  if (p && normSql($("sql").value) !== normSql(p.sql)) { activePreset = null; renderPresets(); }
});

/* ---------- test flight form ---------- */
function fillDbs(dbs) {
  const sel = $("db");
  sel.replaceChildren(...dbs.map((d) => { const o = el("option", null, d); o.value = d; return o; }));
  const saved = store.get("altimeter.db");
  if (saved && dbs.includes(saved)) sel.value = saved;
  else if (dbs.includes("formula_1")) sel.value = "formula_1";
  $("checkDb").replaceChildren(...dbs.map((d) => { const o = el("option", null, d); o.value = d; return o; }));
  $("checkDb").value = dbs.includes("codebase_community") ? "codebase_community" : sel.value;
  renderSuggestions(dbs);
}

async function loadDbs() {
  try {
    const r = await fetch("/api/dbs", { cache: "no-store" });
    fillDbs((await r.json()).dbs);
  } catch {
    setStatus("Could not load the database list.", "", true);
  }
}

function submit(e) {
  e.preventDefault();
  const question = $("question").value.trim();
  const db_id = $("db").value;
  if (!question || !db_id || pending || warming()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { setStatus("No link to the laptop yet.", "", true); connect(); return; }
  store.set("altimeter.db", db_id);
  pending = { question, db_id, t0: performance.now(), phase: "sent", card: newRun(question, db_id) };
  syncAsk();
  setStatus("");
  pending.card.stage("Sent", "");
  pending.card.node.scrollIntoView({ block: "nearest", behavior: smoothScroll() });
  announce("Question sent.");
  ws.send(JSON.stringify({ db_id, question }));
}

$("flight").addEventListener("submit", submit);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("flight").requestSubmit(); }
});

setMode(location.hash === "#test" ? "test" : "check");
if (MOCK) {
  const s = document.createElement("script");
  s.src = "mock.js";
  document.body.append(s);
} else {
  loadDbs();
  loadPresets();
  connect();
}
