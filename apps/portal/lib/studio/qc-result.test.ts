import assert from "node:assert/strict";
import test from "node:test";
import { measureFromQcResult, technicalReportFor } from "./qc-result.ts";
import { seedTemplates } from "./templates.ts";

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

test("a failed job, an unreadable result and a missing template each give a failed G-technical report", () => {
  const t = seedTemplates()[0];
  const failed = technicalReportFor({ status: "failed", error: "ffmpeg crashed" }, t, "short", t.id);
  assert.equal(failed.gate.gate, "G-technical");
  assert.equal(failed.gate.passed, false);
  assert.match(failed.gate.issues[0], /ffmpeg crashed/);
  const bad = technicalReportFor({ status: "succeeded", result: { schemaVersion: 2 } }, t, "short", t.id);
  assert.equal(bad.gate.passed, false);
  assert.match(bad.gate.issues[0], /could not be read/);
  const good = {
    schemaVersion: 1, width: 1080, height: 1920, fps: 30, durationSec: 40, hasAudio: true, integratedLufs: -14, truePeakDb: -2,
    blackRuns: [], silenceRuns: [], freezeRuns: [], cuts: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38],
  };
  const missing = technicalReportFor({ status: "succeeded", result: good }, null, "short", "tpl-x");
  assert.equal(missing.gate.passed, false);
  assert.match(missing.gate.issues[0], /tpl-x was not found/);
  assert.ok(missing.measure);
  assert.equal(technicalReportFor({ status: "succeeded", result: good }, t, "short", t.id).gate.executor, "worker qc-video");
});
