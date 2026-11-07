"""Log Altimeter probe runs (gate2, v1) to MLflow, locally or on Databricks.

Reads only files written by scripts/train_probe.py; every logged number comes from them.

Local:      python scripts/log_mlflow.py --store ~/mlruns   (SQLite at ~/mlruns/mlflow.db, artifacts in ~/mlruns/artifacts)
            mlflow ui --backend-store-uri sqlite:///$HOME/mlruns/mlflow.db --port 5001
Databricks: python scripts/log_mlflow.py --databricks --env-file /mnt/c/Users/Jzgam/databricks.env
            (env file holds DATABRICKS_HOST=... and DATABRICKS_TOKEN=...; the token is never printed)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path

import mlflow
from mlflow.tracking import MlflowClient

EXPERIMENT = "altimeter-confidence"
MODEL = "Qwen2.5-Coder-3B-Instruct"
QUANT = "bitsandbytes 4-bit NF4, compute bfloat16"
SUBSETS = {
    "BIRD (headline; not used for selection)": "bird",
    "Spider (selection set, optimistic)": "spider",
    "BIRD, executable SQL only": "bird_exec",
    "pooled": "pooled",
}
CI_SUBSETS = {"bird", "spider"}
LOG_SUBSET = re.compile(r"^== (.+): n=(\d+), correct=([\d.]+), dbs=(\d+)")


def metric_key(name: str) -> str:
    """'probe[mean_gen@26]' -> 'probe'; 'prompt_only_probe[last_prompt@34]' -> 'prompt_only_probe'.
    The layer/position goes in params so the key is stable across runs."""
    return re.sub(r"[^A-Za-z0-9_./ -]", "_", name.split("[")[0])


def read_env_file(path: str) -> None:
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(f"env file not found: {p}")
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().removeprefix("export ").strip()
        os.environ[k] = v.strip().strip('"').strip("'")


def plot_reliability(rel: list[dict], ece: float, title: str, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(5.2, 5.2), dpi=150)
    ax.plot([0, 1], [0, 1], color="#9a9a94", lw=1, ls="--", label="perfect calibration")
    xs = [b["mean_pred"] for b in rel if b["n"] > 0]
    ys = [b["frac_correct"] for b in rel if b["n"] > 0]
    ax.plot(xs, ys, color="#2a78d6", lw=2, marker="o", ms=6, label="stacked score (OOF)")
    for b in rel:
        if b["n"] > 0:
            ax.annotate(f"n={b['n']}", (b["mean_pred"], b["frac_correct"]), textcoords="offset points",
                        xytext=(6, -10), fontsize=7, color="#555550")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Mean predicted P(correct) in bin")
    ax.set_ylabel("Fraction of SQL actually correct")
    ax.set_title(f"{title}: reliability, ECE = {ece:.3f}", fontsize=10)
    ax.grid(color="#e6e5e0", lw=0.6)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.legend(frameon=False, fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def plot_sweep(sweep: dict, selected: tuple[str, int], select_on: str, title: str, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    by_pos: dict[str, list[tuple[int, float]]] = {}
    for k, v in sweep.items():
        pos, layer = k.split("@")
        by_pos.setdefault(pos, []).append((int(layer), v))
    colors = ["#2a78d6", "#eb6834", "#1baf7a"]
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=150)
    ax.axhline(0.5, color="#9a9a94", lw=1, ls="--")
    ends = []
    for c, (pos, pts) in zip(colors, sorted(by_pos.items())):
        pts.sort()
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=c, lw=2, marker="o", ms=4)
        ends.append([pts[-1][1], pts[-1][0], pos])
    ends.sort()
    for i in range(1, len(ends)):  # keep end labels at least 0.012 apart so they never overlap
        ends[i][0] = max(ends[i][0], ends[i - 1][0] + 0.012)
    for y, x, pos in ends:
        ax.annotate(pos, (x, y), textcoords="offset points", xytext=(6, 0), fontsize=8,
                    color="#333330", va="center")
    sp, sl = selected
    sv = sweep.get(f"{sp}@{sl}")
    if sv is not None:
        ax.plot([sl], [sv], marker="o", ms=11, mfc="none", mec="#1a1a19", mew=1.5)
        ax.annotate(f"selected {sp}@{sl}: {sv:.3f}", (sl, sv), textcoords="offset points",
                    xytext=(0, 11), fontsize=8, ha="center", va="bottom")
        lo, hi = ax.get_ylim()
        ax.set_ylim(lo, max(hi, sv + 0.04))
    ax.set_xlabel("Layer")
    ax.set_ylabel(f"OOF AUROC on {select_on} (schema-disjoint CV)")
    ax.set_title(f"{title}: probe AUROC by layer and token position", fontsize=10)
    ax.grid(color="#e6e5e0", lw=0.6)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.set_xlim(right=max(int(k.split("@")[1]) for k in sweep) + 5)
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def parse_log(path: Path) -> dict[str, dict]:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(errors="replace").splitlines():
        m = LOG_SUBSET.match(line)
        if m and m.group(1) in SUBSETS:
            out[SUBSETS[m.group(1)]] = {"n": int(m.group(2)), "acc": float(m.group(3)), "n_dbs": int(m.group(4))}
    return out


def log_run(name: str, run_dir: Path, stem: str, client: MlflowClient, exp_id: str) -> str:
    res = json.loads((run_dir / f"{stem}_results.json").read_text())
    probe_path = run_dir / f"{stem}.json"
    probe = json.loads(probe_path.read_text()) if probe_path.exists() else {}
    log_path = run_dir / f"{stem}.log"
    sub_stats = parse_log(log_path)

    for r in client.search_runs([exp_id], f"tags.mlflow.runName = '{name}'"):
        client.delete_run(r.info.run_id)  # re-running replaces, never duplicates

    sel_pos, sel_layer = res["selected"]
    prompt_key = next((k for k in res["results"]["pooled"] if k.startswith("prompt_only_probe[")), "")
    params = {
        "model": MODEL,
        "quantization": QUANT,
        "n_questions": res["n"],
        "n_dbs": res["n_dbs"],
        "selected_position": sel_pos,
        "selected_layer": sel_layer,
        "select_on": res["select_on"],
        "cv_scheme": "GroupKFold by db_id (k=min(5, n_dbs)), schema-disjoint, all scores out-of-fold",
        "ci_method": "bootstrap resampled by database (500 for AUROC, 1000 paired for deltas)",
        "probe_pipeline": "StandardScaler -> PCA(256) -> LogisticRegression(L2, C=0.1)",
        "stacker": "StandardScaler -> LogisticRegression over probe + SQL-aware features",
        "label": "execution match vs gold on SQLite (set equality, floats 4 dp, 10 s timeout = wrong)",
        "data": "BIRD dev + Spider dev (held-out; no train splits)",
        "prompt_only_feature": prompt_key[len("prompt_only_probe["):-1] if prompt_key else "",
    }
    if probe:
        params.update({
            "excluded_dbs_deploy_probe": ",".join(probe.get("excluded_dbs", [])),
            "n_train_deploy_probe": probe.get("n_train"),
            "stack_features": ",".join(probe.get("stack_features", [])),
            "platt_a": probe.get("platt_a"),
            "platt_b": probe.get("platt_b"),
        })

    metrics: dict[str, float] = {"acc": res["acc"], "ece": res["ece"]}
    for subset, short in SUBSETS.items():
        block = res["results"].get(subset)
        if block is None:
            continue
        for k, (pt, lo, hi) in block.items():
            key = f"{short}.{metric_key(k)}"
            metrics[key] = pt
            if short in CI_SUBSETS or k.startswith("delta_"):
                metrics[f"{key}_lo"] = lo
                metrics[f"{key}_hi"] = hi
        for k, v in sub_stats.get(short, {}).items():
            metrics[f"{short}.{k}"] = v

    with mlflow.start_run(experiment_id=exp_id, run_name=name) as run:
        mlflow.set_tags({"run_dir": str(run_dir), "stage": name, "project": "Altimeter (HackRPI 2026)"})
        mlflow.log_params({k: v for k, v in params.items() if v is not None and v != ""})
        mlflow.log_metrics(metrics)
        for k, v in res["sweep"].items():  # stepped: step = layer
            pos, layer = k.split("@")
            mlflow.log_metric(f"sweep.{pos}_auroc", v, step=int(layer))
        for b in res["reliability"]:
            mlflow.log_metric("reliability.frac_correct", b["frac_correct"], step=int(round(b["bin"][0] * 10)))
            mlflow.log_metric("reliability.mean_pred", b["mean_pred"], step=int(round(b["bin"][0] * 10)))

        for f in (f"{stem}_results.json", f"{stem}_results_oof.jsonl", f"{stem}.json", f"{stem}.log"):
            if (run_dir / f).exists():
                mlflow.log_artifact(str(run_dir / f), artifact_path="run_files")
        try:
            with tempfile.TemporaryDirectory() as td:
                rp, sp = Path(td) / "reliability.png", Path(td) / "auroc_by_layer.png"
                plot_reliability(res["reliability"], res["ece"], name, rp)
                plot_sweep(res["sweep"], (sel_pos, sel_layer), res["select_on"], name, sp)
                mlflow.log_artifact(str(rp), artifact_path="plots")
                mlflow.log_artifact(str(sp), artifact_path="plots")
        except ImportError:
            print("matplotlib not available; skipped PNGs")
        return run.info.run_id


def readback(client: MlflowClient, run_id: str) -> None:
    r = client.get_run(run_id)
    arts = [a.path for d in ("run_files", "plots") for a in client.list_artifacts(run_id, d)]
    print(f"\n== {r.info.run_name} ({run_id}): {len(r.data.params)} params, "
          f"{len(r.data.metrics)} metric keys, {len(arts)} artifacts")
    for k in sorted(r.data.metrics):
        print(f"  {k:55s} {r.data.metrics[k]:.4f}")
    hist = client.get_metric_history(run_id, f"sweep.{r.data.params['selected_position']}_auroc")
    print(f"  sweep.{r.data.params['selected_position']}_auroc steps: {len(hist)}")
    print("  artifacts:", ", ".join(arts))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-root", default="~/runs")
    ap.add_argument("--store", default="~/mlruns", help="local store dir (ignored with --databricks)")
    ap.add_argument("--databricks", action="store_true")
    ap.add_argument("--env-file", default="", help="file with DATABRICKS_HOST / DATABRICKS_TOKEN")
    a = ap.parse_args()

    root = Path(a.runs_root).expanduser()
    if a.databricks:
        if a.env_file:
            read_env_file(a.env_file)
        if not (os.environ.get("DATABRICKS_HOST") and os.environ.get("DATABRICKS_TOKEN")):
            raise SystemExit("DATABRICKS_HOST and DATABRICKS_TOKEN must be set (or pass --env-file)")
        mlflow.set_tracking_uri("databricks")
        user = os.environ.get("DATABRICKS_USER")
        if not user:
            from databricks.sdk import WorkspaceClient
            user = WorkspaceClient().current_user.me().user_name
        exp_name = f"/Users/{user}/{EXPERIMENT}"
    else:
        # MLflow 3.x refuses the plain file store; use SQLite metadata + a local artifact dir.
        store = Path(a.store).expanduser().resolve()
        store.mkdir(parents=True, exist_ok=True)
        mlflow.set_tracking_uri(f"sqlite:///{store / 'mlflow.db'}")
        exp_name = EXPERIMENT
        if mlflow.get_experiment_by_name(exp_name) is None:
            MlflowClient().create_experiment(exp_name, artifact_location=(store / "artifacts").as_uri())

    exp = mlflow.set_experiment(exp_name)
    client = MlflowClient()
    print(f"tracking: {'databricks' if a.databricks else mlflow.get_tracking_uri()}  experiment: {exp_name}")
    ids = []
    for name, sub, stem in (("gate2", "g2", "probe_g2"), ("v1", "v1", "probe_v1")):
        if (root / sub / f"{stem}_results.json").exists():
            ids.append(log_run(name, root / sub, stem, client, exp.experiment_id))
        else:
            print(f"missing {root / sub / f'{stem}_results.json'}; skipped {name}")
    for rid in ids:
        readback(client, rid)


if __name__ == "__main__":
    main()
