"""Deterministic JOIN fan-out auditor (not ML).

A JOIN can repeat rows of one table; SUM/AVG/COUNT/TOTAL/GROUP_CONCAT (without DISTINCT) over that
table's rows then sees each row several times. For every SELECT scope with >=2 sources and such an
aggregate, we re-run the scope's own FROM/JOIN/WHERE/GROUP BY/HAVING/ORDER BY/LIMIT with extra columns:

  joined_rows   = COUNT(CASE WHEN <agg arg> IS NOT NULL THEN <row key> END)
  distinct_rows = COUNT(DISTINCT CASE WHEN <agg arg> IS NOT NULL THEN <row key> END)

where <row key> identifies one row of the aggregate's entity table (rowid, or primary key for WITHOUT ROWID
tables). GROUP BY is checked per group (DISTINCT inside each group, summed over the returned groups), so a
row legitimately appearing once in each of several groups is not flagged. joined_rows > distinct_rows means
the entity repeats.

Entity of an aggregate:
  SUM/AVG/TOTAL/GROUP_CONCAT(value)      the tables of the value's columns
  COUNT(x)                               the tables of x's columns (for CASE/IIF: of the non-constant results)
  SUM(CASE WHEN cond THEN 1 ELSE 0 END)  the tables of cond's columns (a conditional count)
  COUNT(*), COUNT(1), SUM(1)             no entity: flagged only if every joined table repeats (many-to-many)
DISTINCT aggregates, MIN/MAX and window aggregates are unaffected by duplication and never checked.

Repetition alone is not a bug. When an entity repeats, the whole query is re-run with each repeated aggregate
replaced by a de-duplicated twin (a custom SQLite aggregate that keeps one value per entity row key) and the
two results are compared. Same result => "rows repeat but the answer is unaffected", not flagged. A count
used only as an existence test (COUNT(..) > 0, = 0, ...) cannot change and is not flagged either. If the
result check cannot run in the time budget, the structural finding is reported (unverified).
"""
from __future__ import annotations

import math
from collections import Counter
import time
from dataclasses import dataclass, field
from typing import Any

import sqlglot
from sqlglot import exp

from altimeter.sqlexec import connect_guarded, run

_AGGS = (exp.Count, exp.Sum, exp.Avg, exp.GroupConcat)


@dataclass
class AuditResult:
    flagged: bool
    findings: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    suggested_sql: str | None = None
    error: str | None = None
    benign: list[dict[str, Any]] = field(default_factory=list)  # rows repeat, answer unaffected
    verified: bool | None = None  # True: original vs de-duplicated results compared; False: not compared


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


def _strip(e: exp.Expression) -> exp.Expression:
    while isinstance(e, (exp.Paren, exp.Cast)):
        e = e.this
    return e


def _branches(e: exp.Expression) -> list[exp.Expression | None] | None:
    """Result branches of a CASE/IIF, None if e is not one."""
    e = _strip(e)
    if isinstance(e, exp.Case):
        return [i.args.get("true") for i in e.args.get("ifs") or []] + [e.args.get("default")]
    if isinstance(e, exp.If):
        return [e.args.get("true"), e.args.get("false")]
    return None


def _counts_rows(agg: exp.Expression, arg: exp.Expression | None) -> bool:
    """True if the aggregate counts rows rather than summing a table's values: any non-DISTINCT COUNT(x),
    or SUM/AVG/TOTAL of a constant or of CASE/IIF whose results are all constants."""
    if arg is None or isinstance(agg, exp.Count) or _const(arg):
        return True
    br = _branches(arg)
    return br is not None and all(_const(b) for b in br)


def _cond_entity(agg: exp.Expression, arg: exp.Expression | None) -> bool:
    """True if the counted entity comes from a CASE/IIF condition (all result branches constant)."""
    if arg is None or not _counts_rows(agg, arg):
        return False
    br = _branches(arg)
    return br is not None and all(_const(b) for b in br)


def _entity_cols(agg: exp.Expression, arg: exp.Expression | None, sel: exp.Select) -> list[exp.Column]:
    """Columns whose tables are the counted/summed entity (see module docstring)."""
    if arg is None:
        return []
    if _counts_rows(agg, arg):
        br = _branches(arg)
        if br is not None:
            live = [b for b in br if not _const(b)]
            if live:  # COUNT(CASE WHEN cond THEN T1.ID END): the entity is T1
                return [c for b in live for c in b.find_all(exp.Column) if _own(c, sel)]
    return [c for c in arg.find_all(exp.Column) if _own(c, sel)]


def _own(node: exp.Expression, sel: exp.Select) -> bool:
    return node.find_ancestor(exp.Select) is sel


def _scope_aggs(sel: exp.Select, windows: bool = False) -> list[exp.Expression]:
    """Aggregates owned by this scope; window aggregates (SUM(..) OVER ..) only if windows=True."""
    return [a for a in sel.find_all(exp.AggFunc, exp.Anonymous)
            if _is_agg(a) and _own(a, sel) and (windows or not isinstance(a.parent, exp.Window))]


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
        if len(_sources(sel)) >= 2 and any(not _is_distinct(a) for a in _scope_aggs(sel, windows=True)):
            return True
    return False


def _existence_only(agg: exp.Expression) -> bool:
    """agg is only tested for being zero / non-zero (COUNT(..) > 0, SUM(CASE..1..0) = 0, ...)."""
    node = agg
    while isinstance(node.parent, (exp.Paren, exp.Cast)):
        node = node.parent
    cmp = node.parent
    if not isinstance(cmp, (exp.GT, exp.GTE, exp.LT, exp.LTE, exp.EQ, exp.NEQ)):
        return False
    other = cmp.expression if cmp.this is node else cmp.this
    if not (isinstance(other, exp.Literal) and not other.is_string):
        return False
    v = float(other.this)
    lhs = cmp.this is node
    ok = {(exp.GT, True): 0, (exp.GTE, True): 1, (exp.LT, True): 1, (exp.LTE, True): 0,
          (exp.GT, False): 1, (exp.GTE, False): 0, (exp.LT, False): 0, (exp.LTE, False): 1,
          (exp.EQ, True): 0, (exp.EQ, False): 0, (exp.NEQ, True): 0, (exp.NEQ, False): 0}
    return ok.get((type(cmp), lhs)) == v


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

    def sole_pk(self, table: str) -> str | None:
        pk = [c for c, p in self.cols(table) if p > 0]
        return pk[0] if len(pk) == 1 else None

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
    aliases: list[str]  # entity aliases (lower-case); empty = no entity (COUNT(*))
    kind: str  # "value" (SUM/AVG of values), "count" (counts rows of an entity), "star" (counts joined rows)
    existence: bool = False
    through_join: bool = False  # a count whose other tables are used only in JOIN .. ON (see below)
    cond_entity: bool = False  # entity inferred from a condition: SUM(CASE WHEN T2.x THEN 1 ELSE 0 END)
    nonzero: bool = False  # SUM/TOTAL of a 0/1 indicator: only rows with a non-zero value are counted
    group: bool = False  # scope has GROUP BY


# COUNT(T1.Id) FROM posts T1 JOIN votes T2 ON T1.Id = T2.PostId: votes is used only to multiply rows, so the
# count is almost always meant to count votes ("number of votes for the post"). When every non-entity table of
# a count appears only in ON clauses, a repeated entity is reported as benign instead of flagged.
COUNT_THROUGH_JOIN_IS_INTENT = True


def _on_only(sel: exp.Select, alias_table: dict[str, str], schema: "_Schema") -> set[str]:
    """Lower-case aliases of the scope whose columns appear only inside JOIN .. ON conditions."""
    on_ids = {id(c) for j in sel.args.get("joins") or [] if j.args.get("on") is not None
              for c in j.args["on"].find_all(exp.Column)}
    seen_outside: set[str] = set()
    for c in sel.find_all(exp.Column):
        if not _own(c, sel) or id(c) in on_ids:
            continue
        t = c.table.lower()
        if not t:
            hits = [a for a, tb in alias_table.items() if c.name.lower() in {n.lower() for n, _ in schema.cols(tb)}]
            if len(hits) != 1:
                return set()  # unresolvable reference: assume every table is used
            t = hits[0]
        seen_outside.add(t)
    return {s.alias_or_name.lower() for s in _sources(sel)} - seen_outside


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
    on_only = _on_only(sel, alias_table, schema)
    all_aliases = {s.alias_or_name.lower() for s in _sources(sel)}
    for i, agg in enumerate(_scope_aggs(sel)):
        if _is_distinct(agg) or (isinstance(agg, exp.Anonymous) and not agg.expressions):
            continue
        arg = _agg_arg(agg)
        row_count = _counts_rows(agg, arg)
        aliases: list[str] = []
        ok = True
        for c in _entity_cols(agg, arg, sel):
            t = c.table.lower()
            if not t:  # unqualified: resolve against the scope's base tables
                hits = [a for a, tb in alias_table.items()
                        if c.name.lower() in {n.lower() for n, _ in schema.cols(tb)}]
                t = hits[0] if len(hits) == 1 else ""
            if t not in alias_key:
                ok = False  # outer/correlated, derived table, view, or ambiguous column
                aliases = []
                break
            if t not in aliases:
                aliases.append(t)
        if not ok and not row_count:
            continue
        kind = "value" if not row_count else ("count" if aliases else "star")
        if kind == "star" and unkeyable:
            continue
        checks.append(_Check(i, agg.sql(dialect="sqlite"), arg.sql(dialect="sqlite") if arg else "*",
                             aliases, kind, row_count and _existence_only(agg),
                             kind == "count" and bool(all_aliases - set(aliases))
                             and all_aliases - set(aliases) <= on_only,
                             kind == "count" and _cond_entity(agg, arg),
                             kind == "count" and isinstance(agg, (exp.Sum, exp.Anonymous)),
                             sel.args.get("group") is not None))
    return checks, alias_table, alias_key, alias_name


def _top(node: exp.Expression, sel: exp.Select) -> exp.Expression:
    while node.parent is not None and node.parent is not sel:
        node = node.parent
    return node


def _mixed_grain(aggs: list[exp.Expression], idx: int, sel: exp.Select,
                 stat: dict[int, tuple[int, int]]) -> bool:
    """A repeated count sits in the same expression as a measured aggregate whose entity does not repeat
    (SUM(CASE WHEN T2.x ..) * 100 / COUNT(T1.id)): the expression is a ratio of joined-row counts, and
    de-duplicating one side alone would mix grains."""
    top = _top(aggs[idx], sel)
    for k, other in enumerate(aggs):
        if k != idx and k in stat and _top(other, sel) is top and stat[k][0] <= stat[k][1]:
            return True
    return False


def _distinct_sibling(aggs: list[exp.Expression], idx: int, sel: exp.Select, aliases: list[str]) -> bool:
    """The same expression also has COUNT(DISTINCT <entity column>): the query itself counts entity rows
    (SUM(CASE WHEN T1.label = '+' ..) * 100 / COUNT(DISTINCT T1.molecule_id)), so the entity is not a lookup."""
    top = _top(aggs[idx], sel)
    for k, other in enumerate(aggs):
        if k != idx and _is_distinct(other) and _top(other, sel) is top:
            if any(c.table.lower() in aliases for c in other.find_all(exp.Column)):
                return True
    return False


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


# --- result check: de-duplicated twins of the aggregates ---------------------------------------------------

class _Dedup:
    """Aggregate over distinct entity row keys: keeps the first non-NULL value seen for each key."""

    def __init__(self) -> None:
        self.vals: dict[Any, Any] = {}
        self.anon = 0

    def step(self, key: Any, value: Any, *_: Any) -> None:
        if key is None:  # NULL-extended row of an outer join: keep every one, like the original
            self.anon += 1
            key = ("__null", self.anon)
        if value is not None or key not in self.vals:
            self.vals.setdefault(key, None)
            if self.vals[key] is None:
                self.vals[key] = value

    def nums(self) -> list[Any]:
        out = []
        for v in self.vals.values():
            if v is None:
                continue
            if isinstance(v, (str, bytes)):
                try:
                    v = float(v)
                except ValueError:
                    v = 0
            out.append(v)
        return out


class _DSum(_Dedup):
    def finalize(self) -> Any:
        n = self.nums()
        return sum(n) if n else None


class _DTotal(_Dedup):
    def finalize(self) -> Any:
        return float(sum(self.nums()))


class _DAvg(_Dedup):
    def finalize(self) -> Any:
        n = self.nums()
        return sum(n) / len(n) if n else None


class _DCount(_Dedup):
    def finalize(self) -> Any:
        return sum(v is not None for v in self.vals.values())


class _DConcat(_Dedup):
    def step(self, key: Any, value: Any, sep: Any = ",") -> None:
        self.sep = "," if sep is None else str(sep)
        super().step(key, value)

    def finalize(self) -> Any:
        vals = [str(v) for v in self.vals.values() if v is not None]
        return getattr(self, "sep", ",").join(vals) if vals else None


_DD_FUNCS = {"sum": _DSum, "total": _DTotal, "avg": _DAvg, "count": _DCount, "gc": _DConcat}


def _dd_name(agg: exp.Expression) -> str:
    if isinstance(agg, exp.Count):
        return "count"
    if isinstance(agg, exp.Sum):
        return "sum"
    if isinstance(agg, exp.Avg):
        return "avg"
    if isinstance(agg, exp.GroupConcat):
        return "gc"
    return "total"


def _dd_call(agg: exp.Expression, key: str) -> exp.Expression:
    arg = _agg_arg(agg)
    args = [sqlglot.parse_one(key, read="sqlite"), arg.copy() if arg is not None else exp.Literal.number(1)]
    if isinstance(agg, exp.GroupConcat):
        sep = agg.args.get("separator")
        args.append(sep.copy() if sep is not None else exp.Literal.string(","))
    return exp.Anonymous(this=f"altimeter_dd_{_dd_name(agg)}", expressions=args)


def _dedup_sql(root: exp.Expression, targets: list[tuple[int, int, str]]) -> str:
    """Copy of the query with aggregate `agg index` of scope `scope index` replaced by its de-duplicated twin."""
    new = root.copy()
    scopes = list(new.find_all(exp.Select))
    nodes = [(_scope_aggs(scopes[si])[ai], key) for si, ai, key in targets]
    for node, key in nodes:
        node.replace(_dd_call(node, key))
    return new.sql(dialect="sqlite")


class _Runner:
    """One read-only connection with the de-duplicating aggregates registered and a wall-clock deadline."""

    def __init__(self, db_path: str, deadline: float) -> None:
        self.deadline = deadline
        self.con = connect_guarded(db_path)
        for name, cls in _DD_FUNCS.items():
            self.con.create_aggregate(f"altimeter_dd_{name}", 3 if name == "gc" else 2, cls)
        self.con.set_progress_handler(lambda: 1 if time.time() > self.deadline else 0, 10_000)

    def rows(self, sql: str) -> tuple[list[tuple[Any, ...]] | None, str | None]:
        if time.time() > self.deadline:
            return None, "timeout"
        try:
            return self.con.execute(sql).fetchall(), None
        except Exception as e:  # noqa: BLE001
            return None, "timeout" if time.time() > self.deadline or "interrupt" in str(e) else \
                f"{type(e).__name__}: {e}"

    def close(self) -> None:
        self.con.close()


def _cell_eq(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    return a == b


def _sort_key(row: tuple[Any, ...]) -> tuple[Any, ...]:
    return tuple((0, round(v, 6), "") if isinstance(v, (int, float)) else (1, 0, str(v)) for v in row)


def _same(a: list[tuple[Any, ...]], b: list[tuple[Any, ...]], ordered: bool) -> bool:
    if len(a) != len(b):
        return False
    if not ordered:
        a, b = sorted(a, key=_sort_key), sorted(b, key=_sort_key)
    return all(len(x) == len(y) and all(_cell_eq(p, q) for p, q in zip(x, y)) for x, y in zip(a, b))


def _cell(v: Any) -> str:
    return f"{v:.6g}" if isinstance(v, float) else str(v)


def _change(before: list[tuple[Any, ...]], after: list[tuple[Any, ...]]) -> str:
    if len(before) == 1 and len(after) == 1 and len(before[0]) == 1 and len(after[0]) == 1:
        return f"{_cell(before[0][0])} vs {_cell(after[0][0])} de-duplicated"
    rest = Counter(_sort_key(r) for r in after)
    changed = 0
    for r in before:
        k = _sort_key(r)
        if rest[k] > 0:
            rest[k] -= 1
        else:
            changed += 1
    if changed == 0:
        return f"same {len(before)} rows, different order after de-duplication"
    return f"{changed} of {len(before)} result rows differ after de-duplication"


# --- suggestion ------------------------------------------------------------------------------------------

def _suggest(root: exp.Select, flagged: list[tuple[int, str, str]], alias_table: dict[str, str],
             alias_key: dict[str, str], alias_name: dict[str, str], schema: _Schema) -> str | None:
    """Plain-SQL rewrite of the root scope. flagged = [(agg index, entity alias, kind)].
    Counts become COUNT(DISTINCT <entity>); other aggregates are computed over the distinct participating rows
    of their table (only without GROUP BY)."""
    new = root.copy()
    aggs = _scope_aggs(new)
    base = new.copy()
    for k in ("expressions", "group", "having", "order", "limit", "offset", "distinct", "with_"):
        base.set(k, None)
    repl: list[tuple[exp.Expression, exp.Expression]] = []
    for i, alias, kind in flagged:
        agg = aggs[i]
        key = alias_key[alias]
        arg = _agg_arg(agg)
        if isinstance(agg, exp.Count):
            pk = schema.sole_pk(alias_table[alias])
            if isinstance(arg, exp.Column) and arg.table.lower() == alias and pk and arg.name.lower() == pk.lower():
                sub = f"COUNT(DISTINCT {arg.sql(dialect='sqlite')})"
            elif arg is None:
                sub = f"COUNT(DISTINCT {key})"
            else:
                sub = f"COUNT(DISTINCT CASE WHEN ({arg.sql(dialect='sqlite')}) IS NOT NULL THEN {key} END)"
        elif new.args.get("group") is None:
            keys_sel = base.copy().select(sqlglot.parse_one(key, read="sqlite"), copy=False)
            sub = (f"(SELECT {agg.sql(dialect='sqlite')} FROM {_q(alias_table[alias])} AS {_q(alias_name[alias])} "
                   f"WHERE {key} IN ({keys_sel.sql(dialect='sqlite')}))")
        else:
            return None
        repl.append((agg, sqlglot.parse_one(sub, read="sqlite")))
    for agg, sub_e in repl:
        agg.replace(sub_e)
    if not _scope_aggs(new):  # no aggregate left: stop the join from producing one row per joined row
        bare = [c for e in new.expressions for c in e.find_all(exp.Column) if _own(c, new)]
        if bare:
            new.set("limit", exp.Limit(expression=exp.Literal.number(1)))
        else:
            for k in ("from_", "joins", "where", "group", "having", "order", "limit"):
                new.set(k, None)
    return new.sql(dialect="sqlite")


# --- audit -----------------------------------------------------------------------------------------------

def audit(db_path: str, sql: str, timeout_s: float = 5.0) -> AuditResult:
    deadline = time.time() + timeout_s
    try:
        root = sqlglot.parse_one(sql, read="sqlite")
    except Exception as e:  # noqa: BLE001
        return AuditResult(False, message="could not parse SQL", error=f"parse: {e}")
    if root is None or not isinstance(root, (exp.Select, exp.Union, exp.Subquery)):
        return AuditResult(False, message="not a SELECT; nothing to audit")
    runner: _Runner | None = None
    try:
        schema = _Schema(db_path, deadline)
        errors: list[str] = []
        # repeated aggregates: (finding dict, scope index, agg index, dedup key sql, entity alias or None, kind)
        reps: list[tuple[dict[str, Any], int, int, str, str | None, str]] = []
        root_maps: tuple[dict[str, str], dict[str, str], dict[str, str]] | None = None
        checked = 0
        for si, sel in enumerate(root.find_all(exp.Select)):
            if len(_sources(sel)) < 2:
                continue
            checks, alias_table, alias_key, alias_name = _scope_checks(sel, schema)
            if sel is root:
                root_maps = (alias_table, alias_key, alias_name)
            if not checks:
                continue
            pair_ix: dict[tuple[str, str], int] = {}  # identical count columns are computed once
            slots: list[tuple[_Check, str | None, int]] = []  # (check, alias, pair index)
            for ch in checks:
                if ch.kind != "star":
                    key = _key_expr(ch.aliases, alias_key)
                    nz = f" AND ({ch.column}) <> 0" if ch.nonzero else ""
                    cond = f"CASE WHEN ({ch.column}) IS NOT NULL{nz} THEN {key} END"
                    todo = [(None, (f"COUNT({cond})", f"COUNT(DISTINCT {cond})"))]
                else:
                    todo = [(a, (f"COUNT({k})", f"COUNT(DISTINCT {k})")) for a, k in alias_key.items()]
                for a, pair in todo:
                    slots.append((ch, a, pair_ix.setdefault(pair, len(pair_ix))))
            counts, err = _measure(sel, root, list(pair_ix), db_path, deadline)
            if err:
                errors.append(err)
                continue
            checked += 1
            assert counts is not None
            star: dict[int, list[tuple[str, int, int]]] = {}
            stat = {ch.agg_index: (counts[2 * p], counts[2 * p + 1]) for ch, a, p in slots if a is None}
            aggs = _scope_aggs(sel)
            for ch, a, p in slots:
                j, d = counts[2 * p], counts[2 * p + 1]
                if a is not None:
                    star.setdefault(ch.agg_index, []).append((a, j, d))
                elif j > d > 0:
                    f = {"table": ",".join(alias_table[x] for x in ch.aliases),
                         "alias": ",".join(alias_name[x] for x in ch.aliases),
                         "column": ch.column, "aggregate": ch.agg_sql, "joined_rows": j,
                         "distinct_rows": d, "factor": round(j / d, 3), "kind": ch.kind}
                    if ch.existence:
                        f["unaffected"] = "existence test"
                    elif ch.through_join and COUNT_THROUGH_JOIN_IS_INTENT:
                        f["unaffected"] = ("the other tables are used only in the JOIN, so this counts their rows; "
                                           "use COUNT(DISTINCT ..) to count " + f["table"] + " rows")
                    elif (ch.cond_entity and not ch.group and d <= 1
                          and not _distinct_sibling(aggs, ch.agg_index, sel, ch.aliases)):
                        f["unaffected"] = (f"the condition picks a single {f['table']} row (a lookup), "
                                           "so this counts joined rows")
                    elif ch.kind == "count" and _mixed_grain(aggs, ch.agg_index, sel, stat):
                        f["unaffected"] = ("it is divided by or combined with an aggregate over rows that do not "
                                           "repeat, so both count joined rows")
                    reps.append((f, si, ch.agg_index, _key_expr(ch.aliases, alias_key),
                                 ch.aliases[0] if len(ch.aliases) == 1 and sel is root else None, ch.kind))
            for idx, per in star.items():  # COUNT(*): inflated only if every table is repeated
                if not (per and all(j > d > 0 for _, j, d in per)):
                    continue
                ch = next(c for c in checks if c.agg_index == idx)
                a, j, d = min(per, key=lambda x: x[1] / x[2])
                f = {"table": "*", "alias": "*", "column": ch.column, "aggregate": ch.agg_sql, "joined_rows": j,
                     "distinct_rows": d, "factor": round(j / d, 3), "kind": "star", "many_to_many": True}
                if ch.existence:
                    f["unaffected"] = "existence test"
                reps.append((f, si, idx, alias_key[a], a if sel is root else None, "star"))
        err_s = "; ".join(errors) or None
        live = [r for r in reps if "unaffected" not in r[0]]
        benign = [r[0] for r in reps if "unaffected" in r[0]]
        if not live:
            if benign:
                return AuditResult(False, [], _benign_msg(benign), None, err_s, benign, None)
            msg = "no JOIN + aggregate to audit" if checked == 0 and not errors else "no fan-out detected"
            return AuditResult(False, [], msg if not (errors and checked == 0) else "audit incomplete", None, err_s)

        # result check: does de-duplicating the repeated aggregates change the answer?
        ordered = root.args.get("order") is not None
        verified = False
        flagged = live
        before = after = None
        why = ""
        try:
            runner = _Runner(db_path, deadline)
            t_run = time.time()
            orig, e1 = runner.rows(sql)
            t_run = time.time() - t_run
            dd, e2 = (runner.rows(_dedup_sql(root, [(r[1], r[2], r[3]) for r in live]))
                      if orig is not None else (None, None))
            if orig is not None and dd is not None:
                verified = True
                if _same(orig, dd, ordered):
                    for r in live:
                        r[0]["unaffected"] = "same result after de-duplication"
                    benign += [r[0] for r in live]
                    return AuditResult(False, [], _benign_msg(benign), None, err_s, benign, True)
                before, after = orig, dd
                # which aggregates change the answer on their own? (only if the budget allows the extra runs)
                if 1 < len(live) <= 6 and deadline - time.time() > 1.5 * t_run * len(live):
                    own = []
                    for r in live:
                        one, e3 = runner.rows(_dedup_sql(root, [(r[1], r[2], r[3])]))
                        if one is None:
                            own = []
                            break
                        own.append(not _same(orig, one, ordered))
                    if any(own):
                        for r, changes in zip(live, own):
                            if not changes:
                                r[0]["unaffected"] = "same result when de-duplicated alone"
                                benign.append(r[0])
                        flagged = [r for r, changes in zip(live, own) if changes]
            else:
                why = e1 or e2 or "result check failed"
        except Exception as e:  # noqa: BLE001 - fall back to the structural finding
            why = f"{type(e).__name__}: {e}"

        findings = [r[0] for r in flagged]
        f0 = findings[0]
        what = "row of every joined table (at least)" if f0["table"] == "*" else f"{f0['table']} row"
        msg = (f"Fan-out: {f0['aggregate']} sees each {what} {f0['factor']:g}x "
               f"({f0['joined_rows']} joined rows vs {f0['distinct_rows']} distinct) because of the JOIN"
               + (" (many-to-many: no table appears once per joined row)" if f0.get("many_to_many") else ""))
        if verified and before is not None and after is not None:
            msg += f", and it changes the answer ({_change(before, after)})."
        else:
            msg += f". Effect on the answer not verified ({why})."
        suggestion = None
        root_flags = [(r[2], r[4], r[5]) for r in flagged if r[4] is not None]
        if (root_flags and isinstance(root, exp.Select) and root_maps is not None
                and len(root_flags) == len(flagged)):
            try:
                cand = _suggest(root, sorted(set(root_flags)), root_maps[0], root_maps[1], root_maps[2], schema)
                remaining = deadline - time.time()
                r = run(db_path, cand, max(remaining, 0.5)) if cand else None
                if r is not None and r.error is None:
                    target = after if len(flagged) == len(live) else None
                    if target is None and runner is not None:
                        target, _ = runner.rows(_dedup_sql(root, [(x[1], x[2], x[3]) for x in flagged]))
                    if target is None or _same(r.rows or [], target, ordered):
                        suggestion = cand
                        if r.rows and len(r.rows) == 1 and len(r.rows[0]) == 1:
                            msg += f" Deduplicated value: {r.rows[0][0]}."
            except Exception:  # noqa: BLE001 - suggestion is optional
                suggestion = None
        return AuditResult(True, findings, msg, suggestion, err_s, benign, verified)
    except Exception as e:  # noqa: BLE001 - auditor must never crash the caller
        return AuditResult(False, message="audit failed", error=f"{type(e).__name__}: {e}")
    finally:
        if runner is not None:
            runner.close()


def _benign_msg(benign: list[dict[str, Any]]) -> str:
    b = benign[0]
    what = "joined rows" if b["table"] == "*" else f"{b['table']} rows"
    head = ("Rows repeat but the answer is unaffected"
            if b["unaffected"].startswith(("same result", "existence")) else "Rows repeat, not flagged")
    return (f"{head}: {b['aggregate']} sees {what} {b['factor']:g}x "
            f"({b['joined_rows']} vs {b['distinct_rows']}); {b['unaffected']}.")
