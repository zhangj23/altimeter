"""Generate greedy SQL for BIRD dev (cleaned) + Spider dev, execute vs gold, save labels and hidden-state features.

Resumable: re-run the same command to continue. Outputs in --out:
  meta.jsonl          one line per question (labels, log-probs, timings, SQL)
  feats_XXXX.pt       {uids, last_prompt, last_gen, mean_gen}; each (N, L+1, d) float16
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch  # noqa: E402

from altimeter import sqlexec  # noqa: E402
from altimeter.model import SqlModel  # noqa: E402
from altimeter.prompting import build_messages  # noqa: E402


def load_questions(bird_questions: str, bird_dbs: str, spider_dir: str) -> list[dict]:
    qs: list[dict] = []
    for e in json.load(open(bird_questions, encoding="utf-8")):
        qs.append(dict(uid=f"bird-{e['question_id']}", source="bird", db_id=e["db_id"],
                       db_path=os.path.join(bird_dbs, e["db_id"], f"{e['db_id']}.sqlite"),
                       question=e["question"], evidence=e.get("evidence") or "",
                       gold=e["SQL"], difficulty=e.get("difficulty", "")))
    for i, e in enumerate(json.load(open(os.path.join(spider_dir, "dev.json"), encoding="utf-8"))):
        qs.append(dict(uid=f"spider-{i}", source="spider", db_id=e["db_id"],
                       db_path=os.path.join(spider_dir, "database", e["db_id"], f"{e['db_id']}.sqlite"),
                       question=e["question"], evidence="", gold=e["query"], difficulty=""))
    random.Random(0).shuffle(qs)  # partial runs still cover many databases
    return qs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--bird-questions", required=True)
    ap.add_argument("--bird-dbs", required=True)
    ap.add_argument("--spider-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--shard-size", type=int, default=50)
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    meta_path = out / "meta.jsonl"
    done = set()
    if meta_path.exists():
        done = {json.loads(l)["uid"] for l in open(meta_path, encoding="utf-8") if l.strip()}
    shard_idx = len(list(out.glob("feats_*.pt")))

    qs = load_questions(a.bird_questions, a.bird_dbs, a.spider_dir)
    if a.limit:
        qs = qs[: a.limit]
    todo = [q for q in qs if q["uid"] not in done]
    print(f"{len(qs)} questions, {len(done)} done, {len(todo)} to go", flush=True)
    if not todo:
        return

    model = SqlModel(a.model)
    buf: dict[str, list] = {"uids": [], "last_prompt": [], "last_gen": [], "mean_gen": []}
    pending_meta: list[str] = []
    t_start, n_ok, n_done = time.time(), 0, 0

    def flush() -> None:
        nonlocal shard_idx
        if not buf["uids"]:
            return
        torch.save({"uids": buf["uids"], **{k: torch.stack(v) for k, v in buf.items() if k != "uids"}},
                   out / f"feats_{shard_idx:04d}.pt")
        shard_idx += 1
        # write meta only after its features are on disk, so resume never skips unsaved features
        with open(meta_path, "a", encoding="utf-8") as f:
            f.writelines(pending_meta)
        pending_meta.clear()
        for v in buf.values():
            v.clear()

    for q in todo:
        g = model.generate(build_messages(q["db_path"], q["question"], q["evidence"]))
        pred = sqlexec.run(q["db_path"], g.sql, timeout_s=10.0)
        gold = sqlexec.run(q["db_path"], q["gold"], timeout_s=10.0)
        if gold.error:
            label = None  # gold itself fails: exclude from training
        elif pred.error:
            label = 0
        else:
            label = int(sqlexec.results_match(pred.rows, gold.rows))
        rec = dict(
            uid=q["uid"], source=q["source"], db_id=q["db_id"], difficulty=q["difficulty"],
            question=q["question"], evidence=q["evidence"], gold_sql=q["gold"], pred_sql=g.sql,
            label=label, pred_error=pred.error, gold_error=gold.error,
            pred_timeout=pred.timed_out, gold_timeout=gold.timed_out,
            empty_match=bool(label == 1 and not pred.rows and not gold.rows),
            pred_rows=len(pred.rows) if pred.rows is not None else None,
            n_prompt=g.n_prompt, n_gen=g.n_gen, logprob_mean=g.logprob_mean, logprob_min=g.logprob_min,
            gen_seconds=round(g.gen_seconds, 3), feat_seconds=round(g.feat_seconds, 3),
        )
        pending_meta.append(json.dumps(rec) + "\n")
        buf["uids"].append(q["uid"])
        buf["last_prompt"].append(g.hs_last_prompt)
        buf["last_gen"].append(g.hs_last_gen)
        buf["mean_gen"].append(g.hs_mean_gen)
        n_done += 1
        n_ok += int(label == 1)
        if len(buf["uids"]) >= a.shard_size:
            flush()
        if n_done % 10 == 0:
            el = time.time() - t_start
            print(f"{n_done}/{len(todo)}  acc {n_ok / n_done:.3f}  {el / n_done:.2f} s/q  "
                  f"eta {(len(todo) - n_done) * el / n_done / 60:.0f} min", flush=True)
    flush()
    print(f"DONE {n_done} in {(time.time() - t_start) / 60:.1f} min, acc {n_ok / max(n_done, 1):.3f}", flush=True)


if __name__ == "__main__":
    main()
