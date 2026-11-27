import test from "node:test";
import assert from "node:assert/strict";
import { composedScenes } from "./review.ts";

// A review card must be able to hand the owner the exact parts a scene composed: promoting is a copy, not a guess.
test("a composed scene is offered as a named candidate, with its parts", () => {
  const gate = [{ kind: "walls", at: [1, 0, 0], size: [11, 7, 3] }, { kind: "cylinder", radius: 2, height: 12 }];
  const out = composedScenes({
    shots: [
      { seconds: 4, intent: { parts: gate, action: "build", focus: "structure" } },
      { seconds: 3, intent: { structure: "church", action: "idle", focus: "structure" } },
      { seconds: 3, intent: { structure: "gate", parts: gate, action: "idle", focus: "structure" } },
    ],
  });
  // The unnamed one gets a stable fallback name, and a named kit structure is not a candidate at all.
  assert.deepEqual(out, [
    { name: "composed-1", parts: gate },
    { name: "gate", parts: gate },
  ]);
});

test("a run that named everything composes nothing", () => {
  assert.deepEqual(composedScenes({ shots: [{ intent: { structure: "church", action: "build" } }] }), []);
  assert.deepEqual(composedScenes({}), []);
  assert.deepEqual(composedScenes({ shots: [{ intent: { parts: [] } }] }), []);
});