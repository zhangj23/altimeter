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
// Replay schedule, ms after the result is shown. The needle sweeps at T.swing; the whole replay is done by T.done.
const T = { z: 150, p: 600, ref: 950, group0: 1200, groupGap: 280, total: 2250, swing: 2400, done: 3600 };

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
function buildTape(ticks = "ticks", bands = "bands", names = "names") {
  for (let i = 0; i <= 10; i++) {
    const t = el("span");
    t.style.left = `calc(${i * 10}% - ${i === 10 ? 1 : 0}px)`;
    $(ticks).append(t);
  }
  for (const b of BANDS) {
    const w = (b.to - b.from) * 100 + "%";
    const seg = el("span", "b-" + b.key);
    seg.style.width = w;
    $(bands).append(seg);
    const name = el("span", null, b.name);
    name.style.width = w;
    $(names).append(name);
  }
}
const bandOf = (s) => BANDS.find((b) => s < b.to) || BANDS[BANDS.length - 1];
const bandInk = (key) => `var(--${key})`;

/* ---------- motion primitives: every value they move comes from the payload ---------- */
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function tween(from, to, ms, onFrame, onDone, ease = easeOut) { // one rAF loop; reduced motion jumps to the end
  if (reduced() || ms <= 0 || from === to) { onFrame(to, 1); if (onDone) onDone(); return () => {}; }
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms);
    onFrame(from + (to - from) * ease(u), u);
    if (u < 1) raf = requestAnimationFrame(step); else if (onDone) onDone();
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
// Damped spring: stiffness 70, damping ratio 0.72 (one small overshoot of ~4%, then it settles). Semi-implicit Euler.
function spring(from, to, onFrame, onDone) {
  if (reduced() || from === to) { onFrame(to); if (onDone) onDone(); return () => {}; }
  const k = 70, c = 2 * 0.72 * Math.sqrt(k);
  let x = from, v = 0, last = performance.now(), raf = 0;
  const step = (now) => {
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (let n = 0; n < 4; n++) { // sub-steps keep it stable at any frame rate
      const h = dt / 4;
      v += (-k * (x - to) - c * v) * h;
      x += v * h;
    }
    if (Math.abs(x - to) < 0.0005 && Math.abs(v) < 0.002) { onFrame(to); if (onDone) onDone(); return; }
    onFrame(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
const lightTicks = (ticksEl, s) => { // ticks up to the needle are lit
  const ticks = ticksEl.children;
  for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle("lit", s != null && i * 0.1 <= s + 1e-9);
};

/* ---------- gauge (same geometry as the phone); one object per tape so each view keeps its own state ---------- */
function makeGauge(ids) {
  const g = { score: null, mode: "none", cancel: () => {}, pos: 0 };
  const E = () => ({ value: $(ids.value), band: $(ids.band), tape: $(ids.tape), ticks: $(ids.ticks), needle: $(ids.needle), car: $(ids.carriage) });
  const place = (s) => {
    const e = E();
    e.car.style.transform = `translateX(${(s * 100).toFixed(2)}%)`;
    lightTicks(e.ticks, s);
    g.pos = s;
    if (ids.clouds) cloudSet(cloudLevel(g.mode === "hold" || g.mode === "uncal" || g.score == null ? null : s)); // the cloud layer follows the needle
  };
  const showNumber = (s) => { const e = E(); e.value.textContent = s.toFixed(2); };
  g.apply = (score, mode, animate) => { // the single source of truth for this tape; redrawn whenever its view shows
    g.cancel();
    g.score = score; g.mode = mode;
    const e = E();
    e.band.style.color = "";
    e.band.className = "";
    const none = mode === "hold" || score == null || Number.isNaN(score);
    e.value.classList.toggle("blank", none);
    if (mode === "hold") {
      place(0);
      e.value.textContent = "--";
      e.band.textContent = "Awaiting probe";
      e.band.className = "awaiting";
      e.tape.classList.remove("scored");
      e.needle.className = "needle hold";
      return;
    }
    if (none) {
      e.value.textContent = "--";
      e.band.textContent = mode === "noprobe" ? "No probe" : "No reading";
      e.tape.classList.remove("scored");
      e.needle.className = "needle";
      lightTicks(e.ticks, null);
      return;
    }
    const s = Math.min(1, Math.max(0, score));
    const b = bandOf(s);
    const uncal = mode === "uncal"; // uploaded data: the number, no band and no band colour
    e.tape.classList.toggle("scored", !uncal);
    e.needle.className = "needle on";
    const settle = () => {
      showNumber(s);
      e.band.textContent = uncal ? (g.note || UNCAL) : b.name;
      e.band.style.color = uncal ? "var(--ink-2)" : bandInk(b.key);
      place(s);
    };
    if (!animate) { settle(); return; }
    e.band.textContent = "";
    g.running = true;
    const stop = spring(0, s, (x) => { place(x); showNumber(Math.max(0, x)); }, () => { g.running = false; settle(); }); // number counts with the sweep
    g.cancel = () => { stop(); g.running = false; };
  };
  g.sync = () => { if (!g.running) g.apply(g.score, g.mode, false); }; // a view that was hidden shows the latest reading
  return g;
}
const G = {
  main: makeGauge({ value: "value", band: "band", tape: "tape", ticks: "ticks", needle: "needle", carriage: "carriage", clouds: true }),
  ins: makeGauge({ value: "insvalue", band: "insband", tape: "instape", ticks: "insticks", needle: "insneedle", carriage: "inscarriage" }),
};
const setGauge = (score, mode, animate) => G.main.apply(score, mode, animate);
const setInsGauge = (score, mode, animate) => G.ins.apply(score, mode, animate);

const dbName = (d) => (typeof d === "string" && d.startsWith("upload:") ? "uploaded data" : d);
const UNCAL = "Needle not calibrated for uploaded data";
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
  a.replaceChildren(el("h2", null, question), el("p", "route", `${dbName(db_id)} · local`));
  return a;
}

function renderAnswer(r) {
  const a = renderQuestion(r.db_id, r.question);
  a.querySelector(".route").textContent = `${dbName(r.db_id)}${r.fake ? " · fake worker" : ""} · ${fx(r.gen_seconds, 1)} s`;
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
  if (!p || typeof p !== "object") return;
  if (r.explain && r.explain.synthetic) $("probeline").append(el("span", "synth", "Synthetic test probe: random weights, not evidence"));
}

/* ---------- explanation ---------- */
function verdictBlock(ex) {
  const wrap = el("div");
  wrap.append(el("h3", null, "Probe verdict"));
  const v = el("div", "verdict");
  const z = el("div", "step");
  z.dataset.t = T.z;
  z.append(el("b", null, minus(ex.z.toFixed(2))), el("small", null, `probe logit, layer ${ex.layer}`));
  const arrow = el("div", "step arrow", "sigmoid →");
  arrow.dataset.t = T.p;
  const p = el("div", "step");
  p.dataset.t = T.p;
  p.append(el("b", null, ex.p_raw.toFixed(2)), el("small", null, "probe alone, before stacking"));
  v.append(z, arrow, p);
  wrap.append(v);
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
  const ref = row("Baseline", "", minus(ex.stack_ref.toFixed(2)), T.ref);
  const m = el("i", "mark ref");
  m.style.left = pct(ex.stack_ref) + "%";
  ref.append(m);
  ex.groups.forEach((g, k) => {
    const t = T.group0 + k * T.groupGap;
    const track = row(g.name, "", sx(g.value, 2), t);
    const a = cum[k], b = cum[k + 1];
    const bar = el("i", "bar " + (g.value >= 0 ? "up" : "down"));
    bar.style.left = pct(Math.min(a, b)) + "%";
    bar.style.width = `max(3px, ${pct(Math.max(a, b)) - pct(Math.min(a, b))}%)`;
    bar.dataset.t = t + 60;
    track.append(bar);
  });
  // the running sum: shown from the baseline on, its value and mark move as each group lands
  const tot = row("Needle logit", "", minus(ex.stack_ref.toFixed(2)), T.ref + 120);
  const carrier = el("i", "markw");
  carrier.style.transform = `translateX(${pct(ex.stack_ref)}%)`;
  carrier.append(el("i", "mark"));
  tot.append(carrier);
  const totVal = tot.parentNode.querySelector(".val");
  // the last group finishes landing at `end`; from then on the row shows the worker's exact logit (the sum line's figure)
  const end = T.group0 + Math.max(0, ex.groups.length - 1) * T.groupGap + 60 + 380;
  wf.odometer = (t) => { // value at replay time t (ms): baseline + every group that has landed by then, partially while landing
    let s = ex.stack_ref;
    if (t >= end) s = ex.logit;
    else ex.groups.forEach((g, k) => { const u = Math.min(1, Math.max(0, (t - (T.group0 + k * T.groupGap + 60)) / 380)); s += g.value * easeOut(u); });
    totVal.textContent = minus(s.toFixed(2));
    carrier.style.transform = `translateX(${pct(s)}%)`;
  };
  wf.odometer.end = end;

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
  key.append(el("span", "k-up", "raises"), el("span", "k-down", "lowers"), el("span", "k-zero", "needle 0.50"));
  wrap.append(key);
  const total = el("p", "step wf-total",
    `${minus(ex.stack_ref.toFixed(2))} ${ex.groups.map((g) => sx(g.value, 2).replace(/^([+−])/, "$1 ")).join(" ")} = ${minus(ex.logit.toFixed(2))} → needle ${ex.needle.toFixed(2)}`);
  total.dataset.t = T.swing;
  wrap.append(total);
  wrap.odometer = wf.odometer;
  return wrap;
}
let odoStop = () => {};
function runOdometer(fn, from, to) { // drives fn(t) over replay time [from, to], always on to the last landing
  odoStop();
  if (!fn) return;
  to = Math.max(to, fn.end || 0);
  if (reduced()) { fn(to); return; }
  let raf = 0;
  const t0 = performance.now() - from;
  const step = (now) => { const t = now - t0; fn(Math.min(t, to)); if (t < to) raf = requestAnimationFrame(step); };
  raf = requestAnimationFrame(step);
  odoStop = () => cancelAnimationFrame(raf);
}

function recordBlock(ex, r) {
  const ul = el("ul", "record");
  const tr = ex.track_record || {};
  const rate = tr.ask_band_wrong_rate;
  const n = tr.n;
  const nTxt = n == null ? "[TBD]" : Number(n).toLocaleString("en-US");
  ul.append(el("li", null, `Ask band answers were wrong ${rate == null ? "[TBD]" : Math.round(rate * 100) + "%"} of the time on ${nTxt} held-out questions.`));
  return ul;
}

function renderExplain(r) {
  const col = $("excol");
  col.replaceChildren();
  const ex = r.explain;
  if (!ex) {
    col.odometer = null;
    const msg = r.probe == null ? "No probe loaded, so no score to break down." : "This result carries no breakdown.";
    col.append(el("p", "noex", msg));
    return false;
  }
  const wf = waterfall(ex);
  col.append(verdictBlock(ex), wf, recordBlock(ex, r));
  col.odometer = wf.odometer;
  return true;
}

/* ---------- how ---------- */
function rampColor(t) { // sequential, neutral: --panel-3 (#282d35) -> --ink (#e8e6e0)
  const a = [0x28, 0x2d, 0x35], b = [0xe8, 0xe6, 0xe0];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * Math.min(1, Math.max(0, t))));
  return `rgb(${c.join(",")})`;
}

// Plain words for each stack input (names from probe.stack_features).
const INPUT_WORDS = {
  probe: (ex) => `Probe score (layer ${ex.layer})`, logprob_mean: () => "Mean token log-prob", logprob_min: () => "Lowest token log-prob",
  question_chars: () => "Question length", sql_chars: () => "SQL length", n_joins: () => "JOINs", n_aggregates: () => "Aggregates",
  n_subqueries: () => "Subqueries", n_prompt: () => "Prompt tokens", n_gen: () => "SQL tokens", executes: () => "SQL compiles",
};

function stackTable(ex) { // one row per learned weight: logit = intercept + Σ contributions, exactly
  const terms = ex.stack_terms || (ex.features || []).map((f) => ({ name: f.name, value: f.value, contribution: f.contrib }));
  const hasW = terms.length && terms.every((t) => t.weight != null);
  const b0 = ex.stack_intercept != null ? ex.stack_intercept : ex.stack_ref;
  const t = el("table", "wt");
  const hr = el("tr");
  const heads = hasW ? [["Input", 0], ["Weight", 1], ["Contribution", 1], ["", 0]] : [["Input", 0], ["Contribution", 1], ["", 0]];
  for (const [h, n] of heads) hr.append(el("th", n ? "n" : null, h));
  const th = el("thead");
  th.append(hr);
  const tb = el("tbody");
  const maxAbs = Math.max(1e-9, Math.abs(b0), ...terms.map((x) => Math.abs(x.contribution)));
  const cbar = (c, cls) => {
    const trk = el("span", "ctrk" + (cls ? " " + cls : ""));
    const bar = el("i", "cbar " + (c >= 0 ? "up" : "down"));
    const w = (Math.abs(c) / maxAbs) * 50;
    bar.style.width = w + "%";
    bar.style.left = c >= 0 ? "50%" : 50 - w + "%";
    trk.append(bar);
    const td = el("td");
    td.append(trk);
    return td;
  };
  const ref = el("tr", "ref");
  ref.style.setProperty("--i", 0);
  ref.append(el("td", "lab", "Intercept"));
  if (hasW) ref.append(el("td", "n", ""));
  ref.append(el("td", "n", sx(b0, 3)), cbar(b0));
  tb.append(ref);
  let sum = b0;
  const landed = [b0]; // running sum after each row, for the odometer
  terms.forEach((x, i) => {
    const tr = el("tr");
    tr.style.setProperty("--i", i + 1);
    tr.append(el("td", "lab", (INPUT_WORDS[x.name] || (() => x.name))(ex)));
    if (hasW) tr.append(el("td", "n", sx(x.weight, 3)));
    tr.append(el("td", "n", sx(x.contribution, 3)), cbar(x.contribution));
    tb.append(tr);
    sum += x.contribution;
    landed.push(sum);
  });
  const tot = el("tr", "sum");
  tot.style.setProperty("--i", 1); // the total row is there from the start; its number and bar follow the rows
  tot.append(el("td", null, "Logit"));
  if (hasW) tot.append(el("td"));
  const sumCell = el("td", "n", minus(sum.toFixed(3)));
  const sumBar = cbar(sum, "sum");
  tot.append(sumCell, sumBar);
  tb.append(tot);
  t.append(th, tb);
  const bar = sumBar.querySelector(".cbar");
  bar.style.transition = "none";
  const ROW = 90; // ms between rows (--rowgap)
  const odometer = (ms) => { // the logit cell and its bar at cascade time ms: intercept + rows landed so far
    let s = b0;
    terms.forEach((x, i) => { s += x.contribution * easeOut(Math.min(1, Math.max(0, (ms - ((i + 1) * ROW + 90)) / 380))); });
    sumCell.textContent = minus(s.toFixed(3));
    const w = (Math.abs(s) / maxAbs) * 50;
    bar.className = "cbar " + (s >= 0 ? "up" : "down");
    bar.style.width = w + "%";
    bar.style.left = s >= 0 ? "50%" : 50 - w + "%";
    bar.style.transform = "none";
  };
  return { table: t, sum, hasW, n: terms.length, odometer, end: (terms.length + 1) * ROW + 470 };
}

// z -> sigmoid(z): the needle's last step, drawn as the curve with this answer's point on it.
function sigmoidFigure(logit, needle, caption) {
  const W = 190, H = 84, m = { l: 8, r: 8, t: 8, b: 16 };
  const X = (z) => m.l + ((z + 5) / 10) * (W - m.l - m.r);
  const Y = (p) => m.t + (1 - p) * (H - m.t - m.b);
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  svg.append(sv("line", { class: "ax", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }), sv("line", { class: "ax", x1: X(0), x2: X(0), y1: Y(0), y2: Y(1) }));
  svg.append(sv("line", { class: "half", x1: m.l, x2: W - m.r, y1: Y(0.5), y2: Y(0.5) }));
  let d = "";
  for (let z = -5; z <= 5.0001; z += 0.25) d += `${d ? "L" : "M"}${X(z).toFixed(1)},${Y(1 / (1 + Math.exp(-z))).toFixed(1)}`;
  const curve = sv("path", { class: "curve", d });
  const zc = Math.max(-5, Math.min(5, logit));
  svg.append(curve, sv("line", { class: "drop", x1: X(zc), x2: X(zc), y1: Y(0), y2: Y(needle) }),
    sv("line", { class: "drop", x1: X(0), x2: X(zc), y1: Y(needle), y2: Y(needle) }),
    sv("circle", { class: "pt", cx: X(zc), cy: Y(needle), r: 3.5 }),
    sv("text", { x: X(0) + 3, y: Y(1) + 2, "text-anchor": "start" }, "1"), sv("text", { x: X(0) + 3, y: Y(0.5) - 2 }, "0.5"),
    sv("text", { x: m.l, y: H - 2 }, "−5"), sv("text", { x: W - m.r, y: H - 2, "text-anchor": "end" }, "+5"),
    sv("text", { x: X(0), y: H - 2, "text-anchor": "middle" }, "logit"));
  const fig = el("div", "sig");
  fig.append(svg, el("p", "dsum", caption));
  fig.curve = curve;
  return fig;
}

let howStop = () => {};
function renderHow(ex, r, animate) {
  const col = $("howcol");
  howStop();
  col.replaceChildren();
  if (!ex) { col.append(el("p", "noex", "Nothing to show until a scored answer arrives.")); return; }
  const card = ex.model_card || {};
  const synthetic = !!(ex.synthetic || card.synthetic);
  const L = el("div", "how-l"), R = el("div", "how-r");

  // left: the needle's logistic regression, every weight
  L.append(el("h2", null, "How the needle is computed"));
  if (synthetic) { const route = el("p", "route"); route.append(el("span", "synth", "Synthetic test probe: random weights, not evidence")); L.append(route); }
  const st = stackTable(ex);
  const s2 = el("div", "how-block");
  const fig = sigmoidFigure(ex.logit, ex.needle,
    `logit ${minus(st.sum.toFixed(3))} → needle ${ex.needle.toFixed(2)}${Math.abs(st.sum - ex.logit) > 1e-6 ? " (worker reports logit " + minus(ex.logit.toFixed(3)) + ")" : ""}`);
  s2.append(el("h3", null, `The needle: logistic regression over ${st.n} inputs`), st.table, fig);
  L.append(s2);
  L.append(el("p", "fact", "Both stages are logistic regression: every prediction is an exact sum of weight × input. Chosen for that auditability; not compared against nonlinear models."));

  // right: the probe's weights over one layer, then the layer stack
  const pt = ex.probe_terms || {};
  const dims = pt.dims ? pt.dims.map((d) => ({ dim: d.dim, c: d.contribution })) : (ex.dims || []).map(([i, c]) => ({ dim: i, c }));
  const nD = card.probe_dims || ex.d;
  const b1 = el("div", "how-block");
  b1.append(el("h3", null, `The probe: ${Number(nD).toLocaleString("en-US")} weights over layer ${ex.layer}`));
  const maxAbs = Math.max(1e-12, ...dims.map((d) => Math.abs(d.c)));
  const list = el("div", "dims");
  for (const [di, d] of dims.entries()) {
    const rowE = el("div", "drow");
    rowE.style.setProperty("--i", di);
    const tr = el("div", "dtrack");
    const bar = el("i", "dbar " + (d.c >= 0 ? "up" : "down"));
    const w = (Math.abs(d.c) / maxAbs) * 50;
    bar.style.width = w + "%";
    bar.style.left = d.c >= 0 ? "50%" : 50 - w + "%";
    tr.append(bar);
    rowE.append(el("span", "k", `#${d.dim}`), tr, el("span", "v", sx(d.c, 3)));
    list.append(rowE);
  }
  b1.append(list);
  const topSum = dims.reduce((s, d) => s + d.c, 0);
  const rest = pt.rest != null ? pt.rest : ex.rest;
  const nRest = pt.n_rest != null ? pt.n_rest : ex.d - dims.length;
  b1.append(el("p", "dsum",
    `b0 ${minus(ex.b0.toFixed(3))}  ${sx(topSum, 3)} (these ${dims.length})  ${sx(rest, 3)} (other ${Number(nRest).toLocaleString("en-US")})  = z ${minus(ex.z.toFixed(3))} → probe score ${ex.p_raw.toFixed(2)}`));
  R.append(b1);

  const nL = ex.n_layers;
  const au = new Map((ex.layer_auroc || []).map((x) => [x.layer, x.auroc]));
  const vals = [...au.values()];
  const lo = 0.5, hi = vals.length ? Math.max(0.5001, ...vals) : 1;
  const a = el("div", "how-block");
  a.append(el("h3", null, `${nL} layers, the probe reads one`));
  const strip = el("div", "layers");
  for (let Li = 0; Li <= nL; Li++) {
    const c = el("span", Li === ex.layer ? "used" : null);
    if (au.has(Li)) c.style.background = rampColor((au.get(Li) - lo) / (hi - lo));
    c.title = `${Li === 0 ? "Embedding" : "Layer " + Li}: ${au.has(Li) ? "AUROC " + au.get(Li).toFixed(3) : "not measured"}${Li === ex.layer ? ", used" : ", not used"}`;
    strip.append(c);
  }
  const labels = el("div", "layer-labels");
  const left = el("span", null, "Embedding");
  left.style.left = "0";
  const right = el("span", null, `Layer ${nL}`);
  right.style.right = "0";
  const used = el("span", "used", `Layer ${ex.layer}, used${au.has(ex.layer) ? " · AUROC " + au.get(ex.layer).toFixed(3) : ""}`);
  used.style.left = `${((ex.layer + 0.5) / (nL + 1)) * 100}%`;
  labels.append(left, right, used);
  a.append(strip, labels);
  if (vals.length) {
    const lg = el("div", "legend");
    lg.append(el("span", null, "Spider AUROC 0.50"));
    for (let i = 0; i <= 4; i++) { const sw = el("i"); sw.style.background = rampColor(i / 4); lg.append(sw); }
    lg.append(el("span", null, hi.toFixed(2)));
    a.append(lg);
  }
  R.append(a);
  col.append(L, R);

  // cascade: rows land, bars grow, the logit cell ticks up row by row, then the sigmoid curve draws to the needle
  const curve = fig.curve;
  const len = curve.getTotalLength ? curve.getTotalLength() : 0;
  const finish = () => { st.odometer(1e9); st.table.classList.add("on"); list.classList.add("on"); fig.classList.add("on"); curve.style.strokeDasharray = ""; curve.style.strokeDashoffset = ""; };
  if (!animate || reduced() || !len) { finish(); return; }
  curve.style.strokeDasharray = `${len}`;
  curve.style.strokeDashoffset = `${len}`;
  curve.style.transition = "none";
  let raf = 0;
  const t0 = performance.now();
  const timers = [];
  const step = (now) => { const ms = now - t0; st.odometer(Math.min(ms, st.end)); if (ms < st.end) raf = requestAnimationFrame(step); };
  requestAnimationFrame(() => requestAnimationFrame(() => {
    st.table.classList.add("on");
    list.classList.add("on");
    raf = requestAnimationFrame(step);
    timers.push(setTimeout(() => {
      curve.style.transition = "stroke-dashoffset 600ms cubic-bezier(.4,0,.2,1)";
      curve.style.strokeDashoffset = "0";
      timers.push(setTimeout(() => fig.classList.add("on"), 560));
    }, st.end - 200));
  }));
  howStop = () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); howStop = () => {}; };
}

/* ---------- replay ---------- */
function clearTimers() { timers.forEach(clearTimeout); timers = []; }
function later(ms, fn) { timers.push(setTimeout(fn, reduced() ? 0 : ms)); }

function play(r, animate) {
  clearTimers();
  stopClock();
  pipeFinish(r);
  lastShown = r;
  setProbeLine(r);
  renderAnswer(r);
  const has = renderExplain(r);
  renderHow(r.explain, r, animate && document.body.classList.contains("how"));
  const nd = needleOf(r);
  const gm = r.calibrated === false ? "uncal" : "noprobe";
  G.main.note = G.ins.note = r.calibration_note || UNCAL;
  renderInside(r, animate ? "animate" : "still");
  if (!has || !animate) {
    for (const n of document.querySelectorAll("#excol .step, #excol .bar")) n.classList.add("on");
    odoStop();
    if ($("excol").odometer) $("excol").odometer(Infinity); // settled: the exact logit, no replay
    setGauge(nd, gm, false);
    $("status").textContent = has ? "Scored before the SQL ran." : nd == null ? "Probe not loaded." : "";
    playing = false;
    return;
  }
  playing = true;
  setHow(false); // a new answer replays in the explanation column
  setGauge(null, "hold");
  $("status").textContent = "Scored before the SQL ran.";
  for (const n of document.querySelectorAll("#excol .step, #excol .bar")) later(Number(n.dataset.t || 0), () => n.classList.add("on"));
  runOdometer($("excol").odometer, 0, T.total);
  later(T.swing, () => setGauge(nd, gm, true));
  later(T.done, () => {
    playing = false;
    if (deferred) { const d = deferred; deferred = null; play(d, true); }
  });
}

/* ---------- pipeline strip: the worker's stages with their measured time ----------
   Live: each cell's clock is the time between the stage messages this screen received. On the result the cells
   settle to the worker's own measurements (gen_seconds, timing.score_s + layers_s, exec_seconds,
   audit.annotate_seconds); a stage the payload does not time keeps the time measured here. */
const PIPE_SCALE_S = 8; // a full bar is 8 s, the end-to-end budget per question
const PIPE_STAGES = [
  ["generating", "Generating SQL"], ["scoring", "Probe scoring"], ["executing", "Running the query"], ["audit", "Checking joins"],
];
const STAGE = { generating: "Generating SQL", scoring: "Scoring it from the model's hidden states", executing: "Running the SQL on SQLite", sampling: "Sampling other readings" };
let stageLabel = STAGE.generating;
let pipe = null; // { cells: Map(stage -> {node, t, pf}), active, startedAt, measured: Map(stage -> s) }

function pipeBuild(stages) {
  const box = $("pipe");
  box.replaceChildren();
  pipe = { cells: new Map(), active: null, startedAt: 0, measured: new Map() };
  for (const [key, name] of stages) {
    const c = el("div", "pc");
    const pb = el("span", "pb");
    const pf = el("i", "pf");
    pb.append(pf);
    const t = el("span", "pt", "");
    c.append(el("span", "pn", name), t, pb);
    box.append(c);
    pipe.cells.set(key, { node: c, t, pf });
  }
}
const pipeBar = (cell, s) => { cell.pf.style.transform = `scaleX(${Math.min(1, Math.max(0, s / PIPE_SCALE_S)).toFixed(4)})`; };
function pipeSettle(stage, s) { // a stage ends: its cell keeps the measured seconds
  const c = pipe && pipe.cells.get(stage);
  if (!c) return;
  c.node.classList.remove("live");
  c.node.classList.add("done");
  if (s != null) { pipe.measured.set(stage, s); c.t.textContent = s < 0.005 ? "<0.01 s" : `${s.toFixed(s < 10 ? 2 : 1)} s`; pipeBar(c, s); }
}
function pipeGo(stage) { // a stage message: close the running cell with this screen's clock, start the next
  if (!pipe) return;
  const now = performance.now();
  if (pipe.active) pipeSettle(pipe.active, (now - pipe.startedAt) / 1000);
  if (!pipe.cells.has(stage)) { // sampling (two readings) is only announced when it runs
    const c = el("div", "pc");
    const pb = el("span", "pb"), pf = el("i", "pf"), t = el("span", "pt", "");
    pb.append(pf);
    c.append(el("span", "pn", STAGE[stage] || String(stage)), t, pb);
    $("pipe").append(c);
    pipe.cells.set(stage, { node: c, t, pf });
  }
  pipe.active = stage;
  pipe.startedAt = now;
  pipe.cells.get(stage).node.classList.add("live");
}
function pipeTick() {
  if (!pipe || !pipe.active) return;
  const c = pipe.cells.get(pipe.active);
  const s = (performance.now() - pipe.startedAt) / 1000;
  c.t.textContent = `${s.toFixed(1)} s`;
  pipeBar(c, s);
}
function pipeFinish(r) { // the result: every cell settles to the worker's numbers where it has them
  if (!pipe) {
    if (!r || r.gen_seconds == null) { $("pipe").replaceChildren(); return; }
    pipeBuild(PIPE_STAGES); // a replayed result (reconnect): draw the strip from the payload alone
  }
  if (pipe.active) pipeSettle(pipe.active, (performance.now() - pipe.startedAt) / 1000);
  pipe.active = null;
  const tm = (r && r.timing) || {};
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const score = num(tm.score_s) != null || num(tm.layers_s) != null ? (num(tm.score_s) || 0) + (num(tm.layers_s) || 0) : null;
  const audit = r && r.audit ? num(r.audit.annotate_seconds) : null;
  const server = { generating: num(r && r.gen_seconds), scoring: score, executing: num(r && r.exec_seconds), audit, sampling: num(tm.sampling_s) };
  const inputs = r && r.explain && r.explain.stack_terms ? r.explain.stack_terms.length : null;
  const layer = r && r.explain ? r.explain.layer : null;
  if (layer != null) {
    const c = pipe.cells.get("scoring");
    c.node.firstChild.textContent = `Probe, layer ${layer}`;
    if (inputs) c.node.title = `Layer ${layer} probe stacked with ${inputs - 1} other inputs`;
  }
  for (const [key, c] of pipe.cells) {
    const s = server[key] != null ? server[key] : pipe.measured.get(key);
    if (s != null) pipeSettle(key, s);
    else { c.node.classList.remove("live"); c.node.classList.add("done", "skip"); c.t.textContent = key === "scoring" ? "no probe" : "not run"; pipeBar(c, 0); }
  }
  const total = (r && r.timing && num(r.timing.worker_s)) || null;
  if (total != null) { const c = pipe.cells.get("audit"); c.node.title = `Worker total ${total.toFixed(2)} s`; }
}

const drawClock = () => { $("status").textContent = `${stageLabel} · ${((performance.now() - workingSince) / 1000).toFixed(1)} s`; pipeTick(); };

function showWorking(job, live) {
  if (live) panelOff(); // a live job returns the screen to the live view
  setCheck(false); // a new Ask job ends the check reveal
  if (playing) return; // the queue line shows it; the replay finishes first
  clearTimers();
  odoStop();
  setHow(false);
  renderQuestion(job.db_id, job.question).append(el("pre", "sql", "Generating SQL"));
  $("excol").replaceChildren(el("p", "noex", "Awaiting probe."));
  renderHow(null);
  renderInside(job, "working"); // Inside stays open across questions: the strip refills with each answer
  setGauge(null, "hold");
  workingSince = performance.now();
  stageLabel = STAGE.generating;
  pipeBuild(PIPE_STAGES);
  pipeGo("generating");
  stopClock();
  drawClock();
  clock = setInterval(drawClock, 100);
}
function showStage(m) {
  if (currentJob && m.job && m.job.id !== currentJob.id) return;
  stageLabel = STAGE[m.stage] || String(m.stage);
  if (!clock) return;
  pipeGo(m.stage);
  drawClock();
  const pre = document.querySelector("#answer pre.sql");
  if (pre && m.stage !== "generating") pre.textContent = "SQL written. Shown once scored.";
}
function stopClock() { if (clock) clearInterval(clock); clock = null; }

/* ---------- pre-flight check reveal ---------- */
// Every number here comes from the /api/check payload (auditor counts, executed results).
const CK = { before: 400, hl: 1300, strike: 2300, after: 3000, ratio: 3800, why: 4600 };
const CALM = { value: 300, word: 900, why: 1500 };
let checkTimers = [];
let presets = []; // GET /api/presets: names the answer key a checked query came from
fetch("api/presets").then((r) => r.json()).then((d) => { presets = d.presets || []; }).catch(() => {});
// Scoreboard / Failures panels (scoreboard.js) replace these; a live message calls panelOff().
let panelOpen = () => false;
let panelOff = () => {};
let checkFit = null; // re-lays out the current check for the window size
let checkMode = false;

function setCheck(on) {
  checkMode = on;
  document.body.classList.toggle("check", on);
  if (!on) { checkTimers.forEach(clearTimeout); checkTimers = []; }
}
const nfmt = (v) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(v));
const times = (f) => `${+Number(f).toPrecision(3)}×`;

function ratioWords(h) { // [big, small]; before/after of the headline cell
  const r = Number(h.ratio);
  if (h.ratio == null || !Number.isFinite(r) || r <= 0 || r === 1) return null;
  const hi = r > 1;
  if (hi && r >= 2) return [times(r), "too high"];
  if (!hi && r <= 0.5) return [times(1 / r), "too low"];
  return [`${Math.round(Math.abs(r - 1) * 100)}%`, hi ? "too high" : "too low"];
}

// The query, trimmed to maxLines: every line a highlight touches (plus ctx lines around it), gaps marked.
function codeView(sql, spans, maxLines, ctx = 1) {
  const NL = String.fromCharCode(10);
  const lines = sql.split(NL);
  const starts = [];
  let o = 0;
  for (const ln of lines) { starts.push(o); o += ln.length + 1; }
  const lineOf = (pos) => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= pos) i++; return i; };
  let keep = lines.map((_, i) => i);
  if (lines.length > maxLines) {
    const want = new Set();
    for (const sp of spans) {
      for (let i = lineOf(sp.start) - ctx; i <= lineOf(Math.max(sp.start, sp.end - 1)) + ctx; i++) if (i >= 0 && i < lines.length) want.add(i);
    }
    keep = (want.size ? [...want].sort((x, y) => x - y) : keep).slice(0, maxLines);
  }
  const box = el("div", "sqlbox");
  const base = el("pre", "base");
  const hl = el("pre", "hl");
  keep.forEach((i, k) => {
    if (k && i > keep[k - 1] + 1) { base.append(el("span", "gap", "  ⋯" + NL)); hl.append(el("span", "gap", "  ⋯" + NL)); }
    const lo = starts[i], hi = lo + lines[i].length;
    const nl = k < keep.length - 1 ? NL : "";
    base.append(lines[i] + nl);
    let p = lo;
    for (const sp of spans) {
      const st = Math.max(sp.start, p), en = Math.min(sp.end, hi);
      if (en <= st) continue;
      if (st > p) hl.append(sql.slice(p, st));
      hl.append(el("mark", sp.kind === "join" ? "join" : "agg", sql.slice(st, en)));
      p = en;
    }
    hl.append(sql.slice(p, hi) + nl);
  });
  box.append(base, hl);
  const contiguous = keep.length && keep[keep.length - 1] - keep[0] === keep.length - 1;
  const range = keep.length === lines.length ? null
    : contiguous ? `Lines ${keep[0] + 1}–${keep[keep.length - 1] + 1} of ${lines.length}` : `${keep.length} of ${lines.length} lines`;
  return { box, hl, range };
}

function evidence(findings) {
  const seen = new Set();
  const t = el("table", "evid");
  const hr = el("tr");
  for (const [h, n] of [["Table", 0], ["Rows after the JOIN", 1], ["Distinct rows", 1], ["Each row counted", 1]]) hr.append(el("th", n ? "n" : null, h));
  const th = el("thead");
  th.append(hr);
  const tb = el("tbody");
  for (const f of findings) {
    const key = `${f.table}|${f.joined_rows}|${f.distinct_rows}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tr = el("tr");
    tr.append(el("td", null, f.table === "*" ? "every joined table" : f.table), el("td", "n", nfmt(f.joined_rows)),
      el("td", "n", nfmt(f.distinct_rows)), el("td", "n", times(f.factor)));
    tb.append(tr);
  }
  t.append(th, tb);
  return t;
}

function singleValue(res) {
  const r = res && res.rows;
  if (!r || r.length !== 1 || r[0].length !== 1 || r[0][0] == null) return null;
  const s = nfmt(r[0][0]);
  return s.length <= 14 ? s : null;
}

function fitNumbers(reveal, chars) { // one font size that fits every big number on one line
  const w = $("checkcol").clientWidth;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const gaps = 3.4 * rem * Math.max(0, reveal.children.length - 1);
  const px = (w - gaps) / (0.62 * Math.max(4, chars));
  const max = reveal.classList.contains("withfan") ? 4.8 : 7.5; // the grid needs the height
  reveal.style.setProperty("--num", `${Math.max(3 * rem, Math.min(max * rem, px)).toFixed(0)}px`);
}

// Ids that share a prefix up to a separator (TR496_1, TR496_10) are shown without it; the caption names it.
function shortIds(ids) {
  const labels = ids.map(String);
  if (labels.length < 2 || !ids.every((v) => typeof v === "string")) return { labels, prefix: "" };
  let p = labels[0];
  for (const s of labels) while (!s.startsWith(p)) p = p.slice(0, -1);
  const cut = p.search(/[^A-Za-z0-9][A-Za-z0-9]*$/);
  p = cut >= 0 ? p.slice(0, cut + 1) : "";
  if (p.length < 3 || labels.some((s) => s.length === p.length)) return { labels, prefix: "" };
  return { labels: labels.map((s) => s.slice(p.length)), prefix: p };
}

// The rows the JOIN produced, one cell per (left row, right row) pair, from the /api/check fanout payload.
function fanStrip(fo, f, h) {
  const g = fo.grid, L = fo.left, R = fo.right, G = g.group;
  const rl = shortIds(g.rows), cl = shortIds(g.cols);
  const lk = `${L.table}.${L.key}`, rk = `${R.table}.${R.key}`;
  const of = (k, n) => (k === n ? `all ${nfmt(n)}` : `${k} of ${nfmt(n)}`);
  let cap = `${lk} down · ${rk} across`;
  if (g.sampled) cap += G ? ` · ${of(g.rows.length, G.left)} × ${of(g.cols.length, G.right)} shown` : ` · ${g.rows.length} × ${g.cols.length} shown`;
  if (g.cells.some((c) => c[2] > 1)) cap += " · a number: joined rows sharing that pair";

  const grid = el("div", "fgrid");
  grid.append(el("span"));
  for (const v of cl.labels) grid.append(el("span", "h", v));
  const n = new Map(g.cells.map((c) => [c[0] * 100000 + c[1], c[2]]));
  const cells = []; // in fan order: row by row, each row's first joined row first (the one that stays after the fix)
  const heads = [];
  g.rows.forEach((_, r) => {
    const rh = el("span", "rh", rl.labels[r]);
    heads.push(rh);
    grid.append(rh);
    let first = true;
    g.cols.forEach((_, k) => {
      const slot = el("span", "slot");
      const v = n.get(r * 100000 + k);
      if (v) {
        const c = el("i", "c " + (first ? "keep" : "dup"), v > 1 ? String(v) : null);
        c.dataset.row = r;
        slot.append(c);
        cells.push(c);
        first = false;
      }
      grid.append(slot);
    });
  });
  const box = el("div", "fbox");
  box.append(el("p", "fcap", cap), grid);
  // --dx: how far each copy sits from its row's first cell, so it can fan out from there and collapse back
  const measure = () => {
    const firstX = new Map();
    for (const c of cells) {
      const x = c.parentNode.offsetLeft;
      if (!firstX.has(c.dataset.row)) firstX.set(c.dataset.row, x);
      c.style.setProperty("--dx", `${(firstX.get(c.dataset.row) - x).toFixed(1)}px`);
    }
  };

  const factor = el("div", "factor");
  const agg = f.aggregate && f.aggregate.length <= 32 ? f.aggregate : "The aggregate";
  const eq = (n, a, m, b, k) => (n * m === k ? `${nfmt(n)} ${a} × ${nfmt(m)} ${b} = ${nfmt(k)} rows` : `${nfmt(n)} ${a} rows and ${nfmt(m)} ${b} rows join into ${nfmt(k)}`);
  let big, sub, lab = null;
  if (fo.cross) {
    big = eq(L.distinct, L.table, R.distinct, R.table, fo.joined_rows);
    sub = `${agg} counts ${nfmt(fo.joined_rows)} rows for ${nfmt(L.distinct)} ${L.table}.`;
  } else {
    const per = fo.link ? `${R.table} row with the same ${fo.link}` : `${R.table} row it joins`;
    const all = `${nfmt(L.distinct)} ${L.table} rows become ${nfmt(fo.joined_rows)} joined rows.`;
    sub = `Each ${L.table} row repeats once per ${per}, up to ${nfmt(fo.max_repeat)} times.`;
    if (G) { lab = `${G.column} ${G.value}`; big = eq(G.left, L.table, G.right, R.table, G.joined_rows); sub += ` Overall, ${all}`; }
    else big = `${nfmt(L.distinct)} ${L.table} rows → ${nfmt(fo.joined_rows)} joined rows`;
  }
  if (lab) factor.append(el("small", null, lab));
  factor.append(el("b", big.length > 26 ? "long" : null, big), el("p", null, sub));
  const node = el("div", "fan");
  node.append(box, factor);

  const size = () => { // cell size from the space there is; header labels always fit
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const W = $("checkcol").clientWidth, H = $("checkcol").clientHeight;
    const C = g.cols.length, Rn = g.rows.length;
    const lab = Math.max(0, ...[...grid.querySelectorAll(".h")].map((x) => x.scrollWidth)) + 6;
    const rh = Math.max(0, ...[...grid.querySelectorAll(".rh")].map((x) => x.scrollWidth)) + 0.5 * rem;
    const cw = Math.max(lab, Math.min(4.6 * rem, (W - 19 * rem - 2.6 * rem - rh - 2 * C) / C));
    const cap = box.firstChild.offsetHeight;
    const ch = Math.max(0.55 * rem, Math.min(2.6 * rem, (0.26 * H - cap - 1.2 * rem) / (Rn + 1) - 2));
    grid.style.gridTemplateColumns = `auto repeat(${C}, ${cw.toFixed(1)}px)`;
    grid.style.setProperty("--ch", `${ch.toFixed(1)}px`);
    measure();
  };
  return { node, cells, heads, grid, size };
}

// Tweens a headline number shown as text ("355", "116.6527", "1,234"): same decimals, same grouping.
function numberText(text) {
  const s = String(text);
  if (!/^-?[\d,]*\.?\d+$/.test(s)) return null;
  const v = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  const dec = (s.split(".")[1] || "").length;
  const grouped = s.includes(",");
  return { v, fmt: (x) => (grouped ? x.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : x.toFixed(dec)) };
}

// Schemas for the join map, one fetch per database (uploads are not cached: they expire).
const ckSchemas = new Map();
function ckSchema(db) {
  if (!db) return Promise.resolve(null);
  if (!ckSchemas.has(db) || db.startsWith("upload:")) {
    const p = fetch(`api/schema?db_id=${encodeURIComponent(db)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    ckSchemas.set(db, p);
    p.then((x) => { if (!x) ckSchemas.delete(db); });
  }
  return ckSchemas.get(db);
}

function showCheck(m, animate) {
  const c = m.check || {};
  const job = m.job || {};
  if (animate) panelOff();
  setCov(false);
  setHow(false);
  setInside(false);
  setCheck(true);
  const col = $("checkcol");
  col.replaceChildren();
  const anim = animate && !reduced();
  const at = (ms, fn) => { if (anim) checkTimers.push(setTimeout(fn, ms)); else fn(); };
  const ph = (node, ms, cls = "ph") => { node.classList.add(...cls.split(" ")); at(ms, () => node.classList.add("on")); return node; };

  const db = c.db_id || job.db_id || "";
  const pre = presets.find((p) => p.db_id === db && (p.question === job.question || p.sql === c.sql));
  const label = pre ? pre.label : "";
  const bits = [dbName(db), label].filter(Boolean);
  col.append(el("p", "route", bits.join(" · ")), el("h2", null, job.question || label || `SQL sent for a pre-flight check on ${db}`));

  const h = c.headline;
  const failed = c.parses === false || !!c.audit_error || c.message === "audit incomplete";
  const flagged = !!c.flagged;
  const reveal = el("div", "reveal");
  const orig = c.original || {};
  let chars = 0;

  // fan-out grid (first finding with one). The story, in order: the source rows appear; each fans out into its
  // joined copies while the number as written climbs; the copies collapse back onto one row each while the
  // corrected number counts down from it; the copies return hollow; the strike; the ratio; the why.
  const fo = flagged ? (c.findings || []).map((f) => f.fanout).find((x) => x && x.grid && x.grid.cells && x.grid.cells.length) : null;
  const fanN = fo ? fo.grid.cells.length : 0;
  const stag = Math.min(45, 1100 / Math.max(1, fanN));
  const K = { ...CK }, Q = { ...CALM };
  let fanEnd = 0;
  if (fo) {
    const g0 = h ? 300 : 250;
    fanEnd = g0 + 200 + (fanN - 1) * stag + 300;
    const collapse = fanEnd + 350;
    Object.assign(K, { before: g0 - 50, fan: g0, cells: g0 + 200, hl: fanEnd + 100, factor: fanEnd + 150, collapse, after: collapse,
      once: collapse + 480, strike: collapse + 650, ratio: collapse + 900, why: collapse + 1100 });
    Object.assign(Q, { fan: g0, cells: g0 + 200, factor: fanEnd + 150, word: fanEnd + 500, why: fanEnd + 900 });
  } else if (flagged && h) {
    Object.assign(K, { before: 250, hl: 700, after: 1000, strike: 1500, ratio: 1800, why: 2100 });
  }

  if (flagged && h) {
    if (!h.single_cell) {
      const cols = orig.columns || [];
      col.append(el("p", "ck-cell", h.row != null && cols[0] ? `${h.column} where ${cols[0]} = ${h.row}` : String(h.column)));
    }
    const before = el("div", "rv before");
    const bb = el("b");
    const bTxt = el("span", "txt", h.before_text);
    bb.append(bTxt, el("i", "strike"));
    before.append(el("small", null, "As written"), bb);
    const after = el("div", "rv");
    const aB = el("b", null, h.after_text);
    after.append(el("small", null, "Corrected"), aB);
    reveal.append(ph(before, K.before), ph(after, K.after, "ph after"));
    const nb = numberText(h.before_text), na = numberText(h.after_text);
    if (anim && nb) { // climbs from 0 as the copies land (or over 600 ms without a grid)
      bTxt.textContent = nb.fmt(0);
      const t0 = fo ? K.cells : K.before, dur = fo ? Math.max(400, fanEnd - K.cells) : 600;
      at(t0, () => { bb.classList.add("live"); tween(0, nb.v, dur, (x) => { bTxt.textContent = nb.fmt(x); }, () => { bb.classList.remove("live"); bTxt.textContent = h.before_text; }); });
    }
    if (anim && nb && na) { // counts down from the inflated number to the corrected one
      aB.textContent = nb.fmt(nb.v);
      at(K.after, () => { aB.classList.add("live"); tween(nb.v, na.v, 560, (x) => { aB.textContent = na.fmt(x); }, () => { aB.classList.remove("live"); aB.textContent = h.after_text; }); });
    }
    at(K.strike, () => before.classList.add("struck"));
    chars = h.before_text.length + h.after_text.length;
    const rw = ratioWords(h);
    if (rw) {
      const ratio = el("div", "rv ratio");
      const rb = el("b", null, rw[0].replace(/×$/, ""));
      if (rw[0].endsWith("×")) rb.append(el("span", "x", "×"));
      rb.append(el("span", "w", rw[1]));
      ratio.append(rb);
      reveal.append(ph(ratio, K.ratio));
      chars += rw[0].length + rw[1].length * 0.3;
    }
  } else {
    const v = orig.error ? null : singleValue(orig);
    if (v) {
      const val = el("div", "rv");
      val.append(el("small", null, flagged ? "As written, unverified" : "Result"), el("b", null, v));
      reveal.append(ph(val, Q.value));
      chars = v.length;
    }
    const word = el("div", "rv okword");
    const wb = el("b", null, flagged ? "Double counting" : failed ? "Check incomplete" : "No double counting found");
    wb.style.color = flagged ? "var(--ask)" : failed ? "var(--caution-ink)" : "";
    word.append(wb);
    reveal.append(ph(word, Q.word));
    chars = Math.max(chars + 8, 12);
  }
  col.append(reveal);
  fitNumbers(reveal, chars);
  let fan = null;
  if (fo) {
    const T0 = h ? K : Q;
    fan = fanStrip(fo, c.findings.find((f) => f.fanout === fo), h);
    col.append(fan.node);
    reveal.classList.add("withfan");
    fitNumbers(reveal, chars);
    ph(fan.node.firstChild, T0.fan);
    ph(fan.node.lastChild, T0.factor);
    fan.cells.forEach((x, i) => at(T0.cells + i * stag, () => { x.classList.add("on"); if (x.classList.contains("keep")) fan.heads[Number(x.dataset.row)].classList.add("src"); }));
    if (h && anim) { // collapse onto one per row, then the duplicates come back hollow
      at(K.collapse, () => fan.grid.classList.add("collapse"));
      at(K.once, () => { fan.grid.classList.remove("collapse"); fan.grid.classList.add("once"); });
    } else if (h) fan.grid.classList.add("once");
  }

  const body = el("div", "ck-body");
  const left = el("div");
  const why = el("div", "why");
  body.append(left, why);
  col.append(body);

  // why: verdict, join map, plain-English explanation, the auditor's counts, where the corrected number came from
  const whyT = flagged && h ? K.why : Q.why;
  // the join map: drawn still for layout, then once with its entrance when the why column arrives (after the strike)
  const mapBox = flagged && window.JoinMap ? el("div", "jmbox") : null;
  let schema = null, mapPlayed = !anim, mapW = 0;
  const drawMap = (play) => {
    if (!mapBox || !col.contains(mapBox)) return;
    const w = mapBox.clientWidth || why.clientWidth;
    if (!w || (!play && w === mapW && mapBox.firstChild)) return;
    mapW = w;
    JoinMap.render(mapBox, schema, { ...c, sql: c.sql || "" }, { mode: "wide", neighbours: false, width: w, animate: !!play });
  };
  if (flagged) {
    if (h) why.append(el("p", "vword", "Double counting"));
    if (mapBox) why.append(mapBox);
    if (c.explanation) why.append(el("p", "expl", c.explanation));
    if ((c.findings || []).length) why.append(evidence(c.findings));
    const cor = c.corrected;
    const tables = [...new Set((c.findings || []).map((f) => f.table).filter((t) => t !== "*"))].join(" and ");
    let fix;
    if (!cor) fix = "No automatic rewrite for this query, so the number as written stays unverified.";
    else if (cor.error) fix = `The corrected query failed: ${cor.error}`;
    else if (!h) fix = "The corrected query ran, but no number in its first row changed.";
    else if (cor.source === "hand") fix = "Corrected value from a hand-written fix, checked against the raw tables.";
    else fix = `Corrected value from the auditor's rewrite, which counts each ${tables || "joined"} row once.`;
    why.append(el("p", "fixline", fix));
  } else if (failed) {
    why.append(el("p", "expl", c.parse_error ? `The SQL did not parse: ${c.parse_error}` : `The check could not finish: ${c.audit_error || c.message}`));
  } else {
    why.append(el("p", "expl", c.audited
      ? "For every aggregate behind a JOIN, joined rows were counted against distinct rows. No row is counted twice."
      : "No JOIN feeds an aggregate here, so no row can be counted twice."));
    if (orig.error) why.append(el("p", "err", orig.error));
    else if (orig.rows && orig.rows.length && !singleValue(orig)) why.append(resultTable(orig.columns, orig.rows));
  }
  for (const n of why.children) ph(n, whyT);

  // left: the query, offending parts highlighted; trimmed to the lines that fit
  const spans = flagged ? (c.highlights || []) : [];
  const sql = c.sql || "";
  const key = el("p", "hkey");
  const range = el("span", "range");
  if (spans.length) key.append(el("span", "agg", "aggregate that counts too much"), el("span", "join", "JOIN that repeats its rows"));
  key.append(range);
  ph(key, spans.length ? K.hl : 0);
  const cor = c.corrected;
  const corHead = flagged && h && cor && cor.sql
    ? (cor.source === "hand" ? "Corrected SQL (hand-written)" : "Corrected SQL (auditor rewrite)") : null;
  let hlOn = false, corOn = false, view = null, corNodes = [];
  // after the strike the highlighted query gives way to the diff: as written against the corrected SQL
  const diffable = !!(flagged && h && cor && cor.sql && window.SqlDiff);
  let diffOn = false, diffPlayed = !anim;
  if (spans.length) at(K.hl, () => { hlOn = true; if (view) view.hl.classList.add("on"); });
  at(K.why, () => { corOn = true; corNodes.forEach((x) => x.classList.add("on")); });
  let fitReady = false;
  if (diffable) at(K.why, () => { diffOn = true; if (fitReady) fit(); });
  if (mapBox) {
    at(whyT, () => { if (!mapPlayed) { mapPlayed = true; mapW = 0; drawMap(true); } });
    ckSchema(db).then((x) => { schema = x; mapW = 0; if (fitReady) fit(); });
  }

  // Lay out the query and the why column for the space there is. Runs again once Poppins has loaded.
  const fitDiff = () => { // largest type at which both columns fit whole
    let ctl = null;
    for (const f of [0.9, 0.82, 0.75, 0.68, 0.62, 0.56]) {
      left.style.setProperty("--sdfs", f + "rem");
      ctl = SqlDiff.render(left, sql, cor.sql, { copy: false, animate: false });
      if (left.scrollHeight <= left.clientHeight + 1) break;
    }
    if (!diffPlayed) { // first showing: fade in, then removals strike and additions slide in
      diffPlayed = true;
      ctl = SqlDiff.render(left, sql, cor.sql, { copy: false, animate: true });
      ctl.root.classList.add("enter");
    }
  };
  const fitWhy = () => { // why column: step the type down until it fits (long explanations list several tables)
    why.className = "why";
    if (mapBox) drawMap(false);
    for (const lvl of fan || mapBox ? ["t1", "t2", "t3", "t4", "t5"] : ["t1", "t2", "t3"]) { // cumulative; t4 drops the table, t5 the verdict word
      if (why.scrollHeight <= why.clientHeight + 1) break;
      why.classList.add(lvl);
    }
  };
  const fit = () => {
    if (!col.contains(left)) return;
    if (fan) fan.size();
    if (diffOn) { fitDiff(); fitWhy(); return; }
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
    // Largest type first; at each size, fewer context lines then fewer lines, keeping every highlighted
    // line (and at least 4). Only at the smallest size does it drop lines below that. Nothing is clipped.
    const SQL_FS = [0.95, 0.85, 0.78, 0.72];
    const tryView = (n, ctx) => {
      view = codeView(sql, spans, n, ctx);
      range.textContent = view.range || "";
      left.replaceChildren(view.box, key);
      return left.scrollHeight <= left.clientHeight + 1;
    };
    const NL = String.fromCharCode(10);
    const lineStarts = [0];
    for (let i = sql.indexOf(NL); i !== -1; i = sql.indexOf(NL, i + 1)) lineStarts.push(i + 1);
    const lineOf = (pos) => { let i = 0; while (i + 1 < lineStarts.length && lineStarts[i + 1] <= pos) i++; return i; };
    const hlLines = new Set();
    for (const sp of spans) for (let i = lineOf(sp.start); i <= lineOf(Math.max(sp.start, sp.end - 1)); i++) hlLines.add(i);
    const floor = Math.max(4, hlLines.size);
    let fits = false;
    for (let si = 0; si < SQL_FS.length && !fits; si++) {
      left.style.setProperty("--sqlfs", SQL_FS[si] + "rem");
      for (let n = Math.max(floor, Math.floor(left.clientHeight / (SQL_FS[si] * 1.5 * fs))); n >= floor && !fits; n--) {
        fits = tryView(n, 1) || tryView(n, 0);
      }
    }
    for (let n = floor - 1; n >= 1 && !fits; n--) fits = tryView(n, 0); // still at the smallest size
    if (hlOn) view.hl.classList.add("on");
    // the corrected query, when the original fits whole and there is room for a few lines of it
    corNodes = [];
    if (corHead && !view.range && !diffable) {
      const head = el("p", "corhead ph", corHead);
      for (let m2 = 40; m2 >= 3; m2--) {
        const v2 = codeView(cor.sql, [], m2);
        v2.box.classList.add("ph");
        head.textContent = corHead + (v2.range ? ` · ${v2.range}` : "");
        left.replaceChildren(view.box, key, head, v2.box);
        if (left.scrollHeight <= left.clientHeight + 1) { corNodes = [head, v2.box]; break; }
      }
      if (!corNodes.length) left.replaceChildren(view.box, key);
      if (corOn) corNodes.forEach((x) => x.classList.add("on"));
    }
    fitWhy();
  };
  checkFit = fit;
  fitReady = true;
  fit();
  if (window.ResizeObserver) { // the space for the query changes with the window and with font loading
    let lastH = left.clientHeight;
    new ResizeObserver(() => { if (left.clientHeight !== lastH) { lastH = left.clientHeight; fit(); } }).observe(body);
  }
  if (document.fonts && document.fonts.status !== "loaded") document.fonts.ready.then(fit);
}

/* ---------- coverage: out-of-fold scores from data/risk.json, all numbers computed here ---------- */
const MIN_K = 20; // the curve starts once this many questions are answered, so it isn't a few-question spike
const SRC_NAME = { both: "BIRD and Spider", bird: "BIRD", spider: "Spider" };
let risk = null;
let riskErr = null;
let covSrc = "both";
let covOn = false;

function loadRisk() {
  if (risk || riskErr) return Promise.resolve();
  return fetch("data/risk.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((d) => { risk = d; })
    .catch((e) => { riskErr = `No data/risk.json (${e.message}). Run scripts/export_risk.py.`; });
}

function setCov(on) {
  covOn = on;
  if (on) panelOff();
  document.body.classList.toggle("cov", on);
  $("covbtn").setAttribute("aria-pressed", String(on));
  if (on) { setCheck(false); setHow(false); setInside(false); loadRisk().then(renderCov); }
}

const pct = (x) => `${Math.round(x * 100)}%`;
const covRows = () => risk.rows.filter((r) => covSrc === "both" || r.src === covSrc);

function renderCov() {
  if (!covOn) return;
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.src === covSrc));
  if (!risk) { $("ledger").replaceChildren(el("p", "noex", riskErr || "Loading")); return; }
  const rows = covRows();
  const t = Number($("thr").value);
  const n = rows.length;
  let k = 0, right = 0, all = 0;
  for (const r of rows) { all += r.y; if (r.s >= t) { k++; right += r.y; } }
  const b = bandOf(t);
  $("thrval").textContent = t.toFixed(2);
  $("thrband").textContent = b.name;
  $("thrband").style.color = bandInk(b.key);
  $("cvcarriage").style.transform = `translateX(${(t * 100).toFixed(2)}%)`;
  lightTicks($("cvticks"), t);
  const row = (lab, big, det, cls) => {
    const d = el("div", "lrow" + (cls ? " " + cls : ""));
    d.append(el("span", "lab", lab), el("span", "big", big), el("span", "det", det));
    return d;
  };
  const f = (x) => Number(x).toLocaleString("en-US");
  $("ledger").replaceChildren(
    row("Answer locally", n ? pct(k / n) : "--", `${f(k)} of ${f(n)} questions`),
    row("Accuracy on those", k ? pct(right / k) : "--", k ? `${f(right)} right, ${f(k - right)} wrong answers shipped` : "No question reaches this reading"),
    row("Answering everything", n ? pct(all / n) : "--", `${f(all)} of ${f(n)} right`, "ref"));
  $("covnote").textContent = `${SRC_NAME[covSrc]}: ${f(n)} held-out questions, out-of-fold scores.`;
  drawCurve(rows, t);
}

const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
let curvePts = [];
let curveX = null;
let curveKey = ""; // src + size of the drawn static layer; the slider only moves the point while it holds
let curveDot = null; // { place(t) }

function drawCurve(rows, t) {
  const svg = $("curve");
  const W = svg.clientWidth, H = svg.clientHeight;
  const key = `${covSrc}|${W}x${H}|${rows.length}`;
  if (key === curveKey && curveDot && svg.childElementCount) { curveDot.place(t); return; }
  curveKey = key;
  svg.replaceChildren();
  if (!W || !H || !rows.length) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const m = { l: 3.6 * fs, r: 1.2 * fs, t: 4.4 * fs, b: 3.4 * fs };
  const n = rows.length;
  const sorted = rows.slice().sort((a, b) => b.s - a.s);
  const pts = [];
  let k = 0, right = 0;
  sorted.forEach((r, i) => {
    k++; right += r.y;
    if ((i === n - 1 || sorted[i + 1].s !== r.s) && k >= MIN_K) pts.push({ s: r.s, c: k / n, a: right / k });
  });
  curvePts = pts;
  const all = right / n;
  const yMin = Math.max(0, Math.floor(Math.min(all, ...pts.map((p) => p.a)) * 10) / 10 - 0.1);
  const X = (c) => m.l + c * (W - m.l - m.r);
  const Y = (a) => m.t + (1 - (a - yMin) / (1 - yMin)) * (H - m.t - m.b);
  curveX = (px) => (px - m.l) / (W - m.l - m.r);
  const small = (0.78 * fs).toFixed(1);
  const mid = (0.9 * fs).toFixed(1);

  for (let a = Math.ceil(yMin * 10) / 10; a <= 1.0001; a += 0.1) {
    svg.append(sv("line", { class: "grid-l", x1: m.l, x2: W - m.r, y1: Y(a), y2: Y(a) }));
    svg.append(sv("text", { x: m.l - 0.5 * fs, y: Y(a) + 0.3 * fs, "text-anchor": "end", "font-size": small }, pct(a)));
  }
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(sv("line", { class: "axis-l", x1: X(c), x2: X(c), y1: H - m.b, y2: H - m.b + 0.35 * fs }));
    svg.append(sv("text", { x: X(c), y: H - m.b + 1.35 * fs, "text-anchor": c === 0 ? "start" : c === 1 ? "end" : "middle", "font-size": small }, pct(c)));
  }
  svg.append(sv("line", { class: "axis-l", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }));
  svg.append(sv("text", { x: X(0.5), y: H - 0.35 * fs, "text-anchor": "middle", "font-size": mid }, "Share of questions answered locally"));
  svg.append(sv("text", { x: m.l - 0.5 * fs, y: m.t - 3.3 * fs, "font-size": mid, class: "strong" }, "Accuracy on the questions answered locally"));

  // answer-everything reference
  svg.append(sv("line", { class: "base", x1: m.l, x2: W - m.r, y1: Y(all), y2: Y(all) }));
  svg.append(sv("text", { x: W - m.r, y: Y(all) + 1.3 * fs, "text-anchor": "end", "font-size": small }, `Answering everything: ${pct(all)}`));

  // band edges, at the coverage each edge gives
  const covAt = (e) => rows.filter((r) => r.s >= e).length / n;
  [[0.8, "var(--cruise)", "Cruise from 0.80", 2.25], [0.5, "var(--caution-ink)", "Ask below 0.50", 1.05]].forEach(([e, col, lab, dy]) => {
    const x = X(covAt(e));
    svg.append(sv("line", { class: "edge", x1: x, x2: x, y1: m.t - dy * fs + 0.3 * fs, y2: H - m.b, stroke: col }));
    const right = x > W - m.r - 8 * fs;
    svg.append(sv("text", { x: x + (right ? -0.4 : 0.4) * fs, y: m.t - dy * fs + 0.75 * fs, "text-anchor": right ? "end" : "start", "font-size": small }, lab));
  });

  if (pts.length) { // the curve draws in from the left the first time this benchmark is shown
    const path = sv("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.c).toFixed(1)},${Y(p.a).toFixed(1)}`).join("") });
    svg.append(path);
    if (!reduced()) {
      const len = path.getTotalLength();
      path.setAttribute("stroke-dasharray", `${len}`);
      path.setAttribute("stroke-dashoffset", `${len}`);
      path.getBoundingClientRect();
      path.classList.add("draw");
      path.style.strokeDashoffset = "0";
    }
  }

  // the slider's threshold: one point and its drop line, moved in place as the slider moves
  const cur = sv("line", { class: "cur" }), dot = sv("circle", { class: "dot", r: 0.42 * fs });
  svg.append(cur, dot);
  curveDot = {
    place: (thr) => {
      let kt = 0, rt = 0;
      for (const r of rows) if (r.s >= thr) { kt++; rt += r.y; }
      const show = kt > 0;
      cur.style.display = dot.style.display = show ? "" : "none";
      if (!show) return;
      const x = X(kt / n), y = Y(rt / kt);
      cur.setAttribute("x1", x); cur.setAttribute("x2", x); cur.setAttribute("y1", y); cur.setAttribute("y2", H - m.b);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    },
  };
  curveDot.place(t);
}

let glideStop = () => {};
function curvePick(ev) { // a tap on the curve: the slider glides to that point, the ledger follows
  if (!curveX || !curvePts.length) return;
  const r = $("curve").getBoundingClientRect();
  const c = curveX(ev.clientX - r.left);
  let best = curvePts[0];
  for (const p of curvePts) if (Math.abs(p.c - c) < Math.abs(best.c - c)) best = p;
  const to = Math.floor(best.s * 100) / 100, from = Number($("thr").value);
  glideStop();
  if (ev.type === "pointermove") { $("thr").value = to.toFixed(2); renderCov(); return; } // dragging follows the pointer directly
  glideStop = tween(from, to, 320, (x, u) => { $("thr").value = (u === 1 ? to : x).toFixed(2); renderCov(); });
}

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
    if (m.last && m.last.type === "check" && !m.current) showCheck(m.last, false);
    if (m.current) showWorking(m.current);
    return;
  }
  if (m.type === "check") showCheck(m, true);
  else if (m.type === "stage") showStage(m);
  else if (m.type === "queued") setQueue(currentJob, m.queue);
  else if (m.type === "working") { currentJob = m.job; setQueue(m.job, m.queue); showWorking(m.job, true); }
  else if (m.type === "result") {
    panelOff();
    currentJob = null;
    setQueue(null, m.queue);
    if (playing) deferred = m; else play(m, true);
  } else if (m.type === "error") {
    panelOff();
    currentJob = null;
    setQueue(null, m.queue);
    if (!playing) {
      stopClock();
      if (pipe && pipe.active) { pipeSettle(pipe.active, (performance.now() - pipe.startedAt) / 1000); pipe.active = null; }
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

/* ---------- Inside the model: one linear probe per layer, from result.layers ---------- */
// Each entry {layer, p, z, auroc:[pt, lo, hi]} is that layer's own probe on this answer plus its held-out BIRD
// AUROC. Only values from the message are drawn; the needle beside the strip is the stacked score (see How).
let insOn = false;
let insTimers = [];
const INS_STEP = 80; // ms between cells, matches --i in the CSS

function setInside(on) {
  insOn = on;
  document.body.classList.toggle("ins", on);
  $("insbtn").setAttribute("aria-pressed", String(on));
  if (on) { panelOff(); setCheck(false); setCov(false); setHow(false); }
}

function layerCell(x, i, usedLayer, dense) {
  const c = el("div", "lc" + (x.layer === usedLayer ? " used" : ""));
  c.style.setProperty("--i", i);
  const p = Number(x.p);
  const hasP = Number.isFinite(p);
  // With every layer shown, numbers only on every 4th layer and the used one; the rest stay in the tooltip.
  const labelled = !dense || x.layer % 4 === 0 || x.layer === usedLayer;
  const pv = el("span", "pv", !labelled ? "" : hasP ? p.toFixed(2) : "--");
  if (hasP) pv.style.color = bandInk(bandOf(p).key);
  const colm = el("div", "col");
  for (const b of BANDS) { // Ask at the bottom, Cruise at the top
    const seg = el("i", "b-" + b.key);
    seg.style.height = (b.to - b.from) * 100 + "%";
    colm.append(seg);
  }
  if (hasP) {
    const fill = el("i", "fill");
    fill.style.height = (Math.min(1, Math.max(0, p)) * 100).toFixed(1) + "%";
    colm.append(fill);
  }
  const au = Array.isArray(x.auroc) && x.auroc.length ? x.auroc.map(Number) : null;
  const auT = el("span", "au", !labelled ? "" : au ? au[0].toFixed(2) : "n/a");
  const atrk = el("div", "atrk");
  if (au) {
    const y = (v) => Math.min(1, Math.max(0, (v - 0.5) / 0.5)) * 100; // 0.50 at the baseline, 1.00 at the top
    const bar = el("i", "abar2");
    bar.style.height = y(au[0]).toFixed(1) + "%";
    atrk.append(bar);
    if (au.length === 3 && Number.isFinite(au[1]) && Number.isFinite(au[2])) {
      const ci = el("i", "aci");
      ci.style.bottom = y(au[1]).toFixed(1) + "%";
      ci.style.height = Math.max(0, y(au[2]) - y(au[1])).toFixed(1) + "%";
      atrk.append(ci);
    }
  }
  const tag = el("span", "tag", x.layer === usedLayer ? "used by needle" : "");
  c.title = `${x.layer === 0 ? "Embeddings (layer 0)" : "Layer " + x.layer}: this answer ${hasP ? p.toFixed(3) : "n/a"}`
    + (x.z != null ? `, z ${minus(Number(x.z).toFixed(2))}` : "")
    + (au ? `. Held-out BIRD AUROC ${au[0].toFixed(3)}${au.length === 3 ? ` (95% CI ${au[1].toFixed(3)}–${au[2].toFixed(3)})` : ""}` : ". AUROC not measured")
    + (x.layer === usedLayer ? ". The shipped probe reads this layer." : "");
  c.append(pv, colm, el("span", "ln", String(x.layer)), atrk, auT, tag);
  return c;
}

function renderInside(r, mode) { // mode: idle | working | animate | still
  insTimers.forEach((t) => (t.cancel ? t.cancel() : clearTimeout(t))); insTimers = [];
  const strip = $("strip");
  const note = $("insnote");
  strip.replaceChildren();
  note.className = "ins-note";
  note.textContent = "";
  if (mode === "idle" || !r) {
    $("insq").textContent = "Inside the model";
    $("insroute").textContent = "";
    strip.append(el("p", "ins-empty", `Ask from a phone at ${location.host}.`));
    setInsGauge(null);
    return;
  }
  $("insq").textContent = r.question || "Inside the model";
  if (mode === "working") {
    $("insroute").textContent = "";
    strip.append(el("p", "ins-empty", "Generating SQL."));
    setInsGauge(null, "hold");
    return;
  }
  const layers = Array.isArray(r.layers) ? r.layers.filter((x) => x && Number.isFinite(Number(x.layer))).slice().sort((a, b) => a.layer - b.layer) : null;
  const usedLayer = r.probe && typeof r.probe === "object" && r.probe.layer != null ? Number(r.probe.layer) : null;
  const nd = needleOf(r);
  $("insroute").textContent = r.fake ? "fake worker" : "";
  if (r.layers_synthetic) { note.className = "ins-note synth"; note.textContent = "Synthetic test data: these layer readings are random, not evidence."; }
  else if (r.layers_error) note.textContent = `Per-layer probes failed: ${r.layers_error}`;
  if (!layers || !layers.length) {
    strip.append(el("p", "ins-empty", r.layers_error ? `Per-layer probes failed: ${r.layers_error}` : "Per-layer probes not installed."));
    setInsGauge(nd, "noprobe");
    return;
  }
  const grid = el("div", "strip");
  grid.style.setProperty("--n", layers.length);
  const cells = layers.map((x, i) => layerCell(x, i, usedLayer, layers.length > 20));
  const lab = el("div", "lc lab on"); // row label for the AUROC track
  lab.append(el("span", "pv"), el("div", "col"), el("span", "ln"), el("span", "atrk", "AUROC"), el("span", "au"), el("span", "tag"));
  grid.append(lab, ...cells);
  strip.append(grid, el("p", "cap", `Each layer: its own probe. Needle uses layer ${usedLayer != null ? usedLayer : "[TBD]"} + other signals.`));
  const anim = mode === "animate" && !reduced();
  const fin = (animate) => setInsGauge(nd, "noprobe", animate);
  if (!anim) {
    cells.forEach((c) => c.classList.add("on", "still", "hit"));
    fin(false);
    return;
  }
  // the scan: cells fill left to right, each number counting up to its real p; the used layer is outlined when reached
  setInsGauge(null, "hold");
  const step = Math.min(INS_STEP, 1500 / cells.length), FILL = 420, pop = 320;
  const parts = cells.map((c, i) => ({
    c, i, p: Number(layers[i].p), fill: c.querySelector(".fill"), abar: c.querySelector(".abar2"), pv: c.querySelector(".pv"),
    labelled: c.querySelector(".pv").textContent !== "", used: c.classList.contains("used"),
  }));
  const end = (cells.length - 1) * step + FILL;
  let raf = 0;
  const t0 = performance.now() + 60;
  const frame = (now) => {
    const t = now - t0;
    for (const q of parts) {
      const a = Math.min(1, Math.max(0, (t - q.i * step) / pop));
      if (a > 0 && !q.c.classList.contains("on")) q.c.classList.add("on");
      q.c.style.opacity = a.toFixed(3);
      q.c.style.transform = a < 1 ? `translateY(${(10 * (1 - easeOut(a))).toFixed(1)}px)` : "";
      const f = easeOut(Math.min(1, Math.max(0, (t - q.i * step - 60) / FILL)));
      if (q.fill) q.fill.style.transform = `scaleY(${f.toFixed(4)})`;
      if (q.abar) q.abar.style.transform = `scaleY(${f.toFixed(4)})`;
      if (q.labelled && Number.isFinite(q.p)) q.pv.textContent = (q.p * f).toFixed(2);
      if (q.used && f >= 1 && !q.c.classList.contains("hit")) q.c.classList.add("hit");
    }
    if (t < end) raf = requestAnimationFrame(frame);
    else { parts.forEach((q) => { q.c.style.transform = ""; q.c.style.opacity = ""; q.c.classList.add("on"); }); fin(true); }
  };
  raf = requestAnimationFrame(frame);
  insTimers.push({ cancel: () => cancelAnimationFrame(raf) });
}

/* ---------- How toggle ---------- */
function setHow(on) {
  const was = document.body.classList.contains("how");
  document.body.classList.toggle("how", on);
  $("howbtn").setAttribute("aria-pressed", String(on));
  if (on) setInside(false);
  if (on && !was && lastShown && lastShown.explain) renderHow(lastShown.explain, lastShown, true); // opening How replays the cascade
}

/* ---------- view order and the shared-axis direction; hidden gauges catch up when their view shows ---------- */
const VIEW_ORDER = ["live", "check", "how", "ins", "cov", "sb", "fail"];
const viewNow = () => VIEW_ORDER.find((v) => v !== "live" && document.body.classList.contains(v)) || "live";
let viewPrev = "live";
new MutationObserver(() => {
  const v = viewNow();
  if (v === viewPrev) return;
  document.body.style.setProperty("--enter", VIEW_ORDER.indexOf(v) > VIEW_ORDER.indexOf(viewPrev) ? "enter-fwd" : "enter-back");
  viewPrev = v;
  if (v === "live") G.main.sync();
  if (v === "ins") G.ins.sync();
  if (v === "cov" && covOn) renderCov();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
function toggleHow() {
  if (checkMode || covOn || insOn || panelOpen()) { panelOff(); setCheck(false); setCov(false); setInside(false); setHow(true); return; }
  setHow(!document.body.classList.contains("how"));
}
$("howbtn").addEventListener("click", toggleHow);
$("insbtn").addEventListener("click", () => setInside(!insOn));
$("covbtn").addEventListener("click", () => setCov(!covOn));
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range") return;
  if (e.key === "h") toggleHow();
  else if (e.key === "i") setInside(!insOn);
  else if (e.key === "c") setCov(!covOn);
  else if (e.key === "b") window.open("board.html", "altimeter-board");
});
$("thr").addEventListener("input", renderCov);
for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => { covSrc = b.dataset.src; renderCov(); });
$("curve").addEventListener("pointerdown", (e) => { $("curve").setPointerCapture(e.pointerId); curvePick(e); });
$("curve").addEventListener("pointermove", (e) => { if (e.buttons) curvePick(e); });
let resizeT = null;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { renderCov(); if (checkMode && checkFit) checkFit(); }, 150);
});

/* ---------- clouds behind the live view: the layer's height follows the needle ----------
   Ask means flying in cloud (the layer rises over the lower panel); Cruise is above it (the layer sinks away);
   no reading leaves a thin low layer. Flat silhouettes in panel greys, a slow drift, nothing else. */
function cloudPath(seed, W, H, base, rMin, rMax) { // a bank of arcs along a baseline, closed to the bottom; deterministic
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
function buildClouds() {
  const host = $("clouds");
  if (!host) return;
  const W = 1200, H = 360;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMax slice", "aria-hidden": "true" });
  const sky = sv("g", { class: "sky" });
  // back bank tops the box (first to show as the layer rises), the nearer banks sit lower and denser
  [[11, 100, 115, 150, "l1"], [29, 230, 75, 120, "l2"], [47, 330, 50, 90, "l3"]].forEach(([seed, base, r0, r1, cls]) => {
    const band = sv("g", { class: "band " + cls });
    const d = cloudPath(seed, W, H, base, r0, r1);
    band.append(sv("path", { d }), sv("path", { d, transform: `translate(${W} 0)` })); // two copies: a seamless drift loop
    sky.append(band);
  });
  svg.append(sky);
  host.append(svg);
}
const cloudLevel = (s) => (s == null ? 0.2 : 0.16 + 0.84 * Math.pow(1 - Math.min(1, Math.max(0, s)), 1.4));
function cloudSet(level) { // level 1: the layer fills its box; 0: fully below the panel
  const host = $("clouds");
  if (host) host.style.transform = `translateY(${((1 - level) * 100).toFixed(2)}%)`;
}
buildClouds();
cloudSet(cloudLevel(null));

buildTape();
buildTape("cvticks", "cvbands", "cvnames"); // same geometry as the gauge tape
buildTape("insticks", "insbands", "insnames");
setGauge(null);
renderInside(null, "idle");
setQueue(null, []);
renderHow(null);
$("excol").append(el("p", "noex", `Ask from a phone at ${location.host}.`));
renderQuestion("", "No question yet").querySelector(".route").textContent = "";
const params = new URLSearchParams(location.search);
setHow(params.get("how") === "1");
connect();

// Dev-only: ?mock=check (571), check200, check140, check89 replays a recorded /api/check response;
// ?mock=coverage[&t=0.5][&src=bird]; ?mock=stage walks a fake job through the stage messages.
const mock = params.get("mock") || "";
if (mock.startsWith("check")) {
  fetch(`data/mock_check_${mock.slice(5) || "571"}.json`).then((r) => r.json())
    .then((m) => setTimeout(() => onMessage({ data: JSON.stringify(m) }), 400));
} else if (mock === "coverage") {
  if (params.get("t")) $("thr").value = params.get("t");
  if (SRC_NAME[params.get("src")]) covSrc = params.get("src");
  setCov(true);
} else if (mock === "stage") {
  const job = { id: -1, db_id: "codebase_community", question: "Mock job: stage messages" };
  const send = (m, ms) => setTimeout(() => onMessage({ data: JSON.stringify({ ...m, job, queue: [] }) }), ms);
  send({ type: "working" }, 400);
  send({ type: "stage", stage: "scoring" }, 2000);
  send({ type: "stage", stage: "executing" }, 3500);
} else if (mock === "inside" || mock === "how") {
  // ?mock=inside[&layers=none] / ?mock=how: a synthetic result for layout only. Every number is random and
  // labelled so on screen (explain.synthetic, layers_synthetic); nothing here comes from a run.
  const m = mockResult(params.get("layers") !== "none");
  setTimeout(() => {
    onMessage({ data: JSON.stringify(m) });
    if (mock === "inside") setInside(true); else setHow(true);
  }, 300);
}

function mockResult(withLayers) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const names = ["probe", "logprob_mean", "logprob_min", "question_chars", "sql_chars", "n_joins", "n_aggregates", "n_subqueries", "n_prompt", "n_gen", "executes"];
  const group = { probe: "Internals", logprob_mean: "Token confidence", logprob_min: "Token confidence", executes: "Compiles" };
  const raw = { probe: 0.41, logprob_mean: -0.19, logprob_min: -3.1, question_chars: 71, sql_chars: 188, n_joins: 2, n_aggregates: 1, n_subqueries: 0, n_prompt: 1460, n_gen: 52, executes: 1 };
  const b0s = -0.35;
  const stack_terms = names.map((n) => {
    const weight = (rnd() - 0.5) * 1.6, mean = raw[n] * (0.8 + rnd() * 0.4), scale = Math.max(1e-3, Math.abs(raw[n]) * 0.5 + 0.2);
    const scaled = (raw[n] - mean) / scale;
    return { name: n, group: group[n] || "Size", weight, value: raw[n], mean, scale, scaled, contribution: weight * scaled };
  });
  const logit = b0s + stack_terms.reduce((s, t) => s + t.contribution, 0);
  const groups = ["Internals", "Token confidence", "Size", "Compiles"].map((g) => ({ name: g, value: stack_terms.filter((t) => t.group === g).reduce((s, t) => s + t.contribution, 0), members: [] }));
  const dims = Array.from({ length: 16 }, () => { const w = (rnd() - 0.5) * 0.08, h = (rnd() - 0.5) * 6, mean = (rnd() - 0.5); return { dim: Math.floor(rnd() * 2048), weight: w, activation: h, mean, contribution: w * (h - mean) }; })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const b0 = 0.12, rest = -0.21;
  const z = b0 + dims.reduce((s, d) => s + d.contribution, 0) + rest;
  const p_raw = sig(z);
  const layers = [];
  for (let L = 0; L <= 36; L += 2) {
    const zl = -1.2 + (L / 36) * 1.1 + (rnd() - 0.5) * 0.9;
    const pt = 0.5 + Math.min(0.45, Math.max(0, (L / 36) * 0.3 + (rnd() - 0.5) * 0.08));
    layers.push({ layer: L, p: +sig(zl).toFixed(4), z: +zl.toFixed(3), auroc: [+pt.toFixed(3), +(pt - 0.03).toFixed(3), +(pt + 0.03).toFixed(3)] });
  }
  const explain = {
    synthetic: true, layer: 26, position: "mean_gen", n_layers: 36, centered: true, b0, z, p_raw, p_cal: sig(1.3 * z - 0.2),
    platt_a: 1.3, platt_b: -0.2, dims: dims.map((d) => [d.dim, d.contribution]), rest, share_top20: 0.31, d: 2048,
    stack_ref: b0s, groups, logit, needle: sig(logit), features: stack_terms.map((t) => ({ name: t.name, value: t.value, contrib: t.contribution })),
    stack_terms, stack_intercept: b0s,
    probe_terms: { layer: 26, position: "mean_gen", b0, z, centered: true, dims, rest, n_rest: 2048 - 16 },
    model_card: { stack: "logistic regression with 11 inputs (StandardScaler, then logistic regression)", stack_inputs: 11,
      probe: "StandardScaler -> PCA 256 -> L2 logistic, collapsed to one linear vector over 2,048 activations at layer 26, mean over SQL tokens",
      probe_layer: 26, probe_position: "mean_gen", probe_dims: 2048, platt: { a: 1.3, b: -0.2 }, n_train: null, excluded_dbs: null, select_on: null, synthetic: true },
    layer_auroc: layers.map((l) => ({ layer: l.layer, auroc: l.auroc[0] })), ece: null, track_record: {}, ms: 0.4,
  };
  const m = {
    type: "result", job: { id: -2, db_id: "synthetic", question: "Synthetic test question: layout only, no run behind these numbers" }, queue: [],
    db_id: "synthetic", question: "Synthetic test question: layout only, no run behind these numbers",
    sql: "SELECT T1.name, COUNT(T2.id) AS n FROM synthetic_a AS T1 INNER JOIN synthetic_b AS T2 ON T1.id = T2.a_id GROUP BY T1.name ORDER BY n DESC LIMIT 5",
    gen_seconds: 0, columns: ["name", "n"], rows: [["synthetic row", 0]], fake: true,
    probe: { needle: +sig(logit).toFixed(4), probe: +p_raw.toFixed(4), calibrated: 0.5, layer: 26, position: "mean_gen", n_train: null, bird_probe_auroc: null },
    explain,
  };
  if (withLayers) { m.layers = layers; m.layers_synthetic = true; }
  if (params.get("legacy") === "1") for (const k of ["stack_terms", "stack_intercept", "probe_terms", "model_card"]) delete explain[k]; // older server
  return m;
}
