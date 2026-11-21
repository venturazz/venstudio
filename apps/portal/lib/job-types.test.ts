import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// jobs.ts imports server-only code, so compare the sources as text. The typed Record<JobType, ...> in jobs.ts
// is the compile-time check; this keeps the two lists honest when only node --test runs.
const protocol = readFileSync(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
const jobs = readFileSync(new URL("./server/jobs.ts", import.meta.url), "utf8");

test("JobType union and JOB_TYPES list the same types", () => {
  const union = /export type JobType =([^;]+);/.exec(protocol)![1];
  const fromUnion = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
  const table = /export const JOB_TYPES[^=]*= \{([\s\S]*?)\n\};/.exec(jobs)![1];
  const fromTable = [...table.matchAll(/^ {2}(?:"([a-z-]+)"|([a-z]+)): \{/gm)].map((m) => m[1] ?? m[2]).sort();
  assert.deepEqual(fromTable, fromUnion);
  for (const t of ["tts", "render-video", "fetch-asset", "agent-task"]) assert.ok(fromUnion.includes(t), t);
});

test("protocol WORKER_VERSION is 0.6.0", () => {
  assert.match(protocol, /WORKER_VERSION = "0\.6\.0"/);
  // The worker reports its own VERSION to the portal; the Workers page flags any worker that differs.
  const worker = readFileSync(new URL("../../worker/venstudio-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /export const VERSION = "0\.6\.0"/);
});
