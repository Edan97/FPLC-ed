// Lab-book style method summary: which inlets were used, and what each phase drew from them.
// Built from the run log (inlet and gradient set-points) plus the Sample flow curve.

const SKIP_FRACTION_TEXT = new Set(["Waste", "Frac", "Waste(Frac)"]);

// Run log instructions worth noting under a phase (inlets are reported separately as volumes).
const NOTE_PATTERNS = [
  /^Wavelength\b/, /^Injection valve\b/, /^Column position\b/, /^pH valve\b/, /^Outlet valve\b/,
  /^Inject\b/, /^Message\b/, /^Fractionation\b/, /^Pause\b/,
];

// Fractionation stop instructions; UNICORN logs them as (Ignored) when nothing was being collected.
const STOP_FRAC = /^Stop (?:peak )?frac(?:tionation| in outlet valve)\b/;

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
  const changes = []; // {volume, A, B, sample, valve, basis, grad}
  // basis: which pump the run's volume axis follows ("system", or "sample" while the sample pump loads).
  const state = {
    A: null, B: null, sample: null, valve: null, basis: "system",
    grad: { v0: 0, from: 0, to: 0, len: 0 }, flow: null,
  };
  const pumpDrivesVolume = result.runLog.some((e) => /calculated based on the sample flow/.test(e.text));
  let current = null;
  for (const e of result.runLog) {
    const ins = instruction(e.text);
    let m;
    if (!ins) {
      // System messages and outcomes that aren't issued instructions.
      if ((m = e.text.match(/^The method flow is now calculated based on the (sample|system) flow/))) {
        state.basis = m[1];
        changes.push({ volume: e.volume, ...state });
      } else if (!current) {
        // nothing to attach the rest to yet
      } else if ((m = e.text.match(/^(.+?) \(Ignored\)/)) && STOP_FRAC.test(m[1])) {
        const k = current.stops.findLastIndex((s) => s.text === m[1]);
        if (k !== -1) current.stops.splice(k, 1);
      } else if (/^Hold until Condition Occurred .*\(Processing\) \(System\)/.test(e.text)) {
        const hold = current.holds.at(-1);
        if (hold && hold.met == null) hold.met = e.volume;
      } else if (/^Peak start \(System\)/.test(e.text)) {
        current.peaks.push({ start: e.volume, end: null });
      } else if (/^Peak end \(System\)/.test(e.text)) {
        const peak = current.peaks.at(-1);
        if (peak && peak.end == null) peak.end = e.volume;
      }
      continue;
    }
    if (ins.startsWith("Phase ")) {
      current = {
        name: ins.slice(6).trim(), start: e.volume, startTime: e.time,
        flows: [], sampleFlows: [], pctB: [], notes: [], washes: [],
        holds: [], peaks: [], stops: [], stopIssued: false, pumpWashes: [], injectAt: null, systemOff: false,
      };
      phases.push(current);
      continue;
    }
    if (!current) continue;
    if ((m = ins.match(/^Inlet ([AB]) (\S+)/))) {
      state[m[1]] = m[2];
      changes.push({ volume: e.volume, ...state });
    } else if ((m = ins.match(/^Sample (?:inlet|valve) (\S+)/))) {
      state.sample = m[1];
      changes.push({ volume: e.volume, ...state });
    } else if ((m = ins.match(/^Sample pump wash (.+)/))) {
      current.pumpWashes.push({ text: clean(m[1]), volume: e.volume });
    } else if ((m = ins.match(/^Sample flow ([\d.]+) \{([^}]*)\}/))) {
      const text = `${m[1]} ${m[2]}`;
      if (parseFloat(m[1]) > 0 && !current.sampleFlows.includes(text)) current.sampleFlows.push(text);
    } else if ((m = ins.match(/^Injection valve (.+)/))) {
      const pos = clean(m[1]);
      state.valve = pos;
      changes.push({ volume: e.volume, ...state });
      // Priming to waste shows up as an inlet volume; Manual load after a direct inject just resets the valve.
      if (pos === "Direct inject") {
        current.injectAt ??= e.volume;
        current.notes.push("Injection valve Direct inject (sample pump onto column)");
      } else if (!(pos === "Sample pump waste" || (pos === "Manual load" && current.injectAt != null))) {
        const text = clean(ins);
        if (!current.notes.includes(text)) current.notes.push(text);
      }
    } else if ((m = ins.match(/^Hold until (.+)/))) {
      current.holds.push({ text: clean(m[1]), met: null, at: e.volume });
    } else if ((m = ins.match(/^Peak fractionation parameters (.+?) (Level|Slope|Level and slope|Level or slope) ([\d.]+) \{min\} ([\d.]+) \{([^}]*)\} ([\d.]+) \{([^}]*)\} ([\d.]+) \{([^}]*)\} ([\d.]+) \{([^}]*)\}/))) {
      const [, source, mode, width, startLvl, lvlUnit, startSlope, slopeUnit, endLvl, , endSlope] = m;
      const parts = [`Peak detection on ${source}, ${mode} mode`, `start level ${startLvl} ${lvlUnit}`, `end level ${endLvl} ${lvlUnit}`];
      if (/slope/i.test(mode)) parts.push(`start slope ${startSlope} ${slopeUnit}`, `end slope ${endSlope} ${slopeUnit}`);
      parts.push(`min peak width ${width} min`);
      current.notes.push(parts.join(", "));
    } else if (/^Peak fractionation parameters\b/.test(ins)) {
      current.notes.push(clean(ins));
    } else if (STOP_FRAC.test(ins)) {
      current.stopIssued = true;
      current.stops.push({ text: ins, volume: e.volume });
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
      if (parseFloat(m[1]) === 0) current.systemOff = true;
      else if (!current.flows.includes(text)) current.flows.push(text);
    } else if ((m = ins.match(/^Fractionation Volume (.+?) tubes ([\d.]+) \{ml\}/))) {
      current.fracSize = `${m[2]} ml each, ${m[1]} tubes`;
    } else if ((m = ins.match(/^Peak fractionation Volume (.+?) tubes ([\d.]+) \{ml\}/))) {
      current.fracSize = `peak fractionation, up to ${m[2]} ml per tube, ${m[1]} tubes`;
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
    let s = { A: null, B: null, sample: null, valve: null, basis: "system", grad: { v0: 0, from: 0, to: 0, len: 0 } };
    for (const c of changes) {
      if (c.volume > v) break;
      s = c;
    }
    return s;
  };
  /**
   * [{inlet, volume, prime}] drawn while the run volume went from a to b. While the sample pump
   * drives the volume axis, the volume is sample (to waste when the injection valve says so, which
   * is priming) and the system pump draws nothing.
   */
  const usesBetween = (a, b, minVolume) => {
    const bounds = [a, ...changes.map((c) => c.volume).filter((v) => v > a && v < b), b];
    const uses = new Map();
    const add = (inlet, vol, prime = 0) => {
      if (!inlet || !(vol > 0)) return;
      const u = uses.get(inlet) || { volume: 0, prime: 0 };
      u.volume += vol;
      u.prime += prime;
      uses.set(inlet, u);
    };
    for (let k = 0; k + 1 < bounds.length; k++) {
      const [s0, s1] = [bounds[k], bounds[k + 1]];
      const s = stateAt(s0);
      if (s.basis === "sample") {
        add(s.sample || "Sample", s1 - s0, s.valve === "Sample pump waste" ? s1 - s0 : 0);
        continue;
      }
      const bVol = volumeB(s.grad, s0, s1);
      add(s.A, s1 - s0 - bVol);
      add(s.B, bVol);
    }
    if (!pumpDrivesVolume) {
      const sVol = sampleVolume(sampleFlow, a, b);
      if (sVol > 0) add(stateAt(a).sample || "Sample", sVol);
    }
    return [...uses].filter(([, u]) => u.volume >= minVolume).map(([inlet, u]) => ({ inlet, ...u }));
  };

  phases.forEach((ph, i) => {
    ph.end = phases[i + 1]?.start ?? end;
    ph.endTime = phases[i + 1]?.startTime ?? endTime;
    ph.volume = ph.end - ph.start;
    ph.cv = cv ? ph.volume / cv : null;
    ph.uses = usesBetween(ph.start, ph.end, 0.1);

    const fr = result.fractions.filter((f) => !SKIP_FRACTION_TEXT.has(f.text) && f.volume >= ph.start && f.volume < ph.end);
    ph.fractions = fr.length ? { first: fr[0].text, last: fr[fr.length - 1].text, count: fr.length } : null;

    // Notes that need the whole phase (outcomes logged later, or the phase end).
    for (const h of ph.holds) {
      const air = h.text.match(/^Air sample inlet Equals Air ([\d.]+) (\S+)/);
      if (air) {
        const met = h.met != null ? `; air detected at ${ml(h.met)}` : `; stopped at max volume`;
        ph.notes.push(`Inject all sample: hold until air at sample inlet, max ${air[1]} ${air[2]}${met}`);
      } else {
        ph.notes.push(`Hold until ${h.text}${h.met != null ? ` (met at ${ml(h.met)})` : ""}`);
      }
    }
    if (ph.pumpWashes.length) {
      const when = ph.injectAt == null ? []
        : [ph.pumpWashes.some((w) => w.volume <= ph.injectAt) && "before", ph.pumpWashes.some((w) => w.volume > ph.injectAt) && "after"].filter(Boolean);
      const what = [...new Set(ph.pumpWashes.map((w) => w.text))].join(", ");
      ph.notes.push(`Sample pump wash with ${what}${when.length ? ` ${when.join(" and ")} loading` : ""}`);
    }
    for (const p of ph.peaks) {
      ph.notes.push(`Peak collected ${p.start.toFixed(2)}–${(p.end ?? ph.end).toFixed(2)} ml`);
    }
    for (const s of ph.stops) {
      const what = /peak/.test(s.text) ? "Peak fractionation" : "Fractionation";
      ph.notes.push(`${what} stopped at ${ml(s.volume)}${ph.end - s.volume < 0.2 ? " (end of phase)" : ""}`);
    }
    if (ph.stopIssued && !ph.stops.length && !ph.fractions && !ph.fracSize) ph.notes.push("No fractionation");
  });

  // Inlets across the run, in A, B, sample order, with total volume drawn.
  const totals = new Map();
  const primes = new Map();
  for (const ph of phases) {
    for (const u of ph.uses) {
      totals.set(u.inlet, (totals.get(u.inlet) || 0) + u.volume);
      if (u.prime) primes.set(u.inlet, (primes.get(u.inlet) || 0) + u.prime);
    }
    for (const w of ph.washes) {
      for (const inlet of [w.A, w.B]) if (inlet && !totals.has(inlet)) totals.set(inlet, 0);
    }
  }
  const washed = new Set(phases.flatMap((ph) => ph.washes.flatMap((w) => [w.A, w.B])));
  const rank = (n) => (/^A/.test(n) ? 0 : /^B/.test(n) ? 1 : 2);
  const inlets = [...totals]
    .map(([inlet, total]) => ({ inlet, total, prime: primes.get(inlet) || 0, washed: washed.has(inlet) }))
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

/** " (1.07 ml primed to waste, 11.12 ml injected)" for sample inlets that were primed. */
const primeText = (u) => (u.prime >= 0.005 ? ` (${ml(u.prime)} primed to waste, ${ml(u.volume - u.prime)} injected)` : "");

/** Lines describing one phase (without the header), using buffer names where given. */
export function phaseLines(ph, buffers = {}) {
  const name = (inlet) => (buffers[inlet] ? `${inlet} (${buffers[inlet]})` : inlet);
  const lines = [];
  for (const u of ph.uses) lines.push(`${name(u.inlet)}: ${ml(u.volume)}${primeText(u)}`);
  for (const w of ph.washes) {
    const via = [w.A, w.B].filter(Boolean).map(name).join(" / ");
    lines.push(`System wash ${w.text}${via ? ` using ${via}` : ""}`);
  }
  // While the sample pump loads, the system flow is off; its set-point at the phase end isn't news.
  const flows = ph.sampleFlows.length && ph.systemOff
    ? ph.sampleFlows.map((f) => `Sample flow ${f} (system flow off while loading)`)
    : [...(ph.systemOff ? ["System flow off"] : []), ...ph.flows.map((f) => `Flow ${f}`), ...ph.sampleFlows.map((f) => `Sample flow ${f}`)];
  const run = [...flows, ...ph.pctB].join(" · ");
  if (run) lines.push(run);
  if (ph.fractions) {
    const f = ph.fractions;
    lines.push(`Fractions ${f.first}${f.count > 1 ? ` – ${f.last}` : ""} (${f.count})${ph.fracSize ? ` · ${ph.fracSize}` : ""}`);
  } else if (ph.fracSize) {
    lines.push(`No fractions collected · ${ph.fracSize}`);
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
  const vol = i.prime >= 0.005 ? `${ml(i.total - i.prime)} injected + ${ml(i.prime)} prime`
    : i.total > 0 ? `${ml(i.total)}${i.washed ? " + system wash" : ""}` : "system wash only";
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
