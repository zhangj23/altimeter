"""Export a probe_v1-style linear probe (mean_gen, StandardScaler -> PCA 256 -> L2 LR) for every layer.

Per layer: deploy fit on all rows minus the excluded demo dbs (collapsed to w, mu, b0 like export_linear),
Platt fit on OOF scores (as for v1), and BIRD out-of-fold AUROC with a database-bootstrap 95% CI.
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_probe import auc_ci, load, oof, probe_pipe  # noqa: E402

POS = "mean_gen"


def f32(a) -> list[float]:
    return [float(x) for x in np.asarray(a, dtype=np.float32)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--exclude-dbs", default="california_schools,codebase_community,formula_1")
    ap.add_argument("--v1-json", required=True)
    ap.add_argument("--v1-pkl", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    rows, arr = load(a.runs)
    X = arr[POS]
    y = np.array([r["label"] for r in rows])
    g = np.array([r["db_id"] for r in rows])
    bird = np.array([r["source"] == "bird" for r in rows])
    excl = sorted(d for d in a.exclude_dbs.split(",") if d)
    keep = ~np.isin(g, excl)
    print(f"N={len(y)} keep={int(keep.sum())} bird={int(bird.sum())} layers={X.shape[1]}", flush=True)

    layers = []
    for L in range(X.shape[1]):
        s = oof(X[:, L], y, g, probe_pipe)
        pt, lo, hi = auc_ci(y[bird], s[bird], g[bird])
        probe = probe_pipe(int(keep.sum()), d=X.shape[2]).fit(X[keep, L], y[keep])
        platt = LogisticRegression().fit(np.log(s[keep] / (1 - s[keep] + 1e-9) + 1e-9)[:, None], y[keep])
        sc, pca, lr = probe.named_steps["standardscaler"], probe.named_steps["pca"], probe.named_steps["logisticregression"]
        v = pca.components_.T @ lr.coef_[0]
        b0 = float(lr.intercept_[0] - pca.mean_ @ v)  # pca.mean_ ~ 0 on standardized data; folded in for exactness
        layers.append({"layer": L, "w": f32(v / sc.scale_), "mu": f32(sc.mean_), "b0": b0,
                       "platt": {"a": float(platt.coef_[0][0]), "b": float(platt.intercept_[0])},
                       "bird_oof_auroc": [round(pt, 4), round(lo, 4), round(hi, 4)]})
        print(f"layer {L:2d}  BIRD OOF AUROC {pt:.3f} [{lo:.3f}, {hi:.3f}]", flush=True)

    # sanity: layer-26 entry vs probe_v1 (json linear form and pickled pipeline) on 20 rows
    v1 = json.load(open(a.v1_json))
    pk = pickle.load(open(a.v1_pkl, "rb"))
    e = layers[v1["layer"]]
    H = X[:20, v1["layer"]].astype(np.float64)
    z_new = e["b0"] + (H - np.array(e["mu"])) @ np.array(e["w"])
    z_v1 = v1["b0"] + (H - np.array(v1["mu"])) @ np.array(v1["w"])
    z_pkl = pk["probe"].decision_function(H)
    sanity = {"layer": v1["layer"], "rows": 20, "max_abs_diff_vs_v1_json": float(np.abs(z_new - z_v1).max()),
              "max_abs_diff_vs_v1_pipeline": float(np.abs(z_new - z_pkl).max()),
              "platt_v1": [v1["platt_a"], v1["platt_b"]], "platt_new": [e["platt"]["a"], e["platt"]["b"]],
              "z_range": [float(z_pkl.min()), float(z_pkl.max())]}
    print("sanity", json.dumps(sanity), flush=True)

    json.dump({"position": POS, "layers": layers, "excluded_dbs": excl, "n_train": int(keep.sum()),
               "formula": "z = b0 + sum_i w_i * (h_i - mu_i) on hs_mean_gen[layer]; p = sigmoid(platt.a * z + platt.b)",
               "sanity_layer26": sanity}, open(a.out, "w"), separators=(",", ":"))
    print("wrote", a.out, os.path.getsize(a.out), flush=True)


if __name__ == "__main__":
    main()
