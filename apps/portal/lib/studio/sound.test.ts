import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOUND, pairCues, parseSound, sfxCues, sfxTagFor } from "./sound.ts";
import { SFX_MIN_GAP_SEC, buildAudioPlan } from "./audio-plan.ts";

const shots = (seconds: number[], roles: string[] = []) => seconds.map((s, n) => ({ seconds: s, beatRole: roles[n] }));

test("an old run reads as the default, and a track id survives only when it is a uuid", () => {
  assert.deepEqual(parseSound(undefined), DEFAULT_SOUND);
  assert.deepEqual(parseSound({ bed: "none", sfx: "rich", ambience: false }), { bed: "none", sfx: "rich", ambience: false });
  const id = "6f1b6f43-2c1e-4c47-9f39-0f0f6a2b1c11";
  assert.equal(parseSound({ bed: id }).bed, id);
  assert.equal(parseSound({ bed: "some-track" }).bed, "auto");
  assert.equal(parseSound({ sfx: "loud" }).sfx, "sparse");
});

test("no mode means no cues, whatever the storyboard says", () => {
  assert.deepEqual(sfxCues(shots([4, 4, 4, 4]), "off"), []);
});

test("a cue never lands on the first shot, and never closer than three seconds", () => {
  const cues = sfxCues(shots([2, 2, 2, 4, 4, 4]), "rich");
  assert.ok(!cues.some((c) => c.atSec === 0), "a cue was placed on the first shot");
  for (let n = 1; n < cues.length; n++) {
    assert.ok(cues[n].atSec - cues[n - 1].atSec >= SFX_MIN_GAP_SEC, `cues at ${cues[n - 1].atSec}s and ${cues[n].atSec}s are too close`);
  }
});

test("sparse keeps about one accent per three shots; rich keeps the ones that clear the gap", () => {
  const board = shots([3, 3, 3, 3, 3, 3, 3, 3, 3]);
  const sparse = sfxCues(board, "sparse");
  const rich = sfxCues(board, "rich");
  assert.ok(sparse.length >= 2 && sparse.length < rich.length, `sparse ${sparse.length} vs rich ${rich.length}`);
  assert.ok(rich.every((c, n) => n === 0 || c.atSec - rich[n - 1].atSec >= SFX_MIN_GAP_SEC));
});

test("the beat decides the accent, and a payoff is not a whoosh", () => {
  assert.equal(sfxTagFor("payoff"), "impact");
  assert.equal(sfxTagFor("cta"), "riser");
  assert.equal(sfxTagFor("body"), "whoosh");
  const cues = sfxCues(shots([4, 4, 4], ["hook", "body", "payoff"]), "rich");
  assert.deepEqual(cues.map((c) => c.tag), ["whoosh", "impact"]);
});

test("an accent with no matching asset is dropped, not replaced", () => {
  const cues = [
    { atSec: 4, tag: "whoosh" },
    { atSec: 9, tag: "impact" },
  ];
  const paired = pairCues(cues, [
    { id: "w1", tags: ["sfx", "whoosh"] },
    { id: "w2", tags: ["sfx", "whoosh"] },
  ]);
  // No impact in the library: the second cue is dropped, and the surviving whoosh is not stretched over it.
  assert.deepEqual(paired, [{ atSec: 4, assetId: "w1" }]);
  assert.deepEqual(pairCues([{ atSec: 2, tag: "riser" }], [{ id: "w1", tags: ["whoosh"] }]), []);
});

test("two cues of the same kind use two different files", () => {
  const paired = pairCues(
    [
      { atSec: 4, tag: "whoosh" },
      { atSec: 9, tag: "whoosh" },
      { atSec: 14, tag: "whoosh" },
    ],
    [
      { id: "w1", tags: ["sfx", "whoosh"] },
      { id: "w2", tags: ["sfx", "whoosh"] },
    ],
  );
  assert.deepEqual(paired.map((p) => p.assetId), ["w1", "w2", "w1"]);
});

test("the paired cues are a mix audio-plan agrees with", () => {
  const cues = pairCues(sfxCues(shots([5, 5, 5, 5, 5]), "rich"), [
    { id: "bed-less-whoosh", tags: ["sfx", "whoosh"] },
    { id: "hit", tags: ["sfx", "impact"] },
  ]);
  const plan = buildAudioPlan({ policy: "self-or-licensed", narrated: true, durationSec: 25, sfx: cues });
  assert.equal(plan.ok, true, plan.ok ? "" : plan.issues.join(". "));
  if (plan.ok) {
    assert.deepEqual(plan.plan.sfx, cues);
    assert.ok(cues.length > 0, "the fixture produced no accents");
  }
});