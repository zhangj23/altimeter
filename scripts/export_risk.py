"""Export out-of-fold stacked scores for the table screen's Coverage view.

Reads the OOF jsonl written by train_probe.py and writes server/static/data/risk.json with
{source_note, n, n_bird, n_spider, rows: [{s, y, src}]}. No question text leaves this script.

    python scripts/export_risk.py [--oof ~/runs/g2/probe_g2_results_oof.jsonl] [--out server/static/data/risk.json]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OOF = Path.home() / "runs" / "g2" / "probe_g2_results_oof.jsonl"
DEFAULT_OUT = ROOT / "server" / "static" / "data" / "risk.json"


def load(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("stacked_oof") is None or r.get("label") is None:
            continue
        rows.append({"s": round(float(r["stacked_oof"]), 4), "y": int(r["label"]), "src": str(r["source"])})
    return rows


def at(rows: list[dict], t: float) -> tuple[float, float | None]:
    """Coverage (share with s >= t) and accuracy on that share."""
    kept = [r["y"] for r in rows if r["s"] >= t]
    return len(kept) / len(rows), (sum(kept) / len(kept) if kept else None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--oof", type=Path, default=DEFAULT_OOF)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--note", default=None, help="override the source note")
    args = ap.parse_args()

    rows = load(args.oof)
    n_bird = sum(r["src"] == "bird" for r in rows)
    n_spider = sum(r["src"] == "spider" for r in rows)
    note = args.note or (f"Out-of-fold scores from {len(rows)} benchmark questions, partial run; each question "
                         "scored by a model that never saw its database")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"source_note": note, "n": len(rows), "n_bird": n_bird, "n_spider": n_spider,
                                    "rows": rows}, separators=(",", ":")))

    print(f"wrote {args.out}  n={len(rows)} (bird {n_bird}, spider {n_spider})")
    for name, sub in (("both", rows), ("bird", [r for r in rows if r["src"] == "bird"]),
                      ("spider", [r for r in rows if r["src"] == "spider"])):
        if not sub:
            continue
        acc = sum(r["y"] for r in sub) / len(sub)
        line = f"{name:6s} n={len(sub):4d} answer-all acc={acc:.1%}"
        for t in (0.5, 0.8):
            cov, a = at(sub, t)
            line += f" | s>={t}: cov={cov:.1%} acc={'n/a' if a is None else f'{a:.1%}'}"
        print(line)


if __name__ == "__main__":
    main()
