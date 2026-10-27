// Shared test helpers: load an anonymised fixture as a result object, and compare text snapshots.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const here = new URL(".", import.meta.url);

/** A fixture from tests/fixtures/, shaped like UnicornResult (curves as Float64Arrays). */
export function loadFixture(name) {
  const r = JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, here), "utf8"));
  for (const c of r.curves) {
    c.volume = Float64Array.from(c.volume);
    c.amplitude = Float64Array.from(c.amplitude);
  }
  return r;
}

/**
 * Compare text with tests/snapshots/<name>.txt. Run `npm run test:update` to rewrite snapshots
 * after an intended change, then read the diff before committing.
 */
export function matchSnapshot(name, text) {
  const dir = new URL("snapshots/", here);
  const file = new URL(`${name}.txt`, dir);
  if (process.env.UPDATE_SNAPSHOTS) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.ok(existsSync(file), `No snapshot ${name}.txt yet; run npm run test:update`);
  assert.equal(text, readFileSync(file, "utf8"), `Output differs from snapshots/${name}.txt`);
}

/** Minimal result for hand-written run logs: [volume, text] pairs, one phase per "Phase X". */
export function syntheticRun(entries, { end, columnVolume = 1, curves = [], fractions = [] } = {}) {
  const runLog = entries.map(([volume, text], i) => ({ volume, time: i / 100, text }));
  const last = end ?? Math.max(...runLog.map((e) => e.volume));
  return {
    info: { ColumnVolume: columnVolume },
    runLog,
    fractions,
    curves: [...curves, { name: "_end", volume: Float64Array.of(0, last), amplitude: Float64Array.of(0, 0) }],
  };
}
