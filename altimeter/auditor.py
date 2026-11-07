"""Deterministic JOIN fan-out auditor (not ML).

A JOIN can repeat rows of one table; SUM/AVG/COUNT/TOTAL/GROUP_CONCAT (without DISTINCT) over that
table's columns then counts each row several times. For every SELECT scope with >=2 sources and such an
aggregate, we re-run the scope's own FROM/JOIN/WHERE/GROUP BY/HAVING/ORDER BY/LIMIT with extra columns:

  joined_rows   = COUNT(CASE WHEN <agg arg> IS NOT NULL THEN <row key> END)
  distinct_rows = COUNT(DISTINCT CASE WHEN <agg arg> IS NOT NULL THEN <row key> END)

where <row key> is the source table's rowid (or primary key for WITHOUT ROWID tables). GROUP BY is
checked per group (DISTINCT is computed inside each group, then both counts are summed over the groups the
query actually returns), so a row legitimately appearing once in each of several groups is not flagged.
joined_rows > distinct_rows => inflated by factor joined/distinct.

COUNT(*) / COUNT(1) count joined rows; they are flagged only when *no* source table appears once per
joined row (many-to-many), since otherwise they are counting the finest-grained table.
MIN/MAX and DISTINCT aggregates are unaffected by duplication and never checked.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import sqlglot
from sqlglot import exp

from altimeter.sqlexec import run

_AGGS = (exp.Count, exp.Sum, exp.Avg, exp.GroupConcat)


@dataclass
class AuditResult:
    flagged: bool
    findings: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    suggested_sql: str | None = None
    error: str | None = None


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _is_agg(node: exp.Expression) -> bool:
    if isinstance(node, _AGGS):
        return True
    return isinstance(node, exp.Anonymous) and str(node.this).upper() == "TOTAL"


def _agg_arg(agg: exp.Expression) -> exp.Expression | None:
    """Argument of the aggregate, None for COUNT(*)."""
    arg = agg.expressions[0] if isinstance(agg, exp.Anonymous) and agg.expressions else agg.this
    if arg is None or isinstance(arg, exp.Star):
        return None
    return arg


def _is_distinct(agg: exp.Expression) -> bool:
    return isinstance(agg.this, exp.Distinct)


def _const(e: exp.Expression | None) -> bool:
    while isinstance(e, (exp.Paren, exp.Cast, exp.Neg)):
        e = e.this
    return e is None or isinstance(e, (exp.Literal, exp.Null, exp.Boolean))


def _counts_rows(agg: exp.Expression, arg: exp.Expression | None) -> bool:
    """True if the aggregate counts joined rows rather than summing a table's values: any non-DISTINCT
    COUNT(x), or SUM/AVG/TOTAL of a constant or of CASE/IIF whose results are all constants
    (SUM(CASE WHEN cond THEN 1 ELSE 0 END)). Columns there only pick rows, so which table is "counted"
    is the analyst's intent, not something the SQL states."""
    if arg is None or isinstance(agg, exp.Count) or _const(arg):
        return True
    while isinstance(arg, (exp.Paren, exp.Cast)):
        arg = arg.this
    if isinstance(arg, exp.Case):
        return all(_const(i.args.get("true")) for i in arg.args.get("ifs") or []) and _const(arg.args.get("default"))
    if isinstance(arg, exp.If):
        return _const(arg.args.get("true")) and _const(arg.args.get("false"))
    return False


def _own(node: exp.Expression, sel: exp.Select) -> bool:
    return node.find_ancestor(exp.Select) is sel


def _scope_aggs(sel: exp.Select) -> list[exp.Expression]:
    return [a for a in sel.find_all(exp.AggFunc, exp.Anonymous) if _is_agg(a) and _own(a, sel)]


def _sources(sel: exp.Select) -> list[exp.Expression]:
    out: list[exp.Expression] = []
    frm = sel.args.get("from_")
    if frm is not None:
        out.append(frm.this)
    out.extend(j.this for j in sel.args.get("joins") or [])
    return out


def has_join_aggregate(sql: str) -> bool:
    """True if any SELECT scope has >=2 sources and a non-DISTINCT SUM/AVG/COUNT/TOTAL/GROUP_CONCAT."""
    try:
        root = sqlglot.parse_one(sql, read="sqlite")
    except Exception:  # noqa: BLE001
        return False
    for sel in root.find_all(exp.Select):
        if len(_sources(sel)) >= 2 and any(not _is_distinct(a) for a in _scope_aggs(sel)):
            return True
    return False


class _Schema:
    def __init__(self, db_path: str, deadline: float) -> None:
        self.db_path, self.deadline = db_path, deadline
        r = run(db_path, "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view')", 2.0)
        self.objs = {n.lower(): (t, s or "") for n, t, s in (r.rows or [])}
        self._cols: dict[str, list[tuple[str, int]]] = {}

    def cols(self, table: str) -> list[tuple[str, int]]:
        """[(column name, pk position)] for a table."""
        key = table.lower()
        if key not in self._cols:
            r = run(self.db_path, f"PRAGMA table_info({_q(table)})", 2.0)
            self._cols[key] = [(row[1], row[5]) for row in (r.rows or [])]
        return self._cols[key]

    def row_key(self, table: str, alias: str) -> str | None:
        """SQL expression identifying one row of `alias` (a base table), or None if not keyable."""
        obj = self.objs.get(table.lower())
        if obj is None or obj[0] != "table":
            return None
        cols = self.cols(table)
        if "WITHOUT ROWID" not in obj[1].upper():
            names = {c.lower() for c, _ in cols}
            for rid in ("rowid", "_rowid_", "oid"):
                if rid not in names:
                    return f"{_q(alias)}.{rid}"
            return None
        pk = [c for c, p in sorted(cols, key=lambda x: x[1]) if p > 0]
        if not pk:
            return None
        return " || '|' || ".join(f"CAST({_q(alias)}.{_q(c)} AS TEXT)" for c in pk)


@dataclass
class _Check:
    agg_index: int
    agg_sql: str
    column: str
    aliases: list[str]  # source aliases of the aggregated column(s); empty = COUNT(*)
    row_count: bool = False  # counts joined rows (COUNT(x), SUM(CASE..THEN 1..)): flag only many-to-many


def _scope_checks(sel: exp.Select, schema: _Schema
                  ) -> tuple[list[_Check], dict[str, str], dict[str, str], dict[str, str]]:
    """Checks for one scope, plus alias->table, alias->row-key, alias->original-case maps (keyable base tables).
    Map keys are lower-cased aliases."""
    alias_table: dict[str, str] = {}
    alias_name: dict[str, str] = {}
    alias_key: dict[str, str] = {}
    unkeyable = False
    for src in _sources(sel):
        if isinstance(src, exp.Table) and not src.args.get("db"):
            alias = src.alias_or_name
            key = schema.row_key(src.name, alias)
            if key is not None:
                alias_table[alias.lower()] = src.name
                alias_key[alias.lower()] = key
                alias_name[alias.lower()] = alias
                continue
        unkeyable = True
    checks: list[_Check] = []
    local = {s.alias_or_name.lower() for s in _sources(sel)}
    if any(c.table and c.table.lower() not in local for c in sel.find_all(exp.Column) if _own(c, sel)):
        return checks, alias_table, alias_key, alias_name  # correlated subquery: cannot run standalone
    for i, agg in enumerate(_scope_aggs(sel)):
        if _is_distinct(agg) or (isinstance(agg, exp.Anonymous) and not agg.expressions):
            continue
        arg = _agg_arg(agg)
        cols = [c for c in arg.find_all(exp.Column) if _own(c, sel)] if arg is not None else []
        row_count = not cols or _counts_rows(agg, arg)
        if row_count and unkeyable:
            continue
        aliases: list[str] = []
        ok = True
        for c in cols:
            t = c.table.lower()
            if not t:  # unqualified: resolve against the scope's base tables
                hits = [a for a, tb in alias_table.items()
                        if c.name.lower() in {n.lower() for n, _ in schema.cols(tb)}]
                t = hits[0] if len(hits) == 1 else ""
            if t not in alias_key:
                ok = row_count  # outer/correlated, derived table, view, or ambiguous column
                aliases = []
                break
            if t not in aliases:
                aliases.append(t)
        if ok:
            checks.append(_Check(i, agg.sql(dialect="sqlite"), arg.sql(dialect="sqlite") if arg else "*",
                                 aliases, row_count))
    return checks, alias_table, alias_key, alias_name


def _key_expr(aliases: list[str], alias_key: dict[str, str]) -> str:
    if len(aliases) == 1:
        return alias_key[aliases[0]]
    return " || '|' || ".join(f"CAST({alias_key[a]} AS TEXT)" for a in aliases)


def _with_sql(root: exp.Expression) -> str:
    w = root.args.get("with_")
    return w.sql(dialect="sqlite") + " " if w is not None else ""


def _measure(sel: exp.Select, root: exp.Expression, pairs: list[tuple[str, str]], db_path: str,
             deadline: float) -> tuple[list[int] | None, str | None]:
    """Run the scope with appended (joined, distinct) count columns; return their sums over returned groups."""
    inner = sel.copy()
    inner.set("with_", None)
    inner.set("distinct", None)
    names = []
    for i, (j, d) in enumerate(pairs):
        inner = inner.select(exp.alias_(sqlglot.parse_one(j, read="sqlite"), f"__j{i}"), append=True, copy=False)
        inner = inner.select(exp.alias_(sqlglot.parse_one(d, read="sqlite"), f"__d{i}"), append=True, copy=False)
        names += [f"__j{i}", f"__d{i}"]
    outer = f"{_with_sql(root)}SELECT {', '.join(f'COALESCE(SUM({n}), 0)' for n in names)} " \
            f"FROM ({inner.sql(dialect='sqlite')})"
    remaining = deadline - time.time()
    if remaining <= 0:
        return None, "timeout"
    r = run(db_path, outer, remaining)
    if r.error or not r.rows:
        return None, r.error or "no rows"
    return [int(v or 0) for v in r.rows[0]], None


def _suggest(root: exp.Select, flagged_idx: list[int], alias_table: dict[str, str],
             alias_key: dict[str, str], alias_name: dict[str, str], findings: dict[int, str]) -> str | None:
    """Rewrite: each inflated aggregate is computed over the distinct participating rows of its table."""
    new = root.copy()
    aggs = _scope_aggs(new)
    base = new.copy()
    for k in ("expressions", "group", "having", "order", "limit", "offset", "distinct", "with_"):
        base.set(k, None)
    for i in flagged_idx:
        alias = findings[i]
        key = alias_key[alias]
        keys_sel = base.copy().select(sqlglot.parse_one(key, read="sqlite"), copy=False)
        agg_sql = aggs[i].sql(dialect="sqlite")
        sub = (f"(SELECT {agg_sql} FROM {_q(alias_table[alias])} AS {_q(alias_name[alias])} "
               f"WHERE {key} IN ({keys_sel.sql(dialect='sqlite')}))")
        aggs[i].replace(sqlglot.parse_one(sub, read="sqlite"))
    if not _scope_aggs(new):  # no aggregate left: stop the join from producing one row per joined row
        bare = [c for e in new.expressions for c in e.find_all(exp.Column) if _own(c, new)]
        if bare:
            new.set("limit", exp.Limit(expression=exp.Literal.number(1)))
        else:
            for k in ("from_", "joins", "where", "group", "having", "order", "limit"):
                new.set(k, None)
    return new.sql(dialect="sqlite")


def audit(db_path: str, sql: str, timeout_s: float = 5.0) -> AuditResult:
    deadline = time.time() + timeout_s
    try:
        root = sqlglot.parse_one(sql, read="sqlite")
    except Exception as e:  # noqa: BLE001
        return AuditResult(False, message="could not parse SQL", error=f"parse: {e}")
    if root is None or not isinstance(root, (exp.Select, exp.Union, exp.Subquery)):
        return AuditResult(False, message="not a SELECT; nothing to audit")
    try:
        schema = _Schema(db_path, deadline)
        findings: list[dict[str, Any]] = []
        errors: list[str] = []
        root_flags: list[int] = []
        root_alias_of: dict[int, str] = {}
        root_maps: tuple[dict[str, str], dict[str, str], dict[str, str]] | None = None
        checked = 0
        for sel in root.find_all(exp.Select):
            if len(_sources(sel)) < 2:
                continue
            checks, alias_table, alias_key, alias_name = _scope_checks(sel, schema)
            if not checks:
                continue
            pair_ix: dict[tuple[str, str], int] = {}  # identical count columns are computed once
            slots: list[tuple[_Check, str | None, int]] = []  # (check, alias, pair index)
            for ch in checks:
                if not ch.row_count:
                    key = _key_expr(ch.aliases, alias_key)
                    cond = f"CASE WHEN ({ch.column}) IS NOT NULL THEN {key} END"
                    todo = [(None, (f"COUNT({cond})", f"COUNT(DISTINCT {cond})"))]
                else:
                    todo = [(a, (f"COUNT({k})", f"COUNT(DISTINCT {k})")) for a, k in alias_key.items()]
                for a, pair in todo:
                    slots.append((ch, a, pair_ix.setdefault(pair, len(pair_ix))))
            pairs = list(pair_ix)
            counts, err = _measure(sel, root, pairs, db_path, deadline)
            if err:
                errors.append(err)
                continue
            checked += 1
            assert counts is not None
            star: dict[int, list[tuple[str, int, int]]] = {}
            for ch, a, p in slots:
                j, d = counts[2 * p], counts[2 * p + 1]
                if a is not None:
                    star.setdefault(ch.agg_index, []).append((a, j, d))
                elif j > d > 0:
                    alias = ",".join(alias_name[x] for x in ch.aliases)
                    findings.append({"table": ",".join(alias_table[x] for x in ch.aliases), "alias": alias,
                                     "column": ch.column, "aggregate": ch.agg_sql, "joined_rows": j,
                                     "distinct_rows": d, "factor": round(j / d, 3)})
                    if sel is root and len(ch.aliases) == 1:
                        root_flags.append(ch.agg_index)
                        root_alias_of[ch.agg_index] = ch.aliases[0]
            for idx, per in star.items():  # row counts: inflated only if every table is repeated
                if not (per and all(j > d > 0 for _, j, d in per)):
                    continue
                ch = next(c for c in checks if c.agg_index == idx)
                if len(ch.aliases) == 1:  # report the counted table (e.g. COUNT(T2.Id) -> T2)
                    a = ch.aliases[0]
                    _, j, d = next(x for x in per if x[0] == a)
                    if sel is root:
                        root_flags.append(idx)
                        root_alias_of[idx] = a
                    tname, aname = alias_table[a], alias_name[a]
                else:
                    _, j, d = min(per, key=lambda x: x[1] / x[2])
                    tname = aname = "*"
                findings.append({"table": tname, "alias": aname, "column": ch.column, "aggregate": ch.agg_sql,
                                 "joined_rows": j, "distinct_rows": d, "factor": round(j / d, 3),
                                 "many_to_many": True})
            if sel is root:
                root_maps = (alias_table, alias_key, alias_name)
        err_s = "; ".join(errors) or None
        if not findings:
            msg = "no JOIN + aggregate to audit" if checked == 0 and not errors else "no fan-out detected"
            return AuditResult(False, [], msg if not (errors and checked == 0) else "audit incomplete", None, err_s)
        f0 = findings[0]
        what = "row of every joined table (at least)" if f0["table"] == "*" else f"{f0['table']} row"
        msg = (f"Fan-out: {f0['aggregate']} sees each {what} {f0['factor']:g}x "
               f"({f0['joined_rows']} joined rows vs {f0['distinct_rows']} distinct) because of the JOIN"
               + (" (many-to-many: no table appears once per joined row)." if f0.get("many_to_many") else "."))
        suggestion = None
        if (root_flags and isinstance(root, exp.Select) and not root.args.get("group")
                and root_maps is not None and len(root_flags) == len(findings)):
            try:
                cand = _suggest(root, sorted(set(root_flags)), root_maps[0], root_maps[1], root_maps[2],
                                root_alias_of)
                remaining = deadline - time.time()
                r = run(db_path, cand, max(remaining, 0.5), max_rows=5) if cand else None
                if r is not None and r.error is None:
                    suggestion = cand
                    if r.rows and len(r.rows) == 1 and len(r.rows[0]) == 1:
                        msg += f" Deduplicated value: {r.rows[0][0]}."
            except Exception:  # noqa: BLE001 - suggestion is optional
                suggestion = None
        return AuditResult(True, findings, msg, suggestion, err_s)
    except Exception as e:  # noqa: BLE001 - auditor must never crash the caller
        return AuditResult(False, message="audit failed", error=f"{type(e).__name__}: {e}")
