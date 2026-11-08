/* Altimeter explainer scenes. ?s=1..5 picks a scene; it autoplays on load.
   R or click: replay. Left/Right: previous/next scene. ?t=<sec>: freeze at that time. ?wait=1: hold at t=0 until window.__play().
   Every animation is a function of the scene clock, so two runs produce the same frames. */
"use strict";

const NS = "http://www.w3.org/2000/svg";
const C = {
  panel: "#171a1f", panel2: "#1f232a", panel3: "#282d35", face: "#0f1114", bezel: "#3a414b",
  ink: "#e8e6e0", ink2: "#9ca1a8", ink3: "#6b7078", rule: "#343a43",
  ask: "#cf5c4f", caution: "#d6a63e", cruise: "#5fae76",
};
const N_SCENES = 5;

/* ---------- easing ---------- */
const EASE = {
  lin: (p) => p,
  io: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: (p) => 1 - Math.pow(1 - p, 3),
  in: (p) => p * p * p,
  swing: (p) => 1 - Math.pow(1 - p, 4), // close to the app's cubic-bezier(.3,.75,.25,1)
};
const clamp01 = (p) => Math.max(0, Math.min(1, p));

/* ---------- scene state ---------- */
let svg = null, nodes = [], ticks = [], DUR = 10;

function E(tag, attrs = {}, parent = svg) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  parent.appendChild(n);
  return n;
}
function G(parent = svg, attrs = {}) { return E("g", attrs, parent); }
function T(parent, x, y, str, o = {}) {
  const n = E("text", {
    x, y, "font-size": o.size || 28, "font-weight": o.w || 400, fill: o.fill || C.ink,
    "text-anchor": o.anchor || "start",
  }, parent);
  if (o.mono) n.setAttribute("class", "mono");
  n.textContent = str;
  return n;
}
/* animated node: state {x,y,s,sx,sy,r,o,d}; ox/oy is the origin for scale and rotate */
function A(node, base = {}) {
  node.__st = Object.assign({ x: 0, y: 0, s: 1, sx: 1, sy: 1, r: 0, o: 1, d: null, ox: 0, oy: 0 }, base);
  node.__base = Object.assign({}, node.__st);
  node.__tr = {};
  node.__last = {};
  node.__pre = node.getAttribute("transform") || ""; // static placement, kept in front of the animated part
  nodes.push(node);
  return node;
}
function tw(node, prop, t0, dur, from, to, ease = "io") {
  if (!node.__tr) A(node);
  (node.__tr[prop] = node.__tr[prop] || []).push({ t0, dur, from, to, ease: EASE[ease] });
  node.__tr[prop].sort((a, b) => a.t0 - b.t0);
  return node;
}
function dashable(node) { node.setAttribute("pathLength", "1"); node.setAttribute("stroke-dasharray", "1 1"); return node; }
function fadeIn(node, t0, dur = 0.5, dy = 0) {
  tw(node, "o", t0, dur, 0, 1, "out");
  if (dy) tw(node, "y", t0, dur, dy, 0, "out");
  return node;
}

function val(segs, t) {
  let v = segs[0].from;
  for (const s of segs) {
    if (t < s.t0) break;
    const p = s.dur > 0 ? clamp01((t - s.t0) / s.dur) : 1;
    v = s.from + (s.to - s.from) * s.ease(p);
  }
  return v;
}

function render(t) {
  for (const n of nodes) {
    const st = Object.assign({}, n.__base);
    for (const k in n.__tr) st[k] = val(n.__tr[k], t);
    let tf = n.__pre;
    if (st.x || st.y) tf += ` translate(${st.x.toFixed(2)} ${st.y.toFixed(2)})`;
    if (st.r) tf += ` rotate(${st.r.toFixed(3)} ${st.ox} ${st.oy})`;
    const sx = st.s * st.sx, sy = st.s * st.sy;
    if (sx !== 1 || sy !== 1) tf += ` translate(${st.ox} ${st.oy}) scale(${Math.max(sx, 0.0001).toFixed(4)} ${Math.max(sy, 0.0001).toFixed(4)}) translate(${-st.ox} ${-st.oy})`;
    if (tf !== n.__last.tf) { tf ? n.setAttribute("transform", tf) : n.removeAttribute("transform"); n.__last.tf = tf; }
    const o = (Math.abs(sx) < 0.002 || Math.abs(sy) < 0.002 ? 0 : st.o).toFixed(3); // a zero-scaled shape leaves no sliver
    if (o !== n.__last.o) { n.setAttribute("opacity", o); n.__last.o = o; }
    if (st.d != null) {
      const d = st.d.toFixed(4);
      if (d !== n.__last.d) { n.style.strokeDashoffset = d; n.__last.d = d; }
    }
  }
  for (const f of ticks) f(t);
}

/* ---------- shared pieces ---------- */
function title(str) {
  const n = T(svg, 120, 118, str, { size: 56, w: 600 });
  fadeIn(A(n), 0, 0.7, 14);
  return n;
}

// flat-bottomed cloud: a row of arcs on a baseline (same look as the app's cloud banks)
function cloudD(x0, base, s, bumps) {
  let x = x0, d = `M${x0},${base}`;
  for (const r of bumps) { d += ` A${r * s},${r * s * 0.95} 0 0 1 ${(x + 2 * r * s).toFixed(1)},${base}`; x += 2 * r * s; }
  return d + " Z";
}
function cloudWidth(s, bumps) { return 2 * s * bumps.reduce((a, b) => a + b, 0); }

// the app's drifting banks along the bottom edge (app.js cloudPath)
function bankPath(seed, W, H, base, rMin, rMax) {
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
function bottomClouds() {
  const host = G(svg, { transform: "translate(0 930)" });
  const W = 2600, H = 150;
  [[11, 40, 60, 80, 0.45, 9], [29, 85, 42, 64, 0.6, -13], [47, 120, 28, 48, 0.8, 18]].forEach(([seed, base, r0, r1, op, v]) => {
    const g = A(G(host, { opacity: op }), { o: op });
    E("path", { d: bankPath(seed, W, H, base, r0, r1), fill: C.panel3 }, g);
    fadeIn(g, 0, 1.2); g.__tr.o[0].to = op;
    ticks.push((t) => g.setAttribute("transform", `translate(${(-v * t - (v < 0 ? 300 : 0)).toFixed(2)} 0)`));
  });
}

// horizontal band strip; p maps 0..1 onto w
function hTape(parent, x, y, w, h = 18) {
  const g = G(parent, { transform: `translate(${x} ${y})` });
  E("rect", { x: 0, y: 0, width: w * 0.5, height: h, fill: C.ask }, g);
  E("rect", { x: w * 0.5, y: 0, width: w * 0.3, height: h, fill: C.caution }, g);
  E("rect", { x: w * 0.8, y: 0, width: w * 0.2, height: h, fill: C.cruise }, g);
  return g;
}
// vertical band strip: Ask at the bottom, Cruise on top (altitude)
function vTape(parent, x, y, w, h) {
  const g = G(parent, { transform: `translate(${x} ${y})` });
  E("rect", { x: 0, y: h * 0.5, width: w, height: h * 0.5, fill: C.ask }, g);
  E("rect", { x: 0, y: h * 0.2, width: w, height: h * 0.3, fill: C.caution }, g);
  E("rect", { x: 0, y: 0, width: w, height: h * 0.2, fill: C.cruise }, g);
  return g;
}
// needle for an hTape: hollow (awaiting) and filled heads; returns {g, hollow, filled}
function hNeedle(parent, top, bottom) {
  const g = G(parent);
  const hollow = A(G(g));
  E("line", { x1: 0, y1: top + 12, x2: 0, y2: bottom, stroke: C.ink2, "stroke-width": 3, "stroke-dasharray": "6 5" }, hollow);
  E("path", { d: `M-10,${top} L10,${top} L0,${top + 14} Z`, fill: C.panel, stroke: C.ink2, "stroke-width": 2 }, hollow);
  const filled = A(G(g), { o: 0 });
  E("line", { x1: 0, y1: top + 12, x2: 0, y2: bottom, stroke: C.ink, "stroke-width": 4 }, filled);
  E("path", { d: `M-11,${top} L11,${top} L0,${top + 15} Z`, fill: C.ink }, filled);
  return { g: A(g), hollow, filled };
}

// point at fraction f of the length of a polyline
function along(pts) {
  const seg = [];
  let L = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); L += l; }
  return (f) => {
    let d = clamp01(f) * L;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const q = seg[i] ? Math.min(1, d / seg[i]) : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * q, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * q];
      }
      d -= seg[i];
    }
    return pts[pts.length - 1];
  };
}
const ptsAttr = (pts) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/* ---------- 1. The problem ---------- */
function scene1() {
  title("Wrong looks right");
  bottomClouds();
  const W = 640, Y = 250, H = 380;
  const cards = [
    { x: 240, v: "205", sql: ["SELECT SUM(amount) FROM budget b", "WHERE b.link_to_event = e.event_id"], p: 0.9, band: "Cruise", col: C.cruise },
    { x: 1040, v: "355", sql: ["SELECT SUM(b.amount) FROM event e", "JOIN budget b … JOIN expense x"], p: 0.25, band: "Ask", col: C.ask },
  ];
  cards.forEach((c, i) => {
    const g = A(G(svg, { transform: `translate(${c.x} ${Y})` }));
    const inner = A(G(g));
    E("rect", { x: 0, y: 0, width: W, height: H, rx: 4, fill: C.panel2, stroke: C.bezel, "stroke-width": 2 }, inner);
    const edge = A(E("rect", { x: 0, y: 0, width: W, height: H, rx: 4, fill: "none", stroke: c.col, "stroke-width": 3 }, inner), { o: 0 });
    T(inner, 48, 74, "November Meeting budget", { size: 32, w: 500 });
    T(inner, 48, 134, c.sql[0], { size: 22, fill: C.ink2, mono: true });
    T(inner, 48, 168, c.sql[1], { size: 22, fill: C.ink2, mono: true });
    T(inner, 44, 320, c.v, { size: 112, w: 600 });
    fadeIn(inner, 0.5, 0.8, 30);
    tw(edge, "o", 6.2, 0.5, 0, 1, "out");
    if (i === 1) {
      const strike = dashable(E("line", { x1: 36, y1: 284, x2: 270, y2: 284, stroke: C.ask, "stroke-width": 7 }, inner));
      A(strike, { d: 1 });
      tw(strike, "d", 6.3, 0.5, 1, 0, "out");
    }
    // tape + needle under the card
    const tape = A(hTape(svg, c.x, 712, W), { o: 0 });
    tw(tape, "o", 3.4, 0.5, 0, 0.38, "out");
    tw(tape, "o", 4.4, 0.6, 0.38, 1, "out");
    const nd = hNeedle(svg, 690, 742);
    const ng = A(G(svg), { o: 0 });
    ng.appendChild(nd.g);
    tw(ng, "o", 3.4, 0.5, 0, 1, "out");
    nd.g.__base.x = c.x + W * 0.5;
    tw(nd.g, "x", 4.1, 1.2, c.x + W * 0.5, c.x + W * c.p, "swing");
    tw(nd.hollow, "o", 4.1, 0.3, 1, 0);
    tw(nd.filled, "o", 4.1, 0.3, 0, 1);
    const lbl = A(T(nd.g, 0, 784, c.band, { size: 28, w: 600, fill: c.col, anchor: "middle" }), { o: 0 });
    tw(lbl, "o", 5.2, 0.4, 0, 1, "out");
  });
  // inspection pass: the same sweep over both cards finds nothing to tell them apart
  const scan = A(E("line", { x1: 0, y1: 232, x2: 0, y2: 648, stroke: C.ink2, "stroke-width": 2 }), { o: 0, x: 200 });
  tw(scan, "x", 1.6, 1.6, 200, 1720, "io");
  tw(scan, "o", 1.6, 0.2, 0, 1, "lin");
  tw(scan, "o", 3.0, 0.2, 1, 0, "lin");
  fadeIn(A(T(svg, 1360, 862, "Double counted: 73% too high", { size: 32, w: 500, anchor: "middle" })), 6.9, 0.6, 10);
  return 10;
}

/* ---------- 2. Why local ---------- */
function scene2() {
  title("Why local");
  // cloud + closed model
  const bumps = [60, 100, 130, 95, 60], s = 0.9, cw = cloudWidth(s, bumps);
  const cloud = A(G(svg));
  E("path", { d: cloudD(960 - cw / 2, 330, s, bumps), fill: C.panel3 }, cloud);
  E("rect", { x: 830, y: 238, width: 260, height: 92, rx: 4, fill: C.face, stroke: C.bezel, "stroke-width": 2 }, cloud);
  T(cloud, 960, 293, "Closed model", { size: 26, w: 500, fill: C.ink2, anchor: "middle" });
  fadeIn(cloud, 0.5, 0.8, -24);

  // laptop
  const lap = G(svg);
  const scr = A(dashable(E("rect", { x: 500, y: 500, width: 920, height: 400, rx: 10, fill: "none", stroke: C.ink3, "stroke-width": 3 }, lap)), { d: 1 });
  tw(scr, "d", 0.3, 1.1, 1, 0, "io");
  const base = A(E("path", { d: "M420,912 H1500 L1462,940 H458 Z", fill: "none", stroke: C.ink3, "stroke-width": 3 }, lap), { o: 0 });
  tw(base, "o", 1.0, 0.5, 0, 1, "out");

  // data rows (stay put)
  const tbl = G(svg);
  const hdr = A(G(tbl), { o: 0 });
  [[560, 130], [700, 100], [810, 90]].forEach(([x, w]) => E("rect", { x, y: 556, width: w, height: 24, fill: C.ink3 }, hdr));
  tw(hdr, "o", 1.1, 0.4, 0, 0.6, "out");
  for (let r = 0; r < 6; r++) {
    const row = A(G(tbl), { o: 0 });
    [[560, 130], [700, 100], [810, 90]].forEach(([x, w]) => E("rect", { x, y: 596 + r * 38, width: w, height: 24, fill: C.panel3 }, row));
    fadeIn(row, 1.2 + r * 0.08, 0.4);
  }
  const sent = A(G(svg), { o: 0 });
  T(sent, 560, 870, "Rows sent:", { size: 28, w: 500, fill: C.ink2 });
  T(sent, 716, 870, "0", { size: 28, w: 600, fill: C.ink });
  fadeIn(sent, 2.0, 0.5);

  // local model: layers visible
  const LX = 1040, LW = 260, LY = 590, GAP = 22, NL = 11;
  const mlabel = A(T(svg, LX + LW / 2, 562, "Local model", { size: 26, w: 500, fill: C.ink2, anchor: "middle" }), { o: 0 });
  fadeIn(mlabel, 2.0, 0.5);
  for (let i = 0; i < NL; i++) {
    const l = A(E("rect", { x: LX, y: LY + i * GAP, width: LW, height: 10, fill: "none", stroke: C.ink3, "stroke-width": 1.5 }), { o: 0 });
    fadeIn(l, 1.4 + (NL - 1 - i) * 0.05, 0.35);
  }
  const PICK = 3, py = LY + PICK * GAP + 5;
  const hl = A(E("rect", { x: LX, y: LY + PICK * GAP, width: LW, height: 10, fill: C.ink, stroke: C.ink, "stroke-width": 1.5 }), { o: 0 });
  tw(hl, "o", 4.0, 0.4, 0, 1, "out");

  // vertical gauge right of the layers
  const TX = 1336, TY = LY, TH = 230;
  const gauge = A(vTape(svg, TX, TY, 16, TH), { o: 0 });
  tw(gauge, "o", 2.2, 0.5, 0, 0.38, "out");
  tw(gauge, "o", 4.6, 0.5, 0.38, 1, "out");
  const tie = A(dashable(E("path", { d: `M${LX + LW},${py} H${TX - 4}`, fill: "none", stroke: C.ink, "stroke-width": 3 })), { d: 1 });
  tw(tie, "d", 4.2, 0.4, 1, 0, "out");
  const ptr = A(G(svg), { o: 0, y: TY + TH * 0.5 });
  E("path", { d: `M${TX + 20},0 L${TX + 36},-10 L${TX + 36},10 Z`, fill: C.ink }, ptr);
  tw(ptr, "o", 4.5, 0.3, 0, 1, "out");
  tw(ptr, "y", 4.7, 1.0, TY + TH * 0.5, TY + TH * 0.72, "swing"); // p = 0.28: Ask

  // a probe aimed at the closed model stops at its wall
  const PX = 1344;
  const probe = A(dashable(E("path", { d: `M${PX},${TY - 6} V284 H1096`, fill: "none", stroke: C.ink2, "stroke-width": 3 })), { d: 1 });
  tw(probe, "d", 2.6, 0.8, 1, 0, "io");
  const probeHit = A(E("path", { d: `M${PX},${TY - 6} V284 H1096`, fill: "none", stroke: C.ask, "stroke-width": 3 }), { o: 0 });
  const wall = A(E("line", { x1: 1096, y1: 262, x2: 1096, y2: 306, stroke: C.ask, "stroke-width": 5 }), { o: 0 });
  tw(probeHit, "o", 3.4, 0.25, 0, 1, "out");
  tw(wall, "o", 3.4, 0.25, 0, 1, "out");
  tw(probe, "o", 0, 0, 1, 1, "lin");
  [probe, probeHit, wall].forEach((n) => tw(n, "o", 4.0, 0.5, 1, 0.25, "out"));

  // escalation: only schema + question rises; rows stay
  const lane = (x, y0, y1, t0, dur, col) => {
    const ln = A(dashable(E("path", { d: `M${x},${y0} V${y1}`, fill: "none", stroke: col, "stroke-width": 2.5 })), { d: 1 });
    tw(ln, "d", t0, dur, 1, 0, "io");
    const dir = y1 < y0 ? -1 : 1;
    const hd = A(E("path", { d: `M${x - 9},${y1 - dir * 14} L${x + 9},${y1 - dir * 14} L${x},${y1} Z`, fill: col }), { o: 0 });
    tw(hd, "o", t0 + dur - 0.15, 0.2, 0, 1, "out");
  };
  lane(900, 498, 334, 5.9, 1.4, C.ink);
  const pk = A(G(svg), { o: 0, x: 900, y: 524 });
  E("rect", { x: -150, y: -26, width: 300, height: 52, rx: 3, fill: C.panel2, stroke: C.ink, "stroke-width": 2 }, pk);
  T(pk, 0, 9, "Schema + question", { size: 24, w: 500, anchor: "middle" });
  tw(pk, "o", 5.9, 0.3, 0, 1, "out");
  tw(pk, "y", 5.9, 1.6, 524, 404, "io");
  // returned SQL comes back down to run locally
  lane(1160, 334, 498, 8.0, 1.2, C.ink2);
  const back = A(G(svg), { o: 0, x: 1160, y: 372 });
  E("rect", { x: -54, y: -24, width: 108, height: 48, rx: 3, fill: C.panel2, stroke: C.ink2, "stroke-width": 2 }, back);
  T(back, 0, 8, "SQL", { size: 24, w: 500, fill: C.ink2, anchor: "middle", mono: true });
  tw(back, "o", 8.0, 0.3, 0, 1, "out");
  tw(back, "y", 8.0, 1.2, 372, 440, "io");
  return 11;
}

/* ---------- 3. Why one layer ---------- */
const BIRD = [0.685, 0.6629, 0.6899, 0.6869, 0.6681, 0.6813, 0.6966, 0.6962, 0.6816, 0.6986, 0.7087, 0.6989, 0.7102, 0.6943,
  0.7211, 0.7047, 0.6999, 0.7073, 0.7249, 0.726, 0.7555, 0.7614, 0.7628, 0.749, 0.7818, 0.782, 0.7973, 0.7913, 0.7656, 0.7634,
  0.7807, 0.7727, 0.7386, 0.7542, 0.765, 0.763, 0.7653]; // ~/models/probe_layers.json bird_oof_auroc[0], layers 0..36
function scene3() {
  title("Why one layer");
  const X0 = 260, X1 = 1660, YB = 920, VMIN = 0.5, PX = (X1 - X0) / 36, PY = 680 / 0.35;
  const X = (l) => X0 + l * PX, Y = (v) => YB - (v - VMIN) * PY;
  const axes = A(G(svg), { o: 0 });
  [0.6, 0.7, 0.8].forEach((v) => {
    E("line", { x1: X0, y1: Y(v), x2: X1, y2: Y(v), stroke: C.rule, "stroke-width": 1.5 }, axes);
    T(axes, X0 - 22, Y(v) + 8, v.toFixed(1), { size: 22, fill: C.ink3, anchor: "end" });
  });
  E("line", { x1: X0, y1: YB, x2: X1, y2: YB, stroke: C.ink3, "stroke-width": 2 }, axes);
  [0, 10, 20, 26, 36].forEach((l) => {
    E("line", { x1: X(l), y1: YB, x2: X(l), y2: YB + 10, stroke: C.ink3, "stroke-width": 2 }, axes);
    T(axes, X(l), YB + 42, String(l), { size: 22, fill: C.ink3, anchor: "middle" });
  });
  T(axes, X1 + 20, YB + 8, "Layer", { size: 22, fill: C.ink3 });
  T(axes, X0 - 22, 238, "AUROC", { size: 22, fill: C.ink3, anchor: "end" });
  fadeIn(axes, 0.4, 0.6);

  // layer 26 is locked on Spider before BIRD is drawn
  const lock = A(G(svg), { o: 0, sy: 0, ox: X(26), oy: 250 });
  E("line", { x1: X(26), y1: 250, x2: X(26), y2: YB, stroke: C.ink2, "stroke-width": 2.5, "stroke-dasharray": "8 8" }, lock);
  tw(lock, "o", 1.2, 0.2, 0, 1, "lin");
  tw(lock, "sy", 1.2, 0.9, 0, 1, "io");
  const lockLbl = A(T(svg, X(26), 228, "Picked on Spider", { size: 26, w: 500, fill: C.ink2, anchor: "middle" }), { o: 0 });
  fadeIn(lockLbl, 1.7, 0.5, 8);
  const lockLbl2 = A(T(svg, X(26), 228, "Picked on Spider", { size: 26, w: 500, fill: C.ink, anchor: "middle" }), { o: 0 });
  tw(lockLbl2, "o", 6.4, 0.4, 0, 1, "out");

  // random-weights model: same as real at layer 0, 0.52-0.60 from layer 20 on
  const band = A(G(svg), { o: 0, sx: 0, ox: X(20), oy: 0 });
  E("rect", { x: X(20), y: Y(0.6), width: X(36) - X(20), height: Y(0.52) - Y(0.6), fill: C.ink3, "fill-opacity": 0.28, stroke: C.ink3, "stroke-width": 1.5 }, band);
  T(band, (X(26) + X(36)) / 2, Y(0.56) - 4, "Random weights", { size: 26, w: 500, fill: C.ink2, anchor: "middle" });
  T(band, (X(26) + X(36)) / 2, Y(0.56) + 30, "0.52–0.60", { size: 22, fill: C.ink3, anchor: "middle" });
  tw(band, "o", 7.7, 0.3, 0, 1, "lin");
  tw(band, "sx", 7.7, 1.0, 0, 1, "io");
  const ring0 = A(E("circle", { cx: X(0), cy: Y(0.688), r: 15, fill: C.ink3, "fill-opacity": 0.28, stroke: C.ink3, "stroke-width": 2.5 }), { o: 0, s: 0.3, ox: X(0), oy: Y(0.688) });
  tw(ring0, "o", 7.1, 0.3, 0, 1, "out");
  tw(ring0, "s", 7.1, 0.5, 0.3, 1, "swing");

  // BIRD curve
  const pts = BIRD.map((v, l) => [X(l), Y(v)]);
  const curve = A(dashable(E("polyline", { points: ptsAttr(pts), fill: "none", stroke: C.ink, "stroke-width": 5, "stroke-linejoin": "round", "stroke-linecap": "round" })), { d: 1 });
  const C0 = 2.6, CD = 3.8;
  tw(curve, "d", C0, CD, 1, 0, "io");
  const pos = along(pts);
  const dot = E("circle", { cx: 0, cy: 0, r: 9, fill: C.ink, opacity: 0 });
  ticks.push((t) => {
    const f = EASE.io(clamp01((t - C0) / CD));
    const [x, y] = pos(f);
    dot.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    dot.setAttribute("opacity", t < C0 ? 0 : t < C0 + CD ? 1 : Math.max(0, 1 - (t - C0 - CD) / 0.3).toFixed(3));
  });
  fadeIn(A(T(svg, X(0) + 12, Y(0.685) - 22, "0.685", { size: 22, fill: C.ink2 })), C0, 0.4);
  const peak = A(E("circle", { cx: X(26), cy: Y(0.7973), r: 15, fill: "none", stroke: C.ink, "stroke-width": 3.5 }), { o: 0, s: 0.3, ox: X(26), oy: Y(0.7973) });
  tw(peak, "o", 6.3, 0.3, 0, 1, "out");
  tw(peak, "s", 6.3, 0.6, 0.3, 1, "swing");
  fadeIn(A(T(svg, X(26) + 26, Y(0.7973) - 22, "0.797", { size: 32, w: 600 })), 6.4, 0.5, 8);
  const endLbl = A(G(svg), { o: 0 });
  T(endLbl, X(36) + 18, Y(0.7653) - 6, "BIRD", { size: 24, w: 600 });
  T(endLbl, X(36) + 18, Y(0.7653) + 24, "0.765", { size: 22, fill: C.ink2 });
  fadeIn(endLbl, 6.3, 0.5);
  return 11;
}

/* ---------- 4. Why logistic regression ---------- */
// One real reading (codebase_community, "How many users are there?"; saved live result, explain().stack_terms):
// [label, weight, standardized input, contribution = weight x input]. intercept + sum = logit 2.326, needle 0.911.
const READING_Q = "How many users are there?";
const STACK = [
  ["Compiles", 2.648, 0.567, 1.502], ["SQL tokens", -0.748, -0.934, 0.699], ["Mean log-prob", 0.692, 0.392, 0.271],
  ["Probe", 0.537, 1.336, 0.717], ["SQL length", -0.376, -0.977, 0.367], ["Question length", -0.188, -1.331, 0.251],
  ["Min log-prob", -0.176, 1.518, -0.266], ["Subqueries", 0.115, -0.397, -0.046], ["Joins", 0.097, -0.686, -0.066],
  ["Prompt length", -0.054, 0.770, -0.042], ["Aggregates", 0.053, 0.291, 0.015], ["Intercept", -1.0765, null, -1.0765],
];
const LOGIT = 2.3262306692942882, NEEDLE = 0.9110262775892934;
function scene4() {
  title("Why logistic regression");
  const LX = 340, WX = 432, IX = 540, X0 = 580, K = 110, RY = 252, RH = 50, BH = 26;
  const sgn = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
  fadeIn(A(T(svg, 120, 182, `“${READING_Q}”`, { size: 24, w: 500, fill: C.ink2 })), 0.4, 0.5);
  fadeIn(A(T(svg, WX, 220, "Weight", { size: 20, fill: C.ink3, anchor: "end" })), 0.5, 0.5);
  fadeIn(A(T(svg, IX, 220, "× Input", { size: 20, fill: C.ink3, anchor: "end" })), 2.7, 0.4);
  fadeIn(A(T(svg, X0, 220, "= Contribution", { size: 20, fill: C.ink3 })), 2.7, 0.4);
  const M0 = 2.8, S0 = 4.9; // morph to contribution; slide into the sum
  let cum = 0;
  STACK.forEach(([name, w, x, c], i) => {
    const y = RY + i * RH;
    const lbl = A(G(svg), { o: 0 });
    T(lbl, LX, y + 8, name, { size: 22, fill: C.ink2, anchor: "end" });
    T(lbl, WX, y + 8, sgn(w), { size: 22, w: 500, fill: C.ink, anchor: "end" });
    fadeIn(lbl, 0.6 + i * 0.1, 0.4);
    if (x !== null) fadeIn(A(T(svg, IX, y + 8, sgn(x), { size: 22, w: 500, fill: C.ink2, anchor: "end" })), M0 + i * 0.1, 0.35);
    const bar = A(G(svg), { sx: 0, ox: X0, oy: y });
    const wcol = w > 0 ? C.cruise : C.ask, ccol = c > 0 ? C.cruise : C.ask;
    const r1 = A(E("rect", { x: X0, y: y - BH / 2, width: Math.abs(w) * K, height: BH, fill: wcol }, bar));
    if (ccol !== wcol) {
      const r2 = A(E("rect", { x: X0, y: y - BH / 2, width: Math.abs(w) * K, height: BH, fill: ccol }, bar), { o: 0 });
      tw(r1, "o", M0 + i * 0.1, 0.6, 1, 0, "io");
      tw(r2, "o", M0 + i * 0.1, 0.6, 0, 1, "io");
    }
    tw(bar, "sx", 0.8 + i * 0.12, 0.5, 0, 1, "out");
    tw(bar, "sx", M0 + i * 0.1, 0.7, 1, Math.abs(c) / Math.abs(w), "io"); // weight -> weight x input
    const next = cum + c;
    tw(bar, "x", S0 + i * 0.06, 0.8, 0, (c > 0 ? cum : next) * K, "io");
    cum = next;
  });
  // the contributions sum to the logit
  const SY = RY + STACK.length * RH + 30, end = X0 + LOGIT * K;
  const sep = A(E("line", { x1: 200, y1: SY - 36, x2: 1000, y2: SY - 36, stroke: C.rule, "stroke-width": 2 }), { o: 0 });
  tw(sep, "o", 5.8, 0.4, 0, 1, "out");
  fadeIn(A(T(svg, LX, SY + 8, "Logit", { size: 22, w: 600, anchor: "end" })), 5.9, 0.4);
  fadeIn(A(T(svg, WX, SY + 8, sgn(LOGIT), { size: 22, w: 600, anchor: "end" })), 6.5, 0.4);
  const sum = A(E("rect", { x: X0, y: SY - BH / 2, width: LOGIT * K, height: BH, fill: C.ink }), { sx: 0, ox: X0, oy: SY });
  tw(sum, "sx", 6.0, 0.6, 0, 1, "io");

  // sigmoid onto the altitude tape (z axis on the Logit row)
  const ZX0 = 1060, ZW = 340, ZY = SY, PH = 320;
  const zx = (z) => ZX0 + (z + 6) / 12 * ZW, py = (p) => ZY - p * PH;
  const sig = A(G(svg), { o: 0 });
  E("line", { x1: ZX0, y1: ZY, x2: ZX0 + ZW, y2: ZY, stroke: C.ink3, "stroke-width": 2 }, sig);
  E("line", { x1: ZX0, y1: py(0.5), x2: ZX0 + ZW, y2: py(0.5), stroke: C.rule, "stroke-width": 1.5, "stroke-dasharray": "6 6" }, sig);
  T(sig, ZX0 + 95, py(0.8) + 14, "σ", { size: 40, w: 500, fill: C.ink2 });
  tw(sig, "o", 6.0, 0.5, 0, 1, "out");
  const sp = [];
  for (let z = -6; z <= 6.001; z += 0.25) sp.push([zx(z), py(1 / (1 + Math.exp(-z)))]);
  const scurve = A(dashable(E("polyline", { points: ptsAttr(sp), fill: "none", stroke: C.ink, "stroke-width": 4, "stroke-linecap": "round" })), { d: 1 });
  tw(scurve, "d", 6.1, 0.8, 1, 0, "io");
  const TX = 1480;
  const tape = A(vTape(svg, TX, py(1), 20, PH), { o: 0 });
  tw(tape, "o", 6.2, 0.5, 0, 0.38, "out");
  tw(tape, "o", 8.0, 0.4, 0.38, 1, "out");
  const names = A(G(svg), { o: 0 });
  T(names, TX + 36, py(0.9) + 8, "Cruise", { size: 22, fill: C.ink2 });
  T(names, TX + 36, py(0.65) + 8, "Caution", { size: 22, fill: C.ink2 });
  T(names, TX + 36, py(0.25) + 8, "Ask", { size: 22, fill: C.ink2 });
  fadeIn(names, 6.3, 0.5);
  const p = NEEDLE;
  const route = [[end, ZY], [zx(LOGIT), ZY], [zx(LOGIT), py(p)], [TX - 8, py(p)]];
  const path = A(dashable(E("polyline", { points: ptsAttr(route), fill: "none", stroke: C.ink2, "stroke-width": 3 })), { d: 1 });
  const R0 = 6.8, RD = 1.3;
  tw(path, "d", R0, RD, 1, 0, "io");
  const pos = along(route);
  const dot = E("circle", { cx: 0, cy: 0, r: 9, fill: C.ink, opacity: 0 });
  ticks.push((t) => {
    const [x, y] = pos(EASE.io(clamp01((t - R0) / RD)));
    dot.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    dot.setAttribute("opacity", t < R0 ? 0 : t < R0 + RD ? 1 : Math.max(0, 1 - (t - R0 - RD) / 0.25).toFixed(3));
  });
  const head = A(E("path", { d: `M${TX - 4},${py(p)} L${TX - 22},${py(p) - 11} L${TX - 22},${py(p) + 11} Z`, fill: C.ink }), { o: 0 });
  tw(head, "o", R0 + RD - 0.1, 0.25, 0, 1, "out");
  fadeIn(A(T(svg, TX - 30, py(p) + 40, p.toFixed(2), { size: 30, w: 600, anchor: "end" })), R0 + RD, 0.4, -6);

  // nonlinear models on the same splits land no higher
  const AX = 1130, VY = (v) => 480 - (v - 0.74) * (260 / 0.18);
  const cmp = A(G(svg), { o: 0 });
  E("line", { x1: AX, y1: VY(0.74), x2: AX, y2: VY(0.92), stroke: C.ink3, "stroke-width": 2 }, cmp);
  [0.75, 0.8, 0.85, 0.9].forEach((v) => {
    E("line", { x1: AX - 8, y1: VY(v), x2: AX, y2: VY(v), stroke: C.ink3, "stroke-width": 2 }, cmp);
    T(cmp, AX - 14, VY(v) + 6, v.toFixed(2), { size: 18, fill: C.ink3, anchor: "end" });
  });
  T(cmp, AX, VY(0.92) - 16, "AUROC", { size: 18, fill: C.ink3, anchor: "middle" });
  T(cmp, 1300, 518, "Probe", { size: 24, w: 600, fill: C.ink2, anchor: "middle" });
  T(cmp, 1640, 518, "Stack", { size: 24, w: 600, fill: C.ink2, anchor: "middle" });
  tw(cmp, "o", 8.4, 0.5, 0, 1, "out");
  [[1180, 1420, 0.797], [1520, 1760, 0.901]].forEach(([a, b, v], i) => {
    const ln = A(dashable(E("line", { x1: a, y1: VY(v), x2: b, y2: VY(v), stroke: C.ink, "stroke-width": 4 })), { d: 1 });
    tw(ln, "d", 8.6 + i * 0.15, 0.6, 1, 0, "io");
    fadeIn(A(T(svg, a, VY(v) - 16, `Logistic ${v.toFixed(3)}`, { size: 22, w: 500 })), 8.8 + i * 0.15, 0.4);
  });
  const drops = [[1250, 0.760], [1300, 0.790], [1350, 0.775], [1640, 0.887]];
  drops.forEach(([x, v], i) => {
    const d = A(E("circle", { cx: x, cy: 0, r: 9, fill: C.panel, stroke: C.ink2, "stroke-width": 3 }), { o: 0, y: VY(0.74) });
    tw(d, "o", 9.4 + i * 0.25, 0.2, 0, 1, "lin");
    tw(d, "y", 9.4 + i * 0.25, 0.8, VY(0.74), VY(v), "out"); // rises from the floor, stops under the logistic line
  });
  fadeIn(A(T(svg, 1368, VY(0.775) + 8, "MLP", { size: 22, fill: C.ink2 })), 10.3, 0.4);
  fadeIn(A(T(svg, 1658, VY(0.887) + 22, "Boosting 0.887", { size: 22, fill: C.ink2 })), 10.6, 0.4);
  return 13;
}

/* ---------- 5. Step forward ---------- */
function scene5() {
  title("Two instruments");
  bottomClouds();
  // cloud, top centre
  const bumps = [60, 100, 130, 95, 60], s = 0.6, cw = cloudWidth(s, bumps), CX0 = 1000 - cw / 2, CB = 205;
  const cloud = A(E("path", { d: cloudD(CX0, CB, s, bumps), fill: C.panel3 }));
  fadeIn(cloud, 0.4, 0.8, -16);

  const div = A(E("line", { x1: 980, y1: 280, x2: 980, y2: 900, stroke: C.rule, "stroke-width": 2 }), { o: 0 });
  tw(div, "o", 0.4, 0.6, 0, 1, "out");

  // needle: broad
  fadeIn(A(T(svg, 120, 320, "Needle", { size: 36, w: 600 })), 0.5, 0.5, 10);
  const L = 120, W = 760;
  const tape = A(hTape(svg, L, 382, W), { o: 0 });
  tw(tape, "o", 1.0, 0.4, 0, 0.38, "out");
  tw(tape, "o", 1.4, 0.5, 0.38, 1, "out");
  const nd = hNeedle(svg, 360, 412);
  const ng = A(G(svg), { o: 0 }); ng.appendChild(nd.g);
  tw(ng, "o", 1.0, 0.4, 0, 1, "out");
  nd.g.__base.x = L + W * 0.5;
  tw(nd.hollow, "o", 1.3, 0.3, 1, 0);
  tw(nd.filled, "o", 1.3, 0.3, 0, 1);
  tw(nd.g, "x", 1.3, 1.0, L + W * 0.5, L + W * 0.9, "swing");
  tw(nd.g, "x", 7.3, 0.9, L + W * 0.9, L + W * 0.42, "swing");

  // AUROC: needle vs token log-prob
  const AY = 556, AX = (v) => L + (v - 0.4) / 0.6 * W;
  const ax = A(G(svg), { o: 0 });
  E("line", { x1: L, y1: AY, x2: L + W, y2: AY, stroke: C.ink3, "stroke-width": 2 }, ax);
  [0.5, 0.6, 0.7, 0.8, 0.9].forEach((v) => {
    E("line", { x1: AX(v), y1: AY, x2: AX(v), y2: AY + 9, stroke: C.ink3, "stroke-width": 2 }, ax);
    T(ax, AX(v), AY + 34, v.toFixed(1), { size: 18, fill: C.ink3, anchor: "middle" });
  });
  T(ax, L + W + 14, AY + 7, "AUROC", { size: 18, fill: C.ink3 });
  tw(ax, "o", 1.9, 0.5, 0, 1, "out");
  [[0.754, "Log-prob 0.754", C.ink3, C.ink2, 2.3], [0.901, "Needle 0.901", C.ink, C.ink, 2.7]].forEach(([v, txt, mc, tc, t0]) => {
    const m = A(G(svg), { o: 0, sy: 0, ox: AX(v), oy: AY });
    E("line", { x1: AX(v), y1: AY - 58, x2: AX(v), y2: AY, stroke: mc, "stroke-width": 4 }, m);
    E("rect", { x: AX(v) - 8, y: AY - 66, width: 16, height: 16, fill: mc }, m);
    tw(m, "o", t0, 0.2, 0, 1, "lin");
    tw(m, "sy", t0, 0.5, 0, 1, "swing");
    fadeIn(A(T(svg, AX(v), AY - 82, txt, { size: 22, w: 500, fill: tc, anchor: "middle" })), t0 + 0.3, 0.4, 6);
  });

  // accuracy when answering only in Cruise (held-out BIRD)
  [["All questions", 0.36, C.ink3, 690, 3.5], ["Cruise only (14%)", 0.85, C.cruise, 800, 3.9]].forEach(([name, acc, col, y, t0]) => {
    fadeIn(A(T(svg, L, y - 14, name, { size: 22, fill: C.ink2 })), t0, 0.4);
    const b = A(E("rect", { x: L, y, width: W * acc, height: 28, fill: col }), { sx: 0, ox: L, oy: y });
    tw(b, "sx", t0 + 0.1, 0.8, 0, 1, "io");
    fadeIn(A(T(svg, L + W * acc + 14, y + 23, `${Math.round(acc * 100)}% right`, { size: 24, w: 600 })), t0 + 0.8, 0.4);
  });

  // auditor: precise
  fadeIn(A(T(svg, 1060, 320, "Auditor", { size: 36, w: 600 })), 0.5, 0.5, 10);
  const SZ = 60, GP = 18, GX = 1060, GY = 372;
  for (let i = 0; i < 23; i++) {
    const c = i % 8, r = Math.floor(i / 8), x = GX + c * (SZ + GP), y = GY + r * (SZ + GP);
    const box = A(E("rect", { x, y, width: SZ, height: SZ, rx: 2, fill: "none", stroke: C.ink3, "stroke-width": 2 }), { o: 0, s: 0.6, ox: x + SZ / 2, oy: y + SZ / 2 });
    tw(box, "o", 4.6 + i * 0.035, 0.25, 0, 1, "out");
    tw(box, "s", 4.6 + i * 0.035, 0.35, 0.6, 1, "swing");
    if (i < 21) {
      const f = A(E("rect", { x: x + 1, y: y + 1, width: SZ - 2, height: SZ - 2, fill: C.ask }), { o: 0 });
      tw(f, "o", 5.7 + i * 0.045, 0.25, 0, 1, "out");
    }
  }
  const al = A(G(svg), { o: 0 });
  T(al, 1060, 690, "21 of 23 flags truly wrong", { size: 34, w: 500 });
  fadeIn(al, 6.8, 0.5, 8);

  // Ask: only schema + question goes up
  const PX = L + W * 0.42, route = [[PX, 352], [PX, 168], [CX0 + 40, 168]];
  const path = A(dashable(E("polyline", { points: ptsAttr(route), fill: "none", stroke: C.ink2, "stroke-width": 3 })), { d: 1 });
  const P0 = 8.2, PD = 1.6;
  tw(path, "d", P0 - 0.2, 0.9, 1, 0, "io");
  const pk = G(svg);
  E("rect", { x: -140, y: -24, width: 280, height: 48, rx: 3, fill: C.panel2, stroke: C.ink, "stroke-width": 2 }, pk);
  T(pk, 0, 8, "Schema + question", { size: 22, w: 500, anchor: "middle" });
  const pos = along(route);
  ticks.push((t) => {
    const f = 0.1 + 0.72 * EASE.io(clamp01((t - P0) / PD)); // starts clear of the tape
    const [x, y] = pos(f);
    const op = t < P0 ? 0 : Math.min(1, (t - P0) / 0.25);
    pk.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    pk.setAttribute("opacity", op.toFixed(3));
  });
  return 12;
}

const SCENES = [scene1, scene2, scene3, scene4, scene5];

/* ---------- player ---------- */
const params = new URLSearchParams(location.search);
let cur = Math.min(N_SCENES, Math.max(1, parseInt(params.get("s") || "1", 10) || 1));
const fixedT = params.has("t") ? parseFloat(params.get("t")) : null;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let t0 = null, raf = 0;

function fit() {
  const st = document.getElementById("stage");
  const k = Math.min(innerWidth / 1920, innerHeight / 1080);
  st.style.transform = `translate(${((innerWidth - 1920 * k) / 2).toFixed(2)}px, ${((innerHeight - 1080 * k) / 2).toFixed(2)}px) scale(${k})`;
}

function build(i) {
  const st = document.getElementById("stage");
  st.textContent = "";
  nodes = []; ticks = [];
  svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 1920 1080");
  svg.setAttribute("aria-hidden", "true");
  st.appendChild(svg);
  DUR = SCENES[i - 1]();
  window.__dur = DUR;
  document.title = `Altimeter explainer ${i}`;
}

function loop(now) {
  if (t0 === null) t0 = now;
  render(Math.min((now - t0) / 1000, DUR));
  raf = requestAnimationFrame(loop);
}
function play() {
  cancelAnimationFrame(raf);
  build(cur);
  if (fixedT !== null) { render(Math.min(fixedT, DUR)); return; }
  if (reduced) { render(DUR); return; }
  render(0);
  t0 = null;
  raf = requestAnimationFrame(loop);
}
function go(i) {
  cur = ((i - 1 + N_SCENES) % N_SCENES) + 1;
  const u = new URL(location.href); u.searchParams.set("s", cur);
  history.replaceState(null, "", u);
  play();
}

addEventListener("resize", fit);
addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") play();
  else if (e.key === "ArrowRight") go(cur + 1);
  else if (e.key === "ArrowLeft") go(cur - 1);
});
addEventListener("click", () => play());
window.__play = play;
window.__render = (t) => { cancelAnimationFrame(raf); render(t); };

fit();
Promise.all(["400", "500", "600"].map((w) => document.fonts.load(`${w} 28px Poppins`))).catch(() => {}).then(() => {
  window.__ready = true;
  if (params.get("wait") === "1") { build(cur); render(0); return; }
  play();
});
