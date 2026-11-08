/* "Use your own data": upload a .sqlite/.db file or 1-8 CSVs to POST /api/upload, show the tables it made.

   const ctl = Upload.render(container, {
     onReady(dbId, info) {},   // after upload or restore; info = {db_id, kind?, tables:[{name, rows}], expires_in_s}
     onRemove(dbId) {},        // "Remove" tapped (client-side forget only)
     onExpire(dbId) {},        // countdown ran out and the server no longer has it
     dbId: "upload:abc...",    // optional: restore a previous upload via GET /api/upload/<id>
     endpoint: "/api/upload",  // optional
   });
   ctl.upload(files)   // same as picking files
   ctl.refresh()       // re-read expires_in_s (the server TTL restarts on every use: call after each check)
   ctl.remove()        // forget it, back to the picker
   ctl.destroy()       // stop timers, empty the container
   ctl.dbId            // current upload db_id or null
*/
(function () {
  "use strict";
  const MAX_BYTES = 10 * 1024 * 1024;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const mb = (b) => (b / 1048576).toFixed(b < 1048576 ? 2 : 1);
  const rowsText = (n) => Number(n).toLocaleString("en-US") + (n === 1 ? " row" : " rows");
  const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // server messages are lower-case fragments ("not a SQLite database (bad header)"): show them as sentences
  const sentence = (t) => { t = t.trim(); t = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?)]$/.test(t) ? t : t + "."; };
  function errorText(xhrOrRes, body) {
    if (body && typeof body.error === "string" && body.error) return sentence(body.error);  // server: 400 {error}
    if (body && typeof body.detail === "string" && body.detail) return sentence(body.detail);
    if (body && Array.isArray(body.detail) && body.detail[0] && body.detail[0].msg) return sentence(body.detail[0].msg);
    const status = xhrOrRes && xhrOrRes.status;
    if (status === 413) return "Too large. The limit is 10 MB.";
    return status ? "Upload failed (HTTP " + status + ")." : "Upload failed: the laptop did not respond.";
  }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function render(container, opts) {
    opts = opts || {};
    const endpoint = opts.endpoint || "/api/upload";
    const root = el("section", "up");
    root.setAttribute("aria-live", "polite");
    container.replaceChildren(root);

    let dbId = null, info = null, xhr = null, timer = null, deadline = 0, names = "", dead = false;

    function clearTimer() { if (timer) { clearInterval(timer); timer = null; } }

    // ---- empty: picker + drop zone (optionally with an error above it) ----
    function showEmpty(err) {
      clearTimer();
      dbId = null; info = null;
      root.replaceChildren();
      if (err) {
        const e = el("p", "up-err", err);
        e.setAttribute("role", "alert");
        root.append(e);
      }
      const drop = el("label", "up-drop");
      const input = el("input", "up-input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".csv,text/csv,.sqlite,.sqlite3,.db,application/x-sqlite3,application/vnd.sqlite3,application/octet-stream";
      input.addEventListener("change", () => { if (input.files.length) upload(input.files); });
      drop.append(el("span", "up-title", "Use your own data"),
                  el("span", "up-line", "CSV or SQLite, up to 10 MB. Stays on this laptop."), input);
      let depth = 0;
      drop.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; drop.classList.add("over"); });
      drop.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
      drop.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; drop.classList.remove("over"); } });
      drop.addEventListener("drop", (e) => {
        e.preventDefault(); depth = 0; drop.classList.remove("over");
        if (e.dataTransfer && e.dataTransfer.files.length) upload(e.dataTransfer.files);
      });
      root.append(drop);
    }

    // ---- uploading: real XHR progress, then "Reading tables…" ----
    function upload(fileList) {
      if (xhr || dead) return;
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > MAX_BYTES) { showEmpty("Files total " + mb(total) + " MB. The limit is 10 MB."); return; }
      names = files.map((f) => f.name).join(", ");

      root.replaceChildren();
      const head = el("p", "up-files", names);
      const track = el("div", "up-track");
      const fill = el("div", "up-fill");
      track.append(fill);
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", "0");
      const status = el("p", "up-status");
      const pct = el("span", "up-pct", "0%");
      const amt = el("span", "up-amt", "0 of " + mb(total) + " MB");
      status.append(pct, amt);
      root.append(head, track, status);

      const set = (loaded, size) => {
        const f = size ? Math.min(1, loaded / size) : 0;
        fill.style.transform = "scaleX(" + f + ")";
        track.setAttribute("aria-valuenow", String(Math.round(f * 100)));
        pct.textContent = Math.round(f * 100) + "%";
        amt.textContent = mb(Math.min(loaded, size)) + " of " + mb(size) + " MB";
      };
      const reading = () => {
        fill.style.transform = "scaleX(1)";
        track.setAttribute("aria-valuenow", "100");
        status.replaceChildren(el("span", "up-pct", "Reading tables…"));
      };

      const fd = new FormData();
      files.forEach((f) => fd.append("files", f, f.name));
      xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint);
      xhr.responseType = "text";
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) set(e.loaded, e.total); };
      xhr.upload.onload = reading;
      xhr.onload = () => {
        const x = xhr; xhr = null;
        if (dead) return;
        const body = parse(x.responseText);
        if (x.status >= 200 && x.status < 300 && body && body.db_id) showReady(body, true);
        else showEmpty(errorText(x, body));
      };
      xhr.onerror = () => { const x = xhr; xhr = null; if (!dead) showEmpty(errorText(x, null)); };
      xhr.send(fd);
    }

    // ---- ready: table list, countdown, Remove ----
    function showReady(data, fresh) {
      dbId = data.db_id; info = data;
      root.replaceChildren();
      if (names) root.append(el("p", "up-files", names));
      const list = el("ul", "up-tables");
      const tables = data.tables || [];
      const step = Math.min(90, 600 / Math.max(1, tables.length));
      const animate = fresh && !reducedMotion();
      tables.forEach((t, i) => {
        const li = el("li", animate ? "up-row in" : "up-row");
        if (animate) li.style.animationDelay = Math.round(i * step) + "ms";
        li.append(el("span", "up-name", t.name), el("span", "up-rows", rowsText(t.rows)));
        list.append(li);
      });
      const foot = el("div", "up-foot");
      const left = el("span", "up-exp");
      const rm = el("button", "up-remove", "Remove");
      rm.type = "button";
      rm.addEventListener("click", remove);
      foot.append(left, rm);
      root.append(list, foot);

      setDeadline(data.expires_in_s);
      const tick = () => {
        const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        left.textContent = s >= 60 ? "Expires in " + Math.ceil(s / 60) + " min" : "Expires in " + s + " s";
        if (s === 0) { clearTimer(); refresh(true); }
      };
      clearTimer();
      tick();
      timer = setInterval(tick, 1000);
      showReady.tick = tick;
      if (opts.onReady) opts.onReady(dbId, data);
    }

    function setDeadline(s) { deadline = Date.now() + Math.max(0, Number(s) || 0) * 1000; }

    function idOf(d) { return String(d).replace(/^upload:/, ""); }

    async function refresh(atZero) {
      if (!dbId || dead) return;
      const id = dbId;
      let res = null, body = null;
      try {
        res = await fetch(endpoint + "/" + encodeURIComponent(idOf(id)), { cache: "no-store" });
        body = parse(await res.text());
      } catch (e) {
        if (atZero && dbId === id) setTimeout(() => refresh(true), 5000);
        return; // network blip: keep showing what we have
      }
      if (dbId !== id || dead) return;
      if (res.ok && body && body.db_id) {
        info = body;
        setDeadline(body.expires_in_s);
        if (!timer) timer = setInterval(showReady.tick, 1000);
        showReady.tick();
      } else if (res.status === 404 || res.status === 400 || res.status === 410) {
        const gone = dbId;
        showEmpty("This upload expired. Upload it again to keep using it.");
        if (opts.onExpire) opts.onExpire(gone);
      }
    }

    function remove() {
      if (xhr) { xhr.abort(); xhr = null; }
      const gone = dbId;
      names = "";
      showEmpty();
      if (gone && opts.onRemove) opts.onRemove(gone);
    }

    function onVisible() { if (document.visibilityState === "visible") refresh(false); }
    document.addEventListener("visibilitychange", onVisible);

    function destroy() {
      dead = true;
      clearTimer();
      if (xhr) { xhr.abort(); xhr = null; }
      document.removeEventListener("visibilitychange", onVisible);
      container.replaceChildren();
    }

    // initial state: restore or empty
    showEmpty();
    if (opts.dbId) {
      fetch(endpoint + "/" + encodeURIComponent(idOf(opts.dbId)), { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((body) => { if (body && body.db_id && !dead && !dbId && !xhr) showReady(body, false); })
        .catch(() => {});
    }

    return {
      upload, refresh: () => refresh(false), remove, destroy,
      get dbId() { return dbId; },
      get info() { return info; },
    };
  }

  window.Upload = { render };
})();
