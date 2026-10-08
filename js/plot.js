// Chromatogram renderer on a 2D canvas. Layout is done in logical units (opts.width x
// opts.height) and scaled to the canvas, so the preview and the PNG look identical.
import { shortName } from "./table.js";

const INK = {
  surface: "#ffffff",
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#6f6e69",
  grid: "#e1e0d9",
  axis: "#a9a89f",
};

// Font sizes in logical units (figure is 1200-1600 units wide).
const FS = {
  title: 38, subtitle: 25, legend: 26, panel: 27, tick: 26, axisTitle: 28, phase: 23, fraction: 30,
};

// Categorical slots in fixed order (validated palette). Colour follows the curve, not
// its position in the selection, so ticking another curve never repaints the others.
const SLOT = {
  blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", yellow: "#eda100",
  magenta: "#e87ba4", green: "#008300", violet: "#4a3aa7", red: "#e34948",
};
// A214 and the pressures each get their own colour (outside the eight slots where needed)
// so any combination of pressures can be told apart.
const BY_NAME = {
  "UV 1_280": SLOT.blue, Cond: SLOT.orange, "Conc B": SLOT.aqua, "UV 3_214": "#8b1a1a",
  pH: SLOT.magenta, "System flow": SLOT.yellow,
  "System pressure": SLOT.red, "PreC pressure": SLOT.violet, "DeltaC pressure": SLOT.green,
  "PostC pressure": "#9c6324", "Sample pressure": "#5b6b7a",
};
const BY_TYPE = {
  UV: SLOT.violet, Conduction: SLOT.orange, Pressure: SLOT.red, pH: SLOT.magenta,
  Temperature: SLOT.green,
};

export function curveColor(c) {
  if (BY_NAME[c.name]) return BY_NAME[c.name];
  if (c.derivedFrom != null) return SLOT.green;
  if (BY_TYPE[c.dataType]) return BY_TYPE[c.dataType];
  return /flow/i.test(c.name) ? SLOT.yellow : SLOT.green;
}

const FONT = 'Arial, "Helvetica Neue", Helvetica, sans-serif';
const SKIP_FRACTION_TEXT = new Set(["Waste", "Frac", "Waste(Frac)"]);

function niceTicks(lo, hi, target) {
  const span = hi - lo || 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const mant = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10;
  const step = mant * mag;
  const minor = step / (mant === 2 ? 4 : 5);
  const ticks = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  const minors = [];
  for (let v = Math.ceil(lo / minor - 1e-9) * minor; v <= hi + minor * 1e-9; v += minor) minors.push(v);
  return { ticks, step, minors };
}

function tickLabel(v, step) {
  // As many decimals as the step itself needs (250 -> 0, 2.5 -> 1, 0.25 -> 2).
  let d = 0;
  while (d < 6 && Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) > 1e-6) d++;
  return v.toFixed(d);
}

function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the recorded point nearest to volume x. */
export function nearestIndex(volume, x) {
  const i = lowerBound(volume, x);
  if (i <= 0) return 0;
  if (i >= volume.length) return volume.length - 1;
  return x - volume[i - 1] <= volume[i] - x ? i - 1 : i;
}

/** Data range in [xmin, xmax], padded; headroom is the fraction of the panel kept clear on top. */
function yRange(c, xmin, xmax, headroom) {
  const a = lowerBound(c.volume, xmin);
  const b = lowerBound(c.volume, xmax + 1e-9);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = a; i < b; i++) {
    const v = c.amplitude[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo > 0 && lo < 0.3 * hi) lo = 0; // anchor mostly-positive signals at zero
  if (hi === lo) return [lo - 1, hi + 1];
  const span = hi - lo;
  const bottomPad = lo === 0 ? 0 : span * 0.04;
  const top = hi + span * 0.04;
  return [lo - bottomPad, top + ((top - lo + bottomPad) * headroom) / (1 - headroom)];
}

function drawLine(ctx, c, xmin, xmax, sx, sy) {
  // One min/max envelope per half logical unit keeps dense curves faithful and fast.
  const v = c.volume;
  const a = Math.max(0, lowerBound(v, xmin) - 1);
  const b = Math.min(v.length, lowerBound(v, xmax) + 1);
  ctx.beginPath();
  let col = null;
  let first, last, mn, mx;
  const flush = () => {
    if (col === null) return;
    ctx.lineTo(col, sy(first));
    if (mn !== first && mn !== last) ctx.lineTo(col, sy(mn));
    if (mx !== first && mx !== last) ctx.lineTo(col, sy(mx));
    ctx.lineTo(col, sy(last));
  };
  for (let i = a; i < b; i++) {
    const px = Math.round(sx(v[i]) * 2) / 2;
    const y = c.amplitude[i];
    if (px !== col) {
      flush();
      if (col === null) ctx.moveTo(px, sy(y));
      col = px;
      first = mn = mx = last = y;
    } else {
      last = y;
      if (y < mn) mn = y;
      if (y > mx) mx = y;
    }
  }
  flush();
  ctx.stroke();
}

function font(ctx, size, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function hline(ctx, x0, x1, y) {
  ctx.beginPath();
  ctx.moveTo(x0, Math.round(y) + 0.5);
  ctx.lineTo(x1, Math.round(y) + 0.5);
  ctx.stroke();
}

function vline(ctx, x, y0, y1) {
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, y0);
  ctx.lineTo(Math.round(x) + 0.5, y1);
  ctx.stroke();
}

/**
 * Draw a chromatogram.
 * opts: curves (ordered), layout ('overlay'|'stacked'), xmin, xmax, showPhases,
 *       showFractions, title, subtitle, width, height
 * Returns geometry for hover readouts.
 */
export function drawChromatogram(canvas, result, opts) {
  const { width: W, height: H, curves, xmin, xmax } = opts;
  const ctx = canvas.getContext("2d");
  const scale = canvas.width / W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = INK.surface;
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const all = result.curves;
  const overlay = opts.layout !== "stacked" && curves.length > 1;
  const PAD = 28;

  // ---------------------------------------------------------------- vertical layout
  let top = PAD;
  const titleY = top;
  if (opts.title) top += FS.title + 12;
  const subtitleY = top;
  if (opts.subtitle) top += FS.subtitle + 10;
  top += 18;

  if (!curves.length) {
    font(ctx, FS.axisTitle);
    ctx.fillStyle = INK.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Select at least one curve to plot", W / 2, H / 2);
    return null;
  }

  // Overlay legend, wrapped onto as many rows as needed.
  const legend = [];
  if (overlay) {
    font(ctx, FS.legend);
    let lx = PAD;
    let row = 0;
    for (const c of curves) {
      const label = shortName(c, all);
      const w = 40 + ctx.measureText(label).width;
      if (lx + w > W - PAD && lx > PAD) {
        lx = PAD;
        row++;
      }
      legend.push({ c, label, x: lx, row });
      lx += w + 32;
    }
    top += (row + 1) * (FS.legend + 14) + 4;
  }

  const bottom = H - (FS.tick + 14 + FS.axisTitle + 22);
  const phaseRowH = FS.phase + 6;
  const phaseBand = opts.showPhases && result.phases.length > 1 ? 2 * phaseRowH + 10 : 0;

  const panels = [];
  if (overlay) {
    for (const c of curves) panels.push({ curve: c, y0: top, y1: bottom });
  } else {
    const labelH = FS.panel + 14;
    const gap = 26 + labelH;
    const weights = curves.map((_, i) => (i === 0 ? (curves.length > 4 ? 2 : 3) : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    const avail = bottom - top - labelH - gap * (curves.length - 1);
    let y = top + labelH;
    curves.forEach((c, i) => {
      const h = (avail * weights[i]) / total;
      panels.push({ curve: c, y0: y, y1: y + h });
      y += h + gap;
    });
  }

  // Y scales and tick labels (need only vertical geometry), then measure them for margins.
  font(ctx, FS.tick);
  panels.forEach((p, i) => {
    const plotH = p.y1 - p.y0;
    const withPhases = overlay || i === 0;
    const headroom = withPhases ? Math.min(0.35, phaseBand / plotH) : 0.02;
    const [lo, hi] = yRange(p.curve, xmin, xmax, headroom);
    p.yt = niceTicks(lo, hi, Math.max(3, Math.round(plotH / 60)));
    p.lo = Math.min(lo, p.yt.ticks[0] ?? lo);
    p.hi = hi;
    p.sy = (v) => p.y1 - ((v - p.lo) / (p.hi - p.lo)) * plotH;
    p.labels = p.yt.ticks.filter((t) => t <= p.hi + 1e-9).map((t) => [t, tickLabel(t, p.yt.step)]);
    p.tickW = Math.max(0, ...p.labels.map(([, s]) => ctx.measureText(s).width));
    p.color = curveColor(p.curve);
    p.label = shortName(p.curve, all) + (p.curve.unit && p.curve.unit.toLowerCase() !== "ratio" ? ` (${p.curve.unit})` : "");
  });

  // ---------------------------------------------------------------- horizontal layout
  const TICK = 10;
  let left;
  let right;
  if (overlay) {
    left = PAD + FS.axisTitle + 14 + panels[0].tickW + TICK + 6;
    let used = PAD;
    const widths = panels.slice(1).map((p) => TICK + 6 + p.tickW + 14 + FS.axisTitle + 16);
    used += widths.reduce((s, w) => s + w, 0);
    right = W - used;
    let ax = right;
    panels.forEach((p, i) => {
      if (i === 0) {
        p.ax = left;
        p.side = "left";
      } else {
        p.ax = ax;
        p.side = "right";
        ax += widths[i - 1];
      }
    });
  } else {
    left = PAD + Math.max(...panels.map((p) => p.tickW)) + TICK + 6;
    right = W - PAD - 12;
    panels.forEach((p) => {
      p.ax = left;
      p.side = "left";
    });
  }
  const sx = (x) => left + ((x - xmin) / (xmax - xmin)) * (right - left);
  font(ctx, FS.tick);
  const xLabelW = ctx.measureText(String(Math.round(Math.max(Math.abs(xmin), Math.abs(xmax))))).width;
  const xt = niceTicks(xmin, xmax, Math.max(5, Math.floor((right - left) / (xLabelW + 28))));

  // ---------------------------------------------------------------- header
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (opts.title) {
    font(ctx, FS.title, 600);
    ctx.fillStyle = INK.primary;
    ctx.fillText(opts.title, PAD, titleY, W - 2 * PAD);
  }
  if (opts.subtitle) {
    font(ctx, FS.subtitle);
    ctx.fillStyle = INK.secondary;
    ctx.fillText(opts.subtitle, PAD, subtitleY, W - 2 * PAD);
  }
  if (legend.length) {
    font(ctx, FS.legend);
    ctx.textBaseline = "middle";
    const legendTop = top - (Math.max(...legend.map((l) => l.row)) + 1) * (FS.legend + 14) - 4;
    for (const l of legend) {
      const y = legendTop + l.row * (FS.legend + 14) + FS.legend / 2;
      ctx.strokeStyle = curveColor(l.c);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(l.x, y);
      ctx.lineTo(l.x + 28, y);
      ctx.stroke();
      ctx.fillStyle = INK.secondary;
      ctx.fillText(l.label, l.x + 40, y);
    }
  }

  // ---------------------------------------------------------------- axes, grid, ticks
  panels.forEach((p, i) => {
    const primary = !overlay || i === 0;

    if (primary) {
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      for (const [t] of p.labels) {
        const y = p.sy(t);
        if (y >= p.y0 - 0.5 && y <= p.y1 + 0.5) hline(ctx, left, right, y);
      }
    }

    // Y axis line, in the curve's colour for overlays (the axis-to-curve link).
    ctx.strokeStyle = overlay ? p.color : INK.axis;
    ctx.lineWidth = overlay ? 3 : 1.5;
    vline(ctx, p.ax, p.y0, p.y1);

    // Major and minor y ticks pointing outward.
    const dir = p.side === "left" ? -1 : 1;
    ctx.strokeStyle = overlay ? p.color : INK.axis;
    ctx.lineWidth = 1.5;
    for (const t of p.yt.minors) {
      const y = p.sy(t);
      if (y < p.y0 - 0.5 || y > p.y1 + 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(p.ax, Math.round(y) + 0.5);
      ctx.lineTo(p.ax + dir * TICK * 0.55, Math.round(y) + 0.5);
      ctx.stroke();
    }
    font(ctx, FS.tick);
    ctx.fillStyle = INK.muted;
    ctx.textBaseline = "middle";
    ctx.textAlign = p.side === "left" ? "right" : "left";
    for (const [t, s] of p.labels) {
      const y = p.sy(t);
      if (y < p.y0 - 1 || y > p.y1 + 1) continue;
      ctx.beginPath();
      ctx.moveTo(p.ax, Math.round(y) + 0.5);
      ctx.lineTo(p.ax + dir * TICK, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(s, p.ax + dir * (TICK + 6), y);
    }

    if (overlay) {
      font(ctx, FS.axisTitle);
      ctx.fillStyle = INK.secondary;
      ctx.save();
      const tx = p.side === "left"
        ? PAD + FS.axisTitle / 2
        : p.ax + TICK + 6 + p.tickW + 14 + FS.axisTitle / 2;
      ctx.translate(tx, (p.y0 + p.y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.label, 0, 0, p.y1 - p.y0);
      ctx.restore();
    } else {
      // Panel label: a colour swatch plus the name in ink, above the panel.
      const y = p.y0 - FS.panel / 2 - 10;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + 28, y);
      ctx.stroke();
      font(ctx, FS.panel, 500);
      ctx.fillStyle = INK.primary;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(p.label, left + 40, y);
    }

    if (primary) {
      ctx.strokeStyle = INK.axis;
      ctx.lineWidth = 1.5;
      hline(ctx, left, right, p.y1);
      for (const t of xt.minors) {
        const x = sx(t);
        if (x >= left - 0.5 && x <= right + 0.5) vline(ctx, x, p.y1, p.y1 + TICK * 0.55);
      }
      for (const t of xt.ticks) vline(ctx, sx(t), p.y1, p.y1 + TICK);
    }
  });

  const plotTop = panels[0].y0;
  const plotBottom = panels[panels.length - 1].y1;

  // ---------------------------------------------------------------- phases
  let drawPhaseLabels = null; // drawn after the curves so they stay legible
  if (opts.showPhases && result.phases.length) {
    const phases = result.phases.filter((ph) => ph.name.toLowerCase() !== "method settings");
    ctx.save();
    ctx.strokeStyle = INK.muted;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 6]);
    for (const ph of phases) {
      const x = sx(ph.volume);
      if (x < left + 3 || x > right - 3) continue; // would sit on an axis
      for (const p of overlay ? [panels[0]] : panels) vline(ctx, x, p.y0, p.y1);
    }
    ctx.restore();

    drawPhaseLabels = () => {
      // Labels in up to two rows. The top row is used only when the label fits before the next
      // phase line; otherwise it drops to the second row. Skipped if neither row has room.
      font(ctx, FS.phase);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const rowEnd = [-Infinity, -Infinity];
      phases.forEach((ph, i) => {
        const next = phases[i + 1]?.volume ?? Infinity;
        if (next <= xmin || ph.volume >= xmax) return;
        const x = Math.max(sx(ph.volume), left) + 8;
        const w = ctx.measureText(ph.name).width;
        const nextX = next < xmax ? sx(next) : right;
        const row = [0, 1].find((r) => x > rowEnd[r] + 12 && (r === 1 || x + w < nextX - 6));
        if (row === undefined || x + w > right) return;
        const y = plotTop + 8 + row * phaseRowH;
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)"; // keeps lines from striking through the text
        ctx.fillRect(x - 4, y - 2, w + 8, FS.phase + 4);
        ctx.fillStyle = INK.secondary;
        ctx.fillText(ph.name, x, y);
        rowEnd[row] = x + w;
      });
    };
  }

  // ---------------------------------------------------------------- curves
  panels.forEach((p) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, p.y0 - 2, right - left, p.y1 - p.y0 + 4);
    ctx.clip();
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 2.5;
    drawLine(ctx, p.curve, xmin, xmax, sx, p.sy);
    ctx.restore();
  });
  drawPhaseLabels?.();

  // ---------------------------------------------------------------- fractions
  if (opts.showFractions) {
    const p = panels[0];
    const fr = result.fractions.filter((e) => !SKIP_FRACTION_TEXT.has(e.text) && e.volume >= xmin && e.volume <= xmax);
    ctx.strokeStyle = INK.secondary;
    ctx.lineWidth = 2;
    font(ctx, FS.fraction);
    ctx.fillStyle = INK.secondary;
    let lastLabel = -Infinity;
    for (const e of fr) {
      const x = sx(e.volume);
      vline(ctx, x, p.y1 - 22, p.y1);
      // Rotated labels need about a cap height of room; closer than that, keep the tick only.
      if (x - lastLabel < FS.fraction * 0.8 + 4) continue;
      ctx.save();
      ctx.translate(x + 5, p.y1 - 6);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      lastLabel = x;
    }
  }

  // ---------------------------------------------------------------- x axis labels
  font(ctx, FS.tick);
  ctx.fillStyle = INK.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of xt.ticks) ctx.fillText(tickLabel(t, xt.step), sx(t), plotBottom + TICK + 6);
  font(ctx, FS.axisTitle);
  ctx.fillStyle = INK.secondary;
  ctx.fillText("Volume (ml)", (left + right) / 2, plotBottom + TICK + 6 + FS.tick + 10);

  return { panels, left, right, top: plotTop, bottom: plotBottom, xmin, xmax, scale };
}
