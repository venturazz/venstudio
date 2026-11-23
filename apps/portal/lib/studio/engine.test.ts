import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DURATION_SEC,
  MODEL_STAGE_STUCK_MINUTES,
  modelStageWorstCaseSec,
  isEngineStage,
  isOrphaned,
  isProductionStage,
  isRunStage,
  isStuck,
  nextRunStage,
  RUN_STAGES,
  STUCK_MINUTES,
  stuckMinutesFor,
  nextStage,
  revisionTarget,
  stageSummary,
} from "./engine.ts";
import { VIDEO_FORMATS } from "./catalog.ts";
import { GATE_QUEUE_TIMEOUT_SEC, HERMES_ASK_TIMEOUT_SEC, HERMES_RETRY_PAUSE_SEC, HERMES_STAGE_ASKS } from "./pacing.ts";

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
  assert.equal(isStuck(new Date("2026-01-01T11:55:00Z"), now, 21), false);
  assert.equal(isStuck(new Date("2026-01-01T11:49:00Z"), now, 21), false);
  assert.equal(isStuck(new Date("2026-01-01T11:30:00Z"), now, 21), true);
  // Without a limit, the longest model stage limit applies.
  assert.equal(isStuck(new Date(now.getTime() - STUCK_MINUTES * 60_000 + 1000), now), false);
  assert.equal(isStuck(new Date(now.getTime() - STUCK_MINUTES * 60_000 - 1000), now), true);
});

test("the stuck threshold exceeds the worst-case Hermes time", () => {
  for (const [stage, minutes] of Object.entries(MODEL_STAGE_STUCK_MINUTES)) {
    const worst = modelStageWorstCaseSec(stage as keyof typeof MODEL_STAGE_STUCK_MINUTES);
    assert.ok(minutes * 60 > worst, `${stage}: ${minutes} min must exceed its worst case of ${worst} s`);
    assert.ok(STUCK_MINUTES >= minutes, "the default limit is the longest");
  }
});

test("each model stage's stuck limit comes from its own call timeout and its 3 asks", () => {
  for (const [stage, minutes] of Object.entries(MODEL_STAGE_STUCK_MINUTES)) {
    const kind = stage as keyof typeof MODEL_STAGE_STUCK_MINUTES;
    assert.equal(modelStageWorstCaseSec(kind), HERMES_STAGE_ASKS * (HERMES_ASK_TIMEOUT_SEC[kind] + GATE_QUEUE_TIMEOUT_SEC + HERMES_RETRY_PAUSE_SEC));
    assert.equal(minutes, Math.ceil(modelStageWorstCaseSec(kind) / 60) + 6);
    assert.equal(stuckMinutesFor(kind), minutes);
  }
  // Research asks for up to 10 minutes, 3 times: 3 x (600 + 120 + 10) s = 36.5 min, plus 6 = 43 min.
  assert.equal(MODEL_STAGE_STUCK_MINUTES.research, 43);
  assert.equal(MODEL_STAGE_STUCK_MINUTES.idea, 25);
  // The HTML design writes a whole page: 3 x (720 + 120 + 10) s = 42.5 min, plus 6 = 49 min.
  assert.equal(MODEL_STAGE_STUCK_MINUTES["html-design"], 49);
  assert.ok(MODEL_STAGE_STUCK_MINUTES["html-design"] > MODEL_STAGE_STUCK_MINUTES.research);
});

test("a research stage that has run 9 minutes (or three full 10-minute asks) is not reaped as stuck", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  assert.equal(isStuck(ago(9), now, stuckMinutesFor("research")), false);
  assert.equal(isStuck(ago(31), now, stuckMinutesFor("research")), false);
  assert.equal(isStuck(ago(42), now, stuckMinutesFor("research")), false);
  assert.equal(isStuck(ago(44), now, stuckMinutesFor("research")), true);
  // The idea stage has a shorter ask, so it is reaped sooner.
  assert.equal(isStuck(ago(26), now, stuckMinutesFor("idea")), true);
});

test("isOrphaned finds a running run with only unclaimed engine stages", () => {
  assert.equal(isOrphaned("running", [{ stage: "script", state: "pending" }]), true);
  assert.equal(isOrphaned("running", [{ stage: "script", state: "pending" }, { stage: "idea", state: "running" }]), false);
  assert.equal(isOrphaned("waiting-human", [{ stage: "script", state: "pending" }]), false);
  assert.equal(isOrphaned("running", [{ stage: "assets", state: "pending" }]), true);
  assert.equal(isOrphaned("running", [{ stage: "render", state: "running" }, { stage: "qc", state: "pending" }]), false);
  assert.equal(isOrphaned("running", [{ stage: "upload", state: "pending" }]), false);
  assert.equal(isOrphaned("running", []), false);
});

test("stageSummary describes each stage and tolerates junk", () => {
  assert.equal(stageSummary("idea", { ideas: [{}, {}] }), "2 ideas");
  assert.equal(stageSummary("research", { notes: [{ sourced: true }, { sourced: false }] }), "2 notes, 1 with a source");
  assert.match(stageSummary("script", { script: "one two three" }), /^3 words/);
  assert.equal(stageSummary("storyboard", { shots: [{ seconds: 3 }, { seconds: 4.4 }] }), "2 shots, about 7 seconds");
  assert.equal(stageSummary("storyboard", null), "0 shots, about 0 seconds");
});

test("the run stage order continues through the production stages", () => {
  assert.deepEqual([...RUN_STAGES], ["idea", "research", "script", "storyboard", "assets", "voice", "render", "qc"]);
  assert.equal(nextRunStage("storyboard"), "assets");
  assert.equal(nextRunStage("assets"), "voice");
  assert.equal(nextRunStage("voice"), "render");
  assert.equal(nextRunStage("render"), "qc");
  assert.equal(nextRunStage("qc"), null);
  assert.ok(isProductionStage("render") && !isProductionStage("script"));
  assert.ok(isRunStage("qc") && !isRunStage("upload"));
});

test("revisionTarget handles production stages", () => {
  assert.equal(revisionTarget(null, "brighter images please", "qc"), "assets");
  assert.equal(revisionTarget(null, "a calmer voice", "render"), "voice");
  assert.equal(revisionTarget(null, "make it better", "render"), "render");
  assert.equal(revisionTarget(null, "rewrite the hook", "qc"), "script");
  assert.equal(revisionTarget(null, "brighter images please", "voice"), "assets");
  assert.equal(revisionTarget(null, "a calmer voice", "assets"), "assets");
});

test("notes on a Hermes-rendered video go back to Hermes; only a note about the voice itself records the narration", () => {
  const h = { renderer: "hermes" };
  for (const own of ["render", "qc"] as const) {
    assert.equal(revisionTarget(null, "there is no sound", own, RUN_STAGES, h), "render");
    assert.equal(revisionTarget(null, "The video is silent", own, RUN_STAGES, h), "render");
    assert.equal(revisionTarget(null, "audio missing", own, RUN_STAGES, h), "render");
    assert.equal(revisionTarget(null, "I can't hear the narration", own, RUN_STAGES, h), "render");
    assert.equal(revisionTarget(null, "no voice at all", own, RUN_STAGES, h), "render", "a missing voice is the video's fault, not the voice's");
    assert.equal(revisionTarget(null, "the music is too loud", own, RUN_STAGES, h), "render");
    assert.equal(revisionTarget(null, "the voice sounds robotic", own, RUN_STAGES, h), "voice");
    assert.equal(revisionTarget(null, "wrong accent, use a female narrator", own, RUN_STAGES, h), "voice");
    assert.equal(revisionTarget(null, "make it better", own, RUN_STAGES, h), "render", "no keyword: Hermes redoes the video");
    // Content notes still go to their step.
    assert.equal(revisionTarget(null, "rewrite the hook", own, RUN_STAGES, h), "script");
  }
  // A skill that voices itself: a note about its voice is Hermes's to fix too.
  const SKILL_VOICED = ["idea", "research", "script", "skill-brief", "render", "qc"] as const;
  assert.equal(revisionTarget(null, "the voice sounds robotic", "qc", SKILL_VOICED, h), "render");
  assert.equal(revisionTarget(null, "there is no sound", "qc", SKILL_VOICED, h), "render");
});

test("notes on a worker-rendered video: missing sound re-runs the render (the mix), only voice words record the voice", () => {
  assert.equal(revisionTarget(null, "there is no sound", "render"), "render");
  assert.equal(revisionTarget(null, "there is no sound", "qc"), "render");
  assert.equal(revisionTarget(null, "the audio is missing", "qc"), "render");
  assert.equal(revisionTarget(null, "the music is too quiet", "qc"), "render");
  assert.equal(revisionTarget(null, "the voice sounds robotic", "qc"), "voice");
  assert.equal(revisionTarget(null, "a calmer voice", "render"), "voice");
  // Unchanged: no keyword stays on the card's own step, and other notes keep their routing.
  assert.equal(revisionTarget(null, "make it better", "qc"), "qc");
  assert.equal(revisionTarget(null, "brighter images please", "qc"), "assets");
  // Notes on earlier cards are not sorted by sound (never later than the card).
  assert.equal(revisionTarget(null, "there is no sound", "assets"), "assets");
});
