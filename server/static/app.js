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
let quiet = false; // true while restoring this session's cards after a reload: no replayed motion
const REDUCED = () => quiet || matchMedia("(prefers-reduced-motion: reduce)").matches;
const smoothScroll = () => (REDUCED() ? "auto" : "smooth");

/* ---------- motion primitives: they only ever move values the payload carries ---------- */
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function tween(from, to, ms, onFrame, onDone) { // one rAF loop; reduced motion jumps to the end
  if (REDUCED() || ms <= 0 || from === to) { onFrame(to, 1); if (onDone) onDone(); return () => {}; }
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    onFrame(from + (to - from) * easeOut(u), u);
    if (u < 1) raf = requestAnimationFrame(step); else if (onDone) onDone();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
// Damped spring: stiffness 70, damping ratio 0.72 (one ~4% overshoot, then settled). Semi-implicit Euler.
function spring(from, to, onFrame, onDone) {
  if (REDUCED() || from === to) { onFrame(to); if (onDone) onDone(); return () => {}; }
  const k = 70, c = 2 * 0.72 * Math.sqrt(k);
  let x = from, v = 0, last = performance.now(), raf = 0;
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (let n = 0; n < 4; n++) { const h = dt / 4; v += (-k * (x - to) - c * v) * h; x += v * h; }
    if (Math.abs(x - to) < 0.0005 && Math.abs(v) < 0.002) { onFrame(to); if (onDone) onDone(); return; }
    onFrame(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
// Tweens a figure shown as text ("355", "116.6527", "1,234") with the same decimals and grouping.
function numberText(text) {
  const s = String(text);
  if (!/^-?[\d,]*\.?\d+$/.test(s)) return null;
  const v = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  const dec = (s.split(".")[1] || "").length;
  const grouped = s.includes(",");
  return { v, fmt: (x) => (grouped ? x.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x.toFixed(dec)) };
}

/* ---------- clouds behind a dial: flat banks in panel greys; the layer's height follows that run's needle ---------- */
function cloudPath(seed, W, H, base, rMin, rMax) { // deterministic arcs along a baseline, closed to the bottom
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  let x = -rMax, d = `M${-rMax},${H} L${-rMax},${base}`;
  while (x < W + rMax) {
    const r = rMin + rnd() * (rMax - rMin);
    const cx = x + r * (0.55 + rnd() * 0.35);
    d += ` A${r},${r * (0.85 + rnd() * 0.15)} 0 0 1 ${(cx + r).toFixed(1)},${base}`;
    x = cx + r * 0.55;
  }
  return d + ` L${x + rMax},${H} Z`;
}
function makeClouds() {
  const host = el("div", "clouds");
  host.setAttribute("aria-hidden", "true");
  const W = 1200, H = 360;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMax slice" });
  [[11, 100, 115, 150, "l1"], [29, 230, 75, 120, "l2"], [47, 330, 50, 90, "l3"]].forEach(([seed, base, r0, r1, cls]) => {
    const band = svgEl("g", { class: cls });
    const d = cloudPath(seed, W, H, base, r0, r1);
    band.append(svgEl("path", { d }), svgEl("path", { d, transform: `translate(${W} 0)` })); // two copies: a seamless drift
    svg.append(band);
  });
  host.append(svg);
  // level 1: the layer fills its box; 0: fully below the card. Ask rises into cloud, Cruise sinks away.
  const level = (s) => (s == null ? 0.2 : 0.16 + 0.84 * Math.pow(1 - clamp01(s), 1.4));
  return { node: host, set: (s) => { host.style.transform = `translateY(${((1 - level(s)) * 100).toFixed(2)}%)`; } };
}

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
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
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
// The figure everyone sees (readout, drum, Why, summary, announcements) and the band read from that same figure,
// so 0.7996 never shows as "0.80 Caution".
const fig = (nd) => clamp01(nd).toFixed(2);
const bandAt = (nd) => bandOf(Number(fig(nd)));
/* Distance from the shown figure to the nearest band edge: "0.03 below Cruise", "0.11 above Caution". */
function edgeText(nd) {
  const v = Number(fig(nd)), i = BANDS.indexOf(bandOf(v)), b = BANDS[i];
  const up = i < BANDS.length - 1 ? b.to - v : Infinity, down = i > 0 ? v - b.from : Infinity;
  if (up === Infinity && down === Infinity) return null;
  if (down < 0.005) return `On the ${b.name} line`;
  return up <= down ? `${up.toFixed(2)} below ${BANDS[i + 1].name}` : `${down.toFixed(2)} above ${BANDS[i - 1].name}`;
}

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
  const ticks = [];
  for (let i = 0; i <= 50; i++) {
    const s = i / 50, major = i % 5 === 0;
    const [x1, y1] = polar(s, 116), [x2, y2] = polar(s, major ? 100 : 108);
    const t = svgEl("line", { class: major ? "tick-major" : "tick-minor", x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2) });
    ticks.push(t);
    svg.append(t);
  }
  const lightTicks = (s) => { for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle("lit", s != null && i / 50 <= s + 1e-9); };
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
  // Drum: digit, point, digit, digit; the point never moves. Each reel is 0-9, a wrap 0, then the blank dash.
  const drum = el("div", "drum blank");
  for (let k = 0; k < 4; k++) {
    if (k === 1) { drum.append(el("span", "dot", ".")); continue; }
    const slot = el("span", "slot");
    const reel = el("span", "reel");
    for (const ch of "01234567890-") reel.append(el("span", null, ch));
    slot.append(reel);
    drum.append(slot);
  }
  root.append(drum);
  const reels = drum.querySelectorAll(".reel");
  const BLANK = 11;
  const roll = (i, pos) => { reels[i].style.transform = `translateY(${(0.55 - pos).toFixed(3)}em)`; };

  function setDrum(text) { // exact figures (or blank)
    drum.classList.toggle("blank", text == null);
    const chars = (text || "-.--").split("");
    [chars[0], chars[2], chars[3]].forEach((ch, i) => roll(i, ch === "-" ? BLANK : Number(ch)));
  }
  function rollDrum(v) { // mid-sweep: the hundredths wheel turns continuously, the others step with it
    const h = v * 100;
    roll(0, Math.floor(v) % 10);
    roll(1, Math.floor(v * 10) % 10 + Math.max(0, (h % 10) - 9)); // steps as the hundredths wheel passes 9
    roll(2, h % 10);
  }
  const point = (s) => { needle.style.transform = `rotate(${angleOf(s).toFixed(2)}deg)`; };
  let stop = () => {};
  let onMove = null; // the clouds behind the dial follow the needle
  /* mode: "idle" (no reading), "hold" (awaiting probe: hollow needle parked at 0), or a score in 0..1 */
  let neutral = false; // uploaded data: no band colours, the clouds stay low
  let onSettle = null;
  function set(score, mode) {
    stop();
    delete root.dataset.band;
    if (mode === "hold") { root.className = "dial hold"; point(0); setDrum(null); lightTicks(null); if (onMove) onMove(null); return; }
    if (score == null || Number.isNaN(score)) { root.className = "dial idle"; point(0); setDrum(null); lightTicks(null); if (onMove) onMove(null); return; }
    const s = clamp01(score);
    root.className = neutral ? "dial scored uncal" : "dial scored";
    if (neutral && onMove) onMove(null);
    drum.classList.remove("blank");
    // the sweep: a damped spring from 0; ticks light as the needle passes, the drum rolls with it
    const move = neutral ? null : onMove;
    // the scale ends at 1: an overshoot near the top rests on the stop instead of swinging into the window
    // the band lands once the needle is within a hair of its figure (~0.4 s), not after the last of the spring's tail
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      if (!neutral) root.dataset.band = bandOf(Number(s.toFixed(2))).key; // the landed band's arc stays lit
      if (onSettle) onSettle();
    };
    stop = spring(0, s, (x) => {
      const c = Math.min(1, Math.max(0, x));
      point(c); lightTicks(c); rollDrum(c); if (move) move(c);
      if (Math.abs(x - s) < 0.015) land();
    }, () => { point(s); lightTicks(s); setDrum(s.toFixed(2)); if (move) move(s); land(); });
  }
  return { root, set, follow: (fn) => { onMove = fn; }, neutral: () => { neutral = true; }, settled: (fn) => { onSettle = fn; } };
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
  for (const b of $("runs").querySelectorAll(".suggest button")) b.disabled = $("ask").disabled; // a tap while warming would do nothing
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
  syncAsk();
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
    run.classList.toggle("opened", !c); // reopening eases the card back in
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  const card = el("div", "body reply");
  const top = el("section", "reading-row");
  const dial = makeDial();
  const clouds = makeClouds();
  dial.follow(clouds.set);
  top.append(clouds.node);
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
    open() { if (run.classList.contains("collapsed")) toggle(); },
    title(question, db) { q.replaceChildren(document.createTextNode(question), el("small", null, db)); },
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
  const fits = () => { box.classList.remove("clamped"); more.remove(); box.removeAttribute("role"); box.removeAttribute("aria-expanded"); box.tabIndex = -1; };
  const measure = () => { if (!pre.clientHeight) return false; if (pre.scrollHeight <= pre.clientHeight + 2) fits(); return true; };
  requestAnimationFrame(() => {
    if (measure() || !window.ResizeObserver) return;
    const ro = new ResizeObserver(() => { if (!box.isConnected || measure()) ro.disconnect(); });
    ro.observe(box);
  });
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
      r._chosen = rd.label;
      saveSession();
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
  let k = 0;
  if (baseline != null) { // the sum starts here, so the baseline row lands first
    const li = el("li", "base");
    li.style.setProperty("--i", k++);
    li.append(el("span", "n", "Baseline"), el("span", "c", sgn(baseline, 2)));
    ul.append(li);
  }
  for (const g of groups) {
    const li = el("li");
    li.style.setProperty("--i", k++);
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
  const tot = el("li", "sum");
  tot.style.setProperty("--i", baseline != null ? 1 : 0);
  const totC = el("span", "c", `${neg(ex.logit, 2)} → ${ex.needle.toFixed(2)}`);
  tot.append(el("span", "n", "Sum"), totC);
  ul.append(tot);
  det.append(ul);
  // opening Why: rows land one by one, bars grow from the zero line, the sum ticks up as each lands
  const b0 = baseline != null ? baseline : 0;
  const first = baseline != null ? 1 : 0;
  const ROW = 110, GROW = 360;
  const at = (ms) => { // the sum at cascade time ms: baseline + the groups landed so far (partially while growing)
    let s = b0;
    groups.forEach((g, i) => { s += g.value * easeOut(Math.min(1, Math.max(0, (ms - ((first + i) * ROW + 80)) / GROW))); });
    return s;
  };
  const end = (first + groups.length - 1) * ROW + 80 + GROW;
  let raf = 0;
  det.addEventListener("toggle", () => {
    cancelAnimationFrame(raf);
    if (!det.open) { ul.classList.remove("go"); return; }
    if (REDUCED()) { ul.classList.add("go"); return; }
    totC.textContent = neg(b0, 2);
    const t0 = performance.now();
    const step = (now) => {
      const ms = now - t0;
      totC.textContent = neg(at(Math.min(ms, end)), 2);
      if (ms < end) raf = requestAnimationFrame(step);
      else totC.textContent = `${neg(ex.logit, 2)} → ${ex.needle.toFixed(2)}`;
    };
    requestAnimationFrame(() => { ul.classList.add("go"); raf = requestAnimationFrame(step); });
  });

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
  let band = null;
  if (nd == null) {
    read.append(el("span", "bandname", "No probe"), el("b", null, "--"));
    card.summary("--", "No probe");
  } else if (r.calibrated === false) { // uploaded data: the bands were calibrated on BIRD dev only
    read.append(el("span", "bandname uncal", r.calibration_note || "Needle not calibrated for this data"), el("b", null, fig(nd)));
    card.summary(fig(nd), "Not calibrated");
  } else {
    band = bandAt(nd);
    const name = el("span", "bandname land", band.name);
    name.style.color = `var(--${band.key})`;
    read.append(name, el("b", null, fig(nd)));
    const edge = edgeText(nd);
    if (edge) read.append(el("span", "edge", edge));
    card.summary(fig(nd), band.name);
    // the band name lands when the needle settles; the figure is readable from the first frame
    if (!REDUCED()) { card.dial.settled(() => read.classList.add("settled")); } else read.classList.add("settled");
  }
  const meta = el("span", "meta");
  const took = secs != null ? `${secs} s` : fmtSeconds(r.timing && r.timing.worker_s != null ? r.timing.worker_s : r.gen_seconds);
  const local = el("span");
  local.append(el("i", null, `Local · ${took} ·`), " ", el("i", null, "0 bytes sent")); // narrow phones wrap between the two
  meta.append(local);
  if (r.audit && r.audit.flagged) meta.append(el("span", null, `Double counting, ${fmtFactor(r.audit.findings[0].factor)}× rows`));
  if (r.fake) meta.append(el("span", null, "Fake worker"));
  if (r.mock) meta.append(el("span", null, "Mock fixture"));
  read.append(meta);
  if (r.calibrated === false) card.dial.neutral();
  card.dial.set(nd, "noprobe");

  const greedyShown = hasReadings && r.readings.some((rd) => normSql(rd.sql) === normSql(r.sql));
  const body = el("section");
  if (!greedyShown) {
    body.append(answerLine(r));
    if (!r.error && r.rows && r.rows.length && !(r.rows.length === 1 && r.rows[0].length === 1)) {
      body.append(resultTable(r.columns, r.rows, PREVIEW_ROWS));
      // the answer line already gives the row count; only say so when the preview cuts rows off
      if (r.rows.length > PREVIEW_ROWS) body.append(el("p", "count", `Showing ${PREVIEW_ROWS} of ${fmtInt(r.rows.length)}`));
    }
    const sqlNode = r.audit && r.audit.flagged && r.sql ? hlBlock(r.sql, r.audit.highlights) : sqlBlock(r.sql, null);
    const box = collapsible(sqlNode);
    box.style.marginTop = "10px";
    body.append(box);
  }
  const why = renderWhy(r);
  if (why) { why.style.marginTop = greedyShown ? "0" : "12px"; body.append(why); }
  const parts = [];
  if (body.children.length) parts.push(body);
  if (hasReadings) parts.push(renderReadings(r));
  if (r.audit && r.audit.flagged) parts.push(renderAudit(r.audit, r));
  const acts = el("section", "acts");
  // Ask band on a benchmark database: the question and schema (never rows) may go to the cloud, on a tap
  if (band && band.key === "ask" && !isUpload(r.db_id) && r.question && !r.cloud) acts.append(towerButton(card, r));
  acts.append(copyButton("Copy reading", () => readingText(r, card)));
  parts.push(acts);
  parts.forEach((p, i) => { p.classList.add("in"); p.style.setProperty("--i", i + 1); card.card.append(p); }); // sections land in order
  if (r.cloud) card.card.append(renderCloud(r.cloud));
}

/* ---------- copy reading: the card as plain text ---------- */
function answerText(r) {
  if (!r) return "No result";
  if (r.error) return `Error: ${r.error}`;
  if (!r.rows) return "No result";
  if (!r.rows.length) return "No rows match";
  if (r.rows.length === 1 && r.rows[0].length === 1) return `${fmtCell(r.rows[0][0])} (${(r.columns || [])[0] || ""})`;
  return `${rowCount(r.rows.length, r.rows_capped, r.rows.length)}; first: ${r.rows[0].map(fmtCell).join(" | ")}`;
}
function readingText(r) {
  const nd = needleOf(r);
  const lines = [`Question: ${r.question || ""}`, `Database: ${dbLabel(r.db_id || "")}`, `SQL: ${(r.sql || "(none)").replace(/\s+/g, " ").trim()}`, `Answer: ${answerText(r)}`];
  if (nd == null) lines.push("Needle: no probe");
  else if (r.calibrated === false) lines.push(`Needle: ${fig(nd)} (not calibrated for uploaded data)`);
  else lines.push(`Needle: ${fig(nd)}, ${bandAt(nd).name} (${edgeText(nd)})`);
  if (r.audit && r.audit.flagged) {
    const h = r.audit.headline;
    lines.push(`Double counting: ${fmtFactor(r.audit.findings[0].factor)}x rows` + (h && r.audit.corrected ? `; ${h.before_text} as written, ${h.after_text} corrected` : ""));
  }
  if (Array.isArray(r.readings) && r.readings.length >= 2) {
    for (const rd of r.readings) lines.push(`Reading ${rd.label}${rd.share != null ? ` (${Math.round(rd.share * 100)}% of samples)` : ""}: ${answerText(rd)}`);
    if (r._chosen) lines.push(`Chosen: reading ${r._chosen}`);
  }
  lines.push("Local model, 0 bytes sent");
  const c = r.cloud;
  if (c) {
    lines.push(`Cloud (${c.model || "Gemini"}${c.source === "cache" ? ", cached reply" : ""}, ${fmtInt(c.bytes_sent || 0)} bytes sent; no needle: cloud SQL)`);
    lines.push(`Cloud SQL: ${(c.sql || "(none)").replace(/\s+/g, " ").trim()}`, `Cloud answer: ${c.error && !c.result ? `Error: ${c.error}` : answerText(c.result)}`);
  }
  return lines.join("\n");
}

/* ---------- radio the tower: Ask band, opt-in cloud escalation of schema + question (never rows) ---------- */
function towerButton(card, r) {
  const row = el("div", "fixrow tower-row");
  const btn = el("button", "outline", "Radio the tower");
  btn.type = "button";
  btn.addEventListener("click", () => openTower(card, r, btn));
  row.append(btn);
  return row;
}
let tower = null; // {card, r, trigger, busy}
/* The payload is Gemini's generateContent body. Its prompt text is shown as text (not as an escaped JSON
   string), then the whole body as JSON. */
function towerPayload(payload) {
  const box = $("towerPay");
  box.replaceChildren();
  if (payload == null) return;
  if (typeof payload === "string") { box.append(el("pre", "sql", payload)); return; }
  const texts = [];
  for (const c of Array.isArray(payload.contents) ? payload.contents : []) {
    for (const part of (c && Array.isArray(c.parts) ? c.parts : [])) if (part && typeof part.text === "string") texts.push(part.text);
  }
  if (texts.length) {
    texts.forEach((t) => box.append(el("p", "tk", "Prompt text"), el("pre", "sql", t)));
    // the body around it, with the prompt (shown above) stood in for so 6 KB of DDL is not printed twice
    const body = JSON.stringify(payload, (k, v) => (k === "text" && typeof v === "string" ? "(prompt text above)" : v), 1);
    box.append(el("p", "tk", "Request body"), el("pre", "sql", body));
    return;
  }
  for (const [k, v] of Object.entries(payload)) {
    box.append(el("p", "tk", k), el("pre", "sql", typeof v === "string" ? v : JSON.stringify(v, null, 2)));
  }
}
function towerState(st, text) {
  const send = $("towerSend"), stay = $("towerStay"), err = $("towerErr");
  err.hidden = st !== "error";
  if (st === "error") err.textContent = text;
  // nothing to show when the payload never came: no line promising "exactly this", no empty byte count
  const blank = st === "error" && !$("towerPay").children.length;
  for (const id of ["towerLine", "towerBytesLine", "towerPay"]) $(id).hidden = blank;
  send.disabled = st !== "ready";
  stay.disabled = st === "sending";
  send.textContent = st === "sending" ? "Transmitting" : "Transmit";
  if (tower) tower.busy = st === "sending";
}
async function openTower(card, r, trigger) {
  if (tower) return;
  tower = { card, r, trigger, busy: false };
  const t = $("tower");
  $("towerBytes").textContent = "--";
  $("towerLine").textContent = "Transmit sends exactly this. No data rows.";
  towerPayload(null);
  towerState("loading");
  t.hidden = false;
  void t.offsetWidth;
  t.classList.add("open");
  document.documentElement.classList.add("locked");
  $("towerStay").focus({ preventScroll: true });
  const res = await apiCall("/api/escalate", { db_id: r.db_id, question: r.question, transmit: false }).catch(() => null);
  if (!tower || tower.r !== r) return;
  if (!res) { towerState("error", "No link to the laptop."); return; }
  if (!res.ok) { towerState("error", res.status === 404 || res.status === 405 ? "Cloud escalation is not set up on this laptop." : (res.data && res.data.error) || `HTTP ${res.status}`); return; }
  $("towerBytes").textContent = fmtInt(res.data.bytes);
  $("towerLine").textContent = `Transmit sends exactly this to ${res.data.model || "Gemini"}. ${res.data.note || "No data rows."}`;
  towerPayload(res.data.payload);
  towerState("ready");
}
function closeTower() {
  if (!tower || tower.busy) return;
  const t = $("tower"), back = tower.trigger;
  tower = null;
  t.classList.remove("open");
  document.documentElement.classList.remove("locked");
  setTimeout(() => { if (!tower) t.hidden = true; }, REDUCED() ? 0 : 240);
  if (back && back.isConnected) back.focus({ preventScroll: true });
}
async function transmit() {
  if (!tower || tower.busy) return;
  const { card, r } = tower;
  towerState("sending");
  const res = await apiCall("/api/escalate", { db_id: r.db_id, question: r.question, transmit: true }).catch(() => null);
  if (!tower) return;
  if (!res || !res.ok) { towerState("error", !res ? "No link to the laptop." : (res.data && res.data.error) || `HTTP ${res.status}`); $("towerSend").disabled = false; return; }
  tower.busy = false;
  r.cloud = { ...res.data, db_id: r.db_id };
  closeTower();
  const row = card.card.querySelector(".tower-row");
  if (row) row.remove();
  const sec = renderCloud(r.cloud);
  sec.classList.add("in");
  card.card.append(sec);
  saveSession();
  renderLog();
  requestAnimationFrame(() => sec.scrollIntoView({ block: "start", behavior: smoothScroll() }));
  announce(r.cloud.error && !r.cloud.result ? `Cloud answer failed: ${r.cloud.error}` : `Cloud answer: ${answerText(r.cloud.result)}. No needle for cloud SQL.`);
}
$("towerStay").addEventListener("click", closeTower);
$("towerSend").addEventListener("click", transmit);
$("tower").addEventListener("click", (e) => { if (e.target.classList.contains("scrim")) closeTower(); });
$("tower").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); closeTower(); return; }
  if (e.key !== "Tab") return; // keep focus inside the sheet
  const f = [...$("tower").querySelectorAll("#towerPay, button:not(:disabled)")];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
});

/* The cloud's answer inside the run: its SQL, run on this laptop, with the double-counting audit. No needle. */
function renderCloud(c) {
  const sec = el("section", "cloud");
  sec.append(el("h2", null, "Cloud answer"));
  const meta = el("p", "cmeta");
  meta.append(el("span", null, `${c.model || "Gemini"}${c.source === "cache" ? ", cached reply" : ""} · ${fmtInt(c.bytes_sent || 0)} bytes sent`),
    el("span", null, "Ran on this laptop · No needle: cloud SQL"));
  sec.append(meta);
  const res = c.result || (c.error ? { error: c.error } : null);
  sec.append(answerLine(res || {}));
  if (res && !res.error && res.rows && res.rows.length && !(res.rows.length === 1 && res.rows[0].length === 1)) {
    sec.append(resultTable(res.columns, res.rows, PREVIEW_ROWS));
    if (res.rows.length > PREVIEW_ROWS) sec.append(el("p", "count", `Showing ${PREVIEW_ROWS} of ${fmtInt(res.rows.length)}`));
  }
  if (c.sql) {
    const a = c.audit;
    const box = collapsible(a && a.flagged ? hlBlock(c.sql, a.highlights) : sqlBlock(c.sql, null));
    box.style.marginTop = "10px";
    sec.append(box);
    if (a && a.flagged) sec.append(renderAudit(a, { sql: c.sql, db_id: c.db_id }));
    else if (a) sec.append(el("p", "note", `Double-counting check: ${auditFact(a)}`));
  }
  return sec;
}

/* ---------- this session: flights and checks, kept across a reload (sessionStorage, this tab only) ---------- */
const SESSION_KEY = MOCK ? null : "altimeter.session";
const KEEP_FLIGHTS = 12, KEEP_CHECKS = 8;
const session = { seq: 0, flights: [], checks: [], shownCheck: null }; // flights {id, m, secs, card}; checks {id, d, preset}
function saveSession() {
  if (!SESSION_KEY) return;
  const data = { seq: session.seq, flights: session.flights.map(({ id, m, secs }) => ({ id, m, secs })), checks: session.checks.map(({ id, d, preset }) => ({ id, d, preset })) };
  for (let tries = 0; tries < 6; tries++) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); return; } catch {
      if (data.flights.length > 1) data.flights.shift(); else if (data.checks.length > 1) data.checks.shift(); else return; // over quota: drop the oldest
    }
  }
}
function addFlight(m, secs, card) {
  session.flights.push({ id: ++session.seq, m, secs, card });
  if (session.flights.length > KEEP_FLIGHTS) session.flights.shift();
  saveSession();
  renderLog();
}
function addCheck(d, preset) {
  const id = ++session.seq;
  session.checks.push({ id, d, preset });
  if (session.checks.length > KEEP_CHECKS) session.checks.shift();
  session.shownCheck = id;
  saveSession();
  renderLog();
}
function flightResult(m) {
  const nd = needleOf(m);
  const cloud = m.cloud ? " · Cloud" : "";
  if (nd == null) return [(m.error ? "Query failed" : "No probe") + cloud, null];
  if (m.calibrated === false) return [`${fig(nd)} not calibrated${cloud}`, null];
  const b = bandAt(nd);
  return [`${fig(nd)} ${b.name}${cloud}`, b.key];
}
function checkResult(d) {
  const o = d.original || {};
  if (o.error) return ["Does not run", "ask"];
  if (d.flagged) return [`Double counting ${fmtFactor(d.findings[0].factor)}×`, "ask"];
  if (!d.audited) return ["Nothing to check", null];
  return d.audit_error ? ["Audit incomplete", null] : ["No double counting", "cruise"];
}
function renderLog() {
  const box = $("log");
  const entries = [...session.flights.map((f) => ({ ...f, kind: "flight" })), ...session.checks.map((c) => ({ ...c, kind: "check" }))].sort((a, b) => b.id - a.id);
  box.hidden = !entries.length;
  if (!entries.length) return;
  const nf = session.flights.length, nc = session.checks.length;
  const parts = [];
  if (nf) parts.push(`${nf} ${nf === 1 ? "flight" : "flights"}`);
  if (nc) parts.push(`${nc} ${nc === 1 ? "check" : "checks"}`);
  box.querySelector("summary").textContent = `This session: ${parts.join(", ")}`;
  const ol = box.querySelector("ol");
  ol.replaceChildren(...entries.map((e) => {
    const li = el("li");
    const b = el("button");
    b.type = "button";
    let text, res, mono = false;
    if (e.kind === "flight") { text = e.m.question || "Test flight"; res = flightResult(e.m); }
    else {
      const p = presets.find((x) => x.id === e.preset);
      text = p ? p.question : e.d.sql.replace(/\s+/g, " ").trim();
      mono = !p;
      res = checkResult(e.d);
    }
    const r = el("span", "lr", res[0]);
    if (res[1]) r.style.color = `var(--${res[1]})`;
    b.append(el("span", "lk", e.kind === "flight" ? "Flight" : "Check"), el("span", "lq" + (mono ? " mono" : ""), text), r);
    b.addEventListener("click", () => goTo(e));
    li.append(b);
    return li;
  }));
}
function goTo(e) {
  $("log").open = false;
  if (e.kind === "flight") {
    setMode("test");
    const c = e.card;
    if (!c || !c.node.isConnected) return;
    c.open();
    c.node.querySelector(".head").focus({ preventScroll: true });
    requestAnimationFrame(() => c.node.scrollIntoView({ block: "start", behavior: smoothScroll() }));
    return;
  }
  setMode("check");
  showCheck(e, true);
}
function showCheck(e, scroll) {
  const d = e.d;
  if (![...$("checkDb").options].some((o) => o.value === d.db_id)) return false; // an upload that has since expired
  $("checkDb").value = d.db_id;
  showSchema("checkSchema", d.db_id);
  $("sql").value = d.sql;
  activePreset = e.preset || null;
  renderPresets();
  session.shownCheck = e.id;
  renderCheck(d, scroll);
  setCheckStatus("");
  return true;
}
function restoreSession() {
  if (!SESSION_KEY) return;
  let data = null;
  try { data = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { data = null; }
  if (!data || !Array.isArray(data.flights)) return;
  session.seq = data.seq || 0;
  session.checks = Array.isArray(data.checks) ? data.checks : [];
  quiet = true;
  try {
    for (const f of data.flights) {
      const card = newRun(f.m.question || "Test flight", dbLabel(f.m.db_id || ""));
      fillReply(card, f.m, f.secs);
      session.flights.push({ ...f, card });
    }
    for (const run of $("runs").querySelectorAll(".run.done")) { run.classList.add("collapsed"); run.querySelector(".head").setAttribute("aria-expanded", "false"); }
  } catch { /* a stored entry from an older page version: show what restored */ } finally { quiet = false; }
  renderLog();
}
// The newest check comes back once the database list (and so its select option) exists.
function restoreCheck() {
  const last = session.checks[session.checks.length - 1];
  if (last && !$("checkOut").children.length && !$("sql").value.trim()) { quiet = true; try { showCheck(last, false); } catch { /* skip */ } finally { quiet = false; } }
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
    const card = (pending && pending.card) || newRun(m.question || "Test flight", dbLabel(m.db_id || ""));
    if (pending && !pending.question && m.question) card.title(m.question, dbLabel(m.db_id || "")); // picked up after a reload
    pending = null;
    stopClock();
    syncAsk();
    setStatus("");
    fillReply(card, m, secs);
    addFlight(m, secs, card);
    const nd = needleOf(m);
    let say = nd == null ? "Answer ready. No probe score."
      : m.calibrated === false ? `Score ${fig(nd)}, not calibrated for uploaded data.`
      : `Needle ${fig(nd)}, ${bandAt(nd).name}, ${edgeText(nd)}.`;
    if (isUpload(m.db_id) && uploader) uploader.refresh();
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
    const expired = pending && isUpload(pending.db_id) && /unknown database|upload expired/i.test(m.message || "");
    const message = expired ? "Your uploaded data expired. Upload it again on the Check a query tab." : m.message;
    if (expired && uploader) uploader.refresh();
    pending = null;
    stopClock();
    syncAsk();
    if (card) card.fail(message);
    else setStatus(message, "", true);
    announce(message);
  }
}

function setLink(up) {
  $("radio").classList.toggle("on", !up);
  $("link").textContent = up ? "Local link" : "No link";
  $("link").classList.remove("wait");
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
    if ($("status").classList.contains("err")) setStatus(""); // "No link" or a failed list load is stale now
    if (!$("db").options.length) loadDbs(); // the page loaded while the laptop was unreachable
    if (!presets.length) loadPresets();
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

// The first finding that carries a fan-out grid (POST /api/check returns one; an answer's audit does not).
const fanoutOf = (a) => ((a && a.findings) || []).map((f) => f.fanout).find((x) => x && x.grid && x.grid.cells && x.grid.cells.length) || null;

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

/* One counted row and its joined copies, from the check's fan-out grid (real ids): the row the grid is
   anchored on, or its first row. Returns {node, cells, n} or null. */
function fanRow(fo) {
  const g = fo && fo.grid;
  if (!g || !g.cells || !g.cells.length) return null;
  const rows = g.rows.map(String);
  let r = g.anchor != null ? rows.indexOf(String(g.anchor)) : 0;
  if (r < 0) r = 0;
  const cells = g.cells.filter((c) => c[0] === r);
  if (!cells.length) return null;
  const node = el("div", "fan");
  const L = fo.left || {}, R = fo.right || {};
  node.append(el("span", "fcap", `${L.table || "row"} ${rows[r]} joins ${cells.length} ${R.table || "rows"} ${cells.length === 1 ? "row" : "rows"}${g.sampled ? ` (${fmtInt(fo.joined_rows)} joined rows in all)` : ""}`));
  const row = el("div", "frow");
  row.append(el("span", "src", rows[r]));
  const boxes = cells.map((c, i) => {
    const b = el("i", "fc " + (i ? "dup" : "keep"));
    b.title = `${R.table || ""} ${g.cols[c[1]]}${c[2] > 1 ? ` ×${c[2]}` : ""}`;
    row.append(b);
    return b;
  });
  node.append(row);
  return { node, cells: boxes, n: cells.length, measure: () => {
    const x0 = boxes[0].offsetLeft;
    boxes.forEach((b) => b.style.setProperty("--dx", `${(x0 - b.offsetLeft).toFixed(1)}px`));
  } };
}

/* Struck as-written figure, corrected figure, and how far off it was. With a fan-out grid: the copies fan out
   while the figure as written climbs, collapse back to one while the corrected figure counts down, then the
   strike. Animates once when attached. */
function ledger(h, fo) {
  const box = el("div", "ledger");
  if (Math.max(h.before_text.length, h.after_text.length) > 6) box.classList.add("long");
  const was = el("div", "col");
  const wasFig = el("span", "fig was", h.before_text);
  was.append(el("span", "lab", "As written"), wasFig);
  const now = el("div", "col");
  const nowFig = el("span", "fig now", h.after_text);
  now.append(el("span", "lab", "Corrected"), nowFig);
  box.append(was, now);
  const rw = ratioWords(h.ratio);
  if (rw) box.append(el("span", "times", rw));
  box.append(el("span", "what", h.row ? `${h.column} for ${h.row}` : h.column));
  const fan = fanRow(fo);
  if (fan) box.append(fan.node);
  const nb = numberText(h.before_text), na = numberText(h.after_text);
  const anim = !REDUCED();
  const timers = [];
  const at = (ms, fn) => (anim ? timers.push(setTimeout(fn, ms)) : fn());
  // schedule (ms after attach)
  // compressed so the corrected figure is on screen by ~0.8 s and the strike lands by ~1.4 s
  const stag = fan ? Math.min(40, 360 / fan.n) : 0;
  const fanEnd = fan ? 120 + (fan.n - 1) * stag + 220 : 0;
  const T = fan
    ? { climb: 120, climbMs: Math.max(300, fanEnd - 120), collapse: fanEnd + 120, down: fanEnd + 120, once: fanEnd + 520, strike: fanEnd + 600, times: fanEnd + 800 }
    : { climb: 80, climbMs: 380, collapse: 0, down: 500, once: 0, strike: 950, times: 1150 };
  if (anim && nb) wasFig.textContent = nb.fmt(0);
  if (anim && nb && na) nowFig.textContent = nb.fmt(nb.v);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (fan) {
      fan.measure();
      fan.cells.forEach((c, i) => at(120 + i * stag, () => c.classList.add("on")));
      at(T.collapse, () => fan.node.classList.add("collapse"));
      at(T.once, () => { fan.node.classList.remove("collapse"); fan.node.classList.add("once"); });
    }
    if (anim && nb) at(T.climb, () => { wasFig.classList.add("live"); tween(0, nb.v, T.climbMs, (x) => { wasFig.textContent = nb.fmt(x); }, () => { wasFig.classList.remove("live"); wasFig.textContent = h.before_text; }); });
    at(T.down, () => {
      box.classList.add("entered");
      if (anim && nb && na) { nowFig.classList.add("live"); tween(nb.v, na.v, 480, (x) => { nowFig.textContent = na.fmt(x); }, () => { nowFig.classList.remove("live"); nowFig.textContent = h.after_text; }); }
    });
    at(T.strike, () => box.classList.add("struck"));
    at(T.times, () => box.classList.add("rated"));
  }));
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

/* Copy text. Plain http on the router has no async clipboard, so fall back to execCommand. Resolves true/false. */
function copyText(text) {
  const legacy = () => {
    const ta = el("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    ta.style.fontSize = "16px"; // iOS zooms into a focused field under 16px
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => legacy());
  return Promise.resolve(legacy());
}
function selectNode(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  node.scrollIntoView({ block: "nearest" });
}
/* An outline button that copies getText(); when no copy path works, onFail(row) selects the text for the
   phone's own Copy menu and returns true (false: nothing to select). */
function copyButton(label, getText, onFail) {
  const row = el("div", "fixrow");
  const btn = el("button", "copy outline", label);
  btn.type = "button";
  const said = el("span", "copied");
  said.setAttribute("aria-live", "polite");
  const done = (text) => {
    said.textContent = text;
    said.classList.remove("on");
    void said.offsetWidth; // restart the fade on a second tap
    said.classList.add("on");
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { said.textContent = ""; said.classList.remove("on"); }, 2500);
  };
  const fallback = onFail || ((r) => {
    let pre = r.nextElementSibling;
    if (!pre || !pre.classList.contains("copytext")) { pre = el("pre", "sql copytext"); r.after(pre); }
    pre.textContent = getText();
    selectNode(pre);
    return true;
  });
  btn.addEventListener("click", () => {
    copyText(getText()).then((ok) => done(ok ? "Copied" : fallback(row) ? "Selected. Use your Copy menu." : "Copy failed."));
  });
  row.append(btn, said);
  return row;
}

/* Copy the corrected SQL; if the clipboard is out of reach, open the rewrite (or the diff) and select its SQL. */
function copyFixButton(c, det) {
  return copyButton("Copy corrected SQL", () => c.sql, (row) => {
    let pre;
    if (det && det.isConnected) { det.open = true; pre = det.querySelector("pre"); }
    else pre = (row.closest(".sheet, .audit") || document).querySelector(".sd-after .sd-code");
    if (!pre) return false;
    selectNode(pre);
    return true;
  });
}

// The SQL diff shows the corrected query in full, so the rewrite disclosure and the highlighted copy are left out.
const hasDiff = (c) => !!(window.SqlDiff && c && c.sql && !c.error);

/* Explanation, "was this intended?" note, copy button. Returns [nodes, rewrite <details> or null]. */
function fixParts(a) {
  const nodes = [el("p", "explain", a.explanation || a.message)];
  if (a.intended) nodes.push(el("p", "intended", a.intended));
  const c = a.corrected;
  const det = c ? rewriteBlock(c) : null;
  if (c && !c.error) nodes.push(copyFixButton(c, det));
  return [nodes, det];
}

/* Join map (which JOIN repeats the counted rows), then the SQL diff against the corrected query. Every flagged
   result gets one, between the struck figure and the long SQL. The map is redrawn when the width changes. */
const maps = new Set(); // {draw}
function mapAndDiff(db_id, check) {
  const wrap = el("div", "mapdiff");
  const box = el("div", "jmbox");
  wrap.append(box);
  let schema = null, w = 0;
  const entry = {};
  entry.draw = (animate) => {
    if (!box.isConnected) { maps.delete(entry); return; }
    const cw = box.clientWidth;
    if (!cw || (!animate && cw === w)) return;
    w = cw;
    JoinMap.render(box, schema, check, { sql: check.sql, width: cw, animate });
  };
  if (window.JoinMap) fetchSchema(db_id).then((s) => {
    schema = s;
    maps.add(entry);
    requestAnimationFrame(() => {
      entry.draw(true);
      if (w || !window.ResizeObserver) return;
      const ro = new ResizeObserver(() => { if (!box.isConnected) { ro.disconnect(); return; } if (box.clientWidth) { ro.disconnect(); entry.draw(true); } });
      ro.observe(box);
    });
  });
  const c = check.corrected;
  if (window.SqlDiff && c && c.sql) {
    const d = el("div", "diffbox");
    SqlDiff.render(d, check.sql, c.sql, { copy: false });
    wrap.append(d);
  }
  return wrap;
}
let mapsT = null;
addEventListener("resize", () => { clearTimeout(mapsT); mapsT = setTimeout(() => maps.forEach((m) => m.draw(false)), 150); });

/* Audit block inside an answer (only when flagged). */
function renderAudit(a, r) {
  const sec = el("section", "audit");
  sec.append(el("h2", null, "Double counting"));
  if (a.headline && a.corrected) sec.append(ledger(a.headline, fanoutOf(a)));
  if (r && r.sql) sec.append(mapAndDiff(r.db_id, { ...a, sql: r.sql, flagged: true }));
  const [nodes, det] = fixParts(a);
  sec.append(...nodes);
  if (!a.corrected) sec.append(el("p", "note", "No automatic rewrite for this query."));
  else if (det && !hasDiff(a.corrected)) sec.append(det);
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

function renderCheck(d, scroll = true) {
  const o = d.original || {};
  const sheet = el("article", "sheet");
  let kind, title, sub;
  if (o.error) { kind = "error"; title = "Query does not run"; sub = o.error; }
  else if (d.flagged) { kind = "flagged"; title = "Double counting"; sub = dbLabel(d.db_id); }
  else if (!d.audited) { kind = "clear"; title = "Nothing to check"; sub = "No JOIN feeds a SUM, AVG or COUNT, so nothing can be double counted."; }
  else if (d.audit_error) { kind = "error"; title = "Audit incomplete"; sub = d.audit_error; }
  else { kind = "clear"; title = "No double counting found"; sub = "No JOIN repeats a counted row. Other mistakes are not checked."; }
  const top = el("section", "v-" + kind);
  const vh = el("div", "verdict");
  vh.append(el("h3", null, title), el("p", null, sub));
  top.append(vh);
  if (d.flagged && d.headline && d.corrected) top.append(ledger(d.headline, fanoutOf(d)));
  let det = null;
  if (d.flagged) {
    const [nodes, rw] = fixParts(d);
    top.append(...nodes);
    det = rw;
  }
  sheet.append(top);
  if (d.flagged && d.sql) {
    const md = el("section");
    md.append(mapAndDiff(d.db_id, d));
    sheet.append(md);
  }

  const items = [];
  const nrows = o.rows ? o.rows.length : 0;
  items.push([`Runs on ${isUpload(d.db_id) ? "your data" : d.db_id}`, o.error ? "No" : `${rowCount(nrows, o.rows_capped, nrows)}, ${fmtSeconds(o.seconds)}`, o.error ? "bad" : null]);
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
  const diffed = d.flagged && hasDiff(d.corrected);
  if (diffed) { // the diff above already shows both queries: keep only what the query returned as written
    if (!o.error && o.rows) {
      body.append(el("p", "tag", "Result as written"));
      if (o.rows.length === 1 && o.rows[0].length === 1) {
        const p = el("p", "ans");
        p.append(el("b", null, fmtCell(o.rows[0][0])));
        body.append(p);
      } else if (o.rows.length) body.append(resultTable(o.columns, o.rows, 5));
      body.append(el("p", "count", rowCount(o.rows.length, o.rows_capped, 5)));
    }
  } else {
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
  }
  if (body.children.length) sheet.append(body);
  $("checkOut").replaceChildren(sheet);
  if (scroll) requestAnimationFrame(() => sheet.scrollIntoView({ block: "start", behavior: smoothScroll() }));
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
      showSchema("checkSchema", p.db_id);
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
    renderLog(); // checks of a preset are listed by its question
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
  $("sql").blur(); // drop the phone keyboard so the verdict has the screen
  try {
    const r = await apiCall("/api/check", body);
    checkBusy(false);
    if (isUpload(db_id) && uploader) uploader.refresh(); // the server TTL restarts on every use
    if ($("sql").value.trim() !== sql || $("checkDb").value !== db_id) { setCheckStatus(""); return; } // a preset or the database changed meanwhile
    if (!r.ok) {
      const gone = isUpload(db_id) && /unknown database|upload/i.test((r.data && r.data.error) || "");
      setCheckStatus(gone ? "Your uploaded data expired. Upload it again." : (r.data && r.data.error) || `Check failed (HTTP ${r.status}).`);
      $("checkOut").replaceChildren();
      return;
    }
    setCheckStatus(""); // the sheet carries the verdict and its own check time
    renderCheck(r.data);
    addCheck(r.data, body.preset || null);
    const d = r.data;
    announce(d.flagged ? `Double counting. ${d.explanation}` + (d.headline ? ` ${d.headline.before_text} becomes ${d.headline.after_text}.` : "")
      : d.original && d.original.error ? "The query does not run." : "No double counting found.");
  } catch {
    checkBusy(false);
    setCheckStatus("No link to the laptop. Try again once it reconnects.");
  }
}

/* push: a tap on a tab adds a history entry, so the phone's Back button returns to the previous tab
   instead of leaving the page. */
function setMode(mode, push) {
  const test = mode === "test";
  const was = document.body.classList.contains("test");
  document.body.classList.toggle("moved", was !== test); // only a change of tab slides the panel in
  document.body.classList.toggle("test", test);
  $("tabTest").setAttribute("aria-selected", String(test));
  $("tabCheck").setAttribute("aria-selected", String(!test));
  $("tabTest").tabIndex = test ? 0 : -1;
  $("tabCheck").tabIndex = test ? -1 : 0;
  const url = location.pathname + location.search + (test ? "#test" : "");
  if (push && was !== test) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

$("tabTest").addEventListener("click", () => setMode("test", true));
$("tabCheck").addEventListener("click", () => setMode("check", true));
addEventListener("popstate", () => setMode(location.hash === "#test" ? "test" : "check"));
// tablist keys: Left/Right/Home/End move between the two tabs
$("tabCheck").parentElement.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const toTest = e.key === "End" || (e.key !== "Home" && !document.body.classList.contains("test"));
  setMode(toTest ? "test" : "check", true);
  $(toTest ? "tabTest" : "tabCheck").focus();
});
$("checkForm").addEventListener("submit", runCheck);
$("sql").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("checkForm").requestSubmit(); } });
$("sql").addEventListener("input", () => {
  const p = presets.find((x) => x.id === activePreset);
  if (p && normSql($("sql").value) !== normSql(p.sql)) { activePreset = null; renderPresets(); }
});

/* ---------- schema of the selected database ---------- */
const schemas = new Map(); // db_id -> Promise<schema | null>
function fetchSchema(db_id) {
  if (!schemas.has(db_id)) {
    const p = fetch(`/api/schema?db_id=${encodeURIComponent(db_id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    p.then((s) => { if (!s) schemas.delete(db_id); });
    schemas.set(db_id, p);
  }
  return schemas.get(db_id);
}

function schemaTable(t) {
  const d = el("div", "t");
  const th = el("div", "th");
  th.append(el("span", "tn", t.name));
  if (t.rows != null) th.append(el("span", "rc", `${t.rows.toLocaleString("en-US")} ${t.rows === 1 ? "row" : "rows"}`));
  const cols = el("p", "cols");
  t.columns.forEach((c, i) => {
    if (i) cols.append(", ");
    const name = c.pk ? el("b", null, c.name) : document.createTextNode(c.name);
    if (!c.fk) { cols.append(name); return; }
    const link = el("span", "link"); // keep "column -> table" on one line
    link.append(name, el("span", "fk", ` → ${c.fk.split(".")[0]}`));
    cols.append(link);
  });
  d.append(th, cols);
  return d;
}

async function showSchema(boxId, db_id) {
  const box = $(boxId);
  box.dataset.db = db_id || "";
  const s = db_id ? await fetchSchema(db_id) : null;
  if (box.dataset.db !== (db_id || "")) return; // the selection changed while this one loaded
  if (!s || !s.tables) { box.hidden = true; return; }
  const n = s.tables.length;
  box.querySelector("summary").textContent = `${n} ${n === 1 ? "table" : "tables"}`;
  const list = box.querySelector(".tables");
  list.replaceChildren(...s.tables.map(schemaTable));
  list.scrollTop = 0;
  box.hidden = false;
}

$("checkDb").addEventListener("change", () => {
  const db = $("checkDb").value;
  const p = presets.find((x) => x.id === activePreset);
  if (p && p.db_id !== db) { activePreset = null; renderPresets(); }
  showSchema("checkSchema", db);
});
$("db").addEventListener("change", () => showSchema("testSchema", $("db").value));

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
  syncUploadOption();
  showSchema("checkSchema", $("checkDb").value);
  showSchema("testSchema", sel.value);
  restoreCheck();
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
  if (!ws || ws.readyState !== WebSocket.OPEN) { setStatus("No link to the laptop. Reconnecting; ask again in a moment.", "", true); retryMs = 500; connect(); return; }
  $("question").blur(); // drop the phone keyboard so the dial is in view
  store.set("altimeter.db", db_id);
  pending = { question, db_id, t0: performance.now(), phase: "sent", card: newRun(question, dbLabel(db_id)) };
  syncAsk();
  setStatus("");
  pending.card.stage("Sent", "");
  pending.card.node.scrollIntoView({ block: "nearest", behavior: smoothScroll() });
  announce("Question sent.");
  ws.send(JSON.stringify({ db_id, question }));
}

/* ---------- your own data: an upload is selectable as "Your data" in both tabs; its db_id stays on this phone ---------- */
const UPLOAD_KEY = "altimeter.upload";
let uploadDb = null;
let uploader = null;
function isUpload(d) { return typeof d === "string" && d.startsWith("upload:"); }
function dbLabel(d) { return isUpload(d) ? "Your data" : d; }
function syncUploadOption() {
  for (const id of ["checkDb", "db"]) {
    const sel = $(id);
    for (const o of [...sel.options]) if (isUpload(o.value) && o.value !== uploadDb) o.remove();
    if (uploadDb && ![...sel.options].some((o) => o.value === uploadDb)) {
      const o = el("option", null, "Your data");
      o.value = uploadDb;
      sel.prepend(o);
    }
  }
}
function onUploadReady(dbId) {
  const fresh = dbId !== store.get(UPLOAD_KEY); // a restore after reload keeps the current selection
  uploadDb = dbId;
  store.set(UPLOAD_KEY, dbId);
  schemas.delete(dbId);
  syncUploadOption();
  if (!fresh) return;
  $("checkDb").value = dbId;
  $("db").value = dbId;
  if (activePreset) { activePreset = null; $("sql").value = ""; renderPresets(); }
  $("checkOut").replaceChildren();
  setCheckStatus("");
  showSchema("checkSchema", dbId);
  showSchema("testSchema", dbId);
}
function onUploadGone(dbId) {
  if (store.get(UPLOAD_KEY) === dbId) store.del(UPLOAD_KEY);
  if (uploadDb !== dbId) return;
  uploadDb = null;
  schemas.delete(dbId);
  const inCheck = $("checkDb").value === dbId, inTest = $("db").value === dbId;
  syncUploadOption();
  const has = (sel, v) => [...$(sel).options].some((o) => o.value === v);
  if (inCheck) {
    if (has("checkDb", "codebase_community")) $("checkDb").value = "codebase_community";
    showSchema("checkSchema", $("checkDb").value);
  }
  if (inTest) {
    if (has("db", "formula_1")) $("db").value = "formula_1";
    showSchema("testSchema", $("db").value);
  }
}
if (window.Upload) {
  uploader = Upload.render($("upload"), {
    dbId: store.get(UPLOAD_KEY) || undefined,
    onReady: onUploadReady,
    onRemove: (id) => { fetch(`/api/upload/${encodeURIComponent(id.replace(/^upload:/, ""))}`, { method: "DELETE" }).catch(() => {}); onUploadGone(id); },
    onExpire: onUploadGone,
  });
}

$("flight").addEventListener("submit", submit);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("flight").requestSubmit(); }
});
// back/forward cache: the socket was closed while the page sat in the cache
addEventListener("pageshow", (e) => { if (e.persisted) { retryMs = 500; connect(); } });

setMode(location.hash === "#test" ? "test" : "check");
if (MOCK) {
  const s = document.createElement("script");
  s.src = "mock.js";
  document.body.append(s);
} else {
  restoreSession();
  loadDbs();
  loadPresets();
  connect();
}
