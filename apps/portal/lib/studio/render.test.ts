import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRenderPayload, captionCues, motionFor } from "./render.ts";

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
