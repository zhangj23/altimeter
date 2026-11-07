"""Export the table screen's Scoreboard panel from the final probe run.

Reads probe_v1_results.json (AUROCs with database-bootstrap CIs, sweep, reliability, ECE) and the
out-of-fold jsonl (for the band table and a sanity recompute of AUROC). Writes
server/static/data/scoreboard.json. Every number here comes from those files, except the
"negatives" list, which records pre-registered side experiments run earlier today.

    python scripts/export_scoreboard.py [--run ~/runs/v1] [--out server/static/data/scoreboard.json]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUN = Path.home() / "runs" / "v1"
DEFAULT_OUT = ROOT / "server" / "static" / "data" / "scoreboard.json"

# Must match BANDS in server/static/app.js and table.js (bandOf: s < to).
BANDS = [("ask", "Ask", 0.0, 0.5), ("caution", "Caution", 0.5, 0.8), ("cruise", "Cruise", 0.8, 1.0)]
CRUISE_FROM = 0.8

SUBSETS = {  # key in results.json -> (short name, filter on oof rows)
    "BIRD (headline; not used for selection)": ("bird", lambda r: r["source"] == "bird"),
    "Spider (selection set, optimistic)": ("spider", lambda r: r["source"] == "spider"),
    "BIRD, executable SQL only": ("bird_exec", lambda r: r["source"] == "bird" and bool(r["executes"])),
    "pooled": ("pooled", lambda r: True),
}
HEADLINE = "BIRD (headline; not used for selection)"
METRICS = [  # (output key, results key prefix, label)
    ("stacked", "stacked", "Stacked needle (probe + log-probs + surface)"),
    ("stack_without_probe", "stack_without_probe", "Same stack without the probe"),
    ("surface_complexity", "surface_complexity", "Surface complexity (lengths, joins, aggregates)"),
    ("probe", "probe[", "Hidden-state probe alone"),
    ("logprob_mean", "logprob_mean", "Mean token log-prob"),
    ("logprob_min", "logprob_min", "Min token log-prob"),
    ("prompt_only_probe", "prompt_only_probe[", "Prompt-only probe (before any SQL)"),
    ("shuffled_label_control", "shuffled_label_control", "Shuffled-label control"),
]
DELTAS = [
    ("delta_probe_minus_logprob", "Probe minus mean log-prob"),
    ("delta_stacked_minus_stack_without_probe", "Stack with probe minus stack without"),
]

NEGATIVES = [
    {"name": "Needle on Gemini-written SQL",
     "test": "Does the needle transfer to SQL written by another model?",
     "measured": "AUROC 0.581", "bar": "AUROC >= 0.70", "value": 0.581, "threshold": 0.70, "n": 79,
     "passed": False,
     "source": "Pre-registered test, Nov 7: needle scored on Gemini SQL for 79 questions. Raw output file not archived under ~/runs."},
    {"name": "Steering honesty dial",
     "test": "Does steering along the probe direction move the AGREE rate by at least 40 points?",
     "measured": "AGREE rate moved 25 points", "bar": ">= 40 points", "value": 25, "threshold": 40, "n": None,
     "passed": False,
     "source": "Pre-registered test, Nov 7: activation steering. n [TBD]; raw output file not archived under ~/runs."},
    {"name": "Caving polygraph",
     "test": "Does a probe separate CAVED from PERSUADED answers after pushback?",
     "measured": "AUROC 0.800 [0.751, 0.850]", "bar": "AUROC >= 0.85", "value": 0.800, "ci": [0.751, 0.850],
     "threshold": 0.85, "n": 436, "passed": False,
     "source": "~/runs/analyze_main_u.txt: nested leave-one-topic-out AUROC on PopQA, CAVED n=101 vs PERSUADED n=335; CI by topic bootstrap."},
    {"name": "Needle finds answer-key errors",
     "test": "Are BIRD gold-SQL errors more common among low-needle questions?",
     "measured": "4/40 vs 4/40", "bar": "low-needle group has more gold errors (Fisher p < 0.05)",
     "value": {"low_needle": [4, 40], "high_needle": [4, 40], "fisher_p": 0.64}, "n": 80, "passed": False,
     "source": "~/runs/redpen/verdicts.jsonl: 80 hand-audited cases, 8 judged GOLD_WRONG or BOTH_WRONG; one-sided Fisher exact p = 0.64."},
]


def auroc(scores: list[float], labels: list[int]) -> float:
    """Mann-Whitney AUROC with average ranks for ties (positive class = label 1)."""
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    n1 = sum(labels)
    n0 = len(labels) - n1
    r1 = sum(r for r, y in zip(ranks, labels) if y == 1)
    return (r1 - n1 * (n1 + 1) / 2) / (n1 * n0)


def wilson(k: int, n: int, z: float = 1.959964) -> list[float] | None:
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def band_table(rows: list[dict]) -> dict:
    out = {"n": len(rows), "bands": []}
    for key, name, lo, hi in BANDS:
        sub = [r for r in rows if r["stacked_oof"] >= lo and (r["stacked_oof"] < hi or hi == 1.0)]
        wrong = sum(1 - int(r["label"]) for r in sub)
        out["bands"].append({"key": key, "name": name, "from": lo, "to": hi, "n": len(sub),
                             "share": round(len(sub) / len(rows), 4) if rows else None, "wrong": wrong,
                             "pct_wrong": round(wrong / len(sub), 4) if sub else None,
                             "pct_wrong_ci95": wilson(wrong, len(sub))})
    kept = [int(r["label"]) for r in rows if r["stacked_oof"] >= CRUISE_FROM]
    out["at_cruise"] = {"threshold": CRUISE_FROM, "n": len(kept),
                        "coverage": round(len(kept) / len(rows), 4) if rows else None,
                        "accuracy": round(sum(kept) / len(kept), 4) if kept else None,
                        "accuracy_ci95": wilson(sum(kept), len(kept)),
                        "answer_all_accuracy": round(sum(int(r["label"]) for r in rows) / len(rows), 4)}
    return out


def triple(t: list[float]) -> dict:
    return {"auroc": round(t[0], 4), "ci95": [round(t[1], 4), round(t[2], 4)]}


def pick(res: dict, prefix: str) -> tuple[str, list[float]]:
    hits = [k for k in res if k == prefix or (prefix.endswith("[") and k.startswith(prefix))]
    if len(hits) != 1:
        raise KeyError(f"{prefix!r} matched {hits}")
    return hits[0], res[hits[0]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, default=DEFAULT_RUN)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    R = json.loads((args.run / "probe_v1_results.json").read_text())
    oof = [json.loads(l) for l in (args.run / "probe_v1_results_oof.jsonl").read_text().splitlines() if l.strip()]
    oof = [r for r in oof if r.get("stacked_oof") is not None and r.get("label") is not None]

    # sanity: row counts and the headline AUROC recomputed from OOF
    assert len(oof) == R["n"], (len(oof), R["n"])
    subsets = {}
    for rkey, (short, f) in SUBSETS.items():
        sub = [r for r in oof if f(r)]
        mine = auroc([r["stacked_oof"] for r in sub], [int(r["label"]) for r in sub])
        theirs = R["results"][rkey]["stacked"][0]
        print(f"{short:9s} n={len(sub):5d} dbs={len({r['db_id'] for r in sub}):3d} "
              f"acc={sum(int(r['label']) for r in sub) / len(sub):.3f} "
              f"stacked AUROC recomputed={mine:.4f} results={theirs:.4f} match3={round(mine, 3) == round(theirs, 3)}")
        assert round(mine, 3) == round(theirs, 3), (short, mine, theirs)
        subsets[short] = {"label": rkey, "n": len(sub), "n_dbs": len({r["db_id"] for r in sub}),
                          "accuracy": round(sum(int(r["label"]) for r in sub) / len(sub), 4)}

    head = R["results"][HEADLINE]
    metrics = []
    for key, prefix, label in METRICS:
        rk, t = pick(head, prefix)
        metrics.append({"key": key, "results_key": rk, "label": label, **triple(t)})
    deltas = [{"key": k, "label": label, "delta": round(head[k][0], 4),
               "ci95": [round(head[k][1], 4), round(head[k][2], 4)],
               "ci_excludes_0": head[k][1] > 0 or head[k][2] < 0} for k, label in DELTAS]

    pos, layer = R["selected"]
    curve = sorted(((int(k.split("@")[1]), v) for k, v in R["sweep"].items() if k.split("@")[0] == pos))

    by_src = {"pooled": oof, "bird": [r for r in oof if r["source"] == "bird"],
              "spider": [r for r in oof if r["source"] == "spider"]}
    out = {
        "source_note": (f"Final probe run v1: {R['n']:,} benchmark questions across {R['n_dbs']} databases "
                        "(BIRD dev + Spider dev). Grouped cross-validation by database; 95% CIs bootstrap "
                        "resampled by database."),
        "run": "~/runs/v1/probe_v1_results.json",
        "selected": {"position": pos, "layer": layer, "selected_on": R["select_on"]},
        "subsets": subsets,
        "headline": {"subset": HEADLINE, "n": subsets["bird"]["n"], "metrics": metrics, "deltas": deltas},
        "calibration": {"subset": "pooled", "n": R["n"], "ece": round(R["ece"], 4), "reliability": R["reliability"]},
        "bands": {k: band_table(v) for k, v in by_src.items()},
        "layer_curve": {"label": "Spider selection set (used to choose the layer; optimistic)", "position": pos,
                        "selected_layer": layer, "n": subsets["spider"]["n"],
                        "points": [{"layer": l, "auroc": v} for l, v in curve]},
        "negatives": NEGATIVES,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1))
    print(f"wrote {args.out}")
    for name, bt in out["bands"].items():
        print(f"== {name} n={bt['n']}")
        for b in bt["bands"]:
            print(f"  {b['name']:8s} n={b['n']:5d} wrong={b['pct_wrong']:.1%} CI95={b['pct_wrong_ci95']}")
        c = bt["at_cruise"]
        print(f"  >=0.80: coverage={c['coverage']:.1%} (n={c['n']}) accuracy={c['accuracy']:.1%} "
              f"CI95={c['accuracy_ci95']} | answer-all acc={c['answer_all_accuracy']:.1%}")


if __name__ == "__main__":
    main()
