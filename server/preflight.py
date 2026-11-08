"""Pre-flight check: run the deterministic fan-out auditor on any SQL (a colleague's, or the model's).

POST /api/check {db_id, sql, preset?} -> audit + original result + corrected result (auditor rewrite, or a
hand-written fix for a preset whose SQL is unchanged) + headline (first number that changed) + highlights.
GET /api/presets -> real queries from the BIRD dev answer keys (five with verified fan-out, one clean).
/api/check also returns, per flagged finding, "fanout": the counted table vs the table that repeats it, their
distinct key counts, the joined row count and up to 12 x 12 real key ids (see fanouts()).
annotate(result) adds result["audit"] to a worker answer (same shape, without "original": the answer itself).
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter
from typing import Any, Awaitable, Callable

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
CHECK_AUDIT_TIMEOUT_S = 15.0  # explicit Pre-flight check: room for auditor v2 result verification
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

# Verbatim from the November 2025 dev file (q197 is identical in the 2024 release).
_Q197 = "SELECT AVG(oxygen_count) FROM (SELECT T1.molecule_id, COUNT(T1.element) AS oxygen_count FROM atom AS T1 INNER JOIN bond AS T2 ON T1.molecule_id = T2.molecule_id  WHERE T2.bond_type = '-' AND T1.element = 'o'  GROUP BY T1.molecule_id) AS oxygen_counts"
_Q205 = "WITH CarbonMolecules AS (\n    SELECT DISTINCT a.molecule_id\n    FROM atom AS a\n    WHERE a.element = 'c'\n),\nMoleculeStats AS (\n    SELECT \n        m.molecule_id,\n        m.label,\n        COUNT(DISTINCT a.atom_id) AS atom_count,\n        COUNT(DISTINCT b.bond_id) AS bond_count,\n        SUM(CASE WHEN a.element = 'c' THEN 1 ELSE 0 END) AS carbon_count,\n        SUM(CASE WHEN a.element = 'cl' THEN 1 ELSE 0 END) AS chlorine_count,\n        SUM(CASE WHEN b.bond_type = '=' THEN 1 ELSE 0 END) AS double_bond_count\n    FROM molecule m\n    JOIN atom a ON m.molecule_id = a.molecule_id\n    LEFT JOIN bond b ON m.molecule_id = b.molecule_id\n    WHERE m.molecule_id IN (SELECT molecule_id FROM CarbonMolecules)\n    GROUP BY m.molecule_id, m.label\n),\nRankedMolecules AS (\n    SELECT\n        molecule_id,\n        label,\n        atom_count,\n        bond_count,\n        carbon_count,\n        chlorine_count,\n        double_bond_count,\n        RANK() OVER (ORDER BY carbon_count DESC, atom_count DESC) AS carbon_rank\n    FROM MoleculeStats\n)\nSELECT \n    rm.molecule_id,\n    rm.label,\n    rm.atom_count,\n    rm.bond_count,\n    rm.carbon_count,\n    rm.chlorine_count,\n    rm.double_bond_count,\n    rm.carbon_rank,\n    (SELECT COUNT(DISTINCT c.atom_id2) \n     FROM connected c \n     JOIN atom a ON c.atom_id = a.atom_id \n     WHERE a.molecule_id = rm.molecule_id) AS connections_count\nFROM RankedMolecules rm\nORDER BY rm.carbon_rank, rm.molecule_id;"

# Hand fix: count each oxygen atom once, not once per single bond of its molecule.
_Q197_FIX = _Q197.replace("COUNT(T1.element) AS oxygen_count", "COUNT(DISTINCT T1.atom_id) AS oxygen_count")

# Hand fix: count distinct atoms/bonds instead of joined rows (same pattern as q200).
_Q205_FIX = (_Q205
             .replace("SUM(CASE WHEN a.element = 'c' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN a.element = 'c' THEN a.atom_id END)")
             .replace("SUM(CASE WHEN a.element = 'cl' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN a.element = 'cl' THEN a.atom_id END)")
             .replace("SUM(CASE WHEN b.bond_type = '=' THEN 1 ELSE 0 END)",
                      "COUNT(DISTINCT CASE WHEN b.bond_type = '=' THEN b.bond_id END)"))

_Q89 = ("SELECT COUNT(T2.account_id) FROM district AS T1 INNER JOIN account AS T2 ON T1.district_id = T2.district_id "
        "WHERE T1.A3 = 'east Bohemia' AND T2.frequency = 'POPLATEK PO OBRATU'")

# Persona scenarios: the join an analyst or an AI typically writes for the question (cards/scenarios.json, verified).
_CLUB_BUDGET = ("SELECT e.event_name, SUM(b.amount) AS total_budget, SUM(x.cost) AS total_spent\n"
                "FROM event e JOIN budget b ON b.link_to_event = e.event_id JOIN expense x ON x.link_to_budget = b.budget_id\n"
                "GROUP BY e.event_id ORDER BY e.event_date")
_BANK_REGION_LOANS = ("SELECT d.A3 AS region, SUM(l.amount) AS total_loaned\n"
                      "FROM loan l JOIN disp p ON l.account_id = p.account_id JOIN client c ON p.client_id = c.client_id\n"
                      "JOIN district d ON c.district_id = d.district_id GROUP BY d.A3 ORDER BY total_loaned DESC")
_CLINIC_CHOLESTEROL_AGE = ("SELECT\n  AVG(strftime('%Y', 'now') - strftime('%Y', T1.Birthday))\nFROM Patient AS T1\n"
                           "JOIN Laboratory AS T2\n  ON T1.ID = T2.ID\nWHERE\n  T2.\"T-CHO\" > 250;")
# Hand fixes from the same cards (verified against direct sums): each budget / loan row counted once.
_CLUB_BUDGET_FIX = ("SELECT e.event_name, (SELECT SUM(amount) FROM budget b WHERE b.link_to_event = e.event_id) AS total_budget,\n"
                    "(SELECT SUM(x.cost) FROM expense x JOIN budget b ON x.link_to_budget = b.budget_id WHERE b.link_to_event = e.event_id) AS total_spent\n"
                    "FROM event e WHERE e.event_id IN (SELECT b.link_to_event FROM budget b JOIN expense x ON x.link_to_budget = b.budget_id) ORDER BY e.event_date")
_BANK_REGION_LOANS_FIX = ("SELECT d.A3 AS region, SUM(l.amount) AS total_loaned FROM loan l JOIN disp p ON l.account_id = p.account_id AND p.type = 'OWNER'\n"
                          "JOIN client c ON p.client_id = c.client_id JOIN district d ON c.district_id = d.district_id GROUP BY d.A3 ORDER BY total_loaned DESC")

# Persona scenarios first, then current-release benchmark bugs (q197 is the benchmark hero).
# Benchmark labels name every release whose answer key contains the query.
PRESETS: list[dict[str, Any]] = [
    {"id": "club_budget", "db_id": "student_club", "sql": _CLUB_BUDGET, "fix": _CLUB_BUDGET_FIX,
     "label": "Club treasurer: budget vs spending per event",
     "question": "For each event, what was the total budget and how much did we actually spend?",
     # The story row: a $23.50 overspend that the inflated budget (355 vs 205) makes look $126.50 under budget.
     "headline_row": "November Meeting"},
    {"id": "bank_region_loans", "db_id": "financial", "sql": _BANK_REGION_LOANS, "fix": _BANK_REGION_LOANS_FIX,
     "label": "Bank analyst: loan book by region",
     "question": "What is the total amount loaned in each region?"},
    {"id": "clinic_cholesterol_age", "db_id": "thrombosis_prediction", "sql": _CLINIC_CHOLESTEROL_AGE, "fix": None,
     "label": "Clinic manager: age of the high-cholesterol group (SQL by Gemini)",
     "question": "What is the average age of patients who have had a total cholesterol result above 250?"},
    {"id": "bird197", "db_id": "toxicology", "sql": _Q197, "fix": _Q197_FIX,
     "label": "BIRD dev answer key, question 197 (2024 and November 2025 releases)",
     "question": "Calculate the average number of oxygen atoms in single-bonded molecules."},
    {"id": "bird200", "db_id": "toxicology", "sql": _Q200, "fix": _Q200_FIX,
     "label": "BIRD dev answer key, question 200 (November 2025 release)",
     "question": "Atom, carbon and triple-bond counts for carcinogenic molecules with triple bonds."},
    {"id": "bird205", "db_id": "toxicology", "sql": _Q205, "fix": _Q205_FIX,
     "label": "BIRD dev answer key, question 205 (November 2025 release)",
     "question": "Atom, bond, carbon, chlorine and double-bond counts for molecules containing carbon, ranked by carbon."},
    {"id": "bird140", "db_id": "financial", "sql": _Q140, "fix": _Q140_FIX,
     "label": "BIRD dev answer key, question 140 (November 2025 release)",
     "question": "Financial profile of all accounts in the Pisek district: deposits, withdrawals, cards, loans."},
    {"id": "bird571", "db_id": "codebase_community", "sql": _Q571, "fix": None,
     "label": "BIRD dev answer key, question 571 (2024 release; fixed in November 2025)",
     "question": "For user No. 24, how many times is the number of posts compared to votes?"},
    {"id": "bird89", "db_id": "financial", "sql": _Q89, "fix": None,
     "label": "BIRD dev answer key, question 89 (2024 and November 2025 releases)",
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


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def headline(orig: dict[str, Any], fixed: dict[str, Any] | None, prefer_row: str | None = None) -> dict[str, Any] | None:
    """The numeric cell that differs most, relatively, between the original and corrected results.
    Rows are aligned by their first column when it is a text key present on both sides, else by position.
    The first row is the anchor: when any of its cells changed, the headline comes from it (it is the row the
    preview shows first and the fan-out grid samples from); other rows are searched only when row 0 is unchanged.
    prefer_row names a key whose row is taken whenever it has a changed cell (a preset's story row)."""
    if not fixed or not orig.get("rows") or not fixed.get("rows"):
        return None
    rows_a, rows_b = orig["rows"], fixed["rows"]
    keyed = all(len(r) > 1 and isinstance(r[0], str) for r in rows_a + rows_b) \
        and bool({r[0] for r in rows_a} & {r[0] for r in rows_b})
    if keyed:
        by_key: dict[str, list[Any]] = {}
        for r in rows_b:
            by_key.setdefault(r[0], r)
        pairs = [(a, by_key[a[0]]) for a in rows_a if a[0] in by_key]
    else:
        pairs = list(zip(rows_a, rows_b))
    best: tuple[float, int, Any, Any, str | None] | None = None
    for n, (a, b) in enumerate(pairs):
        if len(a) != len(b):
            continue
        label = a[0] if len(a) > 1 and isinstance(a[0], str) and a[0] == b[0] else None
        for i, (x, y) in enumerate(zip(a, b)):
            if not (_is_num(x) and _is_num(y)) or round(float(x), 4) == round(float(y), 4):
                continue
            rel = abs(float(x) - float(y)) / max(abs(float(x)), abs(float(y)))
            score = rel + (10.0 if n == 0 else 0.0) + (20.0 if prefer_row is not None and label == prefer_row else 0.0)
            if best is None or score > best[0] + 1e-12:
                best = (score, i, x, y, label)
    if best is None:
        return None
    _, i, x, y, label = best
    ratio = float(x) / float(y) if y else None
    return {"column": (orig.get("columns") or [None] * (i + 1))[i], "row": label,
            "before": x, "after": y, "before_text": fmt_num(x), "after_text": fmt_num(y),
            "ratio": round(ratio, 3) if ratio is not None else None,
            "ratio_text": (f"{ratio:.3g}" if ratio is not None else None),
            "single_cell": len(rows_a) == 1 and len(rows_a[0]) == 1}


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


# --- fan-out grid: the actual rows the JOIN pairs up, for the table screen ---------------------------------
GRID_MAX = 12
FANOUT_TIMEOUT_S = 8.0
FANOUT_MAX_ROWS = 1_000_000  # joined rows fetched (keys only); larger joins get no grid


def _qi(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _lit(v: Any) -> str:
    return exp.convert(v).sql(dialect="sqlite")


def _id_key(v: Any) -> tuple[int, Any]:
    return (0, v) if isinstance(v, (int, float)) and not isinstance(v, bool) else (1, str(v))


class _Scope:
    """One SELECT scope's FROM/JOIN/WHERE, re-selected with key columns. SQL runs only through sqlexec.run
    (read-only connection, authorizer, progress-handler timeout) against a shared deadline."""

    def __init__(self, sel: exp.Select, path: str, deadline: float) -> None:
        w = sel.root().args.get("with_")
        self.with_sql = w.sql(dialect="sqlite") + " " if w is not None else ""
        self.ctes = {c.alias_or_name.lower() for c in (w.expressions if w is not None else [])}
        base = sel.copy()
        for k in ("expressions", "group", "having", "order", "limit", "offset", "distinct", "with_"):
            base.set(k, None)
        self.base, self.path, self.deadline = base, path, deadline

    def fetch(self, cols: list[str], where: str, cap: int) -> list[tuple[Any, ...]] | None:
        """Rows of the joined scope (keys only); None if there are more than cap."""
        left = self.deadline - time.time()
        if left <= 0:
            raise TimeoutError("timeout")
        q = self.base.copy().select(*cols, dialect="sqlite", copy=False).where(where, dialect="sqlite", copy=False)
        r = run(self.path, self.with_sql + q.sql(dialect="sqlite"), timeout_s=left, max_rows=cap + 1)
        if r.error is not None or r.rows is None:
            raise RuntimeError(r.error or "no rows")
        return r.rows if len(r.rows) <= cap else None

    def key(self, table: str, alias: str) -> tuple[str, str] | None:
        """(SQL for one row's identity, its column name): the single-column primary key, else rowid."""
        if table.lower() in self.ctes:
            return None
        kind = run(self.path, f"SELECT type, sql FROM sqlite_master WHERE name = {_lit(table)} COLLATE NOCASE", 2.0)
        if not kind.rows or kind.rows[0][0] != "table":
            return None
        info = run(self.path, f"PRAGMA table_info({_qi(table)})", 2.0).rows or []
        pk = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5] > 0]
        if len(pk) == 1:
            return f"{_qi(alias)}.{_qi(pk[0])}", pk[0]
        if "WITHOUT ROWID" in (kind.rows[0][1] or "").upper():
            return None
        return f"{_qi(alias)}.rowid", "rowid"


def _links(sel: exp.Select) -> list[set[tuple[str, str]]]:
    """Equality classes of qualified columns from the scope's JOIN ... ON and WHERE (a.x = b.y)."""
    parent: dict[tuple[str, str], tuple[str, str]] = {}

    def find(x: tuple[str, str]) -> tuple[str, str]:
        while parent.setdefault(x, x) != x:
            x = parent[x]
        return x
    conds = [j.args.get("on") for j in sel.args.get("joins") or []] + [sel.args.get("where")]
    for c in conds:
        for eq in (c.find_all(exp.EQ) if c is not None else []):
            l, r = eq.this, eq.expression
            if isinstance(l, exp.Column) and isinstance(r, exp.Column) and l.table and r.table:
                parent[find((l.table.lower(), l.name))] = find((r.table.lower(), r.name))
    classes: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for x in list(parent):
        classes.setdefault(find(x), set()).add(x)
    return list(classes.values())


def _fanout_one(sel: exp.Select, pairs: list[tuple[str, str]], f: dict[str, Any], path: str,
                deadline: float, prefer: Any = None) -> dict[str, Any] | None:
    """Counted table (left) vs the joined table that repeats it most (right), with real key ids.
    One query fetches the key of every joined row; the counts and the grid are computed from those rows.
    link: the column the two tables are joined on (e.g. molecule_id); a sample is drawn from one value of it,
    the headline row's value (prefer) when the left rows carry it, else the left row repeated most."""
    sc = _Scope(sel, path, deadline)
    la = f["alias"]
    left_t = next((t for t, a in pairs if a == la), None)
    lk = sc.key(left_t, la) if left_t else None
    if lk is None:
        return None
    cands = [(t, a, k) for t, a in pairs if a != la and t != "(subquery)" for k in [sc.key(t, a)] if k is not None]
    if not cands:
        return None
    classes = _links(sel)
    link_of: list[str | None] = []
    for _, a, _ in cands:
        cls = next((c for c in classes if any(x[0] == la.lower() for x in c) and any(x[0] == a.lower() for x in c)), None)
        link_of.append(sorted(x[1] for x in cls if x[0] == la.lower())[0] if cls else None)
    link_cols = sorted({x for x in link_of if x})
    got = sc.fetch([lk[0]] + [k[0] for _, _, k in cands] + [f"{_qi(la)}.{_qi(x)}" for x in link_cols],
                   f"{lk[0]} IS NOT NULL", FANOUT_MAX_ROWS)
    if got is None:
        return None
    nc = len(cands)
    partners: list[dict[Any, set[Any]]] = [{} for _ in cands]
    for row in got:
        for i in range(nc):
            s = partners[i].setdefault(row[0], set())
            if row[1 + i] is not None:
                s.add(row[1 + i])
    mults = [max((len(s) for s in p.values()), default=0) for p in partners]
    best = max(range(nc), key=lambda i: (mults[i], -i))
    if mults[best] < 2:
        return None
    rt, ra, rk = cands[best]
    part = partners[best]
    link = link_of[best]
    li = 1 + nc + link_cols.index(link) if link else None
    group_of = {row[0]: row[li] for row in got} if li is not None else {}
    n_left = len(part)
    right_all = set().union(*part.values())
    pair_n = Counter((row[0], row[1 + best]) for row in got if row[1 + best] is not None)
    anchor, group = None, None
    if n_left <= GRID_MAX and len(right_all) <= GRID_MAX:
        rows = [a for a, s in part.items() if s]
        cols = list(right_all)
    else:  # deterministic sample around one left row: its right partners, the left rows sharing them
        pool = [a for a in part if part[a]]
        if prefer is not None and group_of:
            pool = [a for a in pool if str(group_of.get(a)) == str(prefer)] or pool
        anchor = min(pool, key=lambda a: (-len(part[a]), _id_key(a)))
        cols = sorted(part[anchor], key=_id_key)[:GRID_MAX]
        cs = set(cols)
        rows = sorted((a for a, s in part.items() if s & cs),
                      key=lambda a: (-len(part[a] & cs), _id_key(a)))[:GRID_MAX]
        if group_of:
            gv = group_of[anchor]
            members = [a for a, v in group_of.items() if v == gv]
            group = {"column": link, "value": _cell(gv), "left": len(members),
                     "right": len(set().union(*(part[a] for a in members))),
                     "joined_rows": sum(1 for row in got if row[li] == gv)}
    rows, cols = sorted(rows, key=_id_key), sorted(cols, key=_id_key)
    ci = {v: i for i, v in enumerate(cols)}
    cells = [[r, ci[b], pair_n[(a, b)]] for r, a in enumerate(rows) for b in cols if (a, b) in pair_n]
    return {
        "left": {"table": left_t, "alias": la, "key": lk[1], "distinct": n_left},
        "right": {"table": rt, "alias": ra, "key": rk[1], "distinct": len(right_all)},
        "link": link, "joined_rows": len(got), "cross": len(got) == n_left * len(right_all),
        "max_repeat": mults[best],
        "grid": {"rows": [_cell(v) for v in rows], "cols": [_cell(v) for v in cols], "cells": cells,
                 "sampled": len(rows) < n_left or len(cols) < len(right_all), "anchor": _cell(anchor),
                 "group": group},
    }


def fanouts(path: str, sql: str, findings: list[dict[str, Any]], prefer: Any = None
            ) -> tuple[list[dict[str, Any] | None], str | None]:
    """Per finding: the two entities, their distinct key counts, the joined row count and up to 12 x 12 real
    key ids (all pairs if both sides fit, else a deterministic sample). None where it cannot be computed."""
    deadline = time.time() + FANOUT_TIMEOUT_S
    scopes = _scopes(sql)
    out: list[dict[str, Any] | None] = []
    memo: dict[tuple[int, str], dict[str, Any] | None] = {}
    err = None
    for f in findings:
        if f.get("table") in (None, "*") or "," in str(f.get("alias", "")):
            out.append(None)
            continue
        hit = next(((i, s, p) for i, (s, p) in enumerate(scopes)
                    if any(a == f["alias"] for _, a in p)
                    and any(x.sql(dialect="sqlite") == f["aggregate"] and x.find_ancestor(exp.Select) is s
                            for x in s.find_all(exp.AggFunc, exp.Anonymous))), None)
        if hit is None:
            out.append(None)
            continue
        key = (hit[0], f["alias"])
        if key not in memo:
            try:
                memo[key] = _fanout_one(hit[1], hit[2], f, path, deadline, prefer)
            except Exception as e:  # noqa: BLE001 - the grid is optional; the check still answers
                memo[key] = None
                err = f"{type(e).__name__}: {e}"
        out.append(memo[key])
    return out, err


_VERBS = {"COUNT": "count", "SUM": "add up", "TOTAL": "add up", "AVG": "average over"}


def intended_note(sql: str, findings: list[dict[str, Any]], has_fix: bool) -> str:
    """One short "was this intended?" line for the first inflated table, or "" when there is nothing to say."""
    f = next((x for x in findings if x.get("table") not in (None, "*")), None)
    if f is None:
        return ""
    table, alias = f["table"], f["alias"]
    verb = _VERBS.get(str(f["aggregate"]).split("(", 1)[0].strip().upper(), "aggregate")
    scopes = _scopes(sql)
    scope = next((p for s, p in scopes  # the scope that owns the aggregate, as in explain()
                  if any(a == alias for _, a in p)
                  and any(x.sql(dialect="sqlite") == f["aggregate"] and x.find_ancestor(exp.Select) is s
                          for x in s.find_all(exp.AggFunc, exp.Anonymous))), None)         or next((p for _, p in scopes if any(a == alias for _, a in p)), [])
    others = list(dict.fromkeys(t for t, a in scope if a != alias and t != table))
    if not others:
        return ""
    unit = f"{table} and {others[0]} pair" if len(others) == 1 else \
        f"{table}, " + ", ".join(others[:-1]) + f" and {others[-1]} combination"
    fix = "use the fix" if has_fix else f"aggregate {table} before the JOIN"
    return f"Fine if you meant to {verb} every {unit}. If you meant each {table} row once, {fix}."


def check(db_id: str, sql: str, preset: str | None = None, audit_timeout_s: float = CHECK_AUDIT_TIMEOUT_S,
          original: dict[str, Any] | None = None, grid: bool = False) -> dict[str, Any]:
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
    findings = a.findings if a else []
    fan_err, fan_s = None, None
    same_preset = p is not None and p["db_id"] == db_id and _norm_sql(p["sql"]) == _norm_sql(sql)
    head = headline(orig, corrected, p.get("headline_row") if same_preset else None) \
        if corrected and not corrected.get("error") else None
    if grid and flagged and findings:
        t1 = time.time()
        fos, fan_err = fanouts(path, sql, findings, head.get("row") if head else None)
        findings = [dict(f, fanout=fo) for f, fo in zip(findings, fos)]
        fan_s = round(time.time() - t1, 4)
    try:
        sqlglot.parse_one(sql, read="sqlite")
        parse_error = None
    except Exception as e:  # noqa: BLE001
        parse_error = str(e).splitlines()[0][:200]
    return {
        "db_id": db_id, "sql": sql,
        "parses": parse_error is None, "parse_error": parse_error,
        "audited": audited, "flagged": flagged,
        "findings": findings, "message": a.message if a else "no JOIN + aggregate to audit",
        "audit_error": a.error if a else None,
        "explanation": sentence, "highlights": spans,
        "intended": intended_note(sql, a.findings, corrected is not None and not corrected.get("error"))
        if flagged and a else "",
        "original": orig, "corrected": corrected,
        "headline": head,
        "audit_seconds": round(audit_s, 4),
        "fanout_seconds": fan_s, "fanout_error": fan_err,
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


# Called after every successful /api/check as await fn(result, preset_or_None); app.py uses it to tell the
# table screen. A listener failure never fails the check.
check_listeners: list[Callable[[dict[str, Any], dict[str, Any] | None], Awaitable[None]]] = []


@router.post("/api/check")
async def api_check(body: CheckIn) -> Any:
    sql = body.sql.strip()
    if body.db_id not in list_dbs():
        return JSONResponse({"error": f"unknown database: {body.db_id}"}, status_code=400)
    if not sql or len(sql) > MAX_SQL_CHARS:
        return JSONResponse({"error": f"SQL must be 1-{MAX_SQL_CHARS} characters"}, status_code=400)
    out = await asyncio.to_thread(check, body.db_id, sql, body.preset, grid=True)
    p = _BY_ID.get(body.preset or "")
    for fn in check_listeners:
        try:
            await fn(out, p if p and p["db_id"] == body.db_id else None)
        except Exception:  # noqa: BLE001
            pass
    return out


@router.get("/api/presets")
def api_presets() -> dict[str, Any]:
    known = set(list_dbs())
    return {"presets": [{k: v for k, v in p.items() if k != "fix"} | {"has_fix": p["fix"] is not None}
                        for p in PRESETS if p["db_id"] in known]}


assert _Q140_FIX != _Q140 and _Q197_FIX != _Q197  # hand fixes applied
assert _Q200_FIX.count("COUNT(DISTINCT CASE") == 3 and _Q205_FIX.count("COUNT(DISTINCT CASE") == 3
