import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DURATION_SEC, isEngineStage, isStuck, nextStage, revisionTarget, stageSummary } from "./engine.ts";
import { VIDEO_FORMATS } from "./catalog.ts";

test("stage order ends after the storyboard", () => {
  assert.equal(nextStage("idea"), "research");
  assert.equal(nextStage("script"), "storyboard");
  assert.equal(nextStage("storyboard"), null);
  assert.ok(isEngineStage("script") && !isEngineStage("assets"));
});

test("default durations sit inside the catalog range", () => {
  for (const f of ["short", "long"] as const) {
    const [lo, hi] = VIDEO_FORMATS[f].durationSec;
    assert.ok(DEFAULT_DURATION_SEC[f] >= lo && DEFAULT_DURATION_SEC[f] <= hi);
  }
});

test("revisionTarget prefers the classifier, then keywords, then the item's own stage, and never goes later", () => {
  assert.equal(revisionTarget("idea", "anything", "storyboard"), "idea");
  assert.equal(revisionTarget("storyboard", "anything", "script"), "script");
  assert.equal(revisionTarget(null, "rewrite the hook", "storyboard"), "script");
  assert.equal(revisionTarget(null, "please do better", "research"), "research");
  assert.equal(revisionTarget(null, "please do better", "storyboard"), "storyboard");
  assert.equal(revisionTarget(null, "different topic", "script"), "idea");
  assert.equal(revisionTarget(null, "fewer shots", "idea"), "idea");
});

test("isStuck compares against the limit", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(isStuck(null, now), false);
  assert.equal(isStuck(new Date("2026-01-01T11:55:00Z"), now), false);
  assert.equal(isStuck(new Date("2026-01-01T11:49:00Z"), now), true);
});

test("stageSummary describes each stage and tolerates junk", () => {
  assert.equal(stageSummary("idea", { ideas: [{}, {}] }), "2 ideas");
  assert.equal(stageSummary("research", { notes: [{ sourced: true }, { sourced: false }] }), "2 notes, 1 with a source");
  assert.match(stageSummary("script", { script: "one two three" }), /^3 words/);
  assert.equal(stageSummary("storyboard", { shots: [{ seconds: 3 }, { seconds: 4.4 }] }), "2 shots, about 7 seconds");
  assert.equal(stageSummary("storyboard", null), "0 shots, about 0 seconds");
});
