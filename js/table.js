// Put curves on one fixed-step volume axis (no interpolation) and write CSV.

// Preferred column order; anything not listed is appended afterwards in file order.
export const DEFAULT_ORDER = [
  "UV 1_280", "Cond", "Conc B", "UV 3_214", "pH",
  "System pressure", "PreC pressure", "DeltaC pressure", "PostC pressure",
  "System flow", "System linear flow", "System flow (CV/h)",
  "% Cond", "Cond temp",
  "Sample pressure", "Sample flow", "Sample linear flow", "Sample flow (CV/h)",
  "UV cell path length", "UV 2_0", "Ratio UV2/UV1", "Counted Volume",
];

const ALIASES = { "UV 1_280": "A280", "UV 3_214": "A214", "UV 2_0": "UV2 (off)" };

export function orderCurves(curves) {
  const rank = (c) => {
    const i = DEFAULT_ORDER.indexOf(c.name);
    return i === -1 ? DEFAULT_ORDER.length : i;
  };
  return curves
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/** Short display name, e.g. "A280" for "UV 1_280"; derived curves name their source. */
export function shortName(curve, allCurves) {
  let name = ALIASES[curve.name] ?? curve.name;
  if (curve.derivedFrom != null) {
    const src = allCurves.find((c) => c.number === curve.derivedFrom);
    const srcName = src ? ALIASES[src.name] ?? src.name : `curve ${curve.derivedFrom}`;
    name = `${srcName} ${(curve.derivedOperation || "derived").toLowerCase()} (evaluation)`;
  }
  return name;
}

export function columnName(curve, allCurves) {
  const name = shortName(curve, allCurves);
  const unit = curve.unit;
  return unit && unit.toLowerCase() !== "ratio" && !name.endsWith(`(${unit})`) ? `${name} (${unit})` : name;
}

function decimalsOf(step) {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/**
 * For each grid volume, the index of the recorded point nearest to it, or -1 when the grid
 * volume is more than half a step outside the curve's recorded range. Volumes are
 * non-decreasing, so one forward pass is enough.
 */
function nearestIndices(volume, grid, step) {
  const n = volume.length;
  const out = new Int32Array(grid.length).fill(-1);
  if (!n) return out;
  const lo = volume[0] - step / 2;
  const hi = volume[n - 1] + step / 2;
  let j = 0;
  for (let k = 0; k < grid.length; k++) {
    const x = grid[k];
    if (x < lo || x > hi) continue;
    while (j + 1 < n && volume[j + 1] <= x) j++;
    out[k] = j + 1 < n && volume[j + 1] - x < x - volume[j] ? j + 1 : j;
  }
  return out;
}

/**
 * Build a table on a fixed volume step. Each cell holds the recorded value at the point
 * nearest to that volume - values are never interpolated.
 *
 * @returns {{headers: string[], columns: (Float64Array|Array)[], decimals: number[]}}
 */
export function buildTable(result, curves, { step = 0.01, xmin = null, xmax = null,
                                             addTime = false, addCV = false } = {}) {
  const all = result.curves;
  const maxVol = Math.max(...curves.map((c) => c.volume[c.volume.length - 1]));
  const start = Math.max(0, xmin ?? 0);
  const end = Math.min(maxVol, xmax ?? maxVol);
  const kStart = Math.ceil(start / step - 1e-9);
  const kEnd = Math.floor(end / step + 1e-9);
  const grid = new Float64Array(Math.max(0, kEnd - kStart + 1));
  for (let k = 0; k < grid.length; k++) grid[k] = (kStart + k) * step;

  const xDec = decimalsOf(step);
  const headers = ["Volume (ml)"];
  const columns = [grid];
  const decimals = [xDec];

  if (addCV && result.info.ColumnVolume) {
    const cv = result.info.ColumnVolume;
    headers.push("Column volumes (CV)");
    columns.push(grid.map((x) => x / cv));
    decimals.push(Math.max(3, xDec + 1));
  }

  if (addTime) {
    // Time comes from the most finely sampled original curve.
    const timed = all.filter((c) => c.timeStep).sort((a, b) => b.amplitude.length - a.amplitude.length)[0];
    if (timed) {
      const idx = nearestIndices(timed.volume, grid, step);
      headers.push("Time (min)");
      columns.push(Array.from(idx, (i) => (i < 0 ? NaN : timed.timeStart + i * timed.timeStep)));
      decimals.push(4);
    }
  }

  for (const c of orderCurves(curves)) {
    const idx = nearestIndices(c.volume, grid, step);
    headers.push(columnName(c, all));
    columns.push(Array.from(idx, (i) => (i < 0 ? NaN : c.amplitude[i])));
    decimals.push(Math.max(c.precision, 3));
  }
  return { headers, columns, decimals };
}

function fmt(v, d) {
  if (!Number.isFinite(v)) return "";
  const s = String(Number(v.toFixed(d)));
  return s === "-0" ? "0" : s;
}

function csvCell(s) {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text with a UTF-8 BOM so Excel shows units like °C correctly. */
export function toCsv({ headers, columns, decimals }) {
  const rows = [headers.map(csvCell).join(",")];
  const n = columns[0].length;
  for (let i = 0; i < n; i++) {
    const row = new Array(columns.length);
    for (let j = 0; j < columns.length; j++) row[j] = fmt(columns[j][i], decimals[j]);
    rows.push(row.join(","));
  }
  return "﻿" + rows.join("\r\n") + "\r\n";
}

/** Run log as CSV: volume, time, text. */
export function runLogCsv(result) {
  const rows = ["Volume (ml),Time (min),Entry"];
  for (const e of result.runLog) rows.push(`${fmt(e.volume, 3)},${fmt(e.time, 3)},${csvCell(e.text)}`);
  return "﻿" + rows.join("\r\n") + "\r\n";
}
