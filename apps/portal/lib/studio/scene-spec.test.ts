// The scene spec of a data-driven page (recipe scene-spec): prompt, validator against the pack's contract, the gate
// (pacing, narration coverage, sourced numbers) and the render plan it feeds. docs/style-packs.md, "Workflows".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { researchPrompt, SCENE_SPEC_RESEARCH_LINES, type DirectorContext, type ResearchNote } from "./director.ts";
import { numbersInText, readSceneSpec, sceneSpecGate, sceneSpecLines, sceneSpecPrompt, sceneSpecShots, sourcingIssues, validateSceneSpec, type SpecContract } from "./scene-spec.ts";
import { buildScenePlan } from "./scene-plan.ts";
import { buildRenderPayload } from "./render.ts";
import { packSeedTemplate, parsePack, styleFromPack } from "./style-registry.ts";
import { planReview, SCENE_SPEC_PREVIEW_NOTE } from "./plan-review.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const graph = parsePack(JSON.parse(readFileSync(path.join(STYLES_DIR, "packs/animated-line-graph/style.json"), "utf8")), lock.packs.find((p) => p.id === "animated-line-graph")!.sha256)!;
const template = packSeedTemplate(graph);
const CONTRACT: SpecContract = { name: graph.name, elements: graph.plan!.elements!, motionTokens: graph.plan!.motionTokens! };

const NOTES: ResearchNote[] = [
  { claim: "Global solar capacity was 40 GW in 2010 and 1,200 GW in 2023", sourceUrl: "https://example.org/solar", sourced: true, summary: "Series: 40 (2010), 140 (2014), 500 (2019), 1,200 (2023) GW." },
  { claim: "Solar is the cheapest new power in most countries", sourceUrl: "", sourced: false, summary: "Costs fell by about 90 percent in a decade." },
];

const goodSpec = () => ({
  scenes: [
    { seconds: 4, beat: "body", elements: [{ kind: "heading", text: "Solar capacity" }], tokens: ["draw"], caption: "Solar power grew faster than anyone planned." },
    { seconds: 4, beat: "body", elements: [{ kind: "bar", text: "GW", series: [40, 140, 500, 1200], labels: ["2010", "2014", "2019", "2023"], source: 1 }], tokens: ["draw", "counter"], caption: "From forty gigawatts to twelve hundred." },
    { seconds: 4, beat: "body", elements: [{ kind: "counter", text: "GW in 2023", value: 1200, source: 1 }], tokens: ["counter"], caption: "That is thirty times more." },
  ],
});

test("the validator checks the shape against the pack's contract: elements, motion tokens, value, series and labels", () => {
  const ok = validateSceneSpec(goodSpec(), { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(ok.ok, ok.ok ? "" : ok.issues.join("; "));
  const with_ = (edit: (s: any) => void) => {
    const s = goodSpec() as any;
    edit(s);
    const r = validateSceneSpec(s, { contract: CONTRACT, noteCount: NOTES.length });
    return r.ok ? [] : r.issues;
  };
  assert.deepEqual(CONTRACT.elements, ["heading", "counter", "bar"]);
  assert.ok(with_((s) => (s.scenes[0].elements = [{ kind: "plate" }])).some((i) => /Scene 1 element 1 is a plate, which Animated line graph \(html-capture\) does not draw\. Use heading, counter, bar\./.test(i)), "an element the page does not draw");
  assert.ok(with_((s) => (s.scenes[0].elements = [{ kind: "sparkle" }])).some((i) => /kind must be one of/.test(i)));
  assert.ok(with_((s) => (s.scenes[0].tokens = ["whip"])).some((i) => /Scene 1 tokens may only be draw, counter, dim/.test(i)), "a motion token outside the contract");
  assert.ok(with_((s) => (s.scenes[0].tokens = [])).some((i) => /Scene 1 needs a motion token/.test(i)));
  assert.ok(with_((s) => (s.scenes[1].elements[0].series = [1, 2, 3, 4, 5, 6, 7])).some((i) => /series must be 1 to 6 numbers/.test(i)));
  assert.ok(with_((s) => (s.scenes[1].elements[0].series = [1, "2"])).some((i) => /series must be 1 to 6 numbers/.test(i)));
  assert.ok(with_((s) => (s.scenes[1].elements[0].labels = ["2010"])).some((i) => /one label per series value/.test(i)));
  assert.ok(with_((s) => (s.scenes[2].elements[0].value = Number.POSITIVE_INFINITY)).some((i) => /value must be a number/.test(i)));
  assert.ok(with_((s) => (s.scenes[2].elements[0].value = 1e16)).some((i) => /value must be a number up to/.test(i)), "a value out of range");
  assert.ok(with_((s) => (s.scenes[2].elements[0].source = 3)).some((i) => /source must be the number of a research note, 1 to 2/.test(i)));
  assert.ok(with_((s) => (s.scenes[0].seconds = 0)).some((i) => /Scene 1 seconds must be a number above 0/.test(i)));
  assert.ok(with_((s) => (s.scenes[0].beat = "middle")).some((i) => /beat must be one of/.test(i)));
  assert.ok(with_((s) => (s.scenes[0].caption = "")).some((i) => /Scene 1 caption is empty/.test(i)));
  assert.ok(with_((s) => (s.scenes = [])).some((i) => /scenes must hold 1 to/.test(i)));
  assert.deepEqual(validateSceneSpec({ shots: [] }, { contract: CONTRACT, noteCount: 1 }), { ok: false, issues: ["Expected an object with a scenes array"] });
});

test("every number must come from a sourced research note: an unsourced number fails the gate, by name", () => {
  const spec = validateSceneSpec(goodSpec(), { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(spec.ok);
  assert.deepEqual(sourcingIssues(spec.value, NOTES), []);
  const g = sceneSpecGate(template, spec.value, NOTES, 11);
  assert.deepEqual([g.gate, g.passed, g.issues], ["G-storyboard", true, []]);
  const edit = (f: (s: any) => void) => {
    const s = goodSpec() as any;
    f(s);
    const v = validateSceneSpec(s, { contract: CONTRACT, noteCount: NOTES.length });
    assert.ok(v.ok, v.ok ? "" : v.issues.join("; "));
    return sceneSpecGate(template, v.value, NOTES, 11);
  };
  const uncited = edit((s) => delete s.scenes[2].elements[0].source);
  assert.equal(uncited.passed, false);
  assert.deepEqual(uncited.issues, ["Scene 3 counter shows 1200 but cites no research note. Numbers must come from the research notes; never invent data."]);
  const invented = edit((s) => (s.scenes[1].elements[0].series = [40, 140, 777, 1200]));
  assert.deepEqual(invented.issues, ["Scene 2 bar shows 777, which note 1 does not contain. Numbers must come from the research notes; never invent data."]);
  const noLink = edit((s) => (s.scenes[2].elements[0] = { kind: "counter", value: 90, source: 2 }));
  assert.deepEqual(noLink.issues, ["Scene 3 counter cites note 2, which has no source link. Numbers must come from the research notes; never invent data."]);
  const inText = edit((s) => (s.scenes[0].elements[0].text = "Solar grew 45 times"));
  assert.match(inText.issues.join(" "), /Scene 1 heading text "Solar grew 45 times" has 45, which no sourced research note contains/);
  const sourcedText = edit((s) => (s.scenes[0].elements[0].text = "From 2010 to 2023"));
  assert.equal(sourcedText.passed, true, "a year a sourced note gives may be shown");
  // Written forms: thousands separators, multipliers and percentages.
  assert.deepEqual(numbersInText("1,200 GW; 3.5 million homes; 45%"), [1200, 3.5, 3500000, 45, 0.45]);
});

test("pacing and narration coverage use the storyboard's shared limits, worded for scenes", () => {
  const spec = validateSceneSpec(goodSpec(), { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(spec.ok);
  const long = sceneSpecGate(template, spec.value, NOTES, 60);
  assert.equal(long.passed, false);
  assert.match(long.issues.join(" "), /The narration is about 60 s but 3 scene\(s\) of at most \d+ s cover only \d+ s\. Add at least \d+ more scene\(s\)/);
  const tooLongScene = { scenes: spec.value.scenes.map((s, i) => (i === 0 ? { ...s, seconds: template.pacing.maxShotSeconds + 1 } : s)) };
  assert.match(sceneSpecGate(template, tooLongScene, NOTES).issues.join(" "), /1 scene\(s\) longer than/);
});

test("the spec feeds the scene plan and the render payload directly: no picture, the worker contract unchanged", () => {
  const spec = validateSceneSpec(goodSpec(), { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(spec.ok);
  const shots = sceneSpecShots(spec.value);
  assert.ok(shots.every((s) => s.imagePrompt === ""), "no image prompt anywhere");
  assert.deepEqual(shots[1].onScreen, { elements: [{ kind: "bar", text: "GW", series: [40, 140, 500, 1200] }], tokens: ["draw", "counter"] }, "labels and sources stay in the spec");
  const plan = buildScenePlan({ styleId: graph.id, format: "short", shots, transitionSec: 0, style: styleFromPack(graph) });
  assert.ok(plan.ok, plan.ok ? "" : plan.issues.join("; "));
  assert.equal(plan.plan.engine, "html-capture");
  assert.equal(plan.plan.template, "animated-line-graph");
  assert.deepEqual(plan.plan.scenes[2].elements, [{ kind: "counter", text: "GW in 2023", value: 1200 }]);
  assert.deepEqual(plan.plan.scenes[1].tokens, ["draw", "counter"]);
  const plate = "00000000-0000-4000-8000-0000000000aa";
  const refs = plan.plan.scenes.map((s) => s.shotRef);
  const payload = buildRenderPayload({
    format: "short",
    shots: refs.map((r, i) => ({ shotRef: r, seconds: shots[i].seconds })),
    shotAssets: Object.fromEntries(refs.map((r) => [r, plate])),
    narrationAssetId: "00000000-0000-4000-8000-0000000000bb",
    narrationSec: 12,
    captions: spec.value.scenes.map((s) => s.caption),
    targetLufs: -14,
    maxShotSeconds: template.pacing.maxShotSeconds,
    engine: "html-capture",
    transitionSec: 0,
    scenePlan: plan.plan,
  });
  assert.ok(payload.ok, payload.ok ? "" : payload.issues.join("; "));
  assert.deepEqual(payload.payload.inputs, [plate, "00000000-0000-4000-8000-0000000000bb"], "one plate for every shot, then the narration");
  assert.ok(!JSON.stringify(payload.payload).includes("labels"), "the worker gets kind, text, value and series only");
});

test("the prompt carries the contract, the numbered notes and the never-invent rule; research asks for numbers only in scene-spec runs", () => {
  const ctx: DirectorContext = { niche: "Energy facts", plan: "Short data videos", language: "en", format: "short", durationSec: 30, template, topicHint: "Solar growth" };
  const [, user] = sceneSpecPrompt(ctx, "Solar power grew faster than anyone planned. From forty gigawatts to twelve hundred. That is thirty times more.", NOTES, CONTRACT);
  assert.match(user.content, /^VENSTUDIO_STAGE: scene-spec$/m);
  assert.match(user.content, /On-screen elements this style allows: heading, counter, bar\./);
  assert.match(user.content, /Motion tokens this style allows: draw, counter, dim\./);
  assert.match(user.content, /1\. Global solar capacity was 40 GW in 2010 and 1,200 GW in 2023 \(source: https:\/\/example\.org\/solar\)/);
  assert.match(user.content, /2\. Solar is the cheapest .* \(no source\)/);
  assert.match(user.content, /Never invent data/);
  assert.match(user.content, /use at least \d+ scenes/);
  assert.doesNotMatch(user.content, /imagePrompt|image_gen/);
  const idea = { title: "Solar growth", hook: "It grew 30 times", angle: "One number" };
  const plain = researchPrompt(ctx, idea)[1].content;
  const data = researchPrompt({ ...ctx, recipe: "scene-spec" }, idea)[1].content;
  for (const line of SCENE_SPEC_RESEARCH_LINES) {
    assert.ok(data.includes(line));
    assert.ok(!plain.includes(line), "an image-sequence run's research prompt is unchanged");
  }
  assert.equal(researchPrompt({ ...ctx, recipe: "hermes-skill" }, idea)[1].content, plain, "hermes-skill research is unchanged too (research-only rules as before)");
});

test("the Review card shows the scene list as text and says there is no still preview yet", () => {
  const spec = validateSceneSpec(goodSpec(), { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(spec.ok);
  const lines = sceneSpecLines(spec.value);
  assert.equal(lines[1], "2. body, 4 s: bar \"GW\" 2010: 40, 2014: 140, 2019: 500, 2023: 1200 (note 1). Motion: draw, counter. Caption: From forty gigawatts to twelve hundred.");
  assert.deepEqual(planReview("scene-spec", spec.value), { plan: { kind: "scene-spec", lines, note: SCENE_SPEC_PREVIEW_NOTE } });
  assert.deepEqual(planReview("storyboard", spec.value), {}, "a storyboard card is unchanged");
  assert.deepEqual(readSceneSpec(JSON.parse(JSON.stringify(spec.value))), spec.value, "a stored spec reads back");
  assert.equal(readSceneSpec({ scenes: "x" }), null);
});
