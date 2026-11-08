/* SQL diff: the query as written next to the corrected query, pretty-printed and diffed token by token.

   SqlDiff.render(container, beforeSql, afterSql, opts) -> { root, replay(), removed, added }
     opts.labels   [before, after] column labels (default ["As written", "Corrected"])
     opts.animate  "auto" (default: play once when scrolled into view) | true (play now) | false
     opts.copy     show "Copy corrected SQL" (default true); copies afterSql exactly as given
   SqlDiff.format(sql) -> pretty-printed string. SqlDiff.diff(a, b) -> { a: tokens+status, b: tokens+status }.
   Needs sqldiff.css. No dependencies. */
(function () {
  "use strict";

  const KW = new Set(("SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN INNER LEFT RIGHT FULL OUTER CROSS " +
    "NATURAL ON USING AS AND OR NOT IN IS NULL LIKE GLOB REGEXP BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT ALL " +
    "UNION INTERSECT EXCEPT WITH RECURSIVE ASC DESC OVER PARTITION ESCAPE COLLATE NULLS REAL INTEGER NUMERIC TEXT").split(" "));
  const FN = new Set(("COUNT SUM AVG MIN MAX TOTAL CAST COALESCE IFNULL NULLIF IIF ROUND ABS LENGTH LOWER UPPER SUBSTR " +
    "SUBSTRING INSTR REPLACE TRIM LTRIM RTRIM STRFTIME DATE TIME DATETIME JULIANDAY GROUP_CONCAT RANK DENSE_RANK " +
    "ROW_NUMBER NTILE LAG LEAD FIRST_VALUE LAST_VALUE PRINTF FORMAT").split(" "));
  const JOINW = new Set(["LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "NATURAL", "JOIN"]);
  const WEAK = new Set([",", "(", ")", ".", "=", ";", "AS", "AND", "OR", "ON", "BY", "NOT", "IS", "IN"]);

  const ID = '(?:"(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\]|[A-Za-z_][A-Za-z0-9_$]*)';
  const RE = new RegExp([
    "(\\s+)",
    "(--[^\\n]*|/\\*[\\s\\S]*?\\*/)",
    "('(?:[^']|'')*'?)",
    `(${ID}(?:\\.(?:${ID}|\\*))*)`,
    "(\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?|\\.\\d+)",
    "(<=|>=|<>|!=|==|\\|\\||[(),;=<>+\\-*/%.])",
    "([\\s\\S])",
  ].join("|"), "g");

  /* ---------- tokens ---------- */
  function tokenize(sql) {
    const out = [];
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(sql || ""))) {
      if (m[1]) continue;
      let t;
      if (m[2]) t = { v: m[2], k: "cmt" };
      else if (m[3]) t = { v: m[3], k: "str" };
      else if (m[4]) {
        const bare = /^[A-Za-z_][A-Za-z0-9_$]*$/.test(m[4]);
        const up = m[4].toUpperCase();
        t = bare && KW.has(up) ? { v: up, k: "kw" } : { v: m[4], k: "id", bare };
      } else if (m[5]) t = { v: m[5], k: "num" };
      else t = { v: m[6] || m[7], k: "op" };
      out.push(t);
    }
    for (let i = 0; i < out.length; i++) {
      const t = out[i], nx = out[i + 1];
      if (nx && nx.v === "(" && t.k === "id" && t.bare) {
        t.k = "fn";
        const up = t.v.toUpperCase();
        if (FN.has(up)) t.v = up;
      }
      t.key = t.k === "kw" || t.k === "fn" ? t.v.toUpperCase() : t.k === "id" ? t.v.toLowerCase() : t.v;
    }
    return out;
  }

  function needSpace(prev, t) {
    if (!prev) return false;
    if (t.v === "," || t.v === ")" || t.v === ";") return false;
    if (prev.v === "(") return false;
    if (t.v === "(" && prev.k === "fn") return false;
    return true;
  }

  /* ---------- deterministic layout ---------- */
  function clauseAt(toks, i) {
    const t = toks[i];
    if (!t || t.k !== "kw") return null;
    const nx = toks[i + 1];
    switch (t.v) {
      case "SELECT": case "FROM": case "WHERE": case "HAVING": case "LIMIT": case "WITH":
      case "INTERSECT": case "EXCEPT":
        return { name: t.v, n: 1 };
      case "GROUP": case "ORDER":
        return nx && nx.v === "BY" ? { name: t.v, n: 2 } : null;
      case "UNION":
        return { name: "UNION", n: nx && nx.v === "ALL" ? 2 : 1 };
    }
    if (JOINW.has(t.v)) {
      let j = i;
      while (j < toks.length && toks[j].k === "kw" && JOINW.has(toks[j].v) && toks[j].v !== "JOIN") j++;
      if (toks[j] && toks[j].v === "JOIN") return { name: "JOIN", n: j - i + 1 };
    }
    return null;
  }

  const opensSub = (toks, i) => {
    const nx = toks[i + 1];
    return toks[i].v === "(" && !!nx && nx.k === "kw" && (nx.v === "SELECT" || nx.v === "WITH");
  };

  // A SELECT list goes one item per line when it holds a subquery, or has 3+ items and is long.
  function longList(toks, i) {
    let depth = 0, len = 0, commas = 0, sub = false;
    for (let k = i + 1; k < toks.length; k++) {
      const t = toks[k];
      if (depth === 0 && clauseAt(toks, k)) break;
      if (t.v === "(") { depth++; if (opensSub(toks, k)) sub = true; }
      else if (t.v === ")") { if (depth === 0) break; depth--; }
      else if (t.v === "," && depth === 0) commas++;
      len += t.v.length + 1;
    }
    return commas > 0 && (sub || (commas >= 2 && len > 56) || len > 90);
  }

  function layout(toks) {
    const lines = [], subs = [];
    let cur = null;
    const nl = (ind) => {
      if (cur && !cur.toks.length) { cur.ind = ind; return; }
      cur = { ind, toks: [] };
      lines.push(cur);
    };
    nl(0);
    const stack = [{ sub: true, ind: 0, open: -1, clause: null, commas: false }];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i], top = stack[stack.length - 1];
      if (top.sub) {
        const c = clauseAt(toks, i);
        if (c) {
          if (cur.toks.length && cur.toks[cur.toks.length - 1] !== top.open) nl(top.ind);
          top.clause = c.name;
          top.commas = c.name === "WITH" || (c.name === "SELECT" && longList(toks, i + c.n - 1));
          for (let k = 0; k < c.n; k++) cur.toks.push(i + k);
          i += c.n - 1;
          continue;
        }
      }
      if (t.v === "(") {
        const sub = opensSub(toks, i);
        const first = cur.toks.length === 0;
        cur.toks.push(i);
        const f = { sub, open: i, openInd: cur.ind, compact: sub && first, clause: null, commas: false, ind: top.ind };
        if (sub) {
          f.ind = first ? cur.ind + 1 : cur.ind + 2;  // "(SELECT" keeps its clauses aligned one column in
          if (!first) nl(f.ind);
        }
        stack.push(f);
        continue;
      }
      if (t.v === ")" && stack.length > 1) {
        const f = stack.pop();
        if (f.sub) {
          f.close = i;
          subs.push(f);
          if (!f.compact) nl(f.openInd);
        }
        cur.toks.push(i);
        continue;
      }
      if (t.v === "," && top.sub && top.commas) {
        cur.toks.push(i);
        nl(top.clause === "WITH" ? top.ind : top.ind + 2);
        continue;
      }
      cur.toks.push(i);
      if (t.v === ";" || t.k === "cmt" && t.v.startsWith("--")) nl(0);
    }
    while (stack.length > 1) {
      const f = stack.pop();
      if (f.sub) { f.close = toks.length - 1; subs.push(f); }
    }
    if (cur && !cur.toks.length) lines.pop();
    return { lines, subs };
  }

  function lineText(toks, line) {
    let s = " ".repeat(line.ind), prev = null;
    for (const k of line.toks) { s += (needSpace(prev, toks[k]) ? " " : "") + toks[k].v; prev = toks[k]; }
    return s;
  }

  function format(sql) {
    const toks = tokenize(sql);
    return layout(toks).lines.map((l) => lineText(toks, l)).join("\n");
  }

  /* ---------- token diff: LCS, whole-subquery locking, small-equality cleanup ---------- */
  function align(A, B, lockA, lockB) {
    const n = A.length, m = B.length;
    const ma = new Int32Array(n).fill(-1), mb = new Int32Array(m).fill(-1);
    const eq = (a, b) => !lockA[a] && !lockB[b] && A[a].key === B[b].key;
    let p = 0;
    while (p < n && p < m && eq(p, p)) { ma[p] = p; mb[p] = p; p++; }
    let s = 0;
    while (s < n - p && s < m - p && eq(n - 1 - s, m - 1 - s)) { ma[n - 1 - s] = m - 1 - s; mb[m - 1 - s] = n - 1 - s; s++; }
    const N = n - p - s, M = m - p - s;
    if (!N || !M || N * M > 4e6) return { ma, mb };
    const W = M + 1, dp = new Uint32Array((N + 1) * W);
    for (let i = N - 1; i >= 0; i--) {
      for (let j = M - 1; j >= 0; j--) {
        dp[i * W + j] = eq(p + i, p + j) ? dp[(i + 1) * W + j + 1] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < N && j < M) {
      if (eq(p + i, p + j)) { ma[p + i] = p + j; mb[p + j] = p + i; i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
      else j++;
    }
    return { ma, mb };
  }

  function toOps(n, m, ma, mb) {
    const ops = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && ma[i] === -1) { ops.push({ t: "d", a: i++ }); continue; }
      if (j < m && mb[j] === -1) { ops.push({ t: "i", b: j++ }); continue; }
      ops.push({ t: "e", a: i++, b: j++ });
    }
    return ops;
  }

  // Drop tiny equalities stranded between edits (a lone "e.event_id" or ", (" matched by chance).
  function cleanup(ops, A) {
    for (let pass = 0; pass < 500; pass++) {
      const runs = [];
      for (const o of ops) {
        const e = o.t === "e", r = runs[runs.length - 1];
        if (r && r.e === e) r.ops.push(o); else runs.push({ e, ops: [o] });
      }
      const size = (r) => { let d = 0, a = 0; for (const o of r.ops) o.t === "d" ? d++ : a++; return Math.max(d, a); };
      let hit = false;
      for (let k = 1; k < runs.length - 1 && !hit; k++) {
        const r = runs[k];
        if (!r.e) continue;
        const L = r.ops.length, before = size(runs[k - 1]), after = size(runs[k + 1]);
        const weak = r.ops.every((o) => WEAK.has(A[o.a].key));
        if ((L <= 2 && L < before && L < after) || (weak && L <= before && L <= after)) {
          r.ops = r.ops.flatMap((o) => [{ t: "d", a: o.a }, { t: "i", b: o.b }]);
          hit = true;
        }
      }
      ops = runs.flatMap((r) => r.ops);
      if (!hit) break;
    }
    return ops;
  }

  function diff(beforeSql, afterSql) {
    const A = tokenize(beforeSql), B = tokenize(afterSql);
    const LA = layout(A), LB = layout(B);
    const lockA = new Uint8Array(A.length), lockB = new Uint8Array(B.length);
    let res = align(A, B, lockA, lockB);
    // A subquery whose SELECT has no partner on the other side is new (or gone) as a whole: no borrowed tokens.
    for (let iter = 0; iter < 4; iter++) {
      let changed = false;
      const lockSubs = (subs, match, lock) => {
        for (const f of subs) {
          if (match[f.open + 1] === -1 && !lock[f.open]) {
            for (let k = f.open; k <= f.close; k++) lock[k] = 1;
            changed = true;
          }
        }
      };
      lockSubs(LB.subs, res.mb, lockB);
      lockSubs(LA.subs, res.ma, lockA);
      if (!changed) break;
      res = align(A, B, lockA, lockB);
    }
    const ops = cleanup(toOps(A.length, B.length, res.ma, res.mb), A);
    const sa = new Uint8Array(A.length), sb = new Uint8Array(B.length);
    for (const o of ops) { if (o.t === "d") sa[o.a] = 1; else if (o.t === "i") sb[o.b] = 1; }
    return { A, B, LA, LB, sa, sb };
  }

  /* ---------- DOM ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderCode(toks, lines, st, tag, groups) {
    const code = el("div", "sd-code");
    for (const line of lines) {
      const div = el("div", "sd-line");
      div.style.setProperty("--i", line.ind);
      const all = line.toks.length > 0 && line.toks.every((k) => st[k]);
      if (all) div.classList.add(tag === "del" ? "sd-ldel" : "sd-ladd");
      let prev = null, group = null, last = null, firstGroup = null;
      for (const k of line.toks) {
        const t = toks[k], sp = needSpace(prev, t);
        if (st[k]) {
          if (!group) {
            if (sp) div.append(" ");
            group = el(tag, "sd-g");
            div.append(group);
            groups.push(group);
            if (!firstGroup) firstGroup = group;
          } else if (sp) last.textContent += " ";
          last = el("span", "sd-t", t.v);
          group.append(last);
        } else {
          group = null;
          if (sp) div.append(" ");
          div.append(t.k === "kw" || t.k === "fn" ? el("span", "sd-kw", t.v) : document.createTextNode(t.v));
        }
        prev = t;
      }
      if (all && firstGroup) div._g = firstGroup;
      code.append(div);
    }
    return code;
  }

  // Removals fade and strike first, then additions slide in; whole sequence ends by 1.4 s.
  function schedule(dels, adds) {
    const stagger = (n, span, dur) => (n > 1 ? Math.min(110, Math.max(0, span - dur) / (n - 1)) : 0);
    const sd = stagger(dels.length, 600, 300);
    dels.forEach((g, i) => g.style.setProperty("--d", Math.round(i * sd) + "ms"));
    const start = dels.length ? 600 : 0, sa = stagger(adds.length, 1400 - start, 340);
    adds.forEach((g, i) => g.style.setProperty("--d", Math.round(start + i * sa) + "ms"));
  }

  function copyButton(text, codeEl) {
    const row = el("div", "sd-fixrow");
    const btn = el("button", "sd-copy", "Copy corrected SQL");
    btn.type = "button";
    const said = el("span", "sd-copied");
    said.setAttribute("aria-live", "polite");
    const done = (msg) => {
      said.textContent = msg;
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { said.textContent = ""; }, 2500);
    };
    const selectIt = () => {
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      codeEl.scrollIntoView({ block: "nearest" });
      done("Selected. Use your Copy menu.");
    };
    const legacy = () => {
      const ta = el("textarea");
      ta.value = text;
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
        navigator.clipboard.writeText(text).then(() => done("Copied"), () => (legacy() ? done("Copied") : selectIt()));
      } else if (legacy()) done("Copied");
      else selectIt();
    });
    row.append(btn, said);
    return row;
  }

  function render(container, beforeSql, afterSql, opts) {
    opts = opts || {};
    const labels = opts.labels || ["As written", "Corrected"];
    const d = diff(beforeSql || "", afterSql || "");
    const root = el("div", "sqldiff");
    const cols = el("div", "sd-cols");
    const dels = [], adds = [];

    const before = el("section", "sd-col sd-before");
    before.append(el("h3", "sd-head", labels[0]), renderCode(d.A, d.LA.lines, d.sa, "del", dels));
    const after = el("section", "sd-col sd-after");
    const afterCode = renderCode(d.B, d.LB.lines, d.sb, "ins", adds);
    after.append(el("h3", "sd-head", labels[1]), afterCode);
    if (opts.copy !== false && afterSql) after.append(copyButton(afterSql, afterCode));
    cols.append(before, after);
    root.append(cols);

    schedule(dels, adds);
    root.querySelectorAll(".sd-ldel, .sd-ladd").forEach((ln) => {
      if (ln._g) ln.style.setProperty("--d", ln._g.style.getPropertyValue("--d"));
    });

    const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = opts.animate === undefined ? "auto" : opts.animate;
    const play = () => {
      root.classList.remove("sd-play");
      void root.offsetWidth;
      root.classList.add("sd-play");
    };
    if (animate && !reduced && (dels.length || adds.length)) {
      root.classList.add("sd-anim");
      if (animate === "auto" && "IntersectionObserver" in window) {
        const io = new IntersectionObserver((es) => {
          if (es.some((e) => e.isIntersecting)) { io.disconnect(); play(); }
        }, { threshold: 0, rootMargin: "0px 0px -15% 0px" }); // a diff taller than the screen still plays
        io.observe(root);
      } else requestAnimationFrame(play);
    }

    container.replaceChildren(root);
    return {
      root,
      replay: () => { if (root.classList.contains("sd-anim")) play(); },
      removed: dels.length,
      added: adds.length,
    };
  }

  window.SqlDiff = {
    render,
    format,
    diff: (a, b) => {
      const d = diff(a, b);
      return {
        a: d.A.map((t, i) => ({ v: t.v, removed: !!d.sa[i] })),
        b: d.B.map((t, i) => ({ v: t.v, added: !!d.sb[i] })),
      };
    },
  };
})();
