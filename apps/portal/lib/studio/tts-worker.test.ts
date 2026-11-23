import { test } from "node:test";
import assert from "node:assert/strict";
import { TTS_QUEUE_GIVE_UP_MIN, ttsJobPayload, ttsJobPoll, ttsResultIssue, ttsWorkerChunks, ttsWorkerReady } from "./tts-worker.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const W = { status: "active", jobTypes: ["render-video", "tts"], capabilities: ["ffmpeg", "tts-kokoro"], lastSeenAt: ago(10) };

test("a worker may speak when it is active, reports tts, its Kokoro answered, and it was seen in the last 75 min", () => {
  assert.equal(ttsWorkerReady([W], NOW), true);
  assert.equal(ttsWorkerReady([], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, status: "draining" }], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, jobTypes: ["render-video"] }], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, capabilities: ["ffmpeg"] }], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, lastSeenAt: ago(120) }], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, lastSeenAt: null }], NOW), false);
  assert.equal(ttsWorkerReady([{ ...W, lastSeenAt: ago(300) }, W], NOW), true);
});

test("the job: text pieces within the worker's limits, the voice, the Kokoro model and the run", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something about the topic.`).join(" ");
  const chunks = ttsWorkerChunks(long);
  if (!chunks) throw new Error("no chunks");
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1500 && c.trim().length > 0);
  assert.equal(ttsWorkerChunks("   "), null);
  assert.equal(ttsWorkerChunks(Array.from({ length: 400 }, () => "x".repeat(380) + ".").join(" ")), null);
  const p = ttsJobPayload({ chunks: ["Hello."], voice: "af_heart", runId: "r1" });
  assert.deepEqual(p.chunks, ["Hello."]);
  assert.equal(p.voice, "af_heart");
  assert.equal(p.model, "kokoro");
  assert.equal(p.runId, "r1");
});

test("a waiting voice stage: speaking, queued, done, failed with the reason, or given up on", () => {
  const job = (status: string, extra: Partial<{ error: string | null; createdAt: Date }> = {}) => ({ status, error: null, createdAt: ago(2), ...extra });
  assert.deepEqual(ttsJobPoll(job("succeeded"), NOW), { kind: "read" });
  assert.equal(ttsJobPoll(job("running"), NOW).kind, "wait");
  assert.match((ttsJobPoll(job("queued"), NOW) as { text: string }).text, /Waiting for a worker with Kokoro/);
  assert.equal((ttsJobPoll(job("failed", { error: "Kokoro answered HTTP 500" }), NOW) as { error: string }).error, "Kokoro on the worker failed: Kokoro answered HTTP 500");
  assert.match((ttsJobPoll(job("cancelled"), NOW) as { error: string }).error, /cancelled/);
  assert.match((ttsJobPoll(null, NOW) as { error: string }).error, /no longer exists/);
  assert.match((ttsJobPoll(job("queued", { createdAt: ago(TTS_QUEUE_GIVE_UP_MIN + 1) }), NOW) as { error: string }).error, /No worker took the narration within 20 min/);
  assert.equal(ttsJobPoll(job("running", { createdAt: ago(500) }), NOW).kind, "wait");
});

test("the file must match the checksum the worker reported", () => {
  assert.equal(ttsResultIssue({ sha256: "ABC123" }, "abc123"), null);
  assert.equal(ttsResultIssue({}, "abc123"), null);
  assert.equal(ttsResultIssue(null, "abc123"), null);
  assert.match(ttsResultIssue({ sha256: "abc123" }, "def456") ?? "", /does not match/);
});
