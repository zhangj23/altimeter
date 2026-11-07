"use strict";
/* Dev-only fixture driver, loaded by app.js only when the URL has ?mock=1. Not a measured result:
   every number here is made up for layout screenshots, and each pass is labeled "mock fixture".
   ?mock=1                       control strip at the bottom of the page
   ?mock=1&state=<name>          run one scenario on load, no strip (idle|awaiting|cruise|caution|ask|readings)
   &choose=A|B                   with state=readings, tap that reading after it renders */
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
  };

  const params = new URLSearchParams(location.search);
  const send = (msg, ms) => setTimeout(() => onMessage({ data: JSON.stringify(msg) }), ms);
  let scenario = "cruise";

  // Stand-in socket: replies with the same message sequence the gateway sends.
  ws = {
    readyState: WebSocket.OPEN,
    send() {
      send({ type: "queued", position: 1 }, 60);
      send({ type: "working" }, 160);
      if (scenario !== "awaiting") send({ type: "result", ...S[scenario] }, 1500);
    },
  };
  $("link").textContent = "Mock fixture";
  fillDbs([DB, "california_schools", "codebase_community"]);

  function run(name) {
    if (pending) return;
    if (name === "idle") { if (params.get("state") !== "idle") location.search = "?mock=1"; return; }
    scenario = name;
    $("db").value = DB;
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
  for (const name of ["idle", "awaiting", "cruise", "caution", "ask", "readings"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = name;
    b.setAttribute("style", "padding:4px 10px;border:1px solid var(--ink-2);border-radius:4px;background:transparent;font-size:var(--t0)");
    b.addEventListener("click", () => run(name));
    strip.append(b);
  }
  document.querySelector("main").append(strip);
})();
