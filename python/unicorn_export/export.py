"""Combine all curves onto a single volume axis and write CSV."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .result import UnicornResult

# Preferred column order; anything not listed is appended afterwards.
DEFAULT_ORDER = [
    "UV 1_280", "Cond", "Conc B", "UV 3_214", "pH",
    "System pressure", "PreC pressure", "DeltaC pressure", "PostC pressure",
    "System flow", "System linear flow", "System flow (CV/h)",
    "% Cond", "Cond temp",
    "Sample pressure", "Sample flow", "Sample linear flow", "Sample flow (CV/h)",
    "UV cell path length", "UV 2_0", "Ratio UV2/UV1", "Counted Volume",
]

# Set-point style signals: hold the last value instead of interpolating.
STEP_CURVES = {
    "Conc B", "System flow", "System linear flow", "System flow (CV/h)",
    "Sample flow", "Sample linear flow", "Sample flow (CV/h)", "UV cell path length",
}

ALIASES = {"UV 1_280": "A280", "UV 3_214": "A214", "UV 2_0": "UV2 (off)"}


def _column_name(curve, curves_by_number) -> str:
    name = ALIASES.get(curve.name, curve.name)
    if curve.derived_from is not None:
        src = curves_by_number.get(curve.derived_from)
        src_name = ALIASES.get(src.name, src.name) if src else f"curve {curve.derived_from}"
        op = (curve.derived_operation or "derived").lower()
        name = f"{src_name} {op} (evaluation)"
    if curve.unit and curve.unit.lower() != "ratio" and not name.endswith(f"({curve.unit})"):
        name = f"{name} ({curve.unit})"
    return name


def resample(x, xp, fp, step=False):
    """Map (xp, fp) onto x. Linear or zero-order hold; NaN outside the recorded range."""
    if step:
        idx = np.searchsorted(xp, x, side="right") - 1
        y = fp[np.clip(idx, 0, len(fp) - 1)].astype(float)
    else:
        y = np.interp(x, xp, fp)
    y[(x < xp[0]) | (x > xp[-1])] = np.nan
    return y


def to_dataframe(result: UnicornResult, axis_curve: str = "UV 1_280", order=None,
                 chrom=None, include_time: bool = False) -> pd.DataFrame:
    curves = result.curves(chrom)
    by_number = {c.number: c for c in curves.values()}
    if axis_curve not in curves:
        axis_curve = max(curves.values(), key=len).name
    x = curves[axis_curve].volume
    order = list(order or DEFAULT_ORDER)
    names = [n for n in order if n in curves] + [n for n in curves if n not in order]

    df = pd.DataFrame({"Volume (ml)": np.round(x, 4)})
    if include_time and curves[axis_curve].time is not None:
        df["Time (min)"] = np.round(curves[axis_curve].time, 5)
    for n in names:
        c = curves[n]
        if c.volume is None:
            continue
        if len(c) == len(x) and np.array_equal(c.volume, x):
            y = c.amplitude.copy()
        else:
            y = resample(x, c.volume, c.amplitude, step=n in STEP_CURVES)
        df[_column_name(c, by_number)] = np.round(y, max(c.precision, 3))
    return df


def write_csv(result: UnicornResult, path, **kw) -> pd.DataFrame:
    df = to_dataframe(result, **kw)
    df.to_csv(path, index=False, encoding="utf-8-sig")  # BOM so Excel shows °C correctly
    return df
