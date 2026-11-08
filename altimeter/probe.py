"""Probe features + serving-time scorer. The trained probe is exported as plain linear weights (JSON),
so it can be sent between machines as text and scored without sklearn."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass

import numpy as np

SURFACE_NAMES = ["question_chars", "sql_chars", "n_joins", "n_aggregates", "n_subqueries",
                 "n_prompt", "n_gen", "executes"]


def surface_features(question: str, pred_sql: str, n_prompt: int, n_gen: int, executes: bool) -> list[float]:
    s = (pred_sql or "").upper()
    return [float(len(question)), float(len(s)), float(s.count(" JOIN ")),
            float(len(re.findall(r"\b(SUM|AVG|COUNT|MIN|MAX)\(", s))), float(max(s.count("SELECT") - 1, 0)),
            float(n_prompt), float(n_gen), float(executes)]


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(z, 60.0), -60.0)))


@dataclass
class ProbeScore:
    probe: float        # raw probe probability
    calibrated: float   # Platt-scaled probe probability
    needle: float       # stacked score (probe + log-probs + surface); what the UI shows


class Probe:
    def __init__(self, path: str) -> None:
        d = json.load(open(path, encoding="utf-8"))
        self.position: str = d["position"]
        self.layer: int = d["layer"]
        self.w = np.asarray(d["w"], dtype=np.float32)
        self.b = float(d["b"])
        self.platt = (float(d["platt_a"]), float(d["platt_b"]))
        self.stack_mean = np.asarray(d["stack_mean"])
        self.stack_scale = np.asarray(d["stack_scale"])
        self.stack_w = np.asarray(d["stack_w"])
        self.stack_b = float(d["stack_b"])
        self.meta = {k: d[k] for k in ("n_train", "cv_auroc", "bird_probe_auroc", "excluded_dbs") if k in d}
        # explain() only: centring point for the per-dimension decomposition (absent in older exports)
        self.mu = np.asarray(d["mu"], dtype=np.float64) if "mu" in d else None
        self.b0 = float(d["b0"]) if "b0" in d else None
        self.stack_features: list[str] = list(d.get("stack_features", ["probe", "logprob_mean", "logprob_min",
                                                                       *SURFACE_NAMES]))
        self.extra = {k: d[k] for k in ("layer_auroc", "ece", "track_record", "synthetic") if k in d}
        self.model_card = self._model_card(d)

    def _model_card(self, d: dict) -> dict:
        """Static facts about the exported model, for the UI. The probe recipe text mirrors
        scripts/train_probe.py (probe_pipe + export_linear); everything else is read from the JSON."""
        pos = {"mean_gen": "mean over SQL tokens", "last_gen": "last SQL token",
               "last_prompt": "last prompt token"}.get(self.position, self.position)
        n_in = len(self.stack_features)
        return {
            "stack": f"logistic regression with {n_in} inputs (StandardScaler, then logistic regression)",
            "stack_inputs": n_in,
            "probe": (f"StandardScaler -> PCA 256 -> L2 logistic, collapsed to one linear vector over "
                      f"{self.w.shape[0]:,} activations at layer {self.layer}, {pos}"),
            "probe_layer": self.layer, "probe_position": self.position, "probe_dims": int(self.w.shape[0]),
            "platt": {"a": self.platt[0], "b": self.platt[1]},
            "n_train": d.get("n_train"), "excluded_dbs": d.get("excluded_dbs"),
            "select_on": d.get("select_on"), "synthetic": bool(d.get("synthetic", False)),
        }

    def score(self, hidden: np.ndarray, logprob_mean: float, logprob_min: float, surface: list[float]) -> ProbeScore:
        """hidden: (L+1, d) features at self.position; uses self.layer."""
        p = _sigmoid(float(hidden[self.layer].astype(np.float32) @ self.w) + self.b)
        logit = math.log(p / (1 - p + 1e-9) + 1e-9)
        cal = _sigmoid(self.platt[0] * logit + self.platt[1])
        x = (np.array([p, logprob_mean, logprob_min, *surface]) - self.stack_mean) / self.stack_scale
        needle = _sigmoid(float(x @ self.stack_w) + self.stack_b)
        return ProbeScore(p, cal, needle)

    def explain(self, hidden: np.ndarray, logprob_mean: float, logprob_min: float, surface: list[float],
                top_k: int = 16) -> dict:
        """Exact additive breakdown of score(). Probe: z = b0 + sum_i w_i (h_i - mu_i). Stack: logit = stack_b +
        sum_j stack_w_j x_j, grouped into 4 bars that sum to logit - stack_b. Without mu/b0, mu = 0 and b0 = b."""
        s = self.score(hidden, logprob_mean, logprob_min, surface)
        h = hidden[self.layer].astype(np.float64)
        w = self.w.astype(np.float64)
        centered = self.mu is not None and self.b0 is not None
        mu = self.mu if centered else np.zeros_like(h)
        b0 = self.b0 if centered else self.b
        c = w * (h - mu)
        z = b0 + float(c.sum())
        order = np.argsort(-np.abs(c), kind="stable")
        top = order[:top_k]
        abs_total = float(np.abs(c).sum())
        share20 = float(np.abs(c[order[:20]]).sum() / abs_total) if abs_total > 0 else 0.0

        f = np.array([s.probe, logprob_mean, logprob_min, *surface], dtype=np.float64)
        x = (f - self.stack_mean) / self.stack_scale
        sc = self.stack_w * x
        idx = {n: i for i, n in enumerate(self.stack_features)}
        groups = [{"name": name, "value": float(sum(sc[idx[m]] for m in members)), "members": members}
                  for name, members in STACK_GROUPS]
        group_of = {m: name for name, members in STACK_GROUPS for m in members}
        # One term per stack input, in stack_features order: logit = stack_intercept + sum(contribution), exactly.
        stack_terms = [{"name": n, "group": group_of.get(n, "Other"), "weight": float(self.stack_w[i]),
                        "value": float(f[i]), "mean": float(self.stack_mean[i]), "scale": float(self.stack_scale[i]),
                        "scaled": float(x[i]), "contribution": float(sc[i])}
                       for i, n in enumerate(self.stack_features)]
        logit = self.stack_b
        for t in stack_terms:
            logit += t["contribution"]
        rest = float(c.sum() - c[top].sum())
        probe_terms = {
            "layer": self.layer, "position": self.position, "b0": b0, "z": z, "centered": centered,
            "dims": [{"dim": int(i), "weight": float(w[i]), "activation": float(h[i]), "mean": float(mu[i]),
                      "contribution": float(c[i])} for i in top],
            "rest": rest, "n_rest": int(c.shape[0] - len(top)),
        }
        return {
            "layer": self.layer, "position": self.position, "n_layers": int(hidden.shape[0]) - 1,
            "centered": centered, "b0": b0, "z": z, "p_raw": s.probe, "p_cal": s.calibrated,
            "platt_a": self.platt[0], "platt_b": self.platt[1],
            "dims": [[int(i), float(c[i])] for i in top], "rest": rest,
            "share_top20": share20, "d": int(c.shape[0]),
            "stack_ref": self.stack_b, "groups": groups, "logit": logit, "needle": _sigmoid(logit),
            "features": [{"name": n, "value": float(f[i]), "contrib": float(sc[i])}
                         for i, n in enumerate(self.stack_features)],
            "stack_terms": stack_terms, "stack_intercept": self.stack_b,
            "probe_terms": probe_terms, "model_card": self.model_card,
            **self.extra,
        }


STACK_GROUPS: list[tuple[str, list[str]]] = [
    ("Internals", ["probe"]),
    ("Token confidence", ["logprob_mean", "logprob_min"]),
    ("Size", ["question_chars", "sql_chars", "n_joins", "n_aggregates", "n_subqueries", "n_prompt", "n_gen"]),
    ("Compiles", ["executes"]),
]
