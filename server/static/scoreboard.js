"use strict";
// Scoreboard and Failures panels on the table screen. Every number comes from data/scoreboard.json
// (reliability bins from data/reliability.json when present, else scoreboard.json's calibration block);
// a missing one shows [TBD]. Loaded after table.js and uses its helpers ($, el, sv, fx, setCov).

let sb = null;
let sbErr = null;
let rel = null; // { n, ece, bins: [{ lo, hi, n, mean_pred, frac_correct }], subset }
let panel = null; // "sb" | "fail" | null

const getJson = (u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
function loadSb() {
  if (sb || sbErr) return Promise.resolve();
  return Promise.all([getJson("data/scoreboard.json"), getJson("data/reliability.json").catch(() => null)])
    .then(([d, r]) => {
      sb = d;
      const cal = d.calibration || {};
      if (r && Array.isArray(r.bins) && r.bins.length) {
        rel = { n: r.n, ece: r.ece, subset: "pooled", bins: r.bins.map((b) => ({ lo: b.bin_lo, hi: b.bin_hi, n: b.n, mean_pred: b.mean_pred, frac_correct: b.frac_correct })) };
      } else if (Array.isArray(cal.reliability) && cal.reliability.length) {
        rel = { n: cal.n, ece: cal.ece, subset: cal.subset, bins: cal.reliability.map((b) => ({ lo: b.bin[0], hi: b.bin[1], n: b.n, mean_pred: b.mean_pred, frac_correct: b.frac_correct })) };
      }
    })
    .catch((e) => { sbErr = `No data/scoreboard.json (${e.message}).`; });
}
const POP = { pooled: "BIRD and Spider", bird: "BIRD", spider: "Spider" };

function setPanel(p) {
  panel = p;
  document.body.classList.toggle("sb", p === "sb");
  document.body.classList.toggle("fail", p === "fail");
  $("sbbtn").setAttribute("aria-pressed", String(p === "sb"));
  $("failbtn").setAttribute("aria-pressed", String(p === "fail"));
  if (!p) return;
  setCov(false);
  setHow(false);
  setInside(false);
  setCheck(false);
  loadSb().then(() => { if (panel === "sb") renderSb(); else if (panel === "fail") renderFail(); });
}
panelOpen = () => panel != null;
panelOff = () => { if (panel) setPanel(null); };

const n0 = (v) => (v == null || !Number.isFinite(Number(v)) ? "[TBD]" : Number(v).toLocaleString("en-US"));
const p0 = (v) => (v == null || !Number.isFinite(Number(v)) ? "[TBD]" : `${Math.round(v * 100)}%`);
const sg = (v, d) => (v == null || !Number.isFinite(Number(v)) ? "[TBD]" : (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d));
const ci3 = (c) => (c && c.length === 2 ? `${fx(c[0], 3)}–${fx(c[1], 3)}` : "[TBD]");
const pctRange = (c) => (c && c.length === 2 ? `${Math.round(c[0] * 100)}–${Math.round(c[1] * 100)}%` : "[TBD]");
const ops = (s) => String(s).replace(/>=/g, "≥").replace(/<=/g, "≤");

/* ---------- scoreboard ---------- */
function renderSb() {
  const col = $("sbcol");
  col.classList.remove("drawn");
  if (!sb) { col.replaceChildren(el("p", "noex", sbErr || "Loading")); return; }
  const H = sb.headline || {};
  const bird = (sb.subsets || {}).bird || {};

  // left: the AUROC bars
  const left = el("div", "sb-left");
  left.append(el("h2", null, "Telling right SQL from wrong: BIRD held-out AUROC"),
    el("p", "route", `${n0(H.n)} BIRD questions, ${n0(bird.n_dbs)} databases, not used to pick the layer · 95% CI by database`));
  const auc = el("div", "auc");
  const grid = el("div", "agrid");
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const i = el("i", v === 0.5 ? "chance" : null);
    i.style.left = `calc(${v * 100}% - ${v === 1 ? 1 : 0}px)`;
    grid.append(i);
  }
  auc.append(grid);
  const rows = (H.metrics || []).slice().sort((a, b) => b.auroc - a.auroc);
  for (const [ri, m] of rows.entries()) {
    const r = el("div", "arow" + (m.key === "stacked" ? " ship" : ""));
    // bars grow top to bottom, each whisker drawn once its bar has landed; the stagger is scaled so the
    // last whisker settles by ~1.09 s with 8 rows (table.html: delay = --i * 70ms + 560ms, 320ms long)
    r.style.setProperty("--i", (ri * Math.min(1, 3 / Math.max(1, rows.length - 1))).toFixed(3));
    r.title = `${m.label}: AUROC ${fx(m.auroc, 3)}, 95% CI ${ci3(m.ci95)}, n = ${n0(H.n)}`;
    const trk = el("div", "trk");
    const bar = el("i", "abar");
    bar.style.width = `${Math.max(0, Math.min(1, m.auroc)) * 100}%`;
    trk.append(bar);
    if (m.ci95) {
      const w = el("i", "whisk");
      w.style.left = `${m.ci95[0] * 100}%`;
      w.style.width = `${(m.ci95[1] - m.ci95[0]) * 100}%`;
      trk.append(w);
    }
    const val = el("div", "val");
    val.append(el("b", null, fx(m.auroc, 3)), el("small", null, ci3(m.ci95)));
    const lab = el("div", "lab");
    lab.append(el("span", null, m.label));
    r.append(lab, trk, val);
    auc.append(r);
  }
  const axis = el("div", "aaxis");
  const scale = el("div", "scale");
  for (const [v, t, cls] of [[0, "0", "first"], [0.25, "0.25", null], [0.5, "Chance 0.50", "chance"], [0.75, "0.75", null], [1, "1.00", "last"]]) {
    const s = el("span", cls, t);
    s.style.left = `${v * 100}%`;
    scale.append(s);
  }
  axis.append(scale, el("span"));
  auc.append(axis);
  left.append(auc);

  const dl = el("p", "deltas");
  (H.deltas || []).forEach((d, k) => {
    if (k) dl.append(" ");
    const ci = d.ci95 ? ` [${sg(d.ci95[0], 3)}, ${sg(d.ci95[1], 3)}]` : "";
    dl.append(`${d.label}: `, el("b", null, `${sg(d.delta, 3)}${ci}`),
      d.ci_excludes_0 == null ? "." : d.ci_excludes_0 ? ", CI excludes 0." : ", CI includes 0.");
  });
  left.append(dl);

  // right: bands, calibration, layer sweep
  const right = el("div", "sb-right");
  const bandsB = ((sb.bands || {}).bird) || {};
  const bw = el("div");
  bw.append(el("h3", null, "Answers wrong in each needle band"), el("p", "cap", `BIRD, n = ${n0(bandsB.n)}`));
  const t = el("table", "bandt");
  const hr = el("tr");
  for (const [h, num] of [["Band", 0], ["Needle", 0], ["Wrong", 1], ["95% CI", 1], ["n", 1]]) hr.append(el("th", num ? "n" : null, h));
  const th = el("thead");
  th.append(hr);
  const tb = el("tbody");
  for (const b of bandsB.bands || []) {
    const tr = el("tr");
    const name = el("td");
    const sw = el("i", "sw b-" + b.key);
    name.append(sw, b.name);
    tr.append(name, el("td", null, `${fx(b.from, 2)}–${fx(b.to, 2)}`), el("td", "n big", p0(b.pct_wrong)),
      el("td", "n", pctRange(b.pct_wrong_ci95)), el("td", "n", n0(b.n)));
    tb.append(tr);
  }
  t.append(th, tb);
  bw.append(t);

  // reliability diagram and layer sweep side by side
  const cw = el("div");
  cw.append(el("h3", null, "Calibration"),
    el("p", "cap", rel ? `${POP[rel.subset] || rel.subset || "[TBD]"}, n = ${n0(rel.n)}, ECE ${fx(rel.ece, 3)}` : "[TBD]"));
  cw.append(sv("svg", { id: "relia", role: "img",
    "aria-label": rel ? "Reliability diagram: " + rel.bins.map((b) => `needle ${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}, mean ${fx(b.mean_pred, 2)}, right ${p0(b.frac_correct)}, n ${b.n}`).join("; ") : "Reliability bins [TBD]" }));

  const lc = sb.layer_curve || {};
  const lw = el("div");
  lw.append(el("h3", null, "Probe AUROC by layer"),
    el("p", "cap", `Spider, n = ${n0(lc.n)}, chose the layer`));
  const svg = sv("svg", { id: "layers", role: "img", "aria-label": `Probe AUROC by layer, ${lc.label || ""}` });
  lw.append(svg);
  const pair = el("div", "sb-pair");
  pair.append(cw, lw);
  right.append(bw, pair);

  col.replaceChildren(left, right);
  drawRelia();
  drawLayers();
  requestAnimationFrame(() => requestAnimationFrame(() => col.classList.add("drawn")));
}

// Reliability diagram: one dot per needle bin at (mean needle in the bin, share of its answers that were right),
// dot area proportional to the bin's question count; the dashed diagonal is perfect calibration and the short
// vertical stem is each bin's gap from it. Under the x axis, the three needle bands in the phone's colours.
function drawRelia() {
  const svg = $("relia");
  if (!svg) return;
  svg.replaceChildren();
  const W = svg.clientWidth, Hh = svg.clientHeight;
  if (!W || !Hh || !rel) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const small = (0.72 * fs).toFixed(1);
  const m = { l: 3 * fs, r: 0.9 * fs, t: 1.6 * fs, b: 1.7 * fs };
  const S = Math.min(W - m.l - m.r, Hh - m.t - m.b); // square plot, so the diagonal is at 45 degrees
  const X = (v) => m.l + v * S, Y = (v) => m.t + (1 - v) * S, y0 = m.t + S;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    if (v) svg.append(sv("line", { class: "grid-l", x1: X(0), x2: X(1), y1: Y(v), y2: Y(v) }));
    svg.append(sv("text", { x: X(0) - 0.85 * fs, y: Y(v) + 0.28 * fs, "text-anchor": "end", "font-size": small }, `${Math.round(v * 100)}%`));
  }
  const bands = [["ask", 0, 0.5], ["caution", 0.5, 0.8], ["cruise", 0.8, 1]];
  for (const [k, a, b] of bands) svg.append(sv("rect", { class: "band", x: X(a), y: y0, width: X(b) - X(a), height: 0.28 * fs, fill: `var(--${k})` }));
  for (const v of [0, 0.5, 0.8, 1]) {
    svg.append(sv("text", { x: X(v), y: y0 + 1.25 * fs, "text-anchor": v === 0 ? "start" : v === 1 ? "end" : "middle", "font-size": small }, v === 1 ? "1" : v ? v.toFixed(2) : "0"));
  }
  svg.append(sv("line", { class: "axis-l", x1: X(0), x2: X(0), y1: Y(1), y2: y0 }));
  svg.append(sv("text", { x: X(0) - 2.55 * fs, y: m.t - 0.75 * fs, "font-size": small }, "Answers right"));
  svg.append(sv("text", { x: X(1), y: y0 - 0.45 * fs, "text-anchor": "end", "font-size": small }, "Needle"));
  svg.append(sv("line", { class: "diag", x1: X(0), y1: Y(0), x2: X(1), y2: Y(1) }));
  const lx = X(0.42), ly = Y(0.42); // below the line, where no bin sits in this data
  svg.append(sv("text", { class: "diag-l", x: lx, y: ly + 1.15 * fs, "text-anchor": "middle", "font-size": small, transform: `rotate(-45 ${lx} ${ly})` }, "Perfect calibration"));
  const nMax = Math.max(...rel.bins.map((b) => b.n || 0)) || 1;
  const rMax = Math.min(0.62 * fs, S / 22);
  rel.bins.forEach((b, i) => {
    if (b.mean_pred == null || b.frac_correct == null || !b.n) return;
    const g = sv("g", { class: "rbin" });
    g.style.setProperty("--i", i);
    g.append(sv("title", null, `Needle ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: mean needle ${b.mean_pred.toFixed(3)}, right ${b.frac_correct.toFixed(3)} (n = ${n0(b.n)})`));
    g.append(sv("line", { class: "stem", x1: X(b.mean_pred), x2: X(b.mean_pred), y1: Y(b.mean_pred), y2: Y(b.frac_correct) }));
    g.append(sv("circle", { class: "hit", cx: X(b.mean_pred), cy: Y(b.frac_correct), r: Math.max(rMax, 0.7 * fs) }));
    g.append(sv("circle", { class: "dot", cx: X(b.mean_pred), cy: Y(b.frac_correct), r: Math.max(2, rMax * Math.sqrt(b.n / nMax)).toFixed(2) }));
    svg.append(g);
  });
  // the largest bin's count, as the scale for the dot areas
  const big = rel.bins.reduce((a, b) => ((b.n || 0) > (a.n || 0) ? b : a));
  if (big && big.n && big.mean_pred != null) {
    // beside the dot, on the side of the diagonal away from the line (below it for a bin near the bottom)
    const low = big.frac_correct < 0.5;
    const bx = X(big.mean_pred) + rMax + (low ? 1.1 : 0.45) * fs, by = low ? Y(big.frac_correct) - 0.3 * fs : Y(big.frac_correct) + 1.2 * fs;
    const t = sv("text", { class: "nlab", x: bx, y: by, "font-size": small }, `n = ${n0(big.n)}`);
    t.style.setProperty("--i", rel.bins.indexOf(big));
    svg.append(t);
  }
}

function drawLayers() {
  const svg = $("layers");
  if (!svg || !sb || !sb.layer_curve) return;
  const lc = sb.layer_curve;
  const pts = (lc.points || []).slice().sort((a, b) => a.layer - b.layer);
  const W = svg.clientWidth, Hh = svg.clientHeight;
  svg.replaceChildren();
  if (!W || !Hh || pts.length < 2) return;
  svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const m = { l: 2.6 * fs, r: 0.6 * fs, t: 1.6 * fs, b: 1.7 * fs };
  const L0 = pts[0].layer, L1 = pts[pts.length - 1].layer;
  // y axis on round 0.05 steps that hold every point, so the slope is read against labelled AUROC values
  const lo = Math.floor(Math.min(...pts.map((p) => p.auroc)) * 20 - 1e-9) / 20;
  const hi = Math.ceil(Math.max(...pts.map((p) => p.auroc)) * 20 + 1e-9) / 20;
  const X = (l) => m.l + ((l - L0) / (L1 - L0)) * (W - m.l - m.r);
  const Y = (a) => m.t + (1 - (a - lo) / (hi - lo || 1)) * (Hh - m.t - m.b);
  const small = (0.72 * fs).toFixed(1);
  for (let k = Math.round(lo * 20); k <= Math.round(hi * 20); k++) {
    const a = k / 20;
    if (k > Math.round(lo * 20)) svg.append(sv("line", { class: "grid-l", x1: m.l, x2: W - m.r, y1: Y(a), y2: Y(a) }));
    svg.append(sv("text", { x: m.l - 0.45 * fs, y: Y(a) + 0.28 * fs, "text-anchor": "end", "font-size": small }, a.toFixed(2)));
  }
  svg.append(sv("line", { class: "axis-l", x1: m.l, x2: W - m.r, y1: Hh - m.b, y2: Hh - m.b }));
  const sel = pts.find((p) => p.layer === lc.selected_layer);
  const gapPx = (a, b) => Math.abs(X(a) - X(b));
  const ticks = [L0, L1];
  if (sel) ticks.push(sel.layer);
  for (let l = Math.ceil(L0 / 10) * 10; l < L1; l += 10) if (ticks.every((t) => gapPx(l, t) > 2.2 * fs)) ticks.push(l);
  for (const l of ticks) {
    const anchor = l === L0 ? "start" : l === L1 ? "end" : "middle";
    svg.append(sv("line", { class: "axis-l", x1: X(l), x2: X(l), y1: Hh - m.b, y2: Hh - m.b + 0.3 * fs }));
    svg.append(sv("text", { x: X(l), y: Hh - m.b + 1.25 * fs, "text-anchor": anchor, "font-size": small, class: sel && l === sel.layer ? "strong" : "" },
      String(l)));
  }
  const line = sv("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.layer).toFixed(1)},${Y(p.auroc).toFixed(1)}`).join("") });
  svg.append(line);
  if (!reduced()) { // draws in layer by layer once the panel is marked drawn (#sbcol.drawn sets the offset to 0)
    const len = line.getTotalLength();
    line.setAttribute("stroke-dasharray", `${len}`);
    line.setAttribute("stroke-dashoffset", `${len}`);
    line.classList.add("draw");
  }
  for (const p of pts) {
    if (p === sel) continue;
    const g = sv("g");
    g.append(sv("title", null, `Layer ${p.layer}: AUROC ${p.auroc.toFixed(3)}`));
    g.append(sv("circle", { class: "hit", cx: X(p.layer), cy: Y(p.auroc), r: 0.7 * fs }), sv("circle", { class: "pt", cx: X(p.layer), cy: Y(p.auroc), r: 2.5 }));
    svg.append(g);
  }
  svg.append(sv("text", { x: W - m.r, y: Hh - m.b - 0.45 * fs, "text-anchor": "end", "font-size": small }, "Layer"));
  if (sel) {
    const g = sv("g");
    g.append(sv("title", null, `Layer ${sel.layer}: AUROC ${sel.auroc.toFixed(3)}, used by the probe`));
    g.append(sv("circle", { class: "sel", cx: X(sel.layer), cy: Y(sel.auroc), r: 5 }));
    svg.append(g);
    const nearRight = X(sel.layer) > W - 5 * fs; // keep the label inside the chart
    svg.append(sv("text", { x: nearRight ? X(sel.layer) + 0.5 * fs : X(sel.layer), y: Y(sel.auroc) - 0.7 * fs, "text-anchor": nearRight ? "end" : "middle", "font-size": small, class: "strong sel-l" },
      `Layer ${sel.layer}, used: ${sel.auroc.toFixed(3)}`));
  }
}

/* ---------- failures ---------- */
function renderFail() {
  const col = $("failcol");
  if (!sb) { col.replaceChildren(el("p", "noex", sbErr || "Loading")); return; }
  const negs = sb.negatives || [];
  const allFailed = negs.length && negs.every((x) => x.passed === false);
  const list = el("div", "negs");
  const cards = [];
  for (const x of negs) {
    const a = el("article", "neg ph");
    const top = el("div", "neg-top");
    top.append(el("h3", null, x.name), el("b", "neg-v" + (x.passed ? " pass" : ""), x.passed ? "Passed" : "Failed"));
    const dl = el("dl", "neg-m");
    const item = (k, v, sub) => {
      const d = el("div");
      const dd = el("dd", v.length > 34 ? "long" : null, v);
      if (sub) dd.append(el("small", null, sub));
      d.append(el("dt", null, k), dd);
      dl.append(d);
    };
    const fp = x.value && typeof x.value === "object" ? x.value.fisher_p_one_sided : null;
    // a measured value that carries its CI in brackets shows the CI on its own line, from x.ci
    const ci = Array.isArray(x.ci) && x.ci.length === 2 && /\s*\[[^\]]*\]\s*$/.test(x.measured) ? x.ci : null;
    const meas = ci ? String(x.measured).replace(/\s*\[[^\]]*\]\s*$/, "") : x.measured;
    item("Measured", ops(meas), fp != null ? `one-sided Fisher p = ${fp.toFixed(3)}` : ci ? `CI ${fx(ci[0], 3)}–${fx(ci[1], 3)}` : null);
    item("Bar", ops(x.bar));
    item("n", n0(x.n));
    a.append(top, el("p", "neg-q", x.test), dl);
    if (x.source) a.title = x.source;
    list.append(a);
    cards.push(a);
  }
  const nFail = negs.filter((x) => x.passed === false).length;
  col.replaceChildren(el("h2", null, allFailed ? `${negs.length} pre-registered tests, all failed` : `${negs.length} pre-registered tests, ${nFail} failed`), list);
  const anim = !reduced();
  cards.forEach((c, i) => (anim ? setTimeout(() => c.classList.add("on"), 120 + i * 140) : c.classList.add("on")));
}

/* ---------- wiring ---------- */
$("sbbtn").addEventListener("click", () => setPanel(panel === "sb" ? null : "sb"));
$("failbtn").addEventListener("click", () => setPanel(panel === "fail" ? null : "fail"));
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== "range") return;
  if (e.key === "s") setPanel(panel === "sb" ? null : "sb");
  else if (e.key === "f") setPanel(panel === "fail" ? null : "fail");
  else if (e.key === "Escape") panelOff();
});
addEventListener("resize", () => { if (panel === "sb") { drawRelia(); drawLayers(); } });

// Styles for the parts this file adds to the scoreboard (table.html holds the rest).
document.head.append(Object.assign(document.createElement("style"), { textContent: `
.sb-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 2rem; }
.sb-right > .sb-pair > div + div { margin-top: 0; }
.sb-pair #layers, #relia { display: block; width: 100%; height: clamp(11rem, calc(100vh - 34rem), 19rem); margin-top: 0.3rem; overflow: visible; }
#relia text, #layers text { font-family: "Poppins", sans-serif; fill: var(--ink-2); font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--panel); stroke-width: 5px; stroke-linejoin: round; }
#relia .grid-l, #layers .grid-l { stroke: var(--rule); stroke-width: 1; }
#relia .axis-l { stroke: var(--ink-2); stroke-width: 1; }
#relia .diag { stroke: var(--ink-2); stroke-width: 1.5; stroke-dasharray: 5 4; }
#relia .stem { stroke: var(--ink-2); stroke-width: 1.5; }
#relia .dot { fill: var(--ink); stroke: var(--panel); stroke-width: 1.5; }
#relia .hit { fill: transparent; }
#relia .rbin { opacity: 0; transform: scale(0.4); transform-box: fill-box; transform-origin: center; transition: opacity 180ms ease-out calc(var(--i) * 45ms + 300ms), transform 300ms var(--ease) calc(var(--i) * 45ms + 300ms); }
#sbcol.drawn #relia .rbin { opacity: 1; transform: none; }
#relia .nlab { opacity: 0; transition: opacity 200ms ease-out calc(var(--i) * 45ms + 450ms); }
#sbcol.drawn #relia .nlab { opacity: 1; }
#relia .diag, #relia .diag-l { opacity: 0; transition: opacity 260ms ease-out 120ms; }
#sbcol.drawn #relia .diag, #sbcol.drawn #relia .diag-l { opacity: 1; }
` }));
{
  const mk = new URLSearchParams(location.search).get("mock");
  if (mk === "scoreboard") setPanel("sb");
  else if (mk === "failures") setPanel("fail");
}
