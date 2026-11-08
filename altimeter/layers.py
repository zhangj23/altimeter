"""Per-layer probe scores: one linear probe per layer, exported by the 3060 as probe_layers.json.

File shape: {"position": "mean_gen", "synthetic"?: bool,
             "layers": [{"layer": L, "w": [d], "mu": [d], "b0": float, "platt": {"a","b"} | null,
                         "bird_oof_auroc": [pt, lo, hi]}, ...]}
Per layer: z = b0 + sum_i w_i (h_i - mu_i) on hidden[L] (hidden is (num_layers + 1, d); index 0 = embeddings),
p = sigmoid(a * z + b) with Platt, else sigmoid(z).

ALTIMETER_LAYERS_PATH overrides the default ~/models/probe_layers.json. The file is re-read when its mtime
changes, so a new export is picked up without restarting the worker. Missing file -> no scores.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_PATH = "~/models/probe_layers.json"


def layers_path() -> Path:
    return Path(os.environ.get("ALTIMETER_LAYERS_PATH", DEFAULT_PATH)).expanduser()


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(z, 60.0), -60.0)))


def _platt(d: Any) -> tuple[float, float] | None:
    """Accepts {"a","b"}, {"platt_a","platt_b"} or {"coef","intercept"}; anything else -> no Platt."""
    if not isinstance(d, dict):
        return None
    for ka, kb in (("a", "b"), ("platt_a", "platt_b"), ("coef", "intercept")):
        if ka in d and kb in d:
            a, b = d[ka], d[kb]
            a = a[0] if isinstance(a, list) else a
            b = b[0] if isinstance(b, list) else b
            return float(a), float(b)
    return None


class LayerProbes:
    def __init__(self, data: dict[str, Any]) -> None:
        self.position: str = data.get("position", "mean_gen")
        self.synthetic = bool(data.get("synthetic", False))
        rows = sorted(data["layers"], key=lambda r: int(r["layer"]))
        if not rows:
            raise ValueError("no layers")
        self.layer_ids = np.array([int(r["layer"]) for r in rows])
        self.W = np.asarray([r["w"] for r in rows], dtype=np.float64)  # (n, d)
        self.MU = np.asarray([r["mu"] for r in rows], dtype=np.float64)  # (n, d)
        if self.W.ndim != 2 or self.W.shape != self.MU.shape:
            raise ValueError(f"w/mu shapes differ: {self.W.shape} vs {self.MU.shape}")
        self.b0 = np.asarray([float(r["b0"]) for r in rows])
        self.platt = [_platt(r.get("platt")) for r in rows]
        self.auroc = [r.get("bird_oof_auroc") for r in rows]

    @property
    def d(self) -> int:
        return int(self.W.shape[1])

    def score(self, hidden: np.ndarray) -> list[dict[str, Any]]:
        """hidden: (num_layers + 1, d) at self.position. Raises ValueError on a shape mismatch."""
        if hidden.ndim != 2 or hidden.shape[1] != self.d:
            raise ValueError(f"hidden is {tuple(hidden.shape)}, probes expect d={self.d}")
        if int(self.layer_ids.max()) >= hidden.shape[0]:
            raise ValueError(f"layer {int(self.layer_ids.max())} out of range for {hidden.shape[0]} hidden states")
        h = hidden[self.layer_ids].astype(np.float64)
        z = self.b0 + ((h - self.MU) * self.W).sum(axis=1)
        out = []
        for i, layer in enumerate(self.layer_ids):
            zi = float(z[i])
            pl = self.platt[i]
            p = _sigmoid(pl[0] * zi + pl[1]) if pl else _sigmoid(zi)
            au = self.auroc[i]
            out.append({"layer": int(layer), "p": round(p, 4), "z": round(zi, 4),
                        "auroc": [round(float(v), 4) for v in au] if isinstance(au, list) else None})
        return out


class LayerSource:
    """Loads the file lazily and reloads it when its mtime changes. get() never raises."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or layers_path()
        self._mtime: float | None = None
        self.probes: LayerProbes | None = None
        self.error: str | None = None

    def get(self) -> LayerProbes | None:
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            self._mtime, self.probes, self.error = None, None, None
            return None
        if mtime != self._mtime:
            self._mtime = mtime
            try:
                self.probes = LayerProbes(json.load(open(self.path, encoding="utf-8")))
                self.error = None
            except Exception as e:  # noqa: BLE001 - a half-copied or malformed file must not break answers
                self.probes, self.error = None, f"{type(e).__name__}: {e}"
        return self.probes


def result_fields(src: LayerSource | None, hidden_by_position: dict[str, Any]) -> dict[str, Any]:
    """{"layers": [...], "layers_synthetic"?: true} or {} when there is no file. Errors -> {"layers_error": str}."""
    if src is None:
        return {}
    lp = src.get()
    if lp is None:
        return {"layers_error": src.error} if src.error else {}
    hid = hidden_by_position.get(lp.position)
    if hid is None:
        return {"layers_error": f"no hidden states for position {lp.position!r}"}
    try:
        h = hid.float().numpy() if hasattr(hid, "float") else np.asarray(hid)
        out: dict[str, Any] = {"layers": lp.score(h)}
    except Exception as e:  # noqa: BLE001
        return {"layers_error": f"{type(e).__name__}: {e}"}
    if lp.synthetic:
        out["layers_synthetic"] = True
    return out
