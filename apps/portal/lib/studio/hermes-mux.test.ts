import { test } from "node:test";
import assert from "node:assert/strict";
import { HERMES_MUX_CAPABILITY, HERMES_MUX_ENGINE, MUX_MAX_PAD_SEC, hermesMuxPayload, hermesMuxPlan, muxNote, muxWorkerIssue, readMuxPlan } from "./hermes-mux.ts";
import { buildAudioPlan } from "./audio-plan.ts";

test("the mux plan: freeze a short picture, pad the narration of a slightly longer one, trim a much longer one", () => {
  const freeze = hermesMuxPlan({ clipSec: 14.2, narrationSec: 16, fps: 30 });
  assert.deepEqual([freeze.mode, freeze.durationSec, freeze.freezeSec], ["freeze", 16, 1.8]);
  const pad = hermesMuxPlan({ clipSec: 17.5, narrationSec: 16, fps: 30 });
  assert.deepEqual([pad.mode, pad.durationSec, pad.padSec], ["pad", 17.5, 1.5]);
  const trim = hermesMuxPlan({ clipSec: 16 + MUX_MAX_PAD_SEC + 5, narrationSec: 16, fps: 30 });
  assert.deepEqual([trim.mode, trim.durationSec, trim.trimSec], ["trim", 16.5, 7.5]);
  assert.equal(hermesMuxPlan({ clipSec: 16.02, narrationSec: 16, fps: 30 }).mode, "match");
  // Within a frame shorter is a match too (the narration loses less than a frame of its silent tail).
  assert.equal(hermesMuxPlan({ clipSec: 15.98, narrationSec: 16, fps: 30 }).mode, "match");
  assert.equal(hermesMuxPlan({ clipSec: 15.9, narrationSec: 16, fps: 30 }).mode, "freeze");
});

test("the card says what was done to fit the lengths, from the worker's reported plan", () => {
  assert.equal(muxNote(hermesMuxPlan({ clipSec: 14.2, narrationSec: 16, fps: 30 })), "Hermes's picture is 14.2 s and the narration 16 s: the last frame is held for 1.8 s so the narration ends on screen.");
  assert.equal(muxNote(hermesMuxPlan({ clipSec: 17.5, narrationSec: 16, fps: 30 })), "Hermes's picture is 17.5 s and the narration 16 s: the picture plays whole and the narration ends 1.5 s before it.");
  assert.match(muxNote(hermesMuxPlan({ clipSec: 30, narrationSec: 16, fps: 30 })), /the picture is cut 0\.5 s after the narration ends \(13\.5 s cut\)\.$/);
  const reported = readMuxPlan({ mode: "pad", durationSec: 17.5, clipSec: 17.5, narrationSec: 16, padSec: 1.5, freezeSec: 0, trimSec: 0 });
  assert.equal(reported?.mode, "pad");
  assert.equal(readMuxPlan({ mode: "stretch", durationSec: 1, clipSec: 1, narrationSec: 1 }), null);
  assert.equal(readMuxPlan(null), null);
});

test("a hermes-mux job goes only to a worker that reports hermes-mux; with none the stage error names the fix", () => {
  assert.equal(muxWorkerIssue([["ffmpeg", "audio-mix"], ["ffmpeg", "audio-mix", HERMES_MUX_CAPABILITY]]), null);
  for (const lists of [[], [["ffmpeg", "audio-mix", "caption-style"]], null]) {
    const why = muxWorkerIssue(lists);
    assert.ok(why);
    assert.match(why, /no worker reports hermes-mux \(worker 0\.13\.0 or later/);
    assert.match(why, /Update the worker/);
    assert.match(why, /no silent video/);
  }
});

test("the mux payload lists every file as a job input: Hermes's picture, the narration and the mix's bed", () => {
  const PIC = "11111111-1111-4111-8111-111111111111";
  const NARR = "22222222-2222-4222-8222-222222222222";
  const BED = "33333333-3333-4333-8333-333333333333";
  const audio = buildAudioPlan({ policy: "self-or-licensed", narrated: true, durationSec: 16, targetLufs: -14, maxTruePeakDb: -1, bed: { assetId: BED, durationSec: 60 } });
  assert.ok(audio.ok);
  const p = hermesMuxPayload({ runId: "r", format: "short", width: 1080, height: 1920, fps: 30, pictureAssetId: PIC, narrationAssetId: NARR, narrationSec: 16, tempo: 1.05, targetLufs: -14, audio: audio.plan });
  assert.equal(p.engine, HERMES_MUX_ENGINE);
  assert.deepEqual(p.inputs, [PIC, NARR, BED]);
  assert.deepEqual(p.picture, { assetId: PIC });
  assert.equal(p.narrationTempo, 1.05);
  assert.equal((p.audio as { master: { targetLufs: number } }).master.targetLufs, p.targetLufs, "the worker refuses a mix whose master target differs");
  const plain = hermesMuxPayload({ runId: "r", format: "short", width: 1080, height: 1920, fps: 30, pictureAssetId: PIC, narrationAssetId: NARR, narrationSec: 16, tempo: 1, targetLufs: -14, audio: null });
  assert.deepEqual(plain.inputs, [PIC, NARR]);
  assert.equal("narrationTempo" in plain, false);
  assert.equal("audio" in plain, false);
});
