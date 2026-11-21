import { test } from "node:test";
import assert from "node:assert/strict";
import { AMBIENT_BAND_HZ, AMBIENT_GAIN_DB, BED_GAIN_DB, BED_SOURCE_LUFS, buildAudioPlan } from "./audio-plan.ts";

const base = { policy: "self-or-licensed" as const, narrated: true, durationSec: 24 };

test("a narrated video with no bed still gets ambience, not digital silence", () => {
  const r = buildAudioPlan(base);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.bed, null);
  assert.deepEqual(r.plan.master, { targetLufs: -14, maxTruePeakDb: -1 });
  assert.deepEqual(r.plan.ambient?.bandHz, AMBIENT_BAND_HZ);
  assert.equal(r.plan.ambient?.gainDb, AMBIENT_GAIN_DB);
  assert.equal(r.plan.ambient?.color, "brown");
  assert.deepEqual(r.plan.sfx, []);
});

test("a bed is normalised before it is lifted, and ducked by a ratio that is audible", () => {
  const r = buildAudioPlan({ ...base, bed: { assetId: "bed-1", durationSec: 60 } });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.bed?.sourceLufs, BED_SOURCE_LUFS);
  assert.equal(r.plan.bed?.gainDb, BED_GAIN_DB);
  assert.ok((r.plan.bed?.duck.ratio ?? 0) >= 2);
  assert.equal(r.plan.bed?.duck.attackMs, 15);
  assert.equal(r.plan.bed?.duck.releaseMs, 350);
});

test("a bed shorter than the cut is looped, never left to run out", () => {
  const short = buildAudioPlan({ ...base, bed: { assetId: "b", durationSec: 10 } });
  assert.ok(short.ok);
  if (short.ok) assert.equal(short.plan.bed?.cover, "loop");
  const long = buildAudioPlan({ ...base, bed: { assetId: "b", durationSec: 90 } });
  assert.ok(long.ok);
  if (long.ok) assert.equal(long.plan.bed?.cover, "trim");
  const unknown = buildAudioPlan({ ...base, bed: { assetId: "b" } });
  assert.ok(unknown.ok);
  if (unknown.ok) assert.equal(unknown.plan.bed?.cover, "loop");
});

test("a template that forbids music refuses a bed instead of mixing it", () => {
  const r = buildAudioPlan({ ...base, policy: "none", bed: { assetId: "b" } });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues.join(" | ") : "", /forbids music/);
  const bare = buildAudioPlan({ ...base, policy: "none" });
  assert.ok(bare.ok);
  if (bare.ok) assert.equal(bare.plan.bed, null);
});

test("a video with no narration gets no ambience to fill around", () => {
  const r = buildAudioPlan({ ...base, narrated: false });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.plan.ambient, null);
});

test("accents are sorted, kept apart and kept inside the cut", () => {
  const r = buildAudioPlan({ ...base, sfx: [{ atSec: 12, assetId: "s2" }, { atSec: 3, assetId: "s1" }] });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.plan.sfx.map((s) => s.assetId), ["s1", "s2"]);

  const dense = buildAudioPlan({ ...base, sfx: [{ atSec: 3, assetId: "a" }, { atSec: 4, assetId: "b" }] });
  assert.equal(dense.ok, false);
  assert.match(!dense.ok ? dense.issues.join(" | ") : "", /at least 3 s apart/);

  const past = buildAudioPlan({ ...base, sfx: [{ atSec: 30, assetId: "a" }] });
  assert.equal(past.ok, false);
  assert.match(!past.ok ? past.issues.join(" | ") : "", /outside a 24 s video/);
});

test("a mix with no length is refused", () => {
  const r = buildAudioPlan({ ...base, durationSec: 0 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues[0] : "", /no length/);
});