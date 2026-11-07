"use strict";
// Table screen (laptop). Listens on /ws/table to every job; replays the score breakdown the worker computed
// (result.explain) before swinging the needle. Every number shown comes from the payload; missing ones are [TBD].

const BANDS = [ // same edges as app.js
  { key: "ask", name: "Ask", from: 0, to: 0.5 },
  { key: "caution", name: "Caution", from: 0.5, to: 0.8 },
  { key: "cruise", name: "Cruise", from: 0.8, to: 1 },
];
const SHOW_ROWS = 5;
const POSITION = { last_prompt: "last prompt token", last_gen: "last generated token", mean_gen: "mean over generated SQL tokens" };
const GROUP_NOTE = {
  "Internals": (f) => `probe ${fx(f.probe, 2)}`,
  "Token confidence": (f) => `mean ${fx(f.logprob_mean, 2)} · min ${fx(f.logprob_min, 2)}`,
  "Size": (f) => `${f.question_chars} + ${f.sql_chars} chars · ${f.n_joins} joins`,
  "Compiles": (f) => (f.executes == null ? "" : f.executes > 0.5 ? "compiles" : "does not compile"),
};
// Replay schedule, ms after the result is shown.
const T = { z: 300, p: 1400, platt: 2400, ref: 3300, group0: 4000, groupGap: 750, total: 7200, swing: 7800, done: 9100 };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fx = (v, d) => (v == null || !Number.isFinite(Number(v)) ? "[TBD]" : Number(v).toFixed(d));
const sx = (v, d) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const minus = (s) => s.replace(/^-/, "−");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let timers = [];
let playing = false;
let deferred = null;
let clock = null;
let workingSince = null;
let lastShown = null;
let currentJob = null;

/* ---------- gauge (same geometry as the phone) ---------- */
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
const bandOf = (s) => BANDS.find((b) => s < b.to) || BANDS[BANDS.length - 1];
const bandInk = (key) => (key === "caution" ? "var(--caution-ink)" : `var(--${key})`);

function parkCarriage() {
  const c = $("carriage");
  c.classList.add("snap");
  c.style.transform = "translateX(0)";
  void c.offsetWidth;
  c.classList.remove("snap");
}

function setGauge(score, mode) {
  const band = $("band");
  band.style.color = "";
  band.className = "";
  if (mode === "hold") {
    parkCarriage();
    $("value").textContent = "--";
    band.textContent = "Awaiting probe";
    band.className = "awaiting";
    $("tape").classList.remove("scored");
    $("needle").className = "needle hold";
    return;
  }
  if (score == null || Number.isNaN(score)) {
    $("value").textContent = "--";
    band.textContent = mode === "noprobe" ? "No probe" : "No reading";
    $("tape").classList.remove("scored");
    $("needle").className = "needle";
    return;
  }
  const s = Math.min(1, Math.max(0, score));
  const b = bandOf(s);
  $("value").textContent = s.toFixed(2);
  band.textContent = b.name;
  band.style.color = bandInk(b.key);
  $("tape").classList.add("scored");
  $("needle").className = "needle on";
  $("carriage").style.transform = `translateX(${(s * 100).toFixed(2)}%)`;
}

function needleOf(r) {
  if (!r || r.probe == null) return null;
  const v = typeof r.probe === "object" ? Number(r.probe.needle) : Number(r.probe);
  return Number.isFinite(v) ? v : null;
}

/* ---------- answer ---------- */
function resultTable(columns, rows) {
  const t = el("table");
  const hr = el("tr");
  for (const c of columns || []) hr.append(el("th", null, c));
  const th = el("thead");
  th.append(hr);
  const tb = el("tbody");
  for (const row of rows.slice(0, SHOW_ROWS)) {
    const tr = el("tr");
    for (const v of row) tr.append(v == null ? el("td", "null", "null") : el("td", null, String(v)));
    tb.append(tr);
  }
  t.append(th, tb);
  return t;
}

function renderQuestion(db_id, question) {
  const a = $("answer");
  a.replaceChildren(el("h2", null, question), el("p", "route", `${db_id} · local`));
  return a;
}

function renderAnswer(r) {
  const a = renderQuestion(r.db_id, r.question);
  a.querySelector(".route").textContent = `${r.db_id} · local${r.fake ? " · fake worker" : ""} · generated in ${fx(r.gen_seconds, 2)} s`;
  a.append(el("pre", "sql", r.sql || "(no SQL generated)"));
  if (r.error) a.append(el("p", "err", r.timed_out ? `Timed out: ${r.error}` : r.error));
  else if (r.rows) {
    if (r.rows.length) a.append(resultTable(r.columns, r.rows));
    const n = r.rows.length;
    let s = r.rows_capped ? `First ${n} rows (capped)` : `${n} ${n === 1 ? "row" : "rows"}`;
    if (n > SHOW_ROWS) s += `, showing ${SHOW_ROWS}`;
    a.append(el("p", "count", s));
  }
}

function setProbeLine(r) {
  const p = r && r.probe;
  $("probeline").replaceChildren();
  if (!p || typeof p !== "object") { $("probeline").textContent = r ? "No probe loaded" : ""; return; }
  if (r.explain && r.explain.synthetic) $("probeline").append(el("span", "synth", "Synthetic test probe: random weights, not evidence"), " · ");
  const bits = [`Probe on layer ${p.layer}`, POSITION[p.position] || p.position];
  bits.push(p.n_train != null ? `trained on ${p.n_train}` : "trained on [TBD]");
  bits.push(`BIRD AUROC ${fx(p.bird_probe_auroc, 3)}`);
  $("probeline").append(bits.join(" · "));
}

/* ---------- explanation ---------- */
function verdictBlock(ex) {
  const wrap = el("div");
  wrap.append(el("h3", null, "Probe verdict"));
  const v = el("div", "verdict");
  const z = el("div", "step");
  z.dataset.t = T.z;
  z.append(el("b", null, minus(ex.z.toFixed(2))),
    el("small", null, `z = b0 + Σ wᵢ(hᵢ − μᵢ) over ${ex.d} dimensions of layer ${ex.layer}, ${POSITION[ex.position] || ex.position}`));
  const arrow = el("div", "step arrow", "sigmoid →");
  arrow.dataset.t = T.p;
  const p = el("div", "step");
  p.dataset.t = T.p;
  p.append(el("b", null, ex.p_raw.toFixed(2)), el("small", null, "raw probe: uncalibrated chance the SQL is right"));
  v.append(z, arrow, p);
  const platt = el("p", "step platt",
    `Platt-calibrated: ${ex.p_cal.toFixed(2)} (a ${minus(ex.platt_a.toFixed(2))}, b ${minus(ex.platt_b.toFixed(2))}). The stack below takes the raw value.`);
  platt.dataset.t = T.platt;
  wrap.append(v, platt);
  return wrap;
}

function waterfall(ex) {
  const wrap = el("div");
  wrap.append(el("h3", null, "What moved the needle"));
  const feats = Object.fromEntries((ex.features || []).map((f) => [f.name, f.value]));
  const cum = [ex.stack_ref];
  for (const g of ex.groups) cum.push(cum[cum.length - 1] + g.value);
  const pts = [0, ...cum, ex.logit];
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = Math.max((hi - lo) * 0.08, 0.25);
  lo -= pad; hi += pad;
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;

  const wf = el("div", "wf");
  const row = (label, note, val, t) => {
    const r = el("div", "wrow step");
    r.dataset.t = t;
    const lab = el("div", "lab", label);
    if (note) lab.append(el("small", null, note));
    const track = el("div", "track");
    r.append(lab, track, el("div", "val", val));
    wf.append(r);
    return track;
  };
  const ref = row("Average question", "reference: stack intercept", minus(ex.stack_ref.toFixed(2)), T.ref);
  const m = el("i", "mark ref");
  m.style.left = pct(ex.stack_ref) + "%";
  ref.append(m);
  ex.groups.forEach((g, k) => {
    const t = T.group0 + k * T.groupGap;
    const track = row(g.name, GROUP_NOTE[g.name] ? GROUP_NOTE[g.name](feats) : "", sx(g.value, 2), t);
    const a = cum[k], b = cum[k + 1];
    const bar = el("i", "bar " + (g.value >= 0 ? "up" : "down"));
    bar.style.left = pct(Math.min(a, b)) + "%";
    bar.style.width = `max(3px, ${pct(Math.max(a, b)) - pct(Math.min(a, b))}%)`;
    bar.dataset.t = t + 60;
    track.append(bar);
  });
  const tot = row("Needle logit", "sum of the rows above", minus(ex.logit.toFixed(2)), T.total);
  const tm = el("i", "mark");
  tm.style.left = pct(ex.logit) + "%";
  tot.append(tm);

  const zero = el("i", "zero");
  zero.style.left = `calc(10.3rem + (100% - 10.3rem - 5.4rem) * ${pct(0) / 100})`;
  wf.append(zero);
  const axis = el("div", "axis");
  const scale = el("div", "scale");
  const step = hi - lo > 8 ? 2 : hi - lo > 3 ? 1 : 0.5;
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    const tick = el("i");
    tick.style.left = pct(v) + "%";
    const lbl = el("span", null, Math.abs(v) < 1e-9 ? "0" : minus(String(+v.toFixed(1))));
    lbl.style.left = pct(v) + "%";
    scale.append(tick, lbl);
  }
  axis.append(el("span"), scale, el("span"));
  wf.append(axis);
  wrap.append(wf);

  const key = el("p", "key");
  key.append(el("span", "k-up", "raises the needle"), el("span", "k-down", "lowers it"), el("span", "k-zero", "logit 0 = needle 0.50"));
  wrap.append(key, el("p", "cap", "log-odds relative to an average training question"));
  const total = el("p", "step wf-total",
    `${minus(ex.stack_ref.toFixed(2))} ${ex.groups.map((g) => sx(g.value, 2).replace(/^([+−])/, "$1 ")).join(" ")} = ${minus(ex.logit.toFixed(2))} → sigmoid → needle ${ex.needle.toFixed(2)}`);
  total.dataset.t = T.swing;
  wrap.append(total);
  return wrap;
}

function recordBlock(ex, r) {
  const ul = el("ul", "record");
  const tr = ex.track_record || {};
  const rate = tr.ask_band_wrong_rate;
  const n = tr.n;
  ul.append(el("li", null, `In the Ask band, the SQL was wrong ${rate == null ? "[TBD]" : Math.round(rate * 100) + "%"} of the time (n=${n == null ? "[TBD]" : n}).`));
  ul.append(el("li", null, `Expected calibration error: ${fx(ex.ece, 3)}.`));
  ul.append(el("li", null, `Breakdown computed in ${fx(ex.ms, 1)} ms, before the SQL ran.`));
  return ul;
}

function renderExplain(r) {
  const col = $("excol");
  col.replaceChildren();
  const ex = r.explain;
  if (!ex) {
    const msg = r.probe == null ? "No probe loaded, so there is no score to break down." : "This result carries no breakdown.";
    col.append(el("p", "noex", msg));
    return false;
  }
  col.append(verdictBlock(ex), waterfall(ex), recordBlock(ex, r));
  return true;
}

/* ---------- how ---------- */
function rampColor(t) { // sequential, one hue: paper-2 (#e8e2d5) -> --up (#25639e)
  const a = [0xe8, 0xe2, 0xd5], b = [0x25, 0x63, 0x9e];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * Math.min(1, Math.max(0, t))));
  return `rgb(${c.join(",")})`;
}

function renderHow(ex) {
  const col = $("howcol");
  col.replaceChildren();
  if (!ex) { col.append(el("p", "noex", "Nothing to show until a scored answer arrives.")); return; }
  const nL = ex.n_layers;
  const au = new Map((ex.layer_auroc || []).map((x) => [x.layer, x.auroc]));
  const vals = [...au.values()];
  const lo = 0.5, hi = vals.length ? Math.max(0.5001, ...vals) : 1;

  const a = el("div");
  a.append(el("h3", null, `Layer stack: embedding + ${nL} transformer layers`));
  const strip = el("div", "layers");
  for (let L = 0; L <= nL; L++) {
    const c = el("span", L === ex.layer ? "used" : null);
    if (au.has(L)) c.style.background = rampColor((au.get(L) - lo) / (hi - lo));
    c.title = `${L === 0 ? "Embedding" : "Layer " + L}: ${au.has(L) ? "AUROC " + au.get(L).toFixed(3) : "not measured"}${L === ex.layer ? ", used" : ", not used"}`;
    strip.append(c);
  }
  const labels = el("div", "layer-labels");
  const left = el("span", null, "Embedding (index 0) · not used");
  left.style.left = "0";
  const right = el("span", null, `Layer ${nL} · not used`);
  right.style.right = "0";
  const used = el("span", "used", `Layer ${ex.layer} · used${au.has(ex.layer) ? " · AUROC " + au.get(ex.layer).toFixed(3) : ""}`);
  used.style.left = `${((ex.layer + 0.5) / (nL + 1)) * 100}%`;
  labels.append(left, right, used);
  a.append(strip, labels);
  if (vals.length) {
    const lg = el("div", "legend");
    lg.append(el("span", null, "AUROC 0.50"));
    for (let i = 0; i <= 4; i++) { const sw = el("i"); sw.style.background = rampColor(i / 4); lg.append(sw); }
    lg.append(el("span", null, `${hi.toFixed(2)} · plain cells: not measured`));
    a.append(lg, el("p", "cap", "how well each layer separates right from wrong on Spider; same for every question"));
  } else {
    a.append(el("p", "cap", "Per-layer AUROC on Spider: [TBD]"));
  }
  a.append(el("p", "cap", `Every layer except ${ex.layer}: not used by this probe.`));

  const b = el("div");
  b.append(el("h3", null, `Top ${ex.dims.length} of ${ex.d} dimensions`));
  const maxAbs = Math.max(1e-12, ...ex.dims.map((d) => Math.abs(d[1])));
  const list = el("div", "dims");
  for (const [i, c] of ex.dims) {
    const row = el("div", "drow");
    const tr = el("div", "dtrack");
    const bar = el("i", "dbar " + (c >= 0 ? "up" : "down"));
    const w = (Math.abs(c) / maxAbs) * 50;
    bar.style.width = w + "%";
    bar.style.left = c >= 0 ? "50%" : 50 - w + "%";
    tr.append(bar);
    row.append(el("span", null, `#${i}`), tr, el("span", "v", sx(c, 3)));
    list.append(row);
  }
  b.append(list);
  const topSum = ex.dims.reduce((s, d) => s + d[1], 0);
  b.append(el("p", "dsum",
    `b0 ${minus(ex.b0.toFixed(3))}  ${sx(topSum, 3)} (top ${ex.dims.length})  ${sx(ex.rest, 3)} (other ${ex.d - ex.dims.length})  = z ${minus(ex.z.toFixed(3))} → sigmoid → raw probe ${ex.p_raw.toFixed(2)}`));
  b.append(el("p", "dsum", `Top 20 cover ${(ex.share_top20 * 100).toFixed(1)}% of the total |contribution|.`));
  b.append(el("p", "cap", "contribution of each raw dimension to this score; individual dimensions have no known meaning"));
  if (!ex.centered) b.append(el("p", "cap", "Probe file has no mean vector: contributions are wᵢhᵢ, uncentered."));
  col.append(a, b);
}

/* ---------- replay ---------- */
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function later(ms, fn) { timers.push(setTimeout(fn, reduced() ? 0 : ms)); }

function play(r, animate) {
  clearTimers();
  stopClock();
  lastShown = r;
  setProbeLine(r);
  renderAnswer(r);
  const has = renderExplain(r);
  renderHow(r.explain);
  const nd = needleOf(r);
  if (!has || !animate) {
    for (const n of document.querySelectorAll("#excol .step, #excol .bar")) n.classList.add("on");
    setGauge(nd, "noprobe");
    $("status").textContent = has ? "Score computed before the SQL ran." : nd == null ? "Probe not loaded." : "";
    playing = false;
    return;
  }
  playing = true;
  setHow(false); // a new answer replays in the explanation column
  setGauge(null, "hold");
  $("status").textContent = "Score computed before the SQL ran. Replaying its breakdown.";
  for (const n of document.querySelectorAll("#excol .step, #excol .bar")) later(Number(n.dataset.t || 0), () => n.classList.add("on"));
  later(T.swing, () => setGauge(nd, "noprobe"));
  later(T.done, () => {
    playing = false;
    $("status").textContent = "Score computed before the SQL ran.";
    if (deferred) { const d = deferred; deferred = null; play(d, true); }
  });
}

function showWorking(job) {
  if (playing) return; // the queue line shows it; the replay finishes first
  clearTimers();
  setHow(false);
  renderQuestion(job.db_id, job.question).append(el("pre", "sql", "Generating SQL"));
  $("excol").replaceChildren(el("p", "noex", "Awaiting probe."));
  renderHow(null);
  setGauge(null, "hold");
  workingSince = performance.now();
  stopClock();
  const draw = () => { $("status").textContent = `Generating SQL · ${((performance.now() - workingSince) / 1000).toFixed(1)} s`; };
  draw();
  clock = setInterval(draw, 100);
}
function stopClock() { if (clock) clearInterval(clock); clock = null; }

/* ---------- queue footer ---------- */
function setQueue(current, queue) {
  $("now").textContent = current ? `Answering: ${current.db_id} · ${current.question}` : "Idle";
  const q = queue || [];
  $("queue").textContent = q.length ? `Waiting ${q.length}: ` + q.map((j) => `${j.db_id} · ${j.question}`).join("   |   ") : "Queue empty";
}

/* ---------- socket ---------- */
let ws = null;
let retryMs = 500;
let retryTimer = null;

function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "snapshot") {
    currentJob = m.current;
    setQueue(m.current, m.queue);
    if (m.last && m.last.type === "result") play(m.last, false);
    if (m.current) showWorking(m.current);
    return;
  }
  if (m.type === "queued") setQueue(currentJob, m.queue);
  else if (m.type === "working") { currentJob = m.job; setQueue(m.job, m.queue); showWorking(m.job); }
  else if (m.type === "result") {
    currentJob = null;
    setQueue(null, m.queue);
    if (playing) deferred = m; else play(m, true);
  } else if (m.type === "error") {
    currentJob = null;
    setQueue(null, m.queue);
    if (!playing) {
      stopClock();
      setGauge(null);
      renderQuestion(m.job.db_id, m.job.question).append(el("p", "err", m.message));
      $("status").textContent = "The worker failed on this question.";
    }
  }
}

function setLink(up) {
  $("link").textContent = up ? "Live" : "No link to gateway";
  $("link").classList.toggle("down", !up);
}

function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/table`);
  ws.onopen = () => { retryMs = 500; setLink(true); };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    setLink(false);
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 4000);
  };
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { retryMs = 500; connect(); } });

/* ---------- How toggle ---------- */
function setHow(on) {
  document.body.classList.toggle("how", on);
  $("howbtn").setAttribute("aria-pressed", String(on));
}
$("howbtn").addEventListener("click", () => setHow(!document.body.classList.contains("how")));
document.addEventListener("keydown", (e) => { if (e.key === "h" && !e.ctrlKey && !e.metaKey && !e.altKey) setHow(!document.body.classList.contains("how")); });

buildTape();
setGauge(null);
setQueue(null, []);
renderHow(null);
$("excol").append(el("p", "noex", `Ask from a phone at ${location.host}. Each answer's score breakdown replays here.`));
renderQuestion("", "No question yet").querySelector(".route").textContent = "";
setHow(new URLSearchParams(location.search).get("how") === "1");
connect();
