import assert from "node:assert/strict";
import test from "node:test";
import { measureFromQcResult } from "./qc-result.ts";

const good = {
  schemaVersion: 1,
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 30,
  hasAudio: true,
  integratedLufs: -14,
  truePeakDb: -2,
  blackRuns: [{ start: 1, end: 2 }],
  silenceRuns: [],
  freezeRuns: [],
  cuts: [2, 4],
};

test("a well-formed qc-video result becomes a technical measure", () => {
  const m = measureFromQcResult(good);
  assert.ok(m);
  assert.equal(m.width, 1080);
  assert.deepEqual(m.blackRuns, [{ start: 1, end: 2 }]);
  assert.equal(m.integratedLufs, -14);
});

test("null loudness is kept as null, not turned into a number", () => {
  const m = measureFromQcResult({ ...good, hasAudio: false, integratedLufs: null, truePeakDb: null });
  assert.equal(m?.integratedLufs, null);
  assert.equal(m?.truePeakDb, null);
});

test("malformed results return null", () => {
  assert.equal(measureFromQcResult(null), null);
  assert.equal(measureFromQcResult({ ...good, schemaVersion: 2 }), null);
  assert.equal(measureFromQcResult({ ...good, width: "1080" }), null);
  assert.equal(measureFromQcResult({ ...good, blackRuns: [{ start: 1 }] }), null);
  assert.equal(measureFromQcResult({ ...good, hasAudio: "yes" }), null);
  assert.equal(measureFromQcResult({ ...good, cuts: ["a"] }), null);
});
