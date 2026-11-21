/**
 * The golden render payload. One fixed storyboard, one style, one job payload, checked in.
 *
 * The pure modules prove arithmetic; this file pins the exact shape that crosses from the portal to
 * the worker, so the two sides can be tested against the same bytes instead of two readings of the
 * same prose. A worker test loads `fixtures/render/explainer-payload.json`, asserts it accepts it and
 * dispatches on `engine`, and the contract cannot drift without this test failing.
 *
 * Regenerate with `GOLDEN_WRITE=1 node --test apps/portal/lib/studio/golden-payload.test.ts` after an
 * intended change, and say in the commit why the contract moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shot } from "./director.ts";
import { buildAudioPlan } from "./audio-plan.ts";
import { captionSpecFor } from "./caption-spec.ts";
import { XFADE_CAPABILITY, transitionForWorker } from "./render-engine.ts";
import { buildRenderPayload } from "./render.ts";
import { buildScenePlan, renderParamsForStyle } from "./scene-plan.ts";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/render/explainer-payload.json", import.meta.url));

/** Fixed on purpose: every field here shapes the contract, so none of it may vary between runs. */
const STYLE_ID = "explainer-flat-vector";
const FORMAT = "short" as const;
const NARRATION_SEC = 24;
const CAPTIONS = ["Iron is everywhere.", "The furnace reaches 1400 degrees.", "The hammer draws the bar out.", "Quenching locks the grain.", "That is how a blade is born."];
const CAPABILITIES = ["ffmpeg", "remotion-2d", "tts-kokoro", XFADE_CAPABILITY];

const SHOTS: Shot[] = [
  {
    beatRole: "hook",
    seconds: 4,
    description: "Iron is everywhere, and almost none of it is useful yet.",
    imagePrompt: "a foundry floor, sparks in the air, no people",
    onScreen: { elements: [{ kind: "heading", text: "Iron is everywhere" }, { kind: "plate" }], tokens: ["pop"] },
  },
  {
    beatRole: "setup",
    seconds: 5,
    description: "The furnace reaches 1400 degrees.",
    imagePrompt: "a glowing ingot inside a furnace mouth",
    onScreen: { elements: [{ kind: "counter", text: "degrees", value: 1400 }, { kind: "plate" }], tokens: ["counter"] },
  },
  {
    beatRole: "body",
    seconds: 6,
    description: "The hammer draws the bar out, blow by blow.",
    imagePrompt: "a hammer striking a red-hot bar on an anvil",
    onScreen: { elements: [{ kind: "bar", text: "draw ratio", series: [0.2, 0.45, 0.7, 0.95] }, { kind: "plate" }], tokens: ["draw", "bar"] },
  },
  {
    beatRole: "body",
    seconds: 5,
    description: "Quenching locks the grain before it can relax.",
    imagePrompt: "steam rising off a blade plunged into water",
    onScreen: { elements: [{ kind: "callout", text: "the grain locks" }, { kind: "plate" }], tokens: ["pop"] },
  },
  {
    beatRole: "outro",
    seconds: 4,
    description: "That is how a blade is born.",
    imagePrompt: "a finished blade on a workbench at night",
    onScreen: { elements: [{ kind: "heading", text: "That is how a blade is born" }, { kind: "plate" }], tokens: ["dim"] },
  },
];

function buildGolden() {
  const params = renderParamsForStyle(STYLE_ID);
  if (!params) throw new Error(`no such style: ${STYLE_ID}`);
  const specs = SHOTS.map((s, i) => ({ shotRef: `shot-${String(i + 1).padStart(2, "0")}`, seconds: s.seconds }));
  const transitionSec = transitionForWorker(CAPABILITIES, specs.map((s) => s.seconds));
  const scenePlan = buildScenePlan({ styleId: STYLE_ID, format: FORMAT, shots: SHOTS, transitionSec });
  if (!scenePlan.ok) throw new Error(`scene plan refused: ${scenePlan.issues.join(". ")}`);
  const audio = buildAudioPlan({
    policy: "self-or-licensed",
    narrated: true,
    durationSec: NARRATION_SEC,
    targetLufs: -14,
    maxTruePeakDb: -1,
    // Shorter than the cut on purpose: this is the case that used to play in silence for its last third.
    bed: { assetId: "asset-bed", durationSec: 10 },
  });
  if (!audio.ok) throw new Error(`audio plan refused: ${audio.issues.join(". ")}`);
  const plan = buildRenderPayload({
    format: FORMAT,
    shots: specs,
    shotAssets: Object.fromEntries(specs.map((s) => [s.shotRef, `asset-${s.shotRef}`])),
    narrationAssetId: "asset-narration",
    narrationSec: NARRATION_SEC,
    captions: CAPTIONS,
    targetLufs: -14,
    maxShotSeconds: 6,
    engine: params.engine,
    transitionSec,
    scenePlan: scenePlan.plan,
    // The beats are pinned — worker tests read these numbers — but the payload's shape is not: caption
    // geometry and the three audio layers joined it, and a worker has to honour both.
    captionSpec: captionSpecFor({ width: 1080, height: 1920, fontAssetId: "asset-font", safeAreaPct: 8 }),
    captionRequired: true,
    audioPlan: audio.plan,
    workerCapabilities: CAPABILITIES,
  });
  if (!plan.ok) throw new Error(`render plan refused: ${plan.issues.join(". ")}`);
  return plan.payload;
}

test("the golden render payload still matches what the portal builds", () => {
  const payload = buildGolden();
  if (process.env.GOLDEN_WRITE === "1") {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
  assert.deepEqual(payload, golden);
});

test("the golden payload is the contract a worker has to honour", () => {
  const p = JSON.parse(readFileSync(FIXTURE, "utf8")) as import("./render.ts").RenderPayload;
  // the engine the worker dispatches on
  assert.equal(p.engine, "remotion-2d");
  // a fade overlaps the shots, so they add up to more than the narration by exactly the overlap
  assert.equal(p.transitionSec, 0.5);
  const sum = p.shots.reduce((n, s) => n + s.seconds, 0);
  assert.ok(Math.abs(sum - p.durationSec - (p.shots.length - 1) * p.transitionSec) < 0.01, `sum ${sum} duration ${p.durationSec}`);
  assert.ok(Math.abs(p.durationSec - p.narrationSec) < 0.01);
  // every scene lines up with the shot that carries it
  assert.ok(p.scenePlan);
  assert.equal(p.scenePlan?.scenes.length, p.shots.length);
  assert.ok(p.scenePlan?.scenes.every((s, i) => s.shotRef === p.shots[i].shotRef));
  // the declared content survives, with its data
  assert.deepEqual(p.scenePlan?.scenes[2].elements[0], { kind: "bar", text: "draw ratio", series: [0.2, 0.45, 0.7, 0.95] });
  // captions end with the narration, not with the shots
  assert.equal(p.captions.at(-1)?.end, p.narrationSec);
  // caption geometry for a portrait frame, floored at the safe area, and its font listed as an input
  assert.equal(p.captionStyle?.fontSizePx, 78);
  assert.equal(p.captionStyle?.marginBottomPx, 154);
  assert.equal(p.captionStyle?.fontAssetId, "asset-font");
  assert.ok(p.inputs.includes("asset-font"), "the burn-in font is an input the worker downloads");
  // three audio layers, and a bed short enough that it has to be looped
  assert.equal(p.audio?.bed?.cover, "loop");
  assert.equal(p.audio?.ambient?.color, "brown");
  assert.equal(p.audio?.master.targetLufs, p.targetLufs);
  assert.ok(p.inputs.includes("asset-bed"), "the bed is an input the worker downloads");
});