// Edge cases on small hand-written run logs, for behaviour the recorded runs don't cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseSummary, phaseLines } from "../js/summary.js";
import { syntheticRun } from "./helpers.mjs";

const I = (s) => `${s} (Issued) (Processing)`;
const linesOf = (run, name) => phaseLines(phaseSummary(run).phases.find((p) => p.name === name));

test("linear gradient splits volume between A and B", () => {
  const run = syntheticRun([
    [0, I("Phase Gradient")],
    [0, I("Inlet A A1")],
    [0, I("Inlet B B2")],
    [0, I("Gradient 100.0 {%B} 10.00 {ml}")],
  ], { end: 10 });
  const [ph] = phaseSummary(run).phases;
  const v = Object.fromEntries(ph.uses.map((u) => [u.inlet, +u.volume.toFixed(3)]));
  assert.deepEqual(v, { A1: 5, B2: 5 });
  assert.deepEqual(ph.pctB, ["Gradient to 100 %B over 10 ml"]);
});

test("a sample pump wash does not replace the sample inlet", () => {
  const run = syntheticRun([
    [0, I("Phase Load")],
    [0, I("Inlet A A1")],
    [0, I("Sample inlet S2")],
    [0, I("Sample pump wash Buffer")],
    [0, I("Injection valve Direct inject")],
    [0, "The method flow is now calculated based on the sample flow. (System)"],
    [5, "The method flow is now calculated based on the system flow. (System)"],
  ], { end: 6 });
  const { inlets } = phaseSummary(run);
  assert.deepEqual(inlets.map((i) => [i.inlet, +i.total.toFixed(2), i.prime]), [["A1", 1, 0], ["S2", 5, 0]]);
});

test("ignored stops with nothing collected read as no fractionation", () => {
  const run = syntheticRun([
    [0, I("Phase Load")],
    [0, I("Stop fractionation")],
    [0, "Stop fractionation (Ignored)"],
    [1, I("Phase Wash")],
    [1, I("Fractionation Volume 15 ml tubes 1.0 {ml} Next tube")],
    [2, I("Stop fractionation")],
  ], { end: 2, fractions: [{ volume: 1.1, time: 0, text: "1.A.1" }] });
  assert.ok(linesOf(run, "Load").includes("No fractionation"));
  const wash = linesOf(run, "Wash");
  assert.ok(!wash.includes("No fractionation"));
  assert.ok(wash.includes("Fractionation stopped at 2.00 ml (end of phase)"));
});

test("peak fractionation with no peak says no fractions were collected", () => {
  const run = syntheticRun([
    [0, I("Phase Elution")],
    [0, I("Peak fractionation Volume 50 ml tubes 45.0 {ml} Next tube")],
  ], { end: 10 });
  assert.ok(linesOf(run, "Elution").includes("No fractions collected · peak fractionation, up to 45.0 ml per tube, 50 ml tubes"));
});

test("slope peak detection lists slopes as well as levels", () => {
  const run = syntheticRun([
    [0, I("Phase Elution")],
    [0, I("Peak fractionation parameters UV1 (U9-M) Level and slope 0.50 {min} 10.00 {mAU} 20.00 {mAU/min} 8.00 {mAU} 15.00 {mAU/min}")],
  ], { end: 1 });
  assert.ok(linesOf(run, "Elution").includes(
    "Peak detection on UV1 (U9-M), Level and slope mode, start level 10.00 mAU, end level 8.00 mAU, start slope 20.00 mAU/min, end slope 15.00 mAU/min, min peak width 0.50 min"));
});

test("holds that never trigger don't claim a volume", () => {
  const run = syntheticRun([
    [0, I("Phase Load")],
    [0, `${I("Hold until Air sample inlet Equals Air 5.00 {ml}")} (Completed)`],
    [0, `${I("Hold until UV 1 Stable signal 0.03 {min} 5.00 {min}")} (Completed)`],
  ], { end: 5 });
  const lines = linesOf(run, "Load");
  assert.ok(lines.includes("Inject all sample: hold until air at sample inlet, max 5.00 ml; stopped at max volume"));
  assert.ok(lines.includes("Hold until UV 1 Stable signal 0.03 min 5.00 min"));
});

test("runs without sample-flow messages fall back to the Sample flow curve", () => {
  // 60 points at 2 ml/min, 1 s apart: 2 ml of sample while the system volume runs 0-6 ml.
  const n = 60;
  const sampleFlow = {
    name: "Sample flow", timeStep: 1 / 60,
    volume: Float64Array.from({ length: n }, (_, i) => (i * 6) / n),
    amplitude: new Float64Array(n).fill(2),
  };
  const run = syntheticRun([
    [0, I("Phase Load")],
    [0, I("Inlet A A1")],
  ], { end: 6, curves: [sampleFlow] });
  const [ph] = phaseSummary(run).phases;
  const sample = ph.uses.find((u) => u.inlet === "Sample");
  assert.equal(sample.volume.toFixed(2), "2.00");
  assert.equal(ph.uses.find((u) => u.inlet === "A1").volume.toFixed(2), "6.00");
});
