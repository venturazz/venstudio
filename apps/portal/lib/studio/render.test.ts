import { test } from "node:test";
import assert from "node:assert/strict";
import { blankComposingShots, buildRenderPayload, captionCues, motionFor } from "./render.ts";
import { buildAudioPlan } from "./audio-plan.ts";
import { captionSpecFor } from "./caption-spec.ts";
import { buildScenePlan } from "./scene-plan.ts";

const shots = [
  { shotRef: "shot-01", seconds: 4 },
  { shotRef: "shot-02", seconds: 4 },
  { shotRef: "shot-03", seconds: 4 },
];
const assets = { "shot-01": "a1", "shot-02": "a2", "shot-03": "a3" };
const base = { format: "short" as const, shots, shotAssets: assets, narrationAssetId: "n1", narrationSec: 15, captions: ["One two.", "Three four five."], targetLufs: -14, maxShotSeconds: 6 };

test("buildRenderPayload rescales shots to the narration and lists inputs", () => {
  const r = buildRenderPayload({ ...base, runId: "run-1" });
  assert.ok(r.ok);
  if (!r.ok) return;
  const sum = r.payload.shots.reduce((n, s) => n + s.seconds, 0);
  assert.ok(Math.abs(sum - 15) < 0.01, String(sum));
  assert.equal(r.payload.width, 1080);
  assert.equal(r.payload.height, 1920);
  assert.equal(r.payload.fps, 30);
  assert.deepEqual(r.payload.inputs, ["a1", "a2", "a3", "n1"]);
  assert.equal(r.payload.runId, "run-1");
  assert.equal(r.payload.targetLufs, -14);
  assert.equal(r.payload.captions.length, 2);
  assert.equal(r.payload.captions[1].end, 15);
});

test("buildRenderPayload clamps by template pacing", () => {
  const r = buildRenderPayload({ ...base, narrationSec: 30 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues[0] : "", /at most 18 s/);
  const ok = buildRenderPayload({ ...base, narrationSec: 17.8 });
  assert.ok(ok.ok);
  if (ok.ok) assert.ok(ok.payload.shots.every((s) => s.seconds <= 6));
});

test("buildRenderPayload rejects narration shorter than the minimum shots", () => {
  const r = buildRenderPayload({ ...base, narrationSec: 2 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues[0] : "", /Remove shots/);
});

test("buildRenderPayload names shots without an asset and a missing narration", () => {
  const r = buildRenderPayload({ ...base, shotAssets: { ...assets, "shot-02": null }, narrationAssetId: null });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.issues.some((i) => i.includes("shot-02")));
    assert.ok(r.issues.some((i) => /no narration/.test(i)));
  }
  assert.equal(buildRenderPayload({ ...base, shots: [] }).ok, false);
});

test("motionFor is deterministic and cycles", () => {
  assert.equal(motionFor(0), motionFor(4));
  assert.notEqual(motionFor(0), motionFor(1));
  assert.equal(motionFor(2), motionFor(2));
});

test("captionCues spreads time by length and skips empties", () => {
  const c = captionCues(["aaaa", "", "bbbbbbbb"], 12);
  assert.equal(c.length, 2);
  assert.equal(c[0].end, 4);
  assert.equal(c[1].end, 12);
  assert.deepEqual(captionCues([], 10), []);
});

test("buildRenderPayload sends the font asset and lists it as an input", () => {
  const r = buildRenderPayload({ ...base, fontAssetId: "f1" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.payload.fontAssetId, "f1");
  assert.ok(r.payload.inputs.includes("f1"));
  const none = buildRenderPayload(base);
  assert.ok(none.ok);
  if (none.ok) assert.equal(none.payload.fontAssetId, null);
});

test("buildRenderPayload names the engine, stills unless asked otherwise", () => {
  const d = buildRenderPayload(base);
  assert.ok(d.ok);
  if (d.ok) {
    assert.equal(d.payload.engine, "ffmpeg-stills");
    assert.equal(d.payload.transitionSec, 0);
  }
  const r = buildRenderPayload({ ...base, engine: "remotion-2d" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.payload.engine, "remotion-2d");
  const bad = buildRenderPayload({ ...base, engine: "no-such-engine" });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.issues[0] : "", /Unknown render engine/);
});

test("a cross-fade lengthens the shots by the overlap so the narration still fits", () => {
  const r = buildRenderPayload({ ...base, transitionSec: 0.5 });
  assert.ok(r.ok);
  if (!r.ok) return;
  const sum = r.payload.shots.reduce((n, s) => n + s.seconds, 0);
  // three shots, two overlaps of 0.5 s: the shots grow to 16 s and the video is 15 s
  assert.ok(Math.abs(sum - 16) < 0.01, String(sum));
  assert.equal(r.payload.transitionSec, 0.5);
  assert.ok(Math.abs(r.payload.durationSec - 15) < 0.01, String(r.payload.durationSec));
});

test("buildRenderPayload refuses a cross-fade that would eat a shot", () => {
  const r = buildRenderPayload({ ...base, transitionSec: 4 });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues[0] : "", /leaves shot/);
});

test("buildRenderPayload carries an animating scene plan and gates its engine", () => {
  const sceneShots = [
    { beatRole: "hook" as const, seconds: 5, description: "It starts here.", imagePrompt: "plate one" },
    { beatRole: "body" as const, seconds: 5, description: "Then a bar rises.", imagePrompt: "plate two" },
    { beatRole: "outro" as const, seconds: 5, description: "That is all.", imagePrompt: "plate three" },
  ];
  const sp = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: sceneShots });
  assert.ok(sp.ok);
  if (!sp.ok) return;

  const r = buildRenderPayload({ ...base, engine: "remotion-2d", scenePlan: sp.plan });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.payload.engine, "remotion-2d");
    assert.equal(r.payload.scenePlan?.scenes.length, 3);
  }

  // an engine the worker cannot run is refused here instead of falling through to stills
  const gated = buildRenderPayload({ ...base, engine: "remotion-2d", workerCapabilities: ["ffmpeg"] });
  assert.equal(gated.ok, false);
  assert.match(!gated.ok ? gated.issues.join(" | ") : "", /needs capability "remotion-2d"/);
  assert.ok(buildRenderPayload({ ...base, engine: "remotion-2d", workerCapabilities: ["ffmpeg", "remotion-2d"] }).ok);

  // a scene plan built for another engine cannot be rendered by this one
  const mixed = buildRenderPayload({ ...base, engine: "ffmpeg-stills", scenePlan: sp.plan });
  assert.equal(mixed.ok, false);
  assert.match(!mixed.ok ? mixed.issues.join(" | ") : "", /scene plan is for engine/);
});

test("buildRenderPayload: a fitted narration carries narrationTempo and plans for the played length; none means no field", () => {
  const plain = buildRenderPayload({ ...base, runId: "run-1" });
  const unit = buildRenderPayload({ ...base, runId: "run-1", narrationTempo: 1 });
  assert.ok(plain.ok && unit.ok);
  if (!plain.ok || !unit.ok) return;
  // Byte-identical to a payload from before the field existed.
  assert.equal(JSON.stringify(unit.payload), JSON.stringify(plain.payload));
  assert.ok(!("narrationTempo" in plain.payload));
  // 19.2 s of speech played at 1.067x lasts 18 s: what three 6 s shots can cover.
  const raw = 19.2;
  const fitted = buildRenderPayload({ ...base, narrationSec: raw / 1.067, narrationTempo: 1.067 });
  assert.ok(fitted.ok);
  if (!fitted.ok) return;
  assert.equal(fitted.payload.narrationTempo, 1.067);
  assert.equal(fitted.payload.narrationSec, 17.994);
  assert.ok(Math.abs(fitted.payload.durationSec - 17.994) < 0.01);
  assert.equal(fitted.payload.captions.at(-1)?.end, 17.994);
  // Without the tempo the same narration does not fit.
  assert.equal(buildRenderPayload({ ...base, narrationSec: raw }).ok, false);
});

test("the payload carries caption geometry and the audio layers, and lists the bed as an input", () => {
  const captionSpec = captionSpecFor({ width: 1080, height: 1920, fontAssetId: "f1" });
  const audio = buildAudioPlan({ policy: "self-or-licensed", narrated: true, durationSec: 15, bed: { assetId: "bed-1", durationSec: 10 } });
  assert.ok(audio.ok);
  if (!audio.ok) return;
  const r = buildRenderPayload({ ...base, fontAssetId: "f1", captionSpec, audioPlan: audio.plan });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.payload.captionStyle?.fontSizePx, captionSpec.fontSizePx);
  assert.equal(r.payload.audio?.bed?.assetId, "bed-1");
  assert.equal(r.payload.audio?.bed?.cover, "loop");
  assert.equal(r.payload.audio?.ambient?.color, "brown");
  // the worker can only mix what it can download
  assert.ok(r.payload.inputs.includes("bed-1"));
});

test("an audio plan that masters somewhere else is refused, so one number wins", () => {
  const audio = buildAudioPlan({ policy: "self-or-licensed", narrated: true, durationSec: 15, targetLufs: -16 });
  assert.ok(audio.ok);
  if (!audio.ok) return;
  const r = buildRenderPayload({ ...base, audioPlan: audio.plan });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues.join(" | ") : "", /masters at -16 LUFS/);
});

test("caption geometry that leaves the words nowhere to go fails the plan", () => {
  const spec = { ...captionSpecFor({ width: 1080, height: 1920 }), fontAssetId: null };
  const r = buildRenderPayload({ ...base, captionSpec: spec, captionRequired: true });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.issues.join(" | ") : "", /no font/);
});

test("a composing look's shot with nothing to build is named, before a frame is drawn", () => {
  // The page used to fill this gap from its own kit: four scripts, one village. It is a pipeline defect, so the render
  // refuses it and says which shots, rather than drawing something the story never asked for.
  const shots = [
    { intent: { parts: [{ kind: "box" }] } },
    { intent: { structure: "gate" } },
    {},
    { intent: {} },
    { intent: { parts: [] } },
  ];
  assert.deepEqual(blankComposingShots(shots), [3, 4, 5]);
  assert.deepEqual(blankComposingShots([{ intent: { parts: [{ kind: "box" }] } }]), []);
});
