/* Join map: the tables a query touches, their FK links, and the JOIN that multiplies rows.
   window.JoinMap.render(container, schema, check, opts) -> summary
     container  element; emptied and filled with one <svg class="jm">
     schema     GET /api/schema?db_id=X  ({tables:[{name, rows, columns:[{name, type, pk, fk}]}]}) or null
     check      POST /api/check response (uses .sql, .findings[].fanout, .flagged) or null for a clean map
     opts       {sql, width, animate=true, neighbours=true, maxNeighbours, focus=false}
                focus: draw only the counted table, the repeating one and the JOIN path between them; the
                other query tables collapse into one "+N tables" box (names listed in it and in its tooltip)
   Returns {mode, width, height, tables, counted, repeating, factor, factorLabel, keys, edges, collapsed}.
   Layout is deterministic: the query's tables in FROM/JOIN order along the primary axis
   (x on wide containers, y on phones), FK neighbours in a second lane. No physics. */
(function () {
  "use strict";

  var KW = ["ON", "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "GROUP", "ORDER",
    "LIMIT", "HAVING", "UNION", "AS", "SET", "USING", "OUTER", "AND", "OR", "SELECT", "FROM", "WITH",
    "EXCEPT", "INTERSECT", "WINDOW", "OFFSET", "STRAIGHT_JOIN"];
  var ID = '(?:"([^"]+)"|`([^`]+)`|\\[([^\\]]+)\\]|([A-Za-z_][\\w$]*))'; // 4 groups
  var NS = "http://www.w3.org/2000/svg";
  var MONO_PX = 0.62;   // em per character, monospace estimate
  var SANS_PX = 0.56;   // em per character, Poppins estimate

  function pick(m, i) { return m[i] || m[i + 1] || m[i + 2] || m[i + 3]; }

  // --- SQL: tables in FROM/JOIN order, alias map, ON-clause pairs --------------------------------------
  function parseSql(sql) {
    var tables = [], alias = {}, joins = [], m;
    var reT = new RegExp("\\b(FROM|JOIN)\\s+" + ID + "(?:\\s+(?:AS\\s+)?" + ID + ")?", "gi");
    while ((m = reT.exec(sql))) {
      var t = pick(m, 2), a = pick(m, 6);
      if (!t) continue;
      if (a && KW.indexOf(a.toUpperCase()) >= 0) a = null;
      alias[t.toLowerCase()] = t;
      if (a) alias[a.toLowerCase()] = t;
      if (tables.indexOf(t) < 0) tables.push(t);
    }
    var reOn = new RegExp("\\bON\\s+" + ID + "\\." + ID + "\\s*=\\s*" + ID + "\\." + ID, "gi");
    while ((m = reOn.exec(sql))) {
      var la = pick(m, 1), lc = pick(m, 5), ra = pick(m, 9), rc = pick(m, 13);
      var lt = alias[la.toLowerCase()], rt = alias[ra.toLowerCase()];
      if (!lt || !rt || lt === rt) continue;
      joins.push({ a: lt, ac: lc, b: rt, bc: rc });
    }
    return { tables: tables, alias: alias, joins: joins };
  }

  // --- the fan-out finding to draw -------------------------------------------------------------------
  function pickFinding(check) {
    if (!check) return null;
    var fs = check.findings ? check.findings : (check.aggregate ? [check] : []);
    var f = null, i;
    for (i = 0; i < fs.length; i++) if (fs[i].fanout) { f = fs[i]; break; }
    if (!f) for (i = 0; i < fs.length; i++) if (fs[i].table && fs[i].table !== "*" && fs[i].table.indexOf(",") < 0) { f = fs[i]; break; }
    if (!f || (check.flagged === false)) return null;
    return f;
  }

  function factorLabel(x) {
    if (x == null || isNaN(x)) return "";
    var s = x >= 100 ? String(Math.round(x)) : x.toFixed(2).replace(/\.?0+$/, "");
    return "×" + s;
  }

  function fmtRows(n) {
    if (n == null) return "";
    return n.toLocaleString("en-US") + (n === 1 ? " row" : " rows");
  }

  function clip(s, maxChars) {
    s = String(s);
    return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + "…" : s;
  }

  // --- layout in abstract (p = primary, s = secondary) coordinates ----------------------------------
  function layout(model, W, opts) {
    var narrow = opts.mode === "narrow";
    var G = narrow
      ? { bp: 62, gap: 26, fgap: 56, laneGap: 30, mS: 6, mP: 4, name: 13, sub: 11 }
      : { bp: 172, gap: 56, fgap: 56, laneGap: 52, mS: 8, mP: 6, name: 13, sub: 11 };
    if (model.collapsed.length && !narrow) { G.bp = 144; G.gap = 40; }   // focus: tighter boxes, so the labels stay larger
    var bs;  // box size along the secondary axis
    if (narrow) {
      var lanes = model.lanes;
      bs = lanes > 1 ? Math.floor((W - 2 * G.mS - G.laneGap * (lanes - 1)) / lanes) : Math.min(W - 2 * G.mS, 300);
      bs = Math.max(120, bs);
    } else {
      bs = 62;
    }
    // detour room on the s-start side when a lane-0 edge skips a box
    var detour = model.edges.some(function (e) { return e.lane0 && Math.abs(e.da - e.db) > 1; });
    var mS0 = G.mS + (detour ? 20 : 0);
    // fan-out keys need room in their gap
    var keyLines = model.keys ? model.keys.lines.slice() : [];
    var keyW = 0;
    keyLines.forEach(function (l) { keyW = Math.max(keyW, l.length * G.sub * MONO_PX); });
    if (model.keys && model.finding && model.finding.distinct_rows != null) {
      keyLines.push("stat");
      keyW = Math.max(keyW, (String(model.finding.distinct_rows).length + String(model.finding.joined_rows).length + 14) * G.sub * SANS_PX);
    }
    var fgap = narrow ? Math.max(G.fgap, keyLines.length * 15 + 26) : Math.max(G.fgap, keyW + 32);
    // a fan-out edge that skips a box detours over the row; its label then stacks above that detour line
    var fanDetour = !narrow && model.fan && model.fan.from.lane === model.fan.to.lane && Math.abs(model.fan.da - model.fan.db) > 1;
    if (fanDetour) mS0 = Math.max(mS0, G.mS + 18 + 6 + Math.max(keyLines.length * 15 + 4, 26));
    var pos = [], p = G.mP, i, slotW = [];
    for (i = 0; i < model.slots; i++) {
      // the "+N tables" box needs only its count and a few short names
      slotW.push(model.collapsed.length && i === model.slots - 1 && !narrow ? 124 : G.bp);
      pos.push(p);
      var isF = model.fanSlot != null && (i === model.fanSlot);
      p += slotW[i] + (i < model.slots - 1 ? (isF ? fgap : G.gap) : 0);
    }
    var totalP = p + G.mP;
    var totalS = mS0 + model.lanes * bs + (model.lanes - 1) * G.laneGap + G.mS;
    model.boxes.forEach(function (b) {
      b.p = pos[b.slot]; b.s = mS0 + b.lane * (bs + G.laneGap); b.bp = b.lane ? G.bp : slotW[b.slot]; b.bs = bs;
    });
    return { G: G, narrow: narrow, totalP: totalP, totalS: totalS, bs: bs, mS0: mS0, fgap: fgap, fanDetour: fanDetour };
  }

  // orthogonal route between two boxes, in (p, s) coordinates
  function route(A, B, L) {
    var pts = [];
    var ac = { p: A.p + A.bp / 2, s: A.s + A.bs / 2 }, bc = { p: B.p + B.bp / 2, s: B.s + B.bs / 2 };
    if (A.lane === B.lane) {
      var dir = B.slot > A.slot ? 1 : -1;
      var aP = dir > 0 ? A.p + A.bp : A.p, bP = dir > 0 ? B.p : B.p + B.bp;
      if (Math.abs(A.slot - B.slot) === 1) {
        pts.push([aP, ac.s], [bP, bc.s]);
      } else {
        var sOut = A.s - 18, half = L.G.gap / 2;
        pts.push([aP, ac.s], [aP + dir * half, ac.s], [aP + dir * half, sOut], [bP - dir * half, sOut],
          [bP - dir * half, bc.s], [bP, bc.s]);
      }
      return pts;
    }
    var top = A.lane < B.lane ? A : B, bot = A.lane < B.lane ? B : A;   // top: nearer the s-start side
    if (top.slot === bot.slot) {
      pts.push([ac.p, A.lane < B.lane ? A.s + A.bs : A.s], [bc.p, A.lane < B.lane ? B.s : B.s + B.bs]);
      return pts;
    }
    var d = bot.slot > top.slot ? 1 : -1;
    var sMid = top.s + top.bs + L.G.laneGap * 0.6;
    var tp = top.p + top.bp / 2 + d * 14, bp = bot.p + bot.bp / 2 - d * 14;
    var seq = [[tp, top.s + top.bs], [tp, sMid], [bp, sMid], [bp, bot.s]];
    if (A !== top) seq.reverse();
    return seq;
  }

  // Shortest JOIN path from the counted table to the repeating one (BFS over the ON pairs), in path order.
  // Without a repeating table or a path: the counted table and the tables joined to it directly.
  function focusPath(main, joins, counted, repeating) {
    var lc = function (t) { return String(t).toLowerCase(); };
    var name = {}, adj = {};
    main.forEach(function (t) { name[lc(t)] = t; adj[lc(t)] = []; });
    joins.forEach(function (j) {
      var a = lc(j.a), b = lc(j.b);
      if (adj[a] && adj[b]) { adj[a].push(b); adj[b].push(a); }
    });
    var c = lc(counted), r = repeating ? lc(repeating) : null;
    if (r && adj[c] && adj[r]) {
      var prev = {}, q = [c], seen = {};
      seen[c] = 1;
      while (q.length) {
        var u = q.shift();
        if (u === r) break;
        adj[u].forEach(function (v) { if (!seen[v]) { seen[v] = 1; prev[v] = u; q.push(v); } });
      }
      if (seen[r]) {
        var path = [r];
        while (path[0] !== c) path.unshift(prev[path[0]]);
        return path.map(function (t) { return name[t]; });
      }
      return [counted, repeating];
    }
    var out = [counted];
    (adj[c] || []).forEach(function (v) { if (out.indexOf(name[v]) < 0) out.push(name[v]); });
    return out;
  }

  // --- model: boxes, lanes, edges ------------------------------------------------------------------
  function buildModel(schema, check, opts) {
    var sql = opts.sql || (check && check.sql) || "";
    var parsed = parseSql(sql);
    var byName = {};
    (schema && schema.tables ? schema.tables : []).forEach(function (t) { byName[t.name.toLowerCase()] = t; });
    var f = pickFinding(check);
    var fo = f && f.fanout ? f.fanout : null;
    var counted = f ? f.table : null;
    var repeating = fo ? fo.right.table : null;

    var main = parsed.tables.slice();
    [counted, repeating].forEach(function (t) { if (t && main.indexOf(t) < 0) main.push(t); });
    var collapsed = [];
    if (opts.focus && counted) {   // focus: the counted table, the repeating one, the JOIN path between them
      var keep = focusPath(main, parsed.joins, counted, repeating);
      if (keep.length < main.length) {
        collapsed = main.filter(function (t) { return keep.indexOf(t) < 0; });
        main = keep;
      }
    }

    var boxes = [], idx = {};
    function canon(name) { var t = byName[name.toLowerCase()]; return t ? t.name : name; }
    main.forEach(function (name, i) {
      var t = byName[name.toLowerCase()];
      var b = { id: canon(name), name: canon(name), rows: t ? t.rows : null, lane: 0, slot: i, role: "", kind: "main" };
      boxes.push(b); idx[b.id.toLowerCase()] = b;
    });

    // neighbours: schema tables outside the query with an FK to/from a query table
    var maxN = opts.maxNeighbours != null ? opts.maxNeighbours : main.length;
    var nEdges = [];
    if (opts.neighbours !== false && schema && schema.tables) {
      var fkOf = function (t) { // [{col, to, toCol}]
        return t.columns.filter(function (c) { return c.fk; }).map(function (c) {
          return { col: c.name, to: c.fk.split(".")[0], toCol: c.fk.split(".")[1] || "" };
        });
      };
      var cands = [];
      schema.tables.forEach(function (t) {
        if (idx[t.name.toLowerCase()]) return;
        var mains = [], seen = {};
        var add = function (m) { if (!seen[m.id]) { seen[m.id] = 1; mains.push(m); } };
        fkOf(t).forEach(function (fk) { var m = idx[fk.to.toLowerCase()]; if (m) add(m); });
        main.forEach(function (name) {
          var u = byName[name.toLowerCase()];
          if (u) fkOf(u).forEach(function (fk) { if (fk.to.toLowerCase() === t.name.toLowerCase()) add(idx[name.toLowerCase()]); });
        });
        if (mains.length) cands.push({ t: t, mains: mains });
      });
      // one neighbour lane; each neighbour takes the free slot nearest to everything it links to
      var taken = {}, placed = 0;
      cands.forEach(function (c) {
        if (placed >= maxN) return;
        var best = null, bestCost = Infinity;
        c.mains.forEach(function (m) {
          if (taken[m.slot]) return;
          var cost = 0;
          c.mains.forEach(function (o) { cost += Math.abs(o.slot - m.slot); });
          if (cost < bestCost || (cost === bestCost && m.slot < best.slot)) { best = m; bestCost = cost; }
        });
        if (!best) return;
        taken[best.slot] = 1; placed++;
        var b = { id: c.t.name, name: c.t.name, rows: c.t.rows, lane: 1, slot: best.slot, role: "", kind: "neighbour" };
        boxes.push(b); idx[b.id.toLowerCase()] = b;
        c.mains.forEach(function (m) { if (Math.abs(m.slot - best.slot) <= 2) nEdges.push({ from: b, to: m, kind: "fk" }); });
      });
    }
    if (collapsed.length) {   // the tables left out, as one box at the end of the row
      var mb = { id: " more", name: "+" + collapsed.length + (collapsed.length === 1 ? " table" : " tables"), rows: null,
        lane: 0, slot: main.length, role: "", kind: "more", sub: collapsed.join(", "), all: collapsed };
      boxes.push(mb);
    }
    var lanes = 1;
    boxes.forEach(function (b) { lanes = Math.max(lanes, b.lane + 1); });

    // query joins
    var edges = [], seenE = {};
    parsed.joins.forEach(function (j) {
      var A = idx[j.a.toLowerCase()], B = idx[j.b.toLowerCase()];
      if (!A || !B) return;
      var key = [A.id, B.id].sort().join("|");
      if (seenE[key]) return;
      seenE[key] = 1;
      edges.push({ from: A, to: B, kind: "join", lane0: true, da: A.slot, db: B.slot, ac: j.ac, bc: j.bc });
    });

    // the fan-out edge: counted -> repeating
    var fan = null, keys = null, fanSlot = null;
    if (fo) {
      var C = idx[counted.toLowerCase()], R = idx[repeating.toLowerCase()];
      if (C && R) {
        C.role = "counted"; R.role = "repeating";
        R.sub = fo.max_repeat != null ? "up to " + fo.max_repeat + " per " + C.name + " row" : "";
        C.agg = f.aggregate || "";
        var e = null, i;
        for (i = 0; i < edges.length; i++) {
          var x = edges[i];
          if ((x.from === C && x.to === R) || (x.from === R && x.to === C)) { e = x; break; }
        }
        var left, right;
        if (e) {
          left = e.from === C ? { t: C.name, c: e.ac } : { t: C.name, c: e.bc };
          right = e.from === C ? { t: R.name, c: e.bc } : { t: R.name, c: e.ac };
          edges.splice(edges.indexOf(e), 1);
        } else {
          left = { t: C.name, c: fo.link || fo.left.key }; right = { t: R.name, c: fo.link || fo.right.key };
        }
        fan = { from: C, to: R, kind: "fanout", lane0: true, da: C.slot, db: R.slot };
        var expr = left.t + "." + left.c + " = " + right.t + "." + right.c;
        keys = { expr: expr, lines: [left.t + "." + left.c, "= " + right.t + "." + right.c] };
        if (Math.abs(C.slot - R.slot) === 1) fanSlot = Math.min(C.slot, R.slot);
      }
    } else if (f && counted && idx[counted.toLowerCase()]) {
      var C2 = idx[counted.toLowerCase()];
      C2.role = "counted"; C2.agg = f.aggregate || "";
      C2.sub = f.distinct_rows != null ? f.distinct_rows.toLocaleString("en-US") + " rows read as " + f.joined_rows.toLocaleString("en-US") : "";
    }
    return {
      boxes: boxes, main: main, lanes: lanes, slots: main.length + (collapsed.length ? 1 : 0), edges: nEdges.concat(edges), fan: fan, collapsed: collapsed,
      keys: keys, fanSlot: fanSlot, finding: f, counted: counted, repeating: repeating
    };
  }

  // Table names packed into at most maxLines lines of maxChars; what does not fit ends as "+N more".
  function wrapNames(names, maxChars, maxLines) {
    var lines = [], cur = "", i;
    for (i = 0; i < names.length; i++) {
      var nm = clip(names[i], maxChars), next = cur ? cur + ", " + nm : nm;
      if (next.length <= maxChars) { cur = next; continue; }
      if (lines.length + 1 >= maxLines) break;
      lines.push(cur + ","); cur = nm;
    }
    if (i < names.length) {
      var more = "+" + (names.length - i) + " more";
      cur = (cur + ", " + more).length <= maxChars ? cur + ", " + more : more;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  // --- SVG --------------------------------------------------------------------------------------------
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, cls, anchor) {
    var t = el("text", { x: x, y: y, "class": cls, "text-anchor": anchor || "start" }, parent);
    t.textContent = str;
    return t;
  }

  function render(container, schema, check, opts) {
    opts = opts || {};
    var W = opts.width || container.clientWidth || 390;
    var mode = opts.mode || (W < 560 ? "narrow" : "wide");
    var o = Object.assign({}, opts, { mode: mode });
    var model = buildModel(schema, check, o);
    var L = layout(model, W, o);
    if (!opts.mode && mode === "wide" && L.totalP > W && W / L.totalP < 0.72) {   // too long for the panel: stack it (unless the caller fixed the mode)
      mode = "narrow"; o.mode = mode;
      model = buildModel(schema, check, o);
      L = layout(model, W, o);
    }
    var narrow = mode === "narrow";
    var X = function (p, s) { return narrow ? [s, p] : [p, s]; };
    // narrow: two lanes can need more than the panel (boxes keep a 120 px minimum); the whole map then scales down to fit
    var vbW = narrow ? Math.max(W, Math.ceil(L.totalS)) : L.totalP, vbH = narrow ? L.totalP : L.totalS;
    var scale = Math.min(1, W / vbW);

    container.innerHTML = "";
    var svg = el("svg", {
      "class": "jm jm-" + mode + (opts.animate === false ? " jm-static" : "") + (model.collapsed.length ? " jm-focus" : ""),
      viewBox: "0 0 " + vbW + " " + vbH, width: Math.round(vbW * scale), height: Math.round(vbH * scale),
      role: "img", "aria-label": model.counted
        ? "Join map: " + model.counted + " is counted " + factorLabel(model.finding.factor) + " through " + (model.repeating || "a join")
        : "Join map: " + model.main.join(", ")
    }, container);

    var pathD = function (pts) {
      return pts.map(function (pt, i) { var xy = X(pt[0], pt[1]); return (i ? "L" : "M") + xy[0].toFixed(1) + " " + xy[1].toFixed(1); }).join(" ");
    };
    var gEdges = el("g", { "class": "jm-edges" }, svg);
    model.edges.forEach(function (e) {
      el("path", { d: pathD(route(e.from, e.to, L)), "class": "jm-edge jm-edge-" + e.kind }, gEdges);
    });

    // fan-out edge + label
    var fanInfo = null;
    if (model.fan) {
      var pts = route(model.fan.from, model.fan.to, L);
      var fp = el("path", { d: pathD(pts), "class": "jm-edge jm-edge-fanout" }, svg);
      var len = 0;
      try { len = fp.getTotalLength(); } catch (err) { len = 0; }
      if (!len) { for (var i = 1; i < pts.length; i++) len += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]); }
      fp.style.strokeDasharray = len; fp.style.strokeDashoffset = len; fp.style.setProperty("--len", len);
      // label anchor: midpoint of the longest primary-axis segment
      var best = 0, mid = null;
      for (var j = 1; j < pts.length; j++) {
        var dp = Math.abs(pts[j][0] - pts[j - 1][0]);
        if (dp >= best) { best = dp; mid = [(pts[j][0] + pts[j - 1][0]) / 2, pts[j][1]]; }
      }
      var lbl = factorLabel(model.finding.factor);
      var g = el("g", { "class": "jm-label" }, svg);
      var lines = model.keys.lines.map(function (l) { return { t: l, cls: "jm-keys", w: l.length * L.G.sub * MONO_PX }; });
      if (model.finding.distinct_rows != null && model.finding.joined_rows != null) {
        var st = model.finding.distinct_rows.toLocaleString("en-US") + " rows read as " + model.finding.joined_rows.toLocaleString("en-US");
        lines.push({ t: st, cls: "jm-stat", w: st.length * L.G.sub * SANS_PX });
      }
      var kw = Math.max.apply(null, lines.map(function (l) { return l.w; })) + 10;
      var kh = lines.length * 15 + 4;
      var fw = lbl.length * 20 * SANS_PX + 12;
      var xy = X(mid[0], mid[1]);
      if (narrow) {
        var kx = xy[0] + 12, ky = xy[1] - (lines.length - 1) * 7.5 + 4;
        el("rect", { x: kx - 5, y: ky - 12, width: kw, height: kh, "class": "jm-knock" }, g);
        lines.forEach(function (l, k) { text(g, kx, ky + k * 15, l.t, l.cls); });
        el("rect", { x: xy[0] - 12 - fw, y: xy[1] - 13, width: fw, height: 26, "class": "jm-knock" }, g);
        text(g, xy[0] - 12, xy[1] + 7, lbl, "jm-factor", "end");
        var right = Math.ceil(kx - 5 + kw + 2);   // the key lines must not run past the right edge either
        if (right > vbW) {
          vbW = right; scale = Math.min(1, W / vbW);
          svg.setAttribute("viewBox", "0 0 " + vbW + " " + vbH);
          svg.setAttribute("width", Math.round(vbW * scale));
          svg.setAttribute("height", Math.round(vbH * scale));
        }
      } else if (L.fanDetour) {   // just above the detour line: the factor, then the keys beside it
        var top0 = xy[1] - 6 - kh, x0 = xy[0] - (fw + 8 + kw) / 2;
        el("rect", { x: x0, y: top0 + kh - 26, width: fw, height: 26, "class": "jm-knock" }, g);
        text(g, x0 + fw - 6, top0 + kh - 6, lbl, "jm-factor", "end");
        el("rect", { x: x0 + fw + 8, y: top0, width: kw, height: kh, "class": "jm-knock" }, g);
        lines.forEach(function (l, k) { text(g, x0 + fw + 13, top0 + 12 + k * 15, l.t, l.cls); });
      } else {
        el("rect", { x: xy[0] - fw / 2, y: xy[1] - 32, width: fw, height: 26, "class": "jm-knock" }, g);
        text(g, xy[0], xy[1] - 11, lbl, "jm-factor", "middle");
        el("rect", { x: xy[0] - kw / 2, y: xy[1] + 7, width: kw, height: kh, "class": "jm-knock" }, g);
        lines.forEach(function (l, k) { text(g, xy[0], xy[1] + 19 + k * 15, l.t, l.cls, "middle"); });
        var need = Math.ceil(xy[1] + 7 + kh + 2);   // one lane only: the key lines hang below the boxes
        if (need > vbH) {
          vbH = need;
          svg.setAttribute("viewBox", "0 0 " + vbW + " " + vbH);
          svg.setAttribute("height", Math.round(vbH * scale));
        }
      }
      fanInfo = { factor: model.finding.factor, factorLabel: lbl, keys: model.keys.expr };
    }

    // boxes
    var gBoxes = el("g", { "class": "jm-boxes" }, svg);
    var order = model.boxes.slice().sort(function (a, b) { return a.lane - b.lane || a.slot - b.slot; });
    order.forEach(function (b, i) {
      var xy = X(b.p, b.s), w = narrow ? b.bs : b.bp, h = narrow ? b.bp : b.bs;
      var g = el("g", { "class": "jm-box jm-" + b.kind + (b.role ? " jm-" + b.role : ""), transform: "translate(" + xy[0] + " " + xy[1] + ")" }, gBoxes);
      g.style.setProperty("--i", i);
      el("rect", { x: 0.5, y: 0.5, width: w - 1, height: h - 1, "class": "jm-rect" }, g);
      var maxName = Math.floor((w - 20) / (L.G.name * MONO_PX));
      if (b.kind === "more") {   // the collapsed tables: their count, then their names as far as they fit
        el("title", {}, g).textContent = b.all.join(", ");
        text(g, 10, 20, b.name, "jm-name");
        var lines = wrapNames(b.all, Math.floor((w - 20) / (L.G.sub * MONO_PX)), Math.max(1, Math.floor((h - 28) / 14)));
        lines.forEach(function (ln, k) { text(g, 10, 37 + k * 14, ln, "jm-rows"); });
        return;
      }
      text(g, 10, 20, clip(b.name, maxName), "jm-name");
      var rows = fmtRows(b.rows);
      if (rows) text(g, 10, 37, rows, "jm-rows");
      var line3 = b.role === "counted" ? b.agg : b.sub;
      if (line3) text(g, 10, 53, clip(line3, Math.floor((w - 20) / (L.G.sub * (b.role === "counted" ? MONO_PX : SANS_PX)))),
        b.role === "counted" ? "jm-agg" : "jm-sub");
    });

    return {
      mode: mode, width: Math.round(vbW * scale), height: Math.round(vbH * scale),
      tables: model.main.slice(), neighbours: model.boxes.filter(function (b) { return b.kind === "neighbour"; }).map(function (b) { return b.name; }),
      counted: model.counted, repeating: model.repeating,
      factor: fanInfo ? fanInfo.factor : null, factorLabel: fanInfo ? fanInfo.factorLabel : "", keys: fanInfo ? fanInfo.keys : "",
      edges: model.edges.length + (model.fan ? 1 : 0), svg: svg, collapsed: model.collapsed.slice()
    };
  }

  window.JoinMap = { render: render, parseSql: parseSql, factorLabel: factorLabel };
})();
