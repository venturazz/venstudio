import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RENDER_ENGINE,
  MAX_UNCOVERED_REPORTED,
  MIN_TRANSITION_SEC,
  MOTION_TOKENS,
  capabilityForEngine,
  coverageIssues,
  engineExists,
  engineIssues,
  engineMotionIssues,
  fitTransitionSec,
  isMotionToken,
  motionCoverage,
  parseMotionTokens,
  planCrossFades,
  renderEngines,
  transitionFor,
  transitionForWorker,
  XFADE_CAPABILITY,
} from "./render-engine.ts";

test("every declared engine maps to a capability", () => {
  const ids = renderEngines();
  assert.ok(ids.length >= 6, `expected the six catalog engines, got ${ids.length}`);
  for (const id of ids) assert.equal(typeof capabilityForEngine(id), "string");
  assert.ok(engineExists(DEFAULT_RENDER_ENGINE));
  assert.equal(engineExists("no-such-engine"), false);
  assert.equal(capabilityForEngine("no-such-engine"), null);
});

test("engineIssues refuses an unknown engine and names the known ones", () => {
  const i = engineIssues({ engine: "nope", reported: ["ffmpeg"] });
  assert.equal(i.length, 1);
  assert.match(i[0], /Unknown render engine/);
  assert.ok(i[0].includes("ffmpeg-stills"));
});

test("engineIssues refuses an engine no worker reports", () => {
  const i = engineIssues({ engine: "remotion-2d", reported: ["ffmpeg", "tts-kokoro"] });
  assert.equal(i.length, 1);
  assert.match(i[0], /needs capability "remotion-2d"/);
  assert.match(i[0], /ffmpeg, tts-kokoro/);
});

test("engineIssues passes once the capability is reported", () => {
  assert.deepEqual(engineIssues({ engine: "remotion-2d", reported: ["ffmpeg", "remotion-2d"] }), []);
  assert.deepEqual(engineIssues({ engine: "ffmpeg-stills", reported: ["ffmpeg"] }), []);
});

test("engineIssues treats a capability no worker runs as unavailable", () => {
  const ids = renderEngines().filter((id) => ["provider", "blender"].includes(capabilityForEngine(id) as string));
  if (ids.length === 0) return;
  const i = engineIssues({ engine: ids[0], reported: ["ffmpeg", "blender", "provider"] });
  assert.equal(i.length, 1);
  assert.match(i[0], /not run by a worker yet/);
});

test("transitionFor is deterministic and has nothing before the first shot", () => {
  assert.equal(transitionFor(0), "none");
  assert.notEqual(transitionFor(1), "none");
  assert.equal(transitionFor(1), transitionFor(7));
  assert.equal(transitionFor(2), transitionFor(2));
});

test("planCrossFades with no transition is a plain concatenation", () => {
  const p = planCrossFades([4, 4, 7], 0);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.starts, [0, 4, 8]);
  assert.deepEqual(p.offsets, [4, 8]);
  assert.equal(p.totalSec, 15);
  assert.equal(p.transitionSec, 0);
});

test("planCrossFades overlaps each adjacent pair and reports the shorter timeline", () => {
  const p = planCrossFades([6, 6, 6], 0.5);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.offsets, [5.5, 11]);
  assert.equal(p.totalSec, 17);
  assert.equal(p.transitionSec, 0.5);
});

test("planCrossFades refuses a fade that eats a shot", () => {
  const p = planCrossFades([6, 6, 6], 3);
  assert.equal(p.ok, false);
  assert.match(!p.ok ? p.issues[0] : "", /leaves shot 2/);
});

test("planCrossFades refuses lengths it cannot use", () => {
  assert.equal(planCrossFades([], 0).ok, false);
  assert.equal(planCrossFades([4, 0], 0).ok, false);
  assert.equal(planCrossFades([4, 4], -1).ok, false);
  assert.equal(planCrossFades([4, 4], MIN_TRANSITION_SEC / 2).ok, false);
});

test("a single shot has nothing to fade with", () => {
  const p = planCrossFades([5], 0.5);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.deepEqual(p.offsets, []);
  assert.equal(p.totalSec, 5);
  assert.equal(p.transitionSec, 0);
});

test("motion tokens are the ones the explainer skill declares", () => {
  assert.ok(MOTION_TOKENS.includes("parallax"));
  assert.ok(MOTION_TOKENS.includes("draw"));
  assert.equal(isMotionToken("parallax"), true);
  assert.equal(isMotionToken("slideshow"), false);
  assert.deepEqual(parseMotionTokens("draw: gauge, then [whip] and drift"), ["draw", "gauge", "whip", "drift"]);
  assert.deepEqual(parseMotionTokens("nothing here"), []);
});

test("coverage counts beats that move and names those that do not", () => {
  const r = motionCoverage([{ label: "hook", tokens: ["pop"], camera: true }, { label: "setup", camera: true }, { label: "body" }]);
  assert.equal(r.total, 3);
  assert.equal(r.covered, 2);
  assert.deepEqual(r.uncovered, [2]);
  const i = coverageIssues([{ label: "hook", camera: true }, { label: "body" }]);
  assert.equal(i.length, 1);
  assert.match(i[0], /Only 1 of 2 beats/);
  assert.match(i[0], /beat 2 \("body"\)/);
});

test("coverage reads tokens out of the beat text too", () => {
  const r = motionCoverage([{ text: "the bar rises with a counter" }, { text: "quiet line" }]);
  assert.equal(r.covered, 1);
  assert.deepEqual(r.uncovered, [1]);
});

test("coverage is quiet when every beat moves, and on an empty plan", () => {
  assert.deepEqual(coverageIssues([{ camera: true }, { tokens: ["flicker"] }]), []);
  assert.deepEqual(coverageIssues([]), []);
});

test("coverage reports at most MAX_UNCOVERED_REPORTED beats and says how many more", () => {
  const many = Array.from({ length: MAX_UNCOVERED_REPORTED + 3 }, (_, i) => ({ label: `b${i}` }));
  const i = coverageIssues(many);
  assert.equal(i.length, 1);
  assert.match(i[0], /0 of 9 beats/);
  assert.match(i[0], /and 3 more/);
});

test("a plan may not hand motion tokens to the stills engine", () => {
  const beats = [{ label: "body", tokens: ["morph"] }];
  const i = engineMotionIssues("ffmpeg-stills", beats);
  assert.equal(i.length, 1);
  assert.match(i[0], /only moves stills/);
  assert.deepEqual(engineMotionIssues("remotion-2d", beats), []);
  assert.deepEqual(engineMotionIssues("ffmpeg-stills", [{ camera: true }]), []);
  assert.deepEqual(engineMotionIssues("ffmpeg-stills", [{ text: "a slow drift" }]), []);
  assert.deepEqual(engineMotionIssues("no-such-engine", beats), []);
});

test("fitTransitionSec keeps a fade inside the shots it joins", () => {
  assert.equal(fitTransitionSec([6, 6, 6], 0.5), 0.5);
  // with two shots each one joins a single fade, so the cap is the whole 1.6 s of room
  assert.equal(fitTransitionSec([2, 2], 3), 1.6);
  assert.equal(fitTransitionSec([5], 0.5), 0);
  assert.equal(fitTransitionSec([0.5, 0.5], 0.5), 0);
  assert.equal(fitTransitionSec([6, 6], 0), 0);
  assert.equal(fitTransitionSec([6, 6], -1), 0);
  assert.equal(fitTransitionSec([4, 0], 0.5), 0);
});

test("whatever fitTransitionSec returns, planCrossFades accepts", () => {
  for (const secs of [[6, 6, 6], [2, 2], [3, 5, 2], [1, 1, 1], [12]]) {
    const d = fitTransitionSec(secs, 1.5);
    if (d > 0) assert.equal(planCrossFades(secs, d).ok, true, `[${secs}] d=${d}`);
  }
});

test("fades stay off until a worker reports that it can build them", () => {
  assert.equal(transitionForWorker(undefined, [6, 6, 6]), 0);
  assert.equal(transitionForWorker(null, [6, 6, 6]), 0);
  assert.equal(transitionForWorker([], [6, 6, 6]), 0);
  assert.equal(transitionForWorker(["ffmpeg", "remotion-2d"], [6, 6, 6]), 0);
  // the switch is the capability, not a constant anyone has to remember to change
  assert.equal(transitionForWorker(["ffmpeg", XFADE_CAPABILITY], [6, 6, 6]), 0.5);
  // and a worker that can fade still cannot fade shots too short to spare the time
  assert.equal(transitionForWorker([XFADE_CAPABILITY], [0.5, 0.5]), 0);
  assert.equal(transitionForWorker([XFADE_CAPABILITY], [6], 0.5), 0);
});
