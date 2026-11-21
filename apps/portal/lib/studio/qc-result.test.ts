import assert from "node:assert/strict";
import test from "node:test";
import { measureFromQcResult, technicalReportFor, withPlannedCuts } from "./qc-result.ts";
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

test("planned scene starts are added to the detected cuts: inside the video only, sorted, no near-duplicates", () => {
  const m = measureFromQcResult(good);
  assert.ok(m);
  const merged = withPlannedCuts(m, [0, 2.05, 7, 3, 30, 31, -1, "x", Number.NaN]);
  // 0 and 30 are the video's edges, 2.05 is the detected cut at 2, and junk values are skipped.
  assert.deepEqual(merged.cuts, [2, 3, 4, 7]);
  assert.deepEqual(m.cuts, [2, 4], "the input measure is not changed");
  assert.equal(withPlannedCuts(m, undefined), m);
  assert.equal(withPlannedCuts(m, "2,3"), m);
});

test("a cross-faded render whose fades the detector cannot see passes the cut checks with the renderer's scene starts", () => {
  const t = seedTemplates()[0];
  const step = Math.min(t.pacing.maxShotSeconds, t.pacing.hookByMs / 1000) * 0.9;
  const starts: number[] = [];
  for (let s = step; s < 40 - 0.5; s += step) starts.push(Math.round(s * 1000) / 1000);
  const faded = {
    schemaVersion: 1, width: 1080, height: 1920, fps: 30, durationSec: 40, hasAudio: true, integratedLufs: t.audio.targetLufs, truePeakDb: -2,
    blackRuns: [], silenceRuns: [], freezeRuns: [], cuts: [],
  };
  const cutIssue = (issues: string[]) => issues.filter((i) => /cut|shot/i.test(i));
  const blind = technicalReportFor({ status: "succeeded", result: faded }, t, "short", t.id);
  assert.ok(cutIssue(blind.gate.issues).length > 0, "without the plan, no detected cut means the cut checks fail");
  const planned = technicalReportFor({ status: "succeeded", result: faded }, t, "short", t.id, [0, ...starts]);
  assert.deepEqual(cutIssue(planned.gate.issues), [], planned.gate.issues.join("; "));
  assert.deepEqual(planned.measure?.cuts, starts);
});
