// Lab-book style method summary: which inlets were used, and what each phase drew from them.
// Built from the run log (inlet and gradient set-points) plus the Sample flow curve.

const SKIP_FRACTION_TEXT = new Set(["Waste", "Frac", "Waste(Frac)"]);

// Run log instructions worth noting under a phase (inlets are reported separately as volumes).
const NOTE_PATTERNS = [
  /^Wavelength\b/, /^Injection valve\b/, /^Column position\b/, /^pH valve\b/, /^Outlet valve\b/,
  /^Sample\b/, /^Inject\b/, /^Message\b/, /^Fractionation\b/,
  /^Hold\b/, /^Pause\b/,
];

/** "Inlet A A1 (Issued) (Processing)" -> "Inlet A A1"; null for entries that aren't issued instructions. */
function instruction(text) {
  const i = text.indexOf(" (Issued)");
  return i === -1 ? null : text.slice(0, i).trim();
}

const clean = (s) => s.replace(/\{([^}]*)\}/g, "$1").replace(/\s+/g, " ").trim();

/** %B set-point at volume v for a gradient {v0, from, to, len (ml)}. */
function pctAt(g, v) {
  if (!g.len) return g.to;
  return g.from + (g.to - g.from) * Math.min(1, Math.max(0, (v - g.v0) / g.len));
}

/** Volume of B over [a, b]: integral of the %B set-point (linear ramps are exact by midpoint rule). */
function volumeB(g, a, b) {
  const n = g.len ? 64 : 1;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const s0 = a + ((b - a) * k) / n;
    const s1 = a + ((b - a) * (k + 1)) / n;
    sum += (pctAt(g, (s0 + s1) / 2) / 100) * (s1 - s0);
  }
  return sum;
}

/** Sample pump volume delivered while the system volume was in [a, b). */
function sampleVolume(curve, a, b) {
  if (!curve?.timeStep) return 0;
  let sum = 0;
  for (let i = 0; i < curve.volume.length; i++) {
    const v = curve.volume[i];
    if (v >= a && v < b && curve.amplitude[i] > 0) sum += curve.amplitude[i] * curve.timeStep;
  }
  return sum;
}

export function phaseSummary(result) {
  const sampleFlow = result.curves.find((c) => c.name === "Sample flow");
  const end = Math.max(...result.curves.map((c) => c.volume[c.volume.length - 1]));
  const endTime = Math.max(...result.runLog.map((e) => e.time));
  const cv = result.info.ColumnVolume;

  // Walk the run log once: phase boundaries, inlet/%B state changes, notes per phase.
  const phases = [];
  const changes = []; // {volume, A, B, sample, grad}
  const state = { A: null, B: null, sample: null, grad: { v0: 0, from: 0, to: 0, len: 0 }, flow: null };
  let current = null;
  for (const e of result.runLog) {
    const ins = instruction(e.text);
    if (!ins) continue;
    if (ins.startsWith("Phase ")) {
      current = {
        name: ins.slice(6).trim(), start: e.volume, startTime: e.time,
        flows: [], pctB: [], notes: [], washes: [],
      };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    let m;
    if ((m = ins.match(/^Inlet ([AB]) (\S+)/))) {
      state[m[1]] = m[2];
      changes.push({ volume: e.volume, ...state });
    } else if ((m = ins.match(/^Sample (?:inlet|pump|valve)\s+(\S+)/i))) {
      state.sample = m[1];
      changes.push({ volume: e.volume, ...state });
    } else if ((m = ins.match(/^Gradient ([\d.]+) \{%B\} ([\d.]+) \{([^}]*)\}/))) {
      const target = parseFloat(m[1]);
      const length = parseFloat(m[2]);
      const unit = m[3].toLowerCase();
      const len = unit === "cv" ? length * (cv || 0) : unit === "min" ? length * (state.flow || 0) : length;
      state.grad = { v0: e.volume, from: pctAt(state.grad, e.volume), to: target, len };
      changes.push({ volume: e.volume, ...state });
      const text = length > 0 ? `Gradient to ${target} %B over ${length} ${m[3]}` : `${target} %B`;
      if (!current.pctB.includes(text)) current.pctB.push(text);
    } else if ((m = ins.match(/^System flow ([\d.]+) \{([^}]*)\}/))) {
      if (m[2] === "ml/min") state.flow = parseFloat(m[1]);
      const text = `${m[1]} ${m[2]}`;
      if (!current.flows.includes(text)) current.flows.push(text);
    } else if ((m = ins.match(/^Fractionation Volume (.+?) tubes ([\d.]+) \{ml\}/))) {
      current.fracSize = `${m[2]} ml each, ${m[1]} tubes`;
    } else if ((m = ins.match(/^System wash (.*)/))) {
      current.washes.push({ text: clean(m[1]), A: state.A, B: state.B });
    } else if (NOTE_PATTERNS.some((re) => re.test(ins))) {
      const text = clean(ins);
      if (!current.notes.includes(text)) current.notes.push(text);
    }
  }

  // Volume drawn from each inlet per phase: split each stretch of constant inlets into
  // B (integral of Conc B) and A (the rest).
  const stateAt = (v) => {
    let s = { A: null, B: null, sample: null, grad: { v0: 0, from: 0, to: 0, len: 0 } };
    for (const c of changes) {
      if (c.volume > v) break;
      s = c;
    }
    return s;
  };
  /** [{inlet, volume}] drawn while the system volume went from a to b. */
  const usesBetween = (a, b, minVolume) => {
    const bounds = [a, ...changes.map((c) => c.volume).filter((v) => v > a && v < b), b];
    const uses = new Map();
    const add = (inlet, vol) => inlet && vol > 0 && uses.set(inlet, (uses.get(inlet) || 0) + vol);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const [s0, s1] = [bounds[k], bounds[k + 1]];
      const s = stateAt(s0);
      const bVol = volumeB(s.grad, s0, s1);
      add(s.A, s1 - s0 - bVol);
      add(s.B, bVol);
    }
    const sVol = sampleVolume(sampleFlow, a, b);
    if (sVol > 0) add(`Sample${stateAt(a).sample ? " " + stateAt(a).sample : ""}`, sVol);
    return [...uses].filter(([, v]) => v >= minVolume).map(([inlet, volume]) => ({ inlet, volume }));
  };

  phases.forEach((ph, i) => {
    ph.end = phases[i + 1]?.start ?? end;
    ph.endTime = phases[i + 1]?.startTime ?? endTime;
    ph.volume = ph.end - ph.start;
    ph.cv = cv ? ph.volume / cv : null;
    ph.uses = usesBetween(ph.start, ph.end, 0.1);

    const fr = result.fractions.filter((f) => !SKIP_FRACTION_TEXT.has(f.text) && f.volume >= ph.start && f.volume < ph.end);
    ph.fractions = fr.length ? { first: fr[0].text, last: fr[fr.length - 1].text, count: fr.length } : null;
  });

  // Inlets across the run, in A, B, sample order, with total volume drawn.
  const totals = new Map();
  for (const ph of phases) {
    for (const u of ph.uses) totals.set(u.inlet, (totals.get(u.inlet) || 0) + u.volume);
    for (const w of ph.washes) {
      for (const inlet of [w.A, w.B]) if (inlet && !totals.has(inlet)) totals.set(inlet, 0);
    }
  }
  const washed = new Set(phases.flatMap((ph) => ph.washes.flatMap((w) => [w.A, w.B])));
  const rank = (n) => (/^A/.test(n) ? 0 : /^B/.test(n) ? 1 : 2);
  const inlets = [...totals]
    .map(([inlet, total]) => ({ inlet, total, washed: washed.has(inlet) }))
    .sort((a, b) => rank(a.inlet) - rank(b.inlet) || a.inlet.localeCompare(b.inlet, undefined, { numeric: true }));

  // Each collected fraction runs until the next fraction event (including a switch to waste).
  const a280 = result.curves.find((c) => c.name === "UV 1_280");
  const events = result.fractions;
  const fractions = [];
  events.forEach((f, k) => {
    if (SKIP_FRACTION_TEXT.has(f.text)) return;
    const stop = events[k + 1]?.volume ?? end;
    const phase = [...phases].reverse().find((ph) => ph.start <= f.volume);
    const uses = usesBetween(f.volume, stop, 0);
    const total = uses.reduce((sum, u) => sum + u.volume, 0);
    let maxA280 = null;
    if (a280) {
      for (let i = 0; i < a280.volume.length; i++) {
        const v = a280.volume[i];
        if (v >= f.volume && v < stop && (maxA280 === null || a280.amplitude[i] > maxA280)) maxA280 = a280.amplitude[i];
      }
    }
    fractions.push({
      name: f.text, start: f.volume, end: stop, volume: stop - f.volume,
      phase: phase?.name ?? "",
      // Inlet shares, dropping anything under 1% of the fraction.
      mix: uses.filter((u) => total > 0 && u.volume / total >= 0.01)
        .map((u) => ({ inlet: u.inlet, pct: (100 * u.volume) / total })),
      maxA280,
    });
  });

  return { inlets, phases, fractions };
}

const ml = (v) => `${v.toFixed(2)} ml`;

/** Lines describing one phase (without the header), using buffer names where given. */
export function phaseLines(ph, buffers = {}) {
  const name = (inlet) => (buffers[inlet] ? `${inlet} (${buffers[inlet]})` : inlet);
  const lines = [];
  for (const u of ph.uses) lines.push(`${name(u.inlet)}: ${ml(u.volume)}`);
  for (const w of ph.washes) {
    const via = [w.A, w.B].filter(Boolean).map(name).join(" / ");
    lines.push(`System wash ${w.text}${via ? ` using ${via}` : ""}`);
  }
  const run = [...ph.flows.map((f) => `Flow ${f}`), ...ph.pctB].join(" · ");
  if (run) lines.push(run);
  if (ph.fractions) {
    const f = ph.fractions;
    lines.push(`Fractions ${f.first}${f.count > 1 ? ` – ${f.last}` : ""} (${f.count})${ph.fracSize ? ` · ${ph.fracSize}` : ""}`);
  }
  for (const n of ph.notes) lines.push(n);
  return lines;
}

export function phaseHeader(ph) {
  if (ph.volume < 0.05) return ph.name;
  const cv = ph.cv ? `, ${ph.cv.toFixed(1)} CV` : "";
  return `${ph.name}  ·  ${ph.start.toFixed(2)}–${ph.end.toFixed(2)} ml (${ph.volume.toFixed(2)} ml${cv})  ·  ${ph.startTime.toFixed(1)}–${ph.endTime.toFixed(1)} min`;
}

/**
 * One line per inlet: "A1 (100.73 ml + system wash): PBS". The buffer goes last so an
 * unfilled line can be completed after pasting.
 */
export function inletLine(i, buffers = {}) {
  const vol = i.total > 0 ? `${ml(i.total)}${i.washed ? " + system wash" : ""}` : "system wash only";
  return `${i.inlet} (${vol}): ${buffers[i.inlet] || ""}`.trimEnd();
}

/** "A1 (PBS)" or, for a mix, "B1 (Glycine) 95% + A1 (PBS) 5%". */
export function mixText(mix, buffers = {}) {
  const name = (inlet) => (buffers[inlet] ? `${inlet} (${buffers[inlet]})` : inlet);
  if (mix.length === 1) return name(mix[0].inlet);
  return [...mix].sort((a, b) => b.pct - a.pct).map((m) => `${name(m.inlet)} ${Math.round(m.pct)}%`).join(" + ");
}

/** Columns for the fraction table, shared by the page and the text. */
export function fractionRows(summary) {
  return summary.fractions.map((f) => ({
    Fraction: f.name,
    Phase: f.phase,
    "Volume (ml)": `${f.start.toFixed(2)}–${f.end.toFixed(2)}`,
    "Size (ml)": f.volume.toFixed(2),
    Intake: mixText(f.mix),
    "Max A280 (mAU)": f.maxA280 === null ? "" : f.maxA280.toFixed(0),
  }));
}

/** Plain-text lab-book block: inlets, fractions, then each phase. */
export function summaryText(summary, buffers = {}) {
  const lines = ["INLETS USED"];
  for (const i of summary.inlets) lines.push(`  ${inletLine(i, buffers)}`);
  const rows = fractionRows(summary);
  if (rows.length) {
    const cols = Object.keys(rows[0]).filter((c) => rows.some((r) => r[c]));
    const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
    const fmt = (vals) => `  ${vals.map((v, j) => v.padEnd(width[j])).join("   ")}`.trimEnd();
    lines.push("", "FRACTIONS", fmt(cols), ...rows.map((r) => fmt(cols.map((c) => r[c]))));
  }
  lines.push("", "PHASES");
  summary.phases.forEach((ph, n) => {
    lines.push(`${n + 1}. ${phaseHeader(ph)}`);
    for (const l of phaseLines(ph, buffers)) lines.push(`     ${l}`);
    lines.push("");
  });
  return lines;
}
