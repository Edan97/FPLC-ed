"""Simple publication-style chromatogram plot."""
from __future__ import annotations

import matplotlib
import matplotlib.pyplot as plt

from .result import UnicornResult

SKIP_FRACTION_TEXT = {"Waste", "Frac", "Waste(Frac)"}


def plot_chromatogram(result: UnicornResult, curve: str = "UV 1_280", path=None,
                      title: str | None = None, ylabel: str | None = None,
                      show_fractions: bool = True, show_phases: bool = True,
                      xlim=None, ylim=None, color="#1f4e9c", figsize=(10, 5), dpi=200):
    curves = result.curves()
    c = curves[curve]
    fig, ax = plt.subplots(figsize=figsize)
    ax.plot(c.volume, c.amplitude, color=color, lw=1.3)
    ax.set_xlim(xlim or (0, float(c.volume[-1])))
    if ylim:
        ax.set_ylim(ylim)
    else:
        span = c.amplitude.max() - min(c.amplitude.min(), 0)
        ax.set_ylim(min(c.amplitude.min(), 0) - 0.035 * span, c.amplitude.max() + 0.1 * span)
    y0, y1 = ax.get_ylim()
    xspan = ax.get_xlim()[1] - ax.get_xlim()[0]

    if show_phases:
        for x, name in result.phases():
            if name.lower() == "method settings":
                continue
            ax.axvline(x, color="grey", lw=0.6, ls="--")
            ax.text(x + 0.006 * xspan, y1 - 0.03 * (y1 - y0), name, fontsize=8, color="grey", va="top")

    if show_fractions:
        fr = [e for e in result.fractions() if e.text not in SKIP_FRACTION_TEXT]
        for i, e in enumerate(fr):
            ax.axvline(e.volume, ymin=0, ymax=0.04, color="#c0392b", lw=0.8)
            # Label goes right of its tick, unless the next tick is too close:
            # then it goes left so labels keep the same order as the ticks.
            crowded = i + 1 < len(fr) and fr[i + 1].volume - e.volume < 0.015 * xspan
            dx = -0.016 * xspan if crowded else 0.004 * xspan
            ax.text(e.volume + dx, y0 + 0.01 * (y1 - y0), e.text, fontsize=7, color="#c0392b",
                    rotation=90, va="bottom")

    ax.set_xlabel("Volume (ml)")
    label = {"UV 1_280": "A280", "UV 3_214": "A214"}.get(curve, curve)
    ax.set_ylabel(ylabel or (f"{label} ({c.unit})" if c.unit else label))
    ax.set_title(title or result.info().get("Name", result.path.stem), fontsize=11)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    if path:
        fig.savefig(path, dpi=dpi)
    return fig, ax
