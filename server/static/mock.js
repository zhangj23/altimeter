"use strict";
/* Dev-only fixture driver, loaded by app.js only when the URL has ?mock=1. Not a measured result:
   every number here is made up for layout screenshots, and each pass is labeled "mock fixture".
   ?mock=1                       control strip at the bottom of the page
   ?mock=1&state=<name>          run one scenario on load, no strip (idle|warming|awaiting|stage|cruise|caution|ask|readings|audit)
   &choose=A|B                   with state=readings, tap that reading after it renders
   ?mock=1&state=check|check-flagged|check-clear   Check mode. Its fixtures are copies of real /api/check output
                                 (BIRD q571 and q89, captured from a local run); the probe numbers are still made up. */
(() => {
  const DB = "formula_1";
  const base = { db_id: DB, rows_capped: false, error: null, timed_out: false, gen_seconds: 2.41, exec_seconds: 0.012,
    n_prompt: 1840, n_gen: 38, logprob_mean: null, logprob_min: null, readings: null, readings_seconds: null, mock: true };
  const probe = (needle) => ({ needle, probe: needle, calibrated: needle, layer: 19, position: "last_prompt", n_train: 0, cv_auroc: null });

  const S = {
    cruise: { question: "How many races were held in 2009?", ...base, probe: probe(0.91),
      sql: "SELECT COUNT(*) FROM races WHERE year = 2009", columns: ["COUNT(*)"], rows: [[17]] },
    caution: { question: "Which constructor scored the most points in 2010?", ...base, probe: probe(0.63),
      sql: "SELECT c.name, SUM(cs.points) AS pts\nFROM constructorStandings cs\nJOIN races r ON r.raceId = cs.raceId\nJOIN constructors c ON c.constructorId = cs.constructorId\nWHERE r.year = 2010\nGROUP BY c.constructorId\nORDER BY pts DESC\nLIMIT 1",
      columns: ["name", "pts"], rows: [["Red Bull", 4851]] },
    ask: { question: "What was Lewis Hamilton's best qualifying lap?", ...base, probe: probe(0.27),
      sql: "SELECT MIN(q.q3)\nFROM qualifying q\nJOIN drivers d ON d.driverId = q.driverId\nWHERE d.forename = 'Lewis' AND d.surname = 'Hamilton'",
      columns: ["MIN(q.q3)"], rows: [["1:14.260"]] },
    readings: { question: "What is the average lap time of Lewis Hamilton?", ...base, probe: probe(0.22), readings_seconds: 4.8,
      sql: "SELECT AVG(lt.milliseconds)\nFROM lapTimes lt\nJOIN drivers d ON d.driverId = lt.driverId\nWHERE d.forename = 'Lewis' AND d.surname = 'Hamilton'",
      columns: ["AVG(lt.milliseconds)"], rows: [[97420.5]],
      readings: [
        { label: "A", share: 0.6, error: null, n_rows: 1, columns: ["AVG(lt.milliseconds)"], rows: [[97420.5]],
          sql: "SELECT AVG(lt.milliseconds)\nFROM lapTimes lt\nJOIN drivers d ON d.driverId = lt.driverId\nWHERE d.forename = 'Lewis' AND d.surname = 'Hamilton'" },
        { label: "B", share: 0.4, error: null, n_rows: 1, columns: ["AVG(r.fastestLapTime)"], rows: [["1:31.842"]],
          sql: "SELECT AVG(r.fastestLapTime)\nFROM results r\nJOIN drivers d ON d.driverId = r.driverId\nWHERE d.forename = 'Lewis' AND d.surname = 'Hamilton'" },
      ] },
    audit: { question: "For the user No.24, how many times is the number of his/her posts compared to his/her votes?", ...base,
      db_id: "codebase_community", probe: probe(0.71), columns: null, rows: null, sql: null },
  };

  const params = new URLSearchParams(location.search);
  const FX = {"presets":[{"id":"bird571","db_id":"codebase_community","sql":"SELECT CAST(COUNT(T2.Id) AS REAL) / COUNT(DISTINCT T1.Id) FROM votes AS T1 INNER JOIN posts AS T2 ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24","label":"BIRD dev answer key, question 571 (2024 release)","question":"For user No. 24, how many times is the number of posts compared to votes?","has_fix":false},{"id":"bird89","db_id":"financial","sql":"SELECT COUNT(T2.account_id) FROM district AS T1 INNER JOIN account AS T2 ON T1.district_id = T2.district_id WHERE T1.A3 = 'east Bohemia' AND T2.frequency = 'POPLATEK PO OBRATU'","label":"BIRD dev answer key, question 89 (2024 release)","question":"How many accounts in East Bohemia chose statement issuance after each transaction?","has_fix":false}],"bird571":{"db_id":"codebase_community","sql":"SELECT CAST(COUNT(T2.Id) AS REAL) / COUNT(DISTINCT T1.Id) FROM votes AS T1 INNER JOIN posts AS T2 ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24","parses":true,"parse_error":null,"audited":true,"flagged":true,"findings":[{"table":"posts","alias":"T2","column":"T2.Id","aggregate":"COUNT(T2.Id)","joined_rows":24,"distinct_rows":3,"factor":8.0,"many_to_many":true}],"message":"Fan-out: COUNT(T2.Id) sees each posts row 8x (24 joined rows vs 3 distinct) because of the JOIN (many-to-many: no table appears once per joined row). Deduplicated value: 0.375.","audit_error":null,"explanation":"Each posts row is counted 8 times because the query also joins votes.","intended":"If you meant to count every posts and votes pair, this is fine. If you meant to count each posts row once, use the fix.","highlights":[{"start":12,"end":24,"kind":"aggregate"},{"start":81,"end":127,"kind":"join"}],"original":{"columns":["CAST(COUNT(T2.Id) AS REAL) / COUNT(DISTINCT T1.Id)"],"rows":[[3.0]],"error":null,"seconds":0.0568,"rows_capped":false},"corrected":{"sql":"SELECT CAST((SELECT COUNT(T2.Id) FROM \"posts\" AS \"T2\" WHERE \"T2\".rowid IN (SELECT \"T2\".rowid FROM votes AS T1 INNER JOIN posts AS T2 ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24)) AS REAL) / COUNT(DISTINCT T1.Id) FROM votes AS T1 INNER JOIN posts AS T2 ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24","source":"auditor","columns":["CAST((SELECT COUNT(T2.Id) FROM \"posts\" AS \"T2\" WHERE \"T2\".rowid IN (SELECT \"T2\".rowid FROM votes AS T1 INNER JOIN posts AS T2 ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24)) AS REAL) / COUNT(DISTINCT T1.Id)"],"rows":[[0.375]],"error":null,"seconds":0.0541,"rows_capped":false},"headline":{"column":"CAST(COUNT(T2.Id) AS REAL) / COUNT(DISTINCT T1.Id)","row":null,"before":3.0,"after":0.375,"before_text":"3.0","after_text":"0.375","ratio":8.0,"ratio_text":"8","single_cell":true},"audit_seconds":0.1456},"bird89":{"db_id":"financial","sql":"SELECT COUNT(T2.account_id) FROM district AS T1 INNER JOIN account AS T2 ON T1.district_id = T2.district_id WHERE T1.A3 = 'east Bohemia' AND T2.frequency = 'POPLATEK PO OBRATU'","parses":true,"parse_error":null,"audited":true,"flagged":false,"findings":[],"message":"no fan-out detected","audit_error":null,"explanation":"","highlights":[],"original":{"columns":["COUNT(T2.account_id)"],"rows":[[13]],"error":null,"seconds":0.0007,"rows_capped":false},"corrected":null,"headline":null,"audit_seconds":0.0039}};
  apiCall = async (url, body) => {
    await new Promise((r) => setTimeout(r, 400));
    if (url === "/api/presets") return { ok: true, status: 200, data: { presets: FX.presets } };
    const p = FX.presets.find((x) => x.sql === body.sql);
    return p ? { ok: true, status: 200, data: FX[p.id] } : { ok: false, status: 400, data: { error: "mock fixture: only the listed presets" } };
  };
  const send = (msg, ms) => setTimeout(() => onMessage({ data: JSON.stringify(msg) }), ms);
  let scenario = "cruise";
  let jobId = 100;
  const status = (warm) => ({ type: "status", ready: !warm, warming: warm, warm_seconds: warm ? 14 : null, queue: 0, fake: false, probe: !warm, restarts: 0 });

  // Stand-in socket: replies with the same message sequence the gateway sends.
  ws = {
    readyState: WebSocket.OPEN,
    send() {
      const job_id = ++jobId;
      send({ type: "queued", job_id, position: 1 }, 60);
      send({ type: "working", job_id, elapsed: 0 }, 160);
      send({ type: "stage", job_id, stage: "generating", elapsed: 0 }, 170);
      if (scenario === "awaiting") return;
      send({ type: "stage", job_id, stage: "scoring", elapsed: 1.0 }, 1150);
      if (scenario === "stage") return; // hold mid-job for screenshots
      send({ type: "stage", job_id, stage: "executing", elapsed: 1.2 }, 1350);
      send({ type: "result", job_id, ...S[scenario] }, 1500);
    },
  };
  onMessage({ data: JSON.stringify(status(params.get("state") === "warming")) });
  {
    const a = FX.bird571;
    Object.assign(S.audit, { sql: a.sql, columns: a.original.columns, rows: a.original.rows,
      audit: { ...a, original: undefined, sql: undefined, annotate_seconds: a.audit_seconds } });
  }
  $("link").textContent = "Mock fixture";
  fillDbs([DB, "california_schools", "codebase_community", "financial"]);
  loadPresets();

  function run(name) {
    if (pending) return;
    if (name === "idle") { if (params.get("state") !== "idle") location.search = "?mock=1"; return; }
    if (name === "warming") { if (params.get("state") !== "warming") location.search = "?mock=1&state=warming"; return; }
    if (name.startsWith("check")) {
      setMode("check");
      const id = { "check-flagged": "bird571", "check-clear": "bird89" }[name];
      if (id) setTimeout(() => {
        [...document.querySelectorAll("#presets button")].find((b) => b.querySelector(".ps").textContent === FX.presets.find((p) => p.id === id).label).click();
        $("checkForm").requestSubmit();
      }, 500);
      return;
    }
    setMode("ask");
    scenario = name;
    if (name === "stage") name = "caution"; // holds at "Scoring confidence"
    $("db").value = S[name] && S[name].db_id ? S[name].db_id : DB;
    $("question").value = (S[name] || S.ask).question;
    $("form").requestSubmit();
  }

  const state = params.get("state");
  if (state) {
    run(state);
    const pick = params.get("choose");
    if (state === "readings" && pick) {
      setTimeout(() => {
        const card = [...document.querySelectorAll(".pass:first-child .reading")].find((c) => c.querySelector(".rname").firstChild.textContent === `Reading ${pick}`);
        if (card) card.click();
      }, 2000);
    }
    return;
  }

  const strip = document.createElement("div");
  strip.setAttribute("style", "margin-top:28px;padding-top:10px;border-top:1px dashed var(--rule);display:flex;flex-wrap:wrap;gap:8px;font-size:var(--t0)");
  for (const name of ["idle", "warming", "awaiting", "stage", "cruise", "caution", "ask", "readings", "audit", "check", "check-flagged", "check-clear"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.setAttribute("style", "padding:4px 10px;border:1px solid var(--ink-2);border-radius:4px;background:transparent;font-size:var(--t0)");
    b.addEventListener("click", () => run(name));
    strip.append(b);
  }
  document.querySelector("main").append(strip);
})();
