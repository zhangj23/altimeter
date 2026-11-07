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

const STAGE = { generating: "Generating SQL", scoring: "Scoring it from the model's hidden states", executing: "Running the SQL on SQLite", sampling: "Sampling other readings" };
let stageLabel = STAGE.generating;
const drawClock = () => { $("status").textContent = `${stageLabel} · ${((performance.now() - workingSince) / 1000).toFixed(1)} s`; };

function showWorking(job) {
  setCheck(false); // a new Ask job ends the check reveal
  if (playing) return; // the queue line shows it; the replay finishes first
  clearTimers();
  setHow(false);
  renderQuestion(job.db_id, job.question).append(el("pre", "sql", "Generating SQL"));
  $("excol").replaceChildren(el("p", "noex", "Awaiting probe."));
  renderHow(null);
  setGauge(null, "hold");
  workingSince = performance.now();
  stageLabel = STAGE.generating;
  stopClock();
  drawClock();
  clock = setInterval(drawClock, 100);
}
function showStage(m) {
  if (currentJob && m.job && m.job.id !== currentJob.id) return;
  stageLabel = STAGE[m.stage] || String(m.stage);
  if (!clock) return;
  drawClock();
  const pre = document.querySelector("#answer pre.sql");
  if (pre && m.stage !== "generating") pre.textContent = "SQL written; it is shown here with its score";
}
function stopClock() { if (clock) clearInterval(clock); clock = null; }

/* ---------- pre-flight check reveal ---------- */
// Every number here comes from the /api/check payload (auditor counts, executed results).
const CK = { before: 400, hl: 1300, strike: 2300, after: 3000, ratio: 3800, why: 4600 };
const CALM = { value: 300, word: 900, why: 1500 };
let checkTimers = [];
let presets = []; // GET /api/presets: names the answer key a checked query came from
fetch("api/presets").then((r) => r.json()).then((d) => { presets = d.presets || []; }).catch(() => {});
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
  const full = g.cells.length === g.rows.length * g.cols.length;
  const of = (k, n) => (k === n ? `all ${nfmt(n)}` : `${k} of ${nfmt(n)}`);
  let cap;
  if (!g.sampled) cap = `Every joined row: ${lk} down, ${rk} across.`;
  else if (G) {
    const why = h && h.row != null && String(h.row) === String(G.value) ? "the headline row" : `has the most repeated ${L.table} row`;
    cap = `Sample from ${G.column} ${G.value} (${why}): ${of(g.rows.length, G.left)} ${lk} down, ${of(g.cols.length, G.right)} ${rk} across.`;
  } else {
    cap = `Sample around the most repeated ${L.table} row: ${g.rows.length} of ${nfmt(L.distinct)} ${lk} down, ${g.cols.length} of ${nfmt(R.distinct)} ${rk} across.`;
  }
  if (!full) cap += " Empty cell: a pair the JOIN did not produce.";
  const pre = [...new Set([rl.prefix, cl.prefix].filter(Boolean))];
  if (pre.length) cap += ` Ids without ${pre.join(" / ")}.`;
  if (g.cells.some((c) => c[2] > 1)) cap += " A number is how many joined rows share that pair.";

  const grid = el("div", "fgrid");
  grid.append(el("span"));
  for (const v of cl.labels) grid.append(el("span", "h", v));
  const n = new Map(g.cells.map((c) => [c[0] * 100000 + c[1], c[2]]));
  const cells = [];
  g.rows.forEach((_, r) => {
    grid.append(el("span", "rh", rl.labels[r]));
    g.cols.forEach((_, k) => {
      const slot = el("span", "slot");
      const v = n.get(r * 100000 + k);
      if (v) { const c = el("i", "c", v > 1 ? String(v) : null); slot.append(c); cells.push(c); }
      grid.append(slot);
    });
  });
  const box = el("div", "fbox");
  box.append(el("p", "fcap", cap), grid);

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
  };
  return { node, cells, size };
}

function showCheck(m, animate) {
  const c = m.check || {};
  const job = m.job || {};
  setCov(false);
  setHow(false);
  setCheck(true);
  const col = $("checkcol");
  col.replaceChildren();
  const anim = animate && !reduced();
  const at = (ms, fn) => { if (anim) checkTimers.push(setTimeout(fn, ms)); else fn(); };
  const ph = (node, ms, cls = "ph") => { node.classList.add(...cls.split(" ")); at(ms, () => node.classList.add("on")); return node; };

  const db = c.db_id || job.db_id || "";
  const pre = presets.find((p) => p.db_id === db && (p.question === job.question || p.sql === c.sql));
  const label = pre ? pre.label : "";
  const bits = [db, label, c.audit_seconds != null ? `audited in ${fx(c.audit_seconds, 2)} s` : ""].filter(Boolean);
  col.append(el("p", "route", bits.join(" · ")), el("h2", null, job.question || label || `SQL sent for a pre-flight check on ${db}`));

  const h = c.headline;
  const failed = c.parses === false || !!c.audit_error || c.message === "audit incomplete";
  const flagged = !!c.flagged;
  const reveal = el("div", "reveal");
  const orig = c.original || {};
  let chars = 0;

  // fan-out grid (first finding with one): cells fill one by one, then the factor line, then the strike
  const fo = flagged ? (c.findings || []).map((f) => f.fanout).find((x) => x && x.grid && x.grid.cells && x.grid.cells.length) : null;
  const fanN = fo ? fo.grid.cells.length : 0;
  const stag = Math.min(55, 2800 / Math.max(1, fanN));
  const K = { ...CK }, Q = { ...CALM };
  if (fo) {
    const g0 = h ? 800 : 700;
    const factor = g0 + 300 + (fanN - 1) * stag + 160 + 300;
    Object.assign(K, { fan: g0, cells: g0 + 300, factor, hl: factor + 300, strike: factor + 900, after: factor + 1600, ratio: factor + 2400, why: factor + 3200 });
    Object.assign(Q, { fan: g0, cells: g0 + 300, factor, word: factor + 700, why: factor + 1300 });
  }

  if (flagged && h) {
    if (!h.single_cell) {
      const cols = orig.columns || [];
      col.append(el("p", "ck-cell", h.row != null && cols[0] ? `${h.column} where ${cols[0]} = ${h.row}` : String(h.column)));
    }
    const before = el("div", "rv before");
    const bb = el("b");
    bb.append(el("span", "txt", h.before_text), el("i", "strike"));
    before.append(el("small", null, "As written"), bb);
    const after = el("div", "rv");
    after.append(el("small", null, "Deduplicated"), el("b", null, h.after_text));
    reveal.append(ph(before, K.before), ph(after, K.after, "ph after"));
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
    const wb = el("b", null, flagged ? "Double counted" : failed ? "Audit incomplete" : "No double counting found");
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
    fan.cells.forEach((x, i) => at(T0.cells + i * stag, () => x.classList.add("on")));
  }

  const body = el("div", "ck-body");
  const left = el("div");
  const why = el("div", "why");
  body.append(left, why);
  col.append(body);

  // why: verdict, plain-English explanation, the auditor's counts, where the corrected number came from
  const whyT = flagged && h ? K.why : Q.why;
  if (flagged) {
    if (h) why.append(el("p", "vword", "Double counted"));
    if (c.explanation) why.append(el("p", "expl", c.explanation));
    if ((c.findings || []).length) why.append(evidence(c.findings));
    const cor = c.corrected;
    const tables = [...new Set((c.findings || []).map((f) => f.table).filter((t) => t !== "*"))].join(" and ");
    let fix;
    if (!cor) fix = "The auditor has no rewrite for this query, so the number as written stays unverified.";
    else if (cor.error) fix = `The corrected query failed: ${cor.error}`;
    else if (!h) fix = "The corrected query ran, but no single number changed in its first row.";
    else if (cor.source === "hand") fix = "Deduplicated value from a hand-written fix for this answer key, checked against the raw tables.";
    else fix = `Deduplicated value from the auditor's rewrite, which counts each ${tables || "joined"} row once.`;
    why.append(el("p", "fixline", fix));
    if (c.intended) why.append(el("p", "fixline", c.intended));
  } else if (failed) {
    why.append(el("p", "expl", c.parse_error ? `The SQL did not parse: ${c.parse_error}` : `The auditor could not finish: ${c.audit_error || c.message}`));
  } else {
    why.append(el("p", "expl", c.audited
      ? "The auditor counted joined rows against distinct rows for every aggregate behind a JOIN. No row is counted twice."
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
    ? (cor.source === "hand" ? "Corrected SQL (hand-written fix)" : "Corrected SQL (auditor's rewrite)") : null;
  let hlOn = false, corOn = false, view = null, corNodes = [];
  if (spans.length) at(K.hl, () => { hlOn = true; if (view) view.hl.classList.add("on"); });
  at(K.why, () => { corOn = true; corNodes.forEach((x) => x.classList.add("on")); });

  // Lay out the query and the why column for the space there is. Runs again once Poppins has loaded.
  const fit = () => {
    if (!col.contains(left)) return;
    if (fan) fan.size();
    const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
    let n = Math.max(4, Math.floor(left.clientHeight / (0.95 * 1.5 * fs)));
    for (let ctx = 1; ; ) {
      view = codeView(sql, spans, n, ctx);
      range.textContent = view.range || "";
      left.replaceChildren(view.box, key);
      if (n <= 4 || left.scrollHeight <= left.clientHeight + 1) break;
      if (ctx) ctx = 0; else n -= 1;
    }
    if (hlOn) view.hl.classList.add("on");
    // the corrected query, when the original fits whole and there is room for a few lines of it
    corNodes = [];
    if (corHead && !view.range) {
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
    // why column: step the type down until it fits (long explanations list several tables)
    why.className = "why";
    for (const lvl of fan ? ["t1", "t2", "t3", "t4"] : ["t1", "t2", "t3"]) { // cumulative; t4 (grid shown) drops the table
      if (why.scrollHeight <= why.clientHeight + 1) break;
      why.classList.add(lvl);
    }
  };
  checkFit = fit;
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
  document.body.classList.toggle("cov", on);
  $("covbtn").setAttribute("aria-pressed", String(on));
  if (on) { setCheck(false); loadRisk().then(renderCov); }
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
  const row = (lab, big, det, cls) => {
    const d = el("div", "lrow" + (cls ? " " + cls : ""));
    d.append(el("span", "lab", lab), el("span", "big", big), el("span", "det", det));
    return d;
  };
  $("ledger").replaceChildren(
    row("Answer locally", n ? pct(k / n) : "--", `${k} of ${n} questions`),
    row("Accuracy on those", k ? pct(right / k) : "--", k ? `${right} right, ${k - right} wrong answers shipped` : "No question reaches this reading"),
    row("Answering everything", n ? pct(all / n) : "--", `${all} of ${n} right`, "ref"));
  $("covnote").textContent = `${risk.source_note}. Showing ${SRC_NAME[covSrc]}: ${n} questions. The curve starts at the ${MIN_K} highest-scored.`;
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

function drawCurve(rows, t) {
  const svg = $("curve");
  const W = svg.clientWidth, H = svg.clientHeight;
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

  if (pts.length) svg.append(sv("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.c).toFixed(1)},${Y(p.a).toFixed(1)}`).join("") }));

  // the slider's threshold
  let kt = 0, rt = 0;
  for (const r of rows) if (r.s >= t) { kt++; rt += r.y; }
  if (kt) {
    const x = X(kt / n), y = Y(rt / kt);
    svg.append(sv("line", { class: "cur", x1: x, x2: x, y1: y, y2: H - m.b }));
    svg.append(sv("circle", { class: "dot", cx: x, cy: y, r: 0.42 * fs }));
  }
}

function curvePick(ev) {
  if (!curveX || !curvePts.length) return;
  const r = $("curve").getBoundingClientRect();
  const c = curveX(ev.clientX - r.left);
  let best = curvePts[0];
  for (const p of curvePts) if (Math.abs(p.c - c) < Math.abs(best.c - c)) best = p;
  $("thr").value = (Math.floor(best.s * 100) / 100).toFixed(2);
  renderCov();
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
function toggleHow() {
  if (checkMode || covOn) { setCheck(false); setCov(false); setHow(true); return; }
  setHow(!document.body.classList.contains("how"));
}
$("howbtn").addEventListener("click", toggleHow);
$("covbtn").addEventListener("click", () => setCov(!covOn));
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "h") toggleHow();
  else if (e.key === "c") setCov(!covOn);
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

buildTape();
(function buildCovTape() { // same geometry as the gauge tape
  for (let i = 0; i <= 10; i++) {
    const t = el("span");
    t.style.left = `calc(${i * 10}% - ${i === 10 ? 1 : 0}px)`;
    $("cvticks").append(t);
  }
  for (const b of BANDS) {
    const w = (b.to - b.from) * 100 + "%";
    const seg = el("span", "b-" + b.key);
    seg.style.width = w;
    $("cvbands").append(seg);
    const name = el("span", null, b.name);
    name.style.width = w;
    $("cvnames").append(name);
  }
})();
setGauge(null);
setQueue(null, []);
renderHow(null);
$("excol").append(el("p", "noex", `Ask from a phone at ${location.host}. Each answer's score breakdown replays here.`));
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
}
