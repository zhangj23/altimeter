"""Train and evaluate the correctness probe on labeled runs (works on partial data).

Methodology (per the ML audit):
- Schema-disjoint CV: GroupKFold by db_id; every score is out-of-fold (OOF).
- Layer/position is SELECTED on Spider rows only; headline numbers are reported on BIRD rows
  (selection and reporting never share data). Spider numbers are marked as the selection set.
- "executes" feature = compile-only check (SQLite EXPLAIN), the same thing serving can know before running.
- Paired database-bootstrap CIs for deltas (probe - logprob, stacked - stack_without_probe).
- Reliability table + ECE for the stacked needle.
- The deploy probe can exclude demo databases (--exclude-dbs) so live demo questions are never in-sample.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import pickle
import sys
from pathlib import Path

import numpy as np
import torch
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from altimeter.probe import SURFACE_NAMES, surface_features  # noqa: E402
from altimeter.sqlexec import compiles  # noqa: E402

POSITIONS = ("last_prompt", "last_gen", "mean_gen")


def load(run_dirs: list[str]) -> tuple[list[dict], dict[str, np.ndarray]]:
    meta: dict[str, dict] = {}
    feats: dict[str, dict[str, np.ndarray]] = {p: {} for p in POSITIONS}
    for d in run_dirs:
        for line in open(os.path.join(d, "meta.jsonl"), encoding="utf-8"):
            r = json.loads(line)
            meta[r["uid"]] = r
        for f in sorted(glob.glob(os.path.join(d, "feats_*.pt"))):
            x = torch.load(f)
            for p in POSITIONS:
                for uid, v in zip(x["uids"], x[p]):
                    feats[p][uid] = v.float().numpy()
    rows = [m for uid, m in meta.items() if m["label"] is not None and uid in feats["last_gen"]]
    arr = {p: np.stack([feats[p][r["uid"]] for r in rows]) for p in POSITIONS}  # (N, L+1, d)
    return rows, arr


def db_path(r: dict, bird_dbs: str, spider_dir: str) -> str:
    if r["source"] == "bird":
        return os.path.join(bird_dbs, r["db_id"], f"{r['db_id']}.sqlite")
    return os.path.join(spider_dir, "database", r["db_id"], f"{r['db_id']}.sqlite")


def surface(rows: list[dict], bird_dbs: str, spider_dir: str) -> np.ndarray:
    out = []
    for r in rows:
        ok = compiles(db_path(r, bird_dbs, spider_dir), r["pred_sql"] or "")
        out.append(surface_features(r["question"], r["pred_sql"], r["n_prompt"], r["n_gen"], ok))
    return np.array(out, dtype=np.float64)


def probe_pipe(n: int, c: float = 0.1, d: int = 10**9):
    return make_pipeline(StandardScaler(), PCA(n_components=min(256, n - 1, d), random_state=0),
                         LogisticRegression(C=c, max_iter=2000))


def lin_pipe(n: int = 0, d: int = 0):
    return make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))


def oof(X: np.ndarray, y: np.ndarray, groups: np.ndarray, make) -> np.ndarray:
    k = min(5, len(np.unique(groups)))
    p = np.zeros(len(y))
    for tr, te in GroupKFold(n_splits=k).split(X, y, groups):
        m = make(len(tr), d=X.shape[1]).fit(X[tr], y[tr])
        p[te] = m.predict_proba(X[te])[:, 1]
    return p


def _boot_idx(groups: np.ndarray, n_boot: int, seed: int = 0):
    rng = np.random.default_rng(seed)
    dbs = np.unique(groups)
    by_db = {d: np.where(groups == d)[0] for d in dbs}
    for _ in range(n_boot):
        yield np.concatenate([by_db[d] for d in rng.choice(dbs, size=len(dbs), replace=True)])


def auc_ci(y, s, groups, n_boot: int = 500) -> tuple[float, float, float]:
    if len(np.unique(y)) < 2:
        return float("nan"), float("nan"), float("nan")
    boots = [roc_auc_score(y[i], s[i]) for i in _boot_idx(groups, n_boot) if len(np.unique(y[i])) == 2]
    lo, hi = np.percentile(boots, [2.5, 97.5]) if boots else (np.nan, np.nan)
    return float(roc_auc_score(y, s)), float(lo), float(hi)


def delta_ci(y, a, b, groups, n_boot: int = 1000) -> tuple[float, float, float]:
    """Paired bootstrap over databases of AUROC(a) - AUROC(b)."""
    if len(np.unique(y)) < 2:
        return float("nan"), float("nan"), float("nan")
    d = [roc_auc_score(y[i], a[i]) - roc_auc_score(y[i], b[i])
         for i in _boot_idx(groups, n_boot, seed=1) if len(np.unique(y[i])) == 2]
    lo, hi = np.percentile(d, [2.5, 97.5])
    return float(roc_auc_score(y, a) - roc_auc_score(y, b)), float(lo), float(hi)


def reliability(y: np.ndarray, p: np.ndarray, bins: int = 10) -> tuple[list[dict], float]:
    edges = np.linspace(0, 1, bins + 1)
    table, ece = [], 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi) if hi < 1 else (p >= lo) & (p <= hi)
        if m.sum() == 0:
            continue
        conf, acc = float(p[m].mean()), float(y[m].mean())
        ece += m.mean() * abs(conf - acc)
        table.append({"bin": [round(float(lo), 1), round(float(hi), 1)], "n": int(m.sum()), "mean_pred": round(conf, 3),
                      "frac_correct": round(acc, 3)})
    return table, float(ece)


def export_linear(path: str, probe, platt, stack, position: str, layer: int, n: int, meta: dict) -> None:
    """Collapse StandardScaler -> PCA -> LogisticRegression into one weight vector (all steps are linear)."""
    sc, pca, lr = probe.named_steps["standardscaler"], probe.named_steps["pca"], probe.named_steps["logisticregression"]
    v = pca.components_.T @ lr.coef_[0]
    w = v / sc.scale_
    b = float(lr.intercept_[0] - (sc.mean_ / sc.scale_) @ v - pca.mean_ @ v)
    s_sc, s_lr = stack.named_steps["standardscaler"], stack.named_steps["logisticregression"]
    # mu/b0 allow the exact per-dimension decomposition z = b0 + sum_i w_i * (h_i - mu_i)
    json.dump({"position": position, "layer": layer, "w": w.astype(float).tolist(), "b": b,
               "mu": sc.mean_.astype(float).tolist(), "b0": float(lr.intercept_[0]),
               "platt_a": float(platt.coef_[0][0]), "platt_b": float(platt.intercept_[0]),
               "stack_features": ["probe", "logprob_mean", "logprob_min", *SURFACE_NAMES],
               "stack_mean": s_sc.mean_.tolist(), "stack_scale": s_sc.scale_.tolist(),
               "stack_w": s_lr.coef_[0].tolist(), "stack_b": float(s_lr.intercept_[0]),
               "n_train": n, **meta}, open(path, "w"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--bird-dbs", required=True)
    ap.add_argument("--spider-dir", required=True)
    ap.add_argument("--layer-step", type=int, default=2)
    ap.add_argument("--select-on", default="spider", choices=["spider", "bird", "all"])
    ap.add_argument("--exclude-dbs", default="", help="comma-separated db_ids left out of the DEPLOY probe")
    ap.add_argument("--save", default="")
    ap.add_argument("--out-json", default="")
    a = ap.parse_args()

    rows, arr = load(a.runs)
    y = np.array([r["label"] for r in rows])
    g = np.array([r["db_id"] for r in rows])
    src = np.array([r["source"] for r in rows])
    n_layers = arr["last_gen"].shape[1]
    print(f"N={len(y)} correct={y.mean():.3f} dbs={len(np.unique(g))} layers={n_layers} "
          f"bird={int((src == 'bird').sum())} spider={int((src == 'spider').sum())}", flush=True)

    lp_mean = np.array([r["logprob_mean"] for r in rows])
    lp_min = np.array([r["logprob_min"] for r in rows])
    S = surface(rows, a.bird_dbs, a.spider_dir)
    executes = S[:, SURFACE_NAMES.index("executes")] > 0.5

    # 1) Select layer/position on the selection set only.
    sel = np.ones(len(y), bool) if a.select_on == "all" else (src == a.select_on)
    sweep: dict[str, float] = {}
    best = ("", -1, -1.0)
    for p in POSITIONS:
        for layer in range(0, n_layers, a.layer_step):
            s = oof(arr[p][sel, layer], y[sel], g[sel], probe_pipe)
            auc = roc_auc_score(y[sel], s)
            sweep[f"{p}@{layer}"] = round(float(auc), 4)
            print(f"  [select on {a.select_on}] {p:12s} layer {layer:2d}  AUROC {auc:.3f}", flush=True)
            if auc > best[2]:
                best = (p, layer, auc)
    bp, bl, _ = best
    best_prompt = max((k for k in sweep if k.startswith("last_prompt")), key=sweep.get)
    pl = int(best_prompt.split("@")[1])
    print(f"selected {bp}@{bl}; best prompt-only {best_prompt}", flush=True)

    # 2) OOF scores on ALL rows with the selected config (each db scored by a model that never saw it).
    probe_s = oof(arr[bp][:, bl], y, g, probe_pipe)
    prompt_s = oof(arr["last_prompt"][:, pl], y, g, probe_pipe)
    stack_X = np.column_stack([probe_s, lp_mean, lp_min, S])
    stacked = oof(stack_X, y, g, lin_pipe)
    stack_noprobe = oof(np.column_stack([lp_mean, lp_min, S]), y, g, lin_pipe)
    surf_s = oof(S, y, g, lin_pipe)
    shuf = np.random.default_rng(0).permutation(y)
    shuf_s = oof(arr[bp][:, bl], shuf, g, probe_pipe)

    scores = {"logprob_mean": lp_mean, "logprob_min": lp_min, "surface_complexity": surf_s,
              f"prompt_only_probe[{best_prompt}]": prompt_s, f"probe[{bp}@{bl}]": probe_s,
              "stack_without_probe": stack_noprobe, "stacked": stacked}
    subsets = {"BIRD (headline; not used for selection)": src == "bird",
               f"Spider ({'selection set, optimistic' if a.select_on == 'spider' else 'held-out'})": src == "spider",
               "BIRD, executable SQL only": (src == "bird") & executes,
               "pooled": np.ones(len(y), bool)}
    res: dict[str, dict] = {}
    for sname, m in subsets.items():
        if m.sum() < 20 or len(np.unique(y[m])) < 2:
            continue
        print(f"\n== {sname}: n={int(m.sum())}, correct={y[m].mean():.3f}, dbs={len(np.unique(g[m]))}")
        res[sname] = {k: auc_ci(y[m], v[m], g[m]) for k, v in scores.items()}
        res[sname]["shuffled_label_control"] = auc_ci(shuf[m], shuf_s[m], g[m])
        for k, (mm, lo, hi) in res[sname].items():
            print(f"  {k:40s} {mm:.3f}  [{lo:.3f}, {hi:.3f}]")
        res[sname]["delta_probe_minus_logprob"] = delta_ci(y[m], probe_s[m], lp_mean[m], g[m])
        res[sname]["delta_stacked_minus_stack_without_probe"] = delta_ci(y[m], stacked[m], stack_noprobe[m], g[m])
        for k in ("delta_probe_minus_logprob", "delta_stacked_minus_stack_without_probe"):
            d, lo, hi = res[sname][k]
            print(f"  {k:40s} {d:+.3f}  [{lo:+.3f}, {hi:+.3f}]  {'CI excludes 0' if lo > 0 or hi < 0 else 'CI includes 0'}")

    rel, ece = reliability(y, stacked)
    print(f"\nStacked needle reliability (pooled OOF), ECE={ece:.3f}")
    for b in rel:
        print(f"  {b['bin']}  n={b['n']:4d}  mean_pred={b['mean_pred']:.3f}  frac_correct={b['frac_correct']:.3f}")

    if a.out_json:
        json.dump({"n": len(y), "acc": float(y.mean()), "n_dbs": int(len(np.unique(g))),
                   "selected": [bp, bl], "select_on": a.select_on, "sweep": sweep, "results": res,
                   "reliability": rel, "ece": ece}, open(a.out_json, "w"), indent=2)
        with open(os.path.splitext(a.out_json)[0] + "_oof.jsonl", "w", encoding="utf-8") as f:
            for i, r in enumerate(rows):
                f.write(json.dumps({"uid": r["uid"], "db_id": r["db_id"], "source": r["source"], "label": int(y[i]),
                                    "probe_oof": round(float(probe_s[i]), 5), "stacked_oof": round(float(stacked[i]), 5),
                                    "stack_without_probe_oof": round(float(stack_noprobe[i]), 5),
                                    "executes": bool(executes[i]), "logprob_mean": r["logprob_mean"],
                                    "logprob_min": r["logprob_min"]}) + "\n")
    if a.save:
        excl = {d for d in a.exclude_dbs.split(",") if d}
        keep = np.array([r["db_id"] not in excl for r in rows])
        probe = probe_pipe(int(keep.sum()), d=arr[bp].shape[2]).fit(arr[bp][keep, bl], y[keep])
        platt = LogisticRegression().fit(np.log(probe_s[keep] / (1 - probe_s[keep] + 1e-9) + 1e-9)[:, None], y[keep])
        stack = lin_pipe().fit(stack_X[keep], y[keep])
        pickle.dump({"position": bp, "layer": bl, "probe": probe, "platt": platt, "stack": stack,
                     "n_train": int(keep.sum()), "excluded_dbs": sorted(excl)}, open(a.save, "wb"))
        export_linear(os.path.splitext(a.save)[0] + ".json", probe, platt, stack, bp, bl, int(keep.sum()),
                      {"excluded_dbs": sorted(excl), "select_on": a.select_on, "ece": ece,
                       "layer_auroc": [{"layer": int(k.split("@")[1]), "auroc": v} for k, v in sweep.items()
                                       if k.startswith(bp + "@")],
                       "bird_probe_auroc": res.get("BIRD (headline; not used for selection)", {})
                       .get(f"probe[{bp}@{bl}]", [None])[0]})
        print(f"saved {a.save} and {os.path.splitext(a.save)[0]}.json (excluded dbs: {sorted(excl) or 'none'})")


if __name__ == "__main__":
    main()
