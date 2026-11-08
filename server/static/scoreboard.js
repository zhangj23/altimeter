"use strict";
// Scoreboard and Failures panels on the table screen. Every number comes from data/scoreboard.json;
// a missing one shows [TBD]. Loaded after table.js and uses its helpers ($, el, sv, fx, setCov).

let sb = null;
let sbErr = null;
let panel = null; // "sb" | "fail" | null

function loadSb() {
  if (sb || sbErr) return Promise.resolve();
  return fetch("data/scoreboard.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((d) => { sb = d; })
    .catch((e) => { sbErr = `No data/scoreboard.json (${e.message}).`; });
}

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
  for (const v of [0, 0.5, 1]) {
    const i = el("i", v === 0.5 ? "chance" : null);
    i.style.left = `calc(${v * 100}% - ${v === 1 ? 1 : 0}px)`;
    grid.append(i);
  }
  auc.append(grid);
  const rows = (H.metrics || []).slice().sort((a, b) => b.auroc - a.auroc);
  for (const m of rows) {
    const r = el("div", "arow" + (m.key === "stacked" ? " ship" : ""));
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
  for (const [v, t, cls] of [[0, "0", "first"], [0.5, "Chance 0.50", "chance"], [1, "1", "last"]]) {
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

  const cal = sb.calibration || {};
  const cw = el("div");
  cw.append(el("h3", null, "Calibration"),
    el("p", "cap", `ECE ${fx(cal.ece, 3)}, n = ${n0(cal.n)}`));
  const ul = el("ul", "calib");
  const bins = (cal.reliability || []).filter((x) => x.bin[0] >= 0.8);
  for (const x of bins) {
    const li = el("li");
    li.append(`Needle ${x.bin[0].toFixed(1)}–${x.bin[1].toFixed(1)}: predicted `, el("b", null, p0(x.mean_pred)),
      ", actual ", el("b", null, p0(x.frac_correct)), ` (n = ${n0(x.n)})`);
    ul.append(li);
  }
  cw.append(ul);

  const lc = sb.layer_curve || {};
  const lw = el("div");
  lw.append(el("h3", null, "Probe AUROC by layer"),
    el("p", "cap", `Spider, n = ${n0(lc.n)}, used to pick the layer`));
  const svg = sv("svg", { id: "layers", role: "img", "aria-label": `Probe AUROC by layer, ${lc.label || ""}` });
  lw.append(svg);
  right.append(bw, cw, lw);

  col.replaceChildren(left, right);
  drawLayers();
  requestAnimationFrame(() => requestAnimationFrame(() => col.classList.add("drawn")));
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
  const m = { l: 0.6 * fs, r: 0.6 * fs, t: 1.6 * fs, b: 1.7 * fs };
  const L0 = pts[0].layer, L1 = pts[pts.length - 1].layer;
  const lo = Math.min(...pts.map((p) => p.auroc)), hi = Math.max(...pts.map((p) => p.auroc));
  const X = (l) => m.l + ((l - L0) / (L1 - L0)) * (W - m.l - m.r);
  const Y = (a) => m.t + (1 - (a - lo) / (hi - lo || 1)) * (Hh - m.t - m.b);
  const small = (0.72 * fs).toFixed(1);
  svg.append(sv("line", { class: "axis-l", x1: m.l, x2: W - m.r, y1: Hh - m.b, y2: Hh - m.b }));
  const sel = pts.find((p) => p.layer === lc.selected_layer);
  const lowest = pts.reduce((a, b) => (b.auroc < a.auroc ? b : a));
  for (const p of [pts[0], sel, pts[pts.length - 1]]) {
    if (!p) continue;
    const anchor = p === pts[0] ? "start" : p === pts[pts.length - 1] ? "end" : "middle";
    svg.append(sv("text", { x: X(p.layer), y: Hh - m.b + 1.2 * fs, "text-anchor": anchor, "font-size": small, class: p === sel ? "strong" : "" },
      String(p.layer)));
  }
  svg.append(sv("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.layer).toFixed(1)},${Y(p.auroc).toFixed(1)}`).join("") }));
  for (const p of pts) {
    if (p === sel) continue;
    const g = sv("g");
    g.append(sv("title", null, `Layer ${p.layer}: AUROC ${p.auroc.toFixed(3)}`));
    g.append(sv("circle", { class: "hit", cx: X(p.layer), cy: Y(p.auroc), r: 0.7 * fs }), sv("circle", { class: "pt", cx: X(p.layer), cy: Y(p.auroc), r: 2.5 }));
    svg.append(g);
  }
  svg.append(sv("text", { x: W - m.r, y: Hh - m.b - 0.45 * fs, "text-anchor": "end", "font-size": small }, "Layer"));
  if (lowest !== sel) { // above the lowest point, clear of its neighbours
    const k = pts.indexOf(lowest);
    const yTop = Math.min(...pts.slice(Math.max(0, k - 2), k + 3).map((p) => Y(p.auroc)));
    svg.append(sv("text", { x: X(pts[Math.max(0, k - 2)].layer), y: yTop - 0.6 * fs, "text-anchor": "start", "font-size": small },
      `Layer ${lowest.layer}: ${lowest.auroc.toFixed(3)}`));
  }
  if (sel) {
    const g = sv("g");
    g.append(sv("title", null, `Layer ${sel.layer}: AUROC ${sel.auroc.toFixed(3)}, used by the probe`));
    g.append(sv("circle", { class: "sel", cx: X(sel.layer), cy: Y(sel.auroc), r: 5 }));
    svg.append(g);
    svg.append(sv("text", { x: X(sel.layer), y: Y(sel.auroc) - 0.7 * fs, "text-anchor": "middle", "font-size": small, class: "strong" },
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
    item("Measured", ops(x.measured), fp != null ? `one-sided Fisher p = ${fp.toFixed(3)}` : null);
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
addEventListener("resize", () => { if (panel === "sb") drawLayers(); });
{
  const mk = new URLSearchParams(location.search).get("mock");
  if (mk === "scoreboard") setPanel("sb");
  else if (mk === "failures") setPanel("fail");
}
