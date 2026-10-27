// HiPrep 26/10 desalting (DesaltingHiPrep_BufferEx): equilibrate, load with the sample pump
// (prime to waste, direct inject until the air sensor trips), isocratic elution with peak
// fractionation on UV. The method varies run to run (sample inlet, max sample volume).
import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseSummary, summaryText, phaseLines, fractionRows } from "../js/summary.js";
import { loadFixture, matchSnapshot } from "./helpers.mjs";

const runs = {
  "desalt-001": {
    inlet: "S4", injected: "11.11", prime: "1.07", air: "28.45", a1: "96.19",
    peak: "32.83–44.54", stop: "108.34", fraction: "1.A.1", size: "11.70", maxA280: "244",
  },
  "desalt-003": {
    inlet: "S6", injected: "8.04", prime: "1.07", air: "25.38", a1: "96.19",
    peak: "32.67–41.82", stop: "105.27", fraction: "1.A.3", size: "9.15", maxA280: "247",
  },
};

for (const [name, want] of Object.entries(runs)) {
  const summary = phaseSummary(loadFixture(name));
  const phase = (n) => summary.phases.find((p) => p.name === n);
  const lines = (n) => phaseLines(phase(n));

  test(`${name}: lab-book text matches the snapshot`, () => {
    matchSnapshot(name, summaryText(summary).join("\n"));
  });

  test(`${name}: phases`, () => {
    assert.deepEqual(summary.phases.map((p) => p.name), ["Method Settings", "Equilibration", "Sample Application", "Elution"]);
  });

  test(`${name}: sample loading is not counted as buffer A`, () => {
    const inlets = Object.fromEntries(summary.inlets.map((i) => [i.inlet, i]));
    assert.deepEqual(Object.keys(inlets), ["A1", "B1", want.inlet]);
    assert.equal(inlets.A1.total.toFixed(2), want.a1);
    const a1 = phase("Sample Application").uses.find((u) => u.inlet === "A1");
    assert.ok(a1.volume < 0.2, `A1 during sample application should be ~0, got ${a1.volume}`);
  });

  test(`${name}: sample inlet split into prime and injected`, () => {
    const s = summary.inlets.find((i) => i.inlet === want.inlet);
    assert.equal(s.prime.toFixed(2), want.prime);
    assert.equal((s.total - s.prime).toFixed(2), want.injected);
    assert.match(lines("Sample Application")[1], new RegExp(`^${want.inlet}: .*\\(${want.prime} ml primed to waste, ${want.injected} ml injected\\)$`));
  });

  test(`${name}: sample application settings`, () => {
    assert.deepEqual(lines("Sample Application").slice(2), [
      "Sample flow 10.000 ml/min (system flow off while loading)",
      "Injection valve Direct inject (sample pump onto column)",
      `Inject all sample: hold until air at sample inlet, max 12.00 ml; air detected at ${want.air} ml`,
      "Sample pump wash with Buffer before and after loading",
      "No fractionation",
    ]);
  });

  test(`${name}: elution peak fractionation settings`, () => {
    assert.deepEqual(lines("Elution"), [
      "A1: 79.84 ml",
      "Flow 10.000 ml/min · 0 %B",
      `Fractions ${want.fraction} (1) · peak fractionation, up to 45.0 ml per tube, 50 ml tubes`,
      "Peak detection on UV1 (U9-M), Level mode, start level 5.00 mAU, end level 5.00 mAU, min peak width 0.80 min",
      `Peak collected ${want.peak} ml`,
      `Peak fractionation stopped at ${want.stop} ml (end of phase)`,
    ]);
  });

  test(`${name}: equilibration`, () => {
    assert.deepEqual(lines("Equilibration"), [
      "A1: 16.18 ml",
      "System wash 15 ml Injection valve (W1) using A1 / B1",
      "Flow 10.000 ml/min · 0 %B",
      "Hold until UV 1 Stable signal 0.03 min 5.00 min (met at 0.17 ml)",
    ]);
  });

  test(`${name}: fraction table`, () => {
    const [row, ...rest] = fractionRows(summary);
    assert.equal(rest.length, 0);
    assert.equal(row.Fraction, want.fraction);
    assert.equal(row.Phase, "Elution");
    assert.equal(row["Size (ml)"], want.size);
    assert.equal(row.Intake, "A1");
    assert.equal(row["Max A280 (mAU)"], want.maxA280);
  });
}
