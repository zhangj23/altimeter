"""Pre-flight check: run the deterministic fan-out auditor on any SQL (a colleague's, or the model's).

POST /api/check {db_id, sql, preset?} -> audit + original result + corrected result (auditor rewrite, or a
hand-written fix for a preset whose SQL is unchanged) + headline (first number that changed) + highlights.
GET /api/presets -> real queries from the BIRD dev answer keys (three with verified fan-out, one clean).
annotate(result) adds result["audit"] to a worker answer (same shape, without "original": the answer itself).
"""
from __future__ import annotations

import re
import time
from typing import Any

import sqlglot
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlglot import exp

from altimeter.auditor import audit, has_join_aggregate
from altimeter.sqlexec import run

from .worker import db_path, list_dbs

MAX_ROWS = 200
EXEC_TIMEOUT_S = 5.0
CHECK_AUDIT_TIMEOUT_S = 15.0  # explicit check: big CTE queries (BIRD q140) need ~2-5 s
ANSWER_AUDIT_TIMEOUT_S = 5.0
MAX_SQL_CHARS = 20_000

router = APIRouter()

# --- presets: SQL copied verbatim from the BIRD dev answer keys ------------------------------------------
_Q571 = ("SELECT CAST(COUNT(T2.Id) AS REAL) / COUNT(DISTINCT T1.Id) FROM votes AS T1 INNER JOIN posts AS T2 "
         "ON T1.UserId = T2.OwnerUserId WHERE T1.UserId = 24")

_Q140 = """WITH PisekAccounts AS (
    SELECT
        a.account_id,
        a.district_id,
        a.frequency,
        a.date,
        d.A2 AS district_name
    FROM account AS a
    INNER JOIN district AS d ON a.district_id = d.district_id
    WHERE d.A2 = 'Pisek'
),
AccountStats AS (
    SELECT
        pa.account_id,
        COUNT(DISTINCT t.trans_id) AS transaction_count,
        SUM(CASE WHEN t.type = 'PRIJEM' THEN t.amount ELSE 0 END) AS total_deposits,
        SUM(CASE WHEN t.type = 'VYDAJ' THEN t.amount ELSE 0 END) AS total_withdrawals,
        MAX(t.balance) AS max_balance,
        COUNT(DISTINCT c.card_id) AS card_count
    FROM PisekAccounts pa
    LEFT JOIN trans t ON pa.account_id = t.account_id
    LEFT JOIN disp d ON pa.account_id = d.account_id
    LEFT JOIN card c ON d.disp_id = c.disp_id
    GROUP BY pa.account_id
),
LoanInfo AS (
    SELECT
        pa.account_id,
        COUNT(l.loan_id) AS loan_count,
        SUM(l.amount) AS total_loan_amount,
        SUM(CASE WHEN l.status = 'A' THEN l.amount ELSE 0 END) AS active_loan_amount,
        AVG(l.duration) AS avg_loan_duration
    FROM PisekAccounts pa
    LEFT JOIN loan l ON pa.account_id = l.account_id
    GROUP BY pa.account_id
)
SELECT
    COUNT(pa.account_id) AS total_pisek_accounts,
    AVG(ast.transaction_count) AS avg_transactions_per_account,
    SUM(ast.total_deposits) AS total_deposits_all_accounts,
    SUM(ast.total_withdrawals) AS total_withdrawals_all_accounts,
    AVG(ast.max_balance) AS avg_max_balance,
    SUM(ast.card_count) AS total_cards_issued,
    SUM(li.loan_count) AS total_loans_issued,
    SUM(li.active_loan_amount) / CASE WHEN SUM(li.total_loan_amount) = 0 THEN 1 ELSE SUM(li.total_loan_amount) END * 100 AS percent_active_loans,
    (SELECT COUNT(DISTINCT c.client_id)
     FROM PisekAccounts pa
     JOIN disp d ON pa.account_id = d.account_id
     JOIN client c ON d.client_id = c.client_id
     WHERE d.type = 'OWNER') AS unique_account_owners
FROM PisekAccounts pa
LEFT JOIN AccountStats ast ON pa.account_id = ast.account_id
LEFT JOIN LoanInfo li ON pa.account_id = li.account_id;"""

# Hand fix: transactions are pre-aggregated per account before disp/card can repeat them.
# Verified: total deposits 31,522,862 = SUM(trans.amount) for Pisek PRIJEM computed directly.
_Q140_FIX = _Q140.replace("""        COUNT(DISTINCT t.trans_id) AS transaction_count,
        SUM(CASE WHEN t.type = 'PRIJEM' THEN t.amount ELSE 0 END) AS total_deposits,
        SUM(CASE WHEN t.type = 'VYDAJ' THEN t.amount ELSE 0 END) AS total_withdrawals,
        MAX(t.balance) AS max_balance,
        COUNT(DISTINCT c.card_id) AS card_count
    FROM PisekAccounts pa
    LEFT JOIN trans t ON pa.account_id = t.account_id
""", """        COALESCE(MAX(t.transaction_count), 0) AS transaction_count,
        COALESCE(MAX(t.total_deposits), 0) AS total_deposits,
        COALESCE(MAX(t.total_withdrawals), 0) AS total_withdrawals,
        MAX(t.max_balance) AS max_balance,
        COUNT(DISTINCT c.card_id) AS card_count
    FROM PisekAccounts pa
    LEFT JOIN (
        SELECT account_id,
            COUNT(trans_id) AS transaction_count,
            SUM(CASE WHEN type = 'PRIJEM' THEN amount ELSE 0 END) AS total_deposits,
            SUM(CASE WHEN type = 'VYDAJ' THEN amount ELSE 0 END) AS total_withdrawals,
            MAX(balance) AS max_balance
        FROM trans
        WHERE account_id IN (SELECT account_id FROM PisekAccounts)
        GROUP BY account_id
    ) t ON pa.account_id = t.account_id
""")

_Q200 = """WITH MoleculeStats AS (
    SELECT
        m.molecule_id,
        m.label,
        COUNT(DISTINCT a.atom_id) AS atom_count,
        COUNT(DISTINCT b.bond_id) AS bond_count,
        SUM(CASE WHEN a.element = 'c' THEN 1 ELSE 0 END) AS carbon_count,
        SUM(CASE WHEN a.element = 'n' THEN 1 ELSE 0 END) AS nitrogen_count,
        SUM(CASE WHEN b.bond_type = '#' THEN 1 ELSE 0 END) AS triple_bond_count
    FROM
        molecule m
    LEFT JOIN
        atom a ON m.molecule_id = a.molecule_id
    LEFT JOIN
        bond b ON m.molecule_id = b.molecule_id
    GROUP BY
        m.molecule_id, m.label
),
TripleBondedAtoms AS (
    SELECT
        c.atom_id,
        c.atom_id2,
        a1.element AS element1,
        a2.element AS element2,
        b.molecule_id
    FROM
        connected c
    JOIN
        bond b ON c.bond_id = b.bond_id
    JOIN
        atom a1 ON c.atom_id = a1.atom_id
    JOIN
        atom a2 ON c.atom_id2 = a2.atom_id
    WHERE
        b.bond_type = '#'
)
SELECT
    ms.molecule_id,
    ms.atom_count,
    ms.bond_count,
    ms.carbon_count,
    ms.nitrogen_count,
    ms.triple_bond_count,
    (SELECT COUNT(*) FROM TripleBondedAtoms tba WHERE tba.molecule_id = ms.molecule_id AND tba.element1 = 'n' AND tba.element2 = 'n') AS nitrogen_triple_bonds,
    (SELECT COUNT(*) FROM TripleBondedAtoms tba WHERE tba.molecule_id = ms.molecule_id AND (tba.element1 = 'c' OR tba.element2 = 'c')) AS carbon_containing_triple_bonds,
    CASE
        WHEN ms.triple_bond_count > 1 THEN 'Multiple Triple Bonds'
        WHEN ms.triple_bond_count = 1 THEN 'Single Triple Bond'
        ELSE 'No Triple Bonds'
    END AS bond_category
FROM
    MoleculeStats ms
WHERE
    ms.label = '+'
    AND ms.triple_bond_count > 0
ORDER BY
    ms.triple_bond_count DESC,
    ms.atom_count DESC;"""

# Hand fix: count distinct atoms/bonds instead of joined rows. Verified: TR041 has 8 carbon atoms, 2 triple bonds.
_Q200_FIX = (_Q200
             .replace("SUM(CASE WHEN a.element = 'c' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN a.element = 'c' THEN a.atom_id END)")
             .replace("SUM(CASE WHEN a.element = 'n' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN a.element = 'n' THEN a.atom_id END)")
             .replace("SUM(CASE WHEN b.bond_type = '#' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN b.bond_type = '#' THEN b.bond_id END)"))

_Q89 = ("SELECT COUNT(T2.account_id) FROM district AS T1 INNER JOIN account AS T2 ON T1.district_id = T2.district_id "
        "WHERE T1.A3 = 'east Bohemia' AND T2.frequency = 'POPLATEK PO OBRATU'")

PRESETS: list[dict[str, Any]] = [
    {"id": "bird571", "db_id": "codebase_community", "sql": _Q571, "fix": None,
     "label": "BIRD dev answer key, question 571 (2024 release)",
     "question": "For user No. 24, how many times is the number of posts compared to votes?"},
    {"id": "bird140", "db_id": "financial", "sql": _Q140, "fix": _Q140_FIX,
     "label": "BIRD dev answer key, question 140 (November 2025 release)",
     "question": "Financial profile of all accounts in the Pisek district: deposits, withdrawals, cards, loans."},
    {"id": "bird200", "db_id": "toxicology", "sql": _Q200, "fix": _Q200_FIX,
     "label": "BIRD dev answer key, question 200 (November 2025 release)",
     "question": "Atom, carbon and triple-bond counts for carcinogenic molecules with triple bonds."},
    {"id": "bird89", "db_id": "financial", "sql": _Q89, "fix": None,
     "label": "BIRD dev answer key, question 89 (2024 release)",
     "question": "How many accounts in East Bohemia chose statement issuance after each transaction?"},
]
_BY_ID = {p["id"]: p for p in PRESETS}


# --- helpers ----------------------------------------------------------------------------------------------
def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str)):
        return v
    if isinstance(v, bytes):
        return f"<blob {len(v)} bytes>"
    return str(v)


def _norm_sql(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().rstrip(";").strip().lower()


def execute(path: str, sql: str) -> dict[str, Any]:
    """Run read-only with the gateway limits; columns come from the cursor of a LIMIT 0 wrapper."""
    from .worker import _columns  # same column logic as answers

    r = run(path, sql, timeout_s=EXEC_TIMEOUT_S, max_rows=MAX_ROWS)
    rows = [[_cell(v) for v in row] for row in r.rows] if r.rows is not None else None
    cols = _columns(path, sql) if rows is not None else None
    if rows is not None and (cols is None or (rows and len(cols) != len(rows[0]))):
        cols = [f"col{i + 1}" for i in range(len(rows[0]) if rows else 0)]
    return {"columns": cols, "rows": rows, "error": r.error, "seconds": round(r.seconds, 4),
            "rows_capped": rows is not None and len(rows) >= MAX_ROWS}


def fmt_num(v: Any) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, int):
        return f"{v:,}"
    if v == int(v) and abs(v) < 1e15:
        return f"{int(v):,}.0"
    s = f"{v:,.4f}".rstrip("0")
    return s + "0" if s.endswith(".") else s


def headline(orig: dict[str, Any], fixed: dict[str, Any] | None) -> dict[str, Any] | None:
    """First numeric cell of the first row that differs between the original and corrected results."""
    if not fixed or not orig.get("rows") or not fixed.get("rows"):
        return None
    a, b = orig["rows"][0], fixed["rows"][0]
    if len(a) != len(b):
        return None
    for i, (x, y) in enumerate(zip(a, b)):
        num = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (x, y))
        if num and round(float(x), 4) != round(float(y), 4):
            label = None
            if len(a) > 1 and isinstance(a[0], str) and a[0] == b[0]:
                label = a[0]  # row key, e.g. molecule TR041
            ratio = float(x) / float(y) if y else None
            return {"column": (orig.get("columns") or [None] * len(a))[i], "row": label,
                    "before": x, "after": y, "before_text": fmt_num(x), "after_text": fmt_num(y),
                    "ratio": round(ratio, 3) if ratio is not None else None,
                    "ratio_text": (f"{ratio:.3g}" if ratio is not None else None),
                    "single_cell": len(orig["rows"]) == 1 and len(a) == 1}
    return None


def _scopes(sql: str) -> list[tuple[exp.Select, list[tuple[str, str]]]]:
    """Each SELECT with >= 2 sources and its (table, alias) pairs, in text order."""
    try:
        root = sqlglot.parse_one(sql, read="sqlite")
    except Exception:  # noqa: BLE001
        return []
    out = []
    for sel in root.find_all(exp.Select):
        pairs = []
        srcs = [sel.args.get("from_") or sel.args.get("from")] + list(sel.args.get("joins") or [])
        for s in srcs:
            if s is None:
                continue
            t = s.this
            if isinstance(t, exp.Table):
                pairs.append((t.name, t.alias_or_name))
            elif t is not None and getattr(t, "alias", None):
                pairs.append(("(subquery)", t.alias))
        if len(pairs) >= 2:
            out.append((sel, pairs))
    return out


def _flex(text: str) -> str:
    """Regex for a SQL fragment that tolerates whitespace and case differences."""
    toks = re.findall(r"\w+|'[^']*'|\S", text)
    return r"\s*".join(re.escape(t) for t in toks)


def explain(sql: str, findings: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Plain-English sentence per inflated table + character spans to highlight (aggregates and their JOINs)."""
    scopes = _scopes(sql)
    spans: list[dict[str, Any]] = []
    sentences: list[str] = []
    seen: set[str] = set()
    for f in findings:
        agg, table, alias = f["aggregate"], f["table"], f["alias"]
        # the scope that owns this aggregate (not an outer SELECT whose WITH clause contains it)
        scope = next((p for s, p in scopes
                      if any(a.sql(dialect="sqlite") == agg and a.find_ancestor(exp.Select) is s
                             for a in s.find_all(exp.AggFunc, exp.Anonymous))), None)
        m = re.search(_flex(agg), sql, re.I)
        if m:
            spans.append({"start": m.start(), "end": m.end(), "kind": "aggregate"})
        others = [t for t, a in (scope or []) if a != alias]
        for t, a in scope or []:
            pat = (r"\bJOIN\s+[\"`\[]?" + re.escape(t) + r"[\"`\]]?\s+(?:AS\s+)?[\"`\[]?" + re.escape(a)
                   + r"[\"`\]]?(?:\s+ON\s+[\w.\"`\[\]]+\s*=\s*[\w.\"`\[\]]+)?") if a != t else \
                  (r"\bJOIN\s+[\"`\[]?" + re.escape(t) + r"[\"`\]]?(?:\s+ON\s+[\w.\"`\[\]]+\s*=\s*[\w.\"`\[\]]+)?")
            # a scope's JOINs follow its SELECT list: take the first match after the aggregate
            jm = re.compile(pat, re.I).search(sql, m.end() if m else 0)
            if jm:
                spans.append({"start": jm.start(), "end": jm.end(), "kind": "join"})
        if table in seen:
            continue
        seen.add(table)
        fac = float(f["factor"])
        exact = abs(fac - round(fac)) < 1e-9
        times = f"{int(round(fac))} times" if exact else f"{fac:.3g} times on average"
        who = "every joined table" if table == "*" else f"{table}"
        names = list(dict.fromkeys(o for o in others if o != table))
        joined = (" and ".join(names) if len(names) <= 2 else ", ".join(names[:-1]) + " and " + names[-1]) \
            if names else "another table"
        if table == "*":
            sentences.append(f"Each row of every joined table is repeated at least {times} by the JOIN.")
        else:
            sentences.append(f"Each {who} row is counted {times} because the query also joins {joined}.")
    # merge overlapping spans, keep text order
    spans.sort(key=lambda s: (s["start"], -s["end"]))
    merged: list[dict[str, Any]] = []
    for s in spans:
        if merged and s["start"] < merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], s["end"])
            continue
        merged.append(dict(s))
    return " ".join(sentences), merged


def check(db_id: str, sql: str, preset: str | None = None, audit_timeout_s: float = CHECK_AUDIT_TIMEOUT_S,
          original: dict[str, Any] | None = None) -> dict[str, Any]:
    path = db_path(db_id)
    t0 = time.time()
    orig = original if original is not None else execute(path, sql)
    audited = has_join_aggregate(sql)
    a = audit(path, sql, timeout_s=audit_timeout_s) if audited else None
    audit_s = time.time() - t0
    flagged = bool(a and a.flagged)
    corrected = None
    p = _BY_ID.get(preset or "")
    if flagged and a and a.suggested_sql:
        corrected = {"sql": a.suggested_sql, "source": "auditor", **execute(path, a.suggested_sql)}
    elif flagged and p and p.get("fix") and p["db_id"] == db_id and _norm_sql(p["sql"]) == _norm_sql(sql):
        corrected = {"sql": p["fix"], "source": "hand", **execute(path, p["fix"])}
    sentence, spans = explain(sql, a.findings) if flagged and a else ("", [])
    try:
        sqlglot.parse_one(sql, read="sqlite")
        parse_error = None
    except Exception as e:  # noqa: BLE001
        parse_error = str(e).splitlines()[0][:200]
    return {
        "db_id": db_id, "sql": sql,
        "parses": parse_error is None, "parse_error": parse_error,
        "audited": audited, "flagged": flagged,
        "findings": a.findings if a else [], "message": a.message if a else "no JOIN + aggregate to audit",
        "audit_error": a.error if a else None,
        "explanation": sentence, "highlights": spans,
        "original": orig, "corrected": corrected,
        "headline": headline(orig, corrected) if corrected and not corrected.get("error") else None,
        "audit_seconds": round(audit_s, 4),
    }


def annotate(result: dict[str, Any]) -> dict[str, Any]:
    """Add result["audit"] for the model's SQL. Cheap when there is no JOIN + aggregate (parse only)."""
    sql, db_id = result.get("sql"), result.get("db_id")
    if not sql or not db_id or result.get("error") or db_id not in list_dbs():
        return result
    t0 = time.time()
    try:
        out = check(db_id, sql, audit_timeout_s=ANSWER_AUDIT_TIMEOUT_S,
                    original={"columns": result.get("columns"), "rows": result.get("rows"), "error": None})
        out.pop("original", None)
        out.pop("sql", None)
        out.pop("db_id", None)
    except Exception as e:  # noqa: BLE001 - the answer must still go out
        out = {"flagged": False, "audited": False, "audit_error": f"{type(e).__name__}: {e}"}
    out["annotate_seconds"] = round(time.time() - t0, 4)
    result["audit"] = out
    return result


# --- routes -----------------------------------------------------------------------------------------------
class CheckIn(BaseModel):
    db_id: str
    sql: str
    preset: str | None = None


@router.post("/api/check")
def api_check(body: CheckIn) -> Any:
    sql = body.sql.strip()
    if body.db_id not in list_dbs():
        return JSONResponse({"error": f"unknown database: {body.db_id}"}, status_code=400)
    if not sql or len(sql) > MAX_SQL_CHARS:
        return JSONResponse({"error": f"SQL must be 1-{MAX_SQL_CHARS} characters"}, status_code=400)
    return check(body.db_id, sql, body.preset)


@router.get("/api/presets")
def api_presets() -> dict[str, Any]:
    known = set(list_dbs())
    return {"presets": [{k: v for k, v in p.items() if k != "fix"} | {"has_fix": p["fix"] is not None}
                        for p in PRESETS if p["db_id"] in known]}


assert _Q140_FIX != _Q140 and _Q200_FIX.count("COUNT(DISTINCT CASE") == 3  # hand fixes applied
