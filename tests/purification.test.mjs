// Protein A affinity purification (HiTrap MabSelect SuRe, 5 ml): column wash, low-pH elution,
// water wash, CIP and re-equilibration, with volume fractionation in wash and elution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseSummary, summaryText, fractionRows, inletLine } from "../js/summary.js";
import { loadFixture, matchSnapshot } from "./helpers.mjs";

const run = loadFixture("protein-a");
const summary = phaseSummary(run);
const phase = (name) => summary.phases.find((p) => p.name === name);
const use = (ph, inlet) => phase(ph).uses.find((u) => u.inlet === inlet)?.volume;

test("lab-book text matches the snapshot", () => {
  matchSnapshot("protein-a", summaryText(summary).join("\n"));
});

test("phases in run order", () => {
  assert.deepEqual(summary.phases.map((p) => p.name),
    ["Method Settings", "Column Wash", "Elution 1 pH 3.4", "MQW wash", "Column CIP", "Equilibration"]);
});

test("inlet totals across the run", () => {
  const totals = Object.fromEntries(summary.inlets.map((i) => [i.inlet, +i.total.toFixed(2)]));
  assert.deepEqual(totals, { A1: 100.73, A2: 25.78, A3: 15.15, B1: 25.29 });
  assert.ok(summary.inlets.every((i) => i.washed), "every inlet also had a system wash");
  assert.equal(inletLine(summary.inlets[0], { A1: "PBS pH 7.4" }), "A1 (100.73 ml + system wash): PBS pH 7.4");
});

test("each phase draws from the right inlet", () => {
  assert.equal(use("Column Wash", "A1").toFixed(2), "50.41");
  assert.equal(use("Elution 1 pH 3.4", "B1").toFixed(2), "25.29");
  assert.equal(use("MQW wash", "A2").toFixed(2), "25.78");
  assert.equal(use("Column CIP", "A3").toFixed(2), "15.15");
  assert.equal(use("Equilibration", "A1").toFixed(2), "50.32");
  assert.deepEqual(phase("Elution 1 pH 3.4").pctB, ["100 %B"]);
});

test("no sample pump: no sample inlet or sample-loading notes", () => {
  assert.ok(!summary.inlets.some((i) => /^S|Sample/.test(i.inlet)));
  const text = summaryText(summary).join("\n");
  assert.doesNotMatch(text, /primed to waste|Inject all sample|No fractionation/);
});

test("fraction table", () => {
  const rows = fractionRows(summary);
  assert.deepEqual(rows.map((r) => r.Fraction), ["1.A.1", "1.A.2", "1.A.3", "3.A.1", "3.A.2", "3.A.3", "3.A.4", "3.A.5", "3.B.1"]);
  const r = Object.fromEntries(rows.map((row) => [row.Fraction, row]));
  assert.equal(r["1.A.1"].Phase, "Column Wash");
  assert.equal(r["3.A.2"]["Volume (ml)"], "55.58–60.58");
  assert.equal(r["3.A.2"].Intake, "B1");
  assert.equal(r["3.A.2"]["Max A280 (mAU)"], "1017");
  assert.equal(r["3.A.3"]["Max A280 (mAU)"], "1032");
});

test("fractionation settings and stops", () => {
  assert.equal(phase("Column Wash").fracSize, "25.0 ml each, 50 ml tubes");
  assert.equal(phase("Elution 1 pH 3.4").fracSize, "5.0 ml each, 15 ml tubes");
  assert.ok(phase("Column Wash").notes.includes("Fractionation stopped at 50.39 ml (end of phase)"));
  assert.ok(phase("Elution 1 pH 3.4").notes.includes("Fractionation stopped at 75.72 ml (end of phase)"));
});
