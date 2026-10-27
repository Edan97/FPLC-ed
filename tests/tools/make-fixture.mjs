// Turn a UNICORN result export into an anonymised test fixture for tests/.
//
//   npm run fixture -- path/to/Result.zip tests/fixtures/name.json [--redact "name"]...
//
// Keeps only what js/summary.js reads: the run log, fraction events, the Sample flow and
// UV 1_280 curves, the run's end volume and the column volume. Names, result folders, the
// computer, sample marks and batch IDs are replaced, and the script refuses to write if any
// --redact string survives. Check the output before committing: the repo is public.
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser } from "linkedom";

// vendor/jszip.min.js is a browser (UMD) build; give it a CommonJS module to fill in.
const jszip = { exports: {} };
new Function("module", "exports", await readFile(new URL("../../vendor/jszip.min.js", import.meta.url), "utf8"))(jszip, jszip.exports);
globalThis.DOMParser = DOMParser;
globalThis.JSZip = jszip.exports;
const { findResults, UnicornResult } = await import("../../js/unicorn.js");

const KEEP_CURVES = ["Sample flow", "UV 1_280"];

const REDACTIONS = [
  [/Result: .*? User /, "Result: /RESULTS/redacted User "],
  [/\bat computer \S+/, "at computer REDACTED"],
  [/^Set mark ".*?"/, 'Set mark "SAMPLE"'],
  [/^Batch ID: \S+/, "Batch ID: redacted"],
];

function anonymise(text) {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}

const args = process.argv.slice(2);
const redact = [];
for (let i = args.indexOf("--redact"); i !== -1; i = args.indexOf("--redact")) {
  redact.push(args[i + 1]);
  args.splice(i, 2);
}
const [zipPath, outPath] = args;
if (!zipPath || !outPath) {
  console.error('usage: npm run fixture -- RESULT.zip OUT.json [--redact "name"]...');
  process.exit(2);
}

const [found] = await findResults(await readFile(zipPath), zipPath.split("/").pop());
if (!found) throw new Error(`No UNICORN result in ${zipPath}`);
const run = await UnicornResult.open(found.zip, found.name);

const end = Math.max(...run.curves.map((c) => c.volume[c.volume.length - 1]));
const curves = run.curves
  .filter((c) => KEEP_CURVES.includes(c.name))
  .map((c) => ({
    name: c.name, unit: c.unit, timeStep: c.timeStep, timeStart: c.timeStart,
    volume: [...c.volume], amplitude: [...c.amplitude],
  }));
// The run's last recorded volume, which the other curves would otherwise supply.
curves.push({ name: "_end", unit: "", timeStep: null, timeStart: null, volume: [0, end], amplitude: [0, 0] });

const fixture = {
  source: "UNICORN result export, anonymised by tests/tools/make-fixture.mjs",
  info: { ColumnVolume: run.info.ColumnVolume ?? null, ColumnInformation: run.info.ColumnInformation ?? "" },
  runLog: run.runLog.map((e) => ({ ...e, text: anonymise(e.text) })),
  fractions: run.fractions,
  curves,
};

const json = JSON.stringify(fixture);
const leaks = redact.filter((s) => json.toLowerCase().includes(s.toLowerCase()));
if (leaks.length) {
  console.error(`Not written: still contains ${leaks.map((s) => JSON.stringify(s)).join(", ")}`);
  process.exit(1);
}
await writeFile(outPath, json);
console.log(`Wrote ${outPath} (${(json.length / 1024).toFixed(0)} kB, ${fixture.runLog.length} log entries)`);
