import { test } from "node:test";
import assert from "node:assert/strict";
import { queueReasons, type JobForReasons, type WorkerForReasons } from "./queue-reasons.ts";

const now = new Date("2026-11-19T12:00:00Z");
const opts = { now, latestVersion: "0.2.0", graceMinutes: 75, urgentPriority: 10, legacyJobTypes: ["echo", "smoke-test"] };
const job = (over: Partial<JobForReasons> = {}): JobForReasons => ({
  type: "render-preview",
  capability: "ffmpeg",
  status: "queued",
  priority: 10,
  preferredWorkerId: null,
  createdAt: new Date("2026-11-19T11:50:00Z"),
  runAfter: new Date("2026-11-19T11:50:00Z"),
  ...over,
});
const worker = (over: Partial<WorkerForReasons> = {}): WorkerForReasons => ({
  id: "w1",
  name: "Muse 01",
  status: "active",
  version: "0.2.0",
  capabilities: ["echo", "ffmpeg"],
  jobTypes: ["echo", "smoke-test", "analyze-video", "render-preview", "qc-video"],
  lastClaimAt: new Date("2026-11-19T11:59:30Z"),
  ...over,
});

test("a job nobody can run says so", () => {
  assert.deepEqual(queueReasons(job(), [], opts), ["No worker is enrolled. Add one on the Workers page."]);
});

test("an updated worker that is asking for work is reported as about to take it", () => {
  const r = queueReasons(job(), [worker()], opts);
  assert.deepEqual(r, ["Muse 01 is asking for work and should take this job within about a minute."]);
});

test("an old worker is told to update, not silently skipped", () => {
  const r = queueReasons(job(), [worker({ version: "0.1.0", jobTypes: [] })], opts);
  assert.ok(r.some((x) => x.includes("can't run \"render-preview\" yet") && x.includes("v0.2.0")));
});

test("a worker without ffmpeg, or draining, says why", () => {
  assert.ok(queueReasons(job(), [worker({ capabilities: ["echo"] })], opts)[0].includes('no "ffmpeg" capability'));
  assert.ok(queueReasons(job(), [worker({ status: "draining" })], opts)[0].includes("is draining"));
});

test("a worker that has not asked for work for a while is reported as probably asleep", () => {
  const r = queueReasons(job(), [worker({ lastClaimAt: new Date("2026-11-19T10:00:00Z") })], opts);
  assert.ok(r[0].includes("probably asleep"));
});

test("a home-worker wait is shown; urgent jobs don't wait", () => {
  const waiting = queueReasons(job({ priority: 0, preferredWorkerId: "w1" }), [worker()], opts);
  assert.ok(waiting.some((x) => x.includes("Waiting up to") && x.includes("home worker")));
  const urgent = queueReasons(job({ priority: 10, preferredWorkerId: "w1" }), [worker()], opts);
  assert.ok(!urgent.some((x) => x.includes("home worker")));
});

test("a job that is not queued has no reasons", () => {
  assert.deepEqual(queueReasons(job({ status: "running" }), [worker()], opts), []);
});

test("a render queued under a style pack names the pack version the worker lacks", () => {
  const r = queueReasons(job({ type: "render-video", capability: "pack:explainer-flat-vector@1.1.0" }), [worker({ capabilities: ["ffmpeg", "remotion-2d", "pack:explainer-flat-vector@1.0.0"], jobTypes: ["render-video"] })], opts);
  assert.equal(r.length, 1);
  assert.match(r[0], /^Muse 01 does not report the style pack explainer-flat-vector 1\.1\.0 \(it has 1\.0\.0\)\. Workers 0\.9\.0 and later install style packs/);
  const ok = queueReasons(job({ type: "render-video", capability: "pack:explainer-flat-vector@1.0.0" }), [worker({ capabilities: ["pack:explainer-flat-vector@1.0.0"], jobTypes: ["render-video"] })], opts);
  assert.match(ok[0], /should take this job/);
});
