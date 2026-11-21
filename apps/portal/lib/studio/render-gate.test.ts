import { test } from "node:test";
import assert from "node:assert/strict";
import { gateCapabilities, renderJobCapability, renderStageError, withFadeFallback } from "./render-gate.ts";
import { buildRenderPayload } from "./render.ts";
import { engineIssues } from "./render-engine.ts";

test("gateCapabilities skips the gate when nothing is known, so a job still waits for a worker to enroll", () => {
  assert.equal(gateCapabilities(null), undefined);
  assert.equal(gateCapabilities(undefined), undefined);
  assert.equal(gateCapabilities([]), undefined);
  assert.deepEqual(gateCapabilities(["echo", "ffmpeg"]), ["echo", "ffmpeg"]);
});

test("renderJobCapability queues each engine under the capability that runs it; stills stay on ffmpeg", () => {
  assert.equal(renderJobCapability("ffmpeg-stills"), "ffmpeg");
  assert.equal(renderJobCapability("remotion-2d"), "remotion-2d");
  assert.equal(renderJobCapability("not-an-engine"), "ffmpeg");
});

const base = {
  format: "short" as const,
  shots: [
    { shotRef: "shot-01", seconds: 3 },
    { shotRef: "shot-02", seconds: 3 },
  ],
  shotAssets: { "shot-01": "a1", "shot-02": "a2" },
  narrationAssetId: "n1",
  narrationSec: 6,
  captions: ["One line."],
  targetLufs: -14,
  maxShotSeconds: 6,
};

test("a remotion-2d render with only ffmpeg workers fails at planning, naming the engine and the way forward", () => {
  const plan = buildRenderPayload({ ...base, engine: "remotion-2d", workerCapabilities: gateCapabilities(["echo", "ffmpeg"]) });
  assert.equal(plan.ok, false);
  const message = renderStageError(plan.ok ? [] : plan.issues, "remotion-2d");
  assert.match(message, /Engine "remotion-2d" needs capability "remotion-2d"/);
  assert.match(message, /not rendered as a slideshow/);
  assert.match(message, /--with-remotion/);
  assert.match(message, /press Retry/);
});

test("with no worker enrolled the stills render still plans, and so does remotion-2d once a worker reports it", () => {
  assert.equal(buildRenderPayload({ ...base, workerCapabilities: gateCapabilities([]) }).ok, true);
  assert.equal(buildRenderPayload({ ...base, engine: "remotion-2d", workerCapabilities: gateCapabilities(["ffmpeg", "remotion-2d"]) }).ok, true);
  assert.equal(buildRenderPayload({ ...base, engine: "ffmpeg-stills", workerCapabilities: gateCapabilities(["echo", "ffmpeg"]) }).ok, true);
});

test("renderStageError says each problem once and adds no hint for problems that are not the engine", () => {
  const issue = engineIssues({ engine: "remotion-2d", reported: ["ffmpeg"] })[0];
  const twice = renderStageError([issue, issue], "remotion-2d");
  assert.equal(twice.split("needs capability").length, 2, "the engine problem is listed once");
  assert.equal(renderStageError(["No image for shot-02"], "remotion-2d"), "No image for shot-02.");
  assert.match(renderStageError([engineIssues({ engine: "manim", reported: ["ffmpeg"] })[0]], "manim"), /Enable "manim" on a worker/);
});

test("a faded stills job is queued under xfade, so a worker that cannot build fades never claims it", () => {
  assert.equal(renderJobCapability("ffmpeg-stills", 0), "ffmpeg");
  assert.equal(renderJobCapability("ffmpeg-stills", 0.5), "xfade");
  // Remotion draws its own transitions.
  assert.equal(renderJobCapability("remotion-2d", 0.5), "remotion-2d");
});

test("withFadeFallback renders with hard cuts when only the fade does not fit the storyboard", () => {
  // Two 3 s shots at a 3 s limit cover 6.4 s of narration with hard cuts (within the 0.5 s tolerance), but a 0.5 s
  // fade leaves them only 5.5 s.
  const tight = { ...base, narrationSec: 6.4, maxShotSeconds: 3, workerCapabilities: ["ffmpeg", "xfade"] };
  assert.equal(buildRenderPayload({ ...tight, transitionSec: 0.5 }).ok, false, "the fade alone does not fit");
  const out = withFadeFallback(0.5, (t) => buildRenderPayload({ ...tight, transitionSec: t }));
  assert.equal(out.transitionSec, 0);
  assert.equal(out.result.ok, true);
  if (out.result.ok) assert.equal(out.result.payload.transitionSec, 0);
  // With room for it the fade is kept.
  const roomy = withFadeFallback(0.5, (t) => buildRenderPayload({ ...base, workerCapabilities: ["ffmpeg", "xfade"], transitionSec: t }));
  assert.equal(roomy.transitionSec, 0.5);
  assert.ok(roomy.result.ok && roomy.result.payload.durationSec === 6 && roomy.result.payload.transitionSec === 0.5);
  // When hard cuts fail too, the problem is reported as it was with the fade.
  const blocked = withFadeFallback(0.5, (t) => buildRenderPayload({ ...base, engine: "remotion-2d", workerCapabilities: ["ffmpeg"], transitionSec: t }));
  assert.equal(blocked.result.ok, false);
  assert.equal(blocked.transitionSec, 0.5);
});
