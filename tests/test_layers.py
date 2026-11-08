"""Per-layer probes (altimeter/layers.py) and the explain() breakdown (altimeter/probe.py), on SYNTHETIC weights.
Run: python tests/test_layers.py"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from altimeter.layers import LayerSource, result_fields  # noqa: E402
from altimeter.probe import SURFACE_NAMES, Probe  # noqa: E402


def close(a: float, b: float, abs: float) -> bool:  # noqa: A002
    return math.isclose(a, b, rel_tol=0.0, abs_tol=abs)

D, NL = 64, 9  # hidden size, num_layers + 1


def synthetic_layers(path: Path, layers=(2, 4, 8), platt_on=(4,), seed=0) -> dict:
    rng = np.random.default_rng(seed)
    d = {"synthetic": True, "position": "mean_gen", "layers": []}
    for L in layers:
        d["layers"].append({"layer": L, "w": rng.normal(0, 0.1, D).tolist(), "mu": rng.normal(0, 1, D).tolist(),
                            "b0": float(rng.normal()), "platt": {"a": 0.5, "b": 0.1} if L in platt_on else None,
                            "bird_oof_auroc": [0.7, 0.65, 0.75]})
    path.write_text(json.dumps(d))
    return d


def test_scores_match_formula(tmp_path: Path) -> None:
    f = tmp_path / "layers.json"
    d = synthetic_layers(f)
    h = np.random.default_rng(1).normal(0, 1, (NL, D)).astype(np.float16)
    out = result_fields(LayerSource(f), {"mean_gen": h})
    assert out["layers_synthetic"] is True
    assert [r["layer"] for r in out["layers"]] == [2, 4, 8]
    for r, spec in zip(out["layers"], d["layers"]):
        z = spec["b0"] + float(np.dot(spec["w"], h[spec["layer"]].astype(np.float64) - np.array(spec["mu"])))
        assert close(r["z"], z, abs=1e-4)
        zz = 0.5 * z + 0.1 if spec["platt"] else z
        assert close(r["p"], 1 / (1 + math.exp(-zz)), abs=1e-4)
        assert r["auroc"] == [0.7, 0.65, 0.75]


def test_missing_file_omits_field(tmp_path: Path) -> None:
    assert result_fields(LayerSource(tmp_path / "nope.json"), {"mean_gen": np.zeros((NL, D))}) == {}
    assert result_fields(None, {"mean_gen": np.zeros((NL, D))}) == {}


def test_real_file_has_no_synthetic_flag(tmp_path: Path) -> None:
    f = tmp_path / "layers.json"
    d = synthetic_layers(f)
    del d["synthetic"]
    f.write_text(json.dumps(d))
    out = result_fields(LayerSource(f), {"mean_gen": np.zeros((NL, D))})
    assert "layers" in out and "layers_synthetic" not in out


def test_shape_mismatch_and_bad_file_do_not_raise(tmp_path: Path) -> None:
    f = tmp_path / "layers.json"
    synthetic_layers(f)
    out = result_fields(LayerSource(f), {"mean_gen": np.zeros((NL, D + 1))})
    assert "layers" not in out and "d=64" in out["layers_error"]
    f.write_text("{not json")
    out = result_fields(LayerSource(f), {"mean_gen": np.zeros((NL, D))})
    assert "layers" not in out and "layers_error" in out


def test_reload_on_change(tmp_path: Path) -> None:
    f = tmp_path / "layers.json"
    synthetic_layers(f, layers=(1,))
    src = LayerSource(f)
    assert [r["layer"] for r in result_fields(src, {"mean_gen": np.zeros((NL, D))})["layers"]] == [1]
    synthetic_layers(f, layers=(3, 5))
    st = f.stat()
    os.utime(f, (st.st_atime, st.st_mtime + 5))
    assert [r["layer"] for r in result_fields(src, {"mean_gen": np.zeros((NL, D))})["layers"]] == [3, 5]


def synthetic_probe(path: Path, seed: int = 0) -> None:
    rng = np.random.default_rng(seed)
    names = ["probe", "logprob_mean", "logprob_min", *SURFACE_NAMES]
    path.write_text(json.dumps({
        "synthetic": True, "position": "mean_gen", "layer": 5, "w": rng.normal(0, 0.1, D).tolist(), "b": -0.3,
        "mu": rng.normal(0, 1, D).tolist(), "b0": 0.2, "platt_a": 0.6, "platt_b": 0.05,
        "stack_features": names, "stack_mean": rng.normal(0, 1, len(names)).tolist(),
        "stack_scale": rng.uniform(0.5, 2, len(names)).tolist(), "stack_w": rng.normal(0, 1, len(names)).tolist(),
        "stack_b": -0.7, "n_train": 123, "excluded_dbs": ["a", "b"]}))


def test_explain_terms_sum_exactly(tmp_path: Path) -> None:
    f = tmp_path / "probe.json"
    synthetic_probe(f)
    p = Probe(str(f))
    h = np.random.default_rng(2).normal(0, 1, (NL, D)).astype(np.float32)
    surf = [80.0, 140.0, 1.0, 1.0, 0.0, 2000.0, 40.0, 1.0]
    ex = p.explain(h, -0.1, -1.2, surf)

    terms = ex["stack_terms"]
    assert [t["name"] for t in terms] == p.stack_features
    groups = {t["group"] for t in terms}
    assert groups == {"Internals", "Token confidence", "Size", "Compiles"}
    logit = ex["stack_intercept"]
    for t in terms:
        assert t["contribution"] == t["weight"] * t["scaled"]
        assert t["scaled"] == (t["value"] - t["mean"]) / t["scale"]
        logit += t["contribution"]
    assert logit == ex["logit"]  # exact: same order, same float ops
    assert close(ex["needle"], p.score(h, -0.1, -1.2, surf).needle, abs=1e-12)
    assert close(sum(g["value"] for g in ex["groups"]) + ex["stack_ref"], ex["logit"], abs=1e-12)

    pt = ex["probe_terms"]
    assert len(pt["dims"]) == 16 and pt["n_rest"] == D - 16
    for t in pt["dims"]:
        assert close(t["contribution"], t["weight"] * (t["activation"] - t["mean"]), abs=1e-12)
    assert close(pt["b0"] + sum(t["contribution"] for t in pt["dims"]) + pt["rest"], pt["z"], abs=1e-9)
    mags = [abs(t["contribution"]) for t in pt["dims"]]
    assert mags == sorted(mags, reverse=True)
    assert ex["dims"][0] == [pt["dims"][0]["dim"], pt["dims"][0]["contribution"]]  # old field kept

    mc = ex["model_card"]
    assert mc["stack_inputs"] == 11 and mc["n_train"] == 123 and mc["excluded_dbs"] == ["a", "b"]
    assert mc["synthetic"] is True and mc["probe_layer"] == 5 and mc["probe_dims"] == D
    assert "PCA 256" in mc["probe"] and "layer 5" in mc["probe"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as d:
                fn(Path(d))
            print("ok", name)
    print("ALL CHECKS PASSED")
