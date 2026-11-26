import { test } from "node:test";
import assert from "node:assert/strict";
import type { Shot } from "./director.ts";
import {
  MAX_ELEMENTS_PER_SCENE,
  PERSON_FPS,
  buildScenePlan,
  elementAnimationFor,
  renderParamsForStyle,
  scenePlanIssues,
  type ScenePlan,
} from "./scene-plan.ts";

const shot = (beatRole: Shot["beatRole"], seconds: number, description: string, imagePrompt = "a plate"): Shot => ({ beatRole, seconds, description, imagePrompt });

const animated: Shot[] = [
  shot("hook", 4, "It starts with a single bar of iron.", "foundry plate"),
  shot("setup", 5, "The furnace reaches 1400 degrees.", "glowing ingot"),
  shot("body", 5, "The hammer draws the shape out, counter by counter.", "hammering"),
  shot("payoff", 5, "The finished blade mocks every test.", "finished blade"),
  shot("outro", 3, "Subscribe for the next one.", "workshop at night"),
];

test("an animating style gets motion tokens and elements", () => {
  const r = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: animated });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.engine, "remotion-2d");
  assert.equal(r.plan.template, "explainer-flat-vector");
  assert.equal(r.plan.scenes.length, 5);
  assert.equal(r.plan.width, 1080);
  assert.equal(r.plan.height, 1920);
  // the beat role carries a default token, and the text adds more
  assert.ok(r.plan.scenes[0].tokens.includes("pop"));
  assert.ok(r.plan.scenes[2].tokens.includes("draw"));
  assert.ok(r.plan.scenes[2].tokens.includes("counter"));
  // the hook moves the camera, then every second scene
  assert.equal(r.plan.scenes[0].camera, true);
  assert.equal(r.plan.scenes[1].camera, false);
  assert.equal(r.plan.scenes[2].camera, true);
  // a heading is always on screen, and the style draws an image under it
  assert.equal(r.plan.scenes[0].elements[0].kind, "heading");
  assert.ok(r.plan.scenes[0].elements.some((e) => e.kind === "plate"));
  // the counters in the text become a counter element
  assert.ok(r.plan.scenes[1].elements.some((e) => e.kind === "counter" && e.text === "1400"));
});

test("a stills style is given a camera move instead of element tokens", () => {
  const r = buildScenePlan({ styleId: "documentary", format: "short", shots: animated });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.engine, "ffmpeg-stills");
  for (const s of r.plan.scenes) {
    assert.deepEqual(s.tokens, ["drift"]);
    assert.equal(s.camera, true);
  }
  assert.ok(r.warnings.some((w) => /moves the camera rather than the elements/.test(w)));
});

test("a style with sprite sheets gets layers on their own clocks", () => {
  const r = buildScenePlan({ styleId: "parallax-2-5d", format: "short", shots: animated });
  assert.ok(r.ok);
  if (!r.ok) return;
  const s = r.plan.scenes[1];
  const ids = s.layers.map((l) => l.id);
  assert.deepEqual(ids, ["plate", "person", "prop-a", "prop-b"]);
  assert.equal(s.layers[0].frames, 1);
  assert.equal(s.layers[1].frames, Math.round(5 * PERSON_FPS));
  const clocks = new Set(s.layers.filter((l) => l.frames > 1).map((l) => l.fps));
  assert.ok(clocks.size >= 2, `expected independent clocks, got ${[...clocks].join(", ")}`);
});

test("a style without sprite sheets gets one scene layer", () => {
  const r = buildScenePlan({ styleId: "kinetic-facts", format: "short", shots: animated });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.scenes[0].layers.map((l) => l.id), ["plate", "scene"]);
  assert.equal(r.plan.scenes[0].layers[1].fps, 30);
});

test("buildScenePlan refuses a style or format it does not know", () => {
  const a = buildScenePlan({ styleId: "no-such-style", format: "short", shots: animated });
  assert.equal(a.ok, false);
  assert.match(!a.ok ? a.issues[0] : "", /Unknown style/);
  const b = buildScenePlan({ styleId: "explainer-flat-vector", format: "no-such-format" as never, shots: animated });
  assert.equal(b.ok, false);
  assert.match(!b.ok ? b.issues[0] : "", /Unknown format/);
  const c = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: [] });
  assert.equal(c.ok, false);
  assert.match(!c.ok ? c.issues[0] : "", /no shots/);
});

test("short shots degrade to hard cuts instead of failing", () => {
  const r = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: [shot("hook", 0.5, "One."), shot("body", 0.5, "Two.")] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.plan.transitionSec, 0);
  assert.ok(r.warnings.some((w) => /too short for a cross-fade/.test(w)));
});

test("a long-enough set of shots keeps the cross-fade", () => {
  const r = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: animated });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.plan.transitionSec > 0, String(r.plan.transitionSec));
});

const planOf = (over: Partial<ScenePlan> = {}): ScenePlan => {
  const base = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: animated });
  if (!base.ok) throw new Error("fixture failed to build");
  return { ...base.plan, ...over };
};

test("the coverage gate fires for a beat that neither moves nor animates", () => {
  const plan = planOf();
  plan.scenes[1] = { ...plan.scenes[1], tokens: [], camera: false };
  const issues = scenePlanIssues(plan);
  assert.ok(issues.some((i) => /carry an animated element or a camera move/.test(i)), issues.join(" | "));
});

test("the engine gate fires when the worker cannot run the engine", () => {
  const issues = scenePlanIssues(planOf(), { reported: ["ffmpeg", "tts-kokoro"] });
  assert.ok(issues.some((i) => /needs capability "remotion-2d"/.test(i)), issues.join(" | "));
  assert.deepEqual(scenePlanIssues(planOf(), { reported: ["ffmpeg", "remotion-2d"] }), []);
});

test("a scene with too many elements or an empty screen is refused", () => {
  const many = planOf();
  many.scenes[2] = { ...many.scenes[2], elements: Array.from({ length: MAX_ELEMENTS_PER_SCENE + 1 }, () => ({ kind: "bar" as const })) };
  assert.ok(scenePlanIssues(many).some((i) => /more than the 6 a template lays out/.test(i)));
  const empty = planOf();
  empty.scenes[2] = { ...empty.scenes[2], elements: [] };
  assert.ok(scenePlanIssues(empty).some((i) => /has nothing on screen/.test(i)));
});

test("a layered scene needs two clocks, and its layers need a clock at all", () => {
  const one = planOf();
  one.scenes[3] = { ...one.scenes[3], layers: [{ id: "plate", frames: 1, fps: 1 }, { id: "person", frames: 90, fps: 30 }, { id: "prop-a", frames: 9, fps: 30 }] };
  assert.ok(scenePlanIssues(one).some((i) => /fewer than two clocks/.test(i)));
  const bad = planOf();
  bad.scenes[3] = { ...bad.scenes[3], layers: [{ id: "plate", frames: 0, fps: 0 }] };
  const issues = scenePlanIssues(bad);
  assert.ok(issues.some((i) => /contributes no frames/.test(i)));
  assert.ok(issues.some((i) => /has no clock/.test(i)));
});

test("scenePlanIssues refuses a plan with no scenes or no frame size", () => {
  assert.ok(scenePlanIssues(planOf({ scenes: [] })).some((i) => /no scenes/.test(i)));
  assert.ok(scenePlanIssues(planOf({ width: 0 })).some((i) => /no frame size/.test(i)));
  assert.ok(scenePlanIssues(planOf({ fps: 0 })).some((i) => /no frame rate/.test(i)));
});

test("scenePlanIssues reports at most eight problems and counts the rest", () => {
  const plan = planOf();
  for (let i = 0; i < plan.scenes.length; i++) plan.scenes[i] = { ...plan.scenes[i], seconds: 0, elements: [], layers: [] };
  const issues = scenePlanIssues(plan);
  assert.equal(issues.length, 9);
  assert.match(issues[8], /^and \d+ more problem\(s\)$/);
});

test("elementAnimationFor reads the engine's capability", () => {
  assert.equal(elementAnimationFor("remotion-2d"), true);
  assert.equal(elementAnimationFor("manim"), true);
  assert.equal(elementAnimationFor("ffmpeg-stills"), false);
  assert.equal(elementAnimationFor("provider-video"), false);
  assert.equal(elementAnimationFor("blender-cycles"), false);
  assert.equal(elementAnimationFor("no-such-engine"), false);
});

test("renderParamsForStyle answers for a style and null for an unknown one", () => {
  const p = renderParamsForStyle("explainer-flat-vector");
  assert.ok(p);
  if (p) {
    assert.equal(p.engine, "remotion-2d");
    assert.equal(p.template, "explainer-flat-vector");
    assert.equal(p.elementAnimation, true);
    assert.ok(p.transitionSec > 0);
  }
  const stills = renderParamsForStyle("documentary");
  assert.equal(stills?.elementAnimation, false);
  assert.equal(renderParamsForStyle("nope"), null);
});

test("a declared on-screen spec outranks what the prose suggests", () => {
  const s = shot("body", 5, "This line mentions no numbers at all.", "a plate");
  s.onScreen = { elements: [{ kind: "bar", text: "yield", series: [0.3, 0.8] }, { kind: "callout", text: "the point" }], tokens: ["bar"] };
  const r = buildScenePlan({ styleId: "explainer-flat-vector", format: "short", shots: [s] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const scene = r.plan.scenes[0];
  assert.deepEqual(scene.tokens, ["bar"]);
  assert.deepEqual(scene.elements, [
    { kind: "bar", text: "yield", series: [0.3, 0.8] },
    { kind: "callout", text: "the point" },
  ]);
});

test("a stills engine keeps the declared content but drops its motion", () => {
  const s = shot("body", 5, "A bar rises.");
  s.onScreen = { elements: [{ kind: "bar", series: [1, 2] }], tokens: ["bar"] };
  const r = buildScenePlan({ styleId: "documentary", format: "short", shots: [s] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.plan.scenes[0].elements, [{ kind: "bar", series: [1, 2] }]);
  assert.deepEqual(r.plan.scenes[0].tokens, ["drift"]);
  assert.equal(r.plan.scenes[0].camera, true);
});
