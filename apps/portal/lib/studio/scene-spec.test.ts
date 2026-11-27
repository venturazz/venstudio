// The scene spec of a data-driven page (recipe scene-spec): prompt, validator against the pack's contract, the gate
// (pacing, narration coverage, sourced numbers) and the render plan it feeds. docs/style-packs.md, "Workflows".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { researchPrompt, SCENE_SPEC_RESEARCH_LINES, type DirectorContext, type ResearchNote } from "./director.ts";
import { numbersInText, readSceneSpec, scriptNumberIssues, sceneSpecGate, sceneSpecLines, sceneSpecPrompt, sceneSpecShots, sourcingIssues, validateSceneSpec, type SpecContract } from "./scene-spec.ts";
import { buildScenePlan } from "./scene-plan.ts";
import { buildRenderPayload } from "./render.ts";
import { packSeedTemplate, parsePack, styleFromPack } from "./style-registry.ts";
import { planReview, SCENE_SPEC_PREVIEW_NOTE } from "./plan-review.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const graph = parsePack(JSON.parse(readFileSync(path.join(STYLES_DIR, "packs/line-graph/style.json"), "utf8")), lock.packs.find((p) => p.id === "line-graph")!.sha256)!;
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
  assert.ok(with_((s) => (s.scenes[0].elements = [{ kind: "plate" }])).some((i) => /Scene 1 element 1 is a plate, which Line Graph does not draw\. Use heading, counter, bar\./.test(i)), "an element the page does not draw");
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
  assert.equal(plan.plan.template, "line-graph");
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

test("a scene-spec script is on screen as captions: digits in it must be sourced numbers too", () => {
  assert.deepEqual(scriptNumberIssues("Solar grew from 40 gigawatts in 2010 to 1,200 in 2023.", NOTES), []);
  assert.deepEqual(scriptNumberIssues("Costs fell by 90 percent.", NOTES), [
    "The script says 90, which no sourced research note contains. Its captions are on screen, so numbers must come from the research notes; never invent data.",
  ], "note 2 says 90 percent but has no source link");
  assert.deepEqual(scriptNumberIssues("It grew thirty times.", NOTES), [], "numbers in words are not read");
});

// The story vocabulary: a look that builds what the script is about (voxel-build) names the words it can draw, and the
// spec must fill every slot from that list. docs/style-families.md, "contract.story".
const voxel = parsePack(JSON.parse(readFileSync(path.join(STYLES_DIR, "packs/voxel-build/style.json"), "utf8")), lock.packs.find((p) => p.id === "voxel-build")!.sha256)!;
const STORY: SpecContract = {
  name: voxel.name,
  elements: voxel.plan!.elements!,
  motionTokens: voxel.plan!.motionTokens!,
  story: voxel.plan!.story!,
};
const storySpec = () => ({
  scenes: [
    { seconds: 4, beat: "hook", elements: [{ kind: "heading", text: "The church burns" }], tokens: ["pop"], caption: "The village woke to smoke.", intent: { structure: "church", action: "build", focus: "structure" } },
    { seconds: 4, beat: "body", elements: [{ kind: "heading", text: "Ruined" }], tokens: ["pull"], caption: "By noon the roof was gone.", intent: { structure: "church", action: "damage", focus: "villager" } },
  ],
});

test("a pack with a vocabulary: every scene must fill the slots, from the list the pack can draw", () => {
  const ok = validateSceneSpec(storySpec(), { contract: STORY, noteCount: NOTES.length });
  assert.ok(ok.ok, ok.ok ? "" : ok.issues.join("; "));
  assert.deepEqual(ok.value.scenes[0].intent, { structure: "church", action: "build", focus: "structure" });
  const with_ = (edit: (s: any) => void) => {
    const s = storySpec() as any;
    edit(s);
    const r = validateSceneSpec(s, { contract: STORY, noteCount: NOTES.length });
    return r.ok ? [] : r.issues;
  };
  // A word the look cannot draw is refused with the list, not quietly swapped for a default.
  assert.ok(with_((s) => (s.scenes[0].intent.structure = "spaceship")).some((i) => /Scene 1 intent\.structure is "spaceship", which .* does not have in its kit\. Compose it from parts instead \(box, walls, roof/.test(i)));
  assert.ok(with_((s) => (s.scenes[1].intent.action = "explode")).some((i) => /It can draw: build, damage, idle/.test(i)));
  // Every slot is required: a missing one would leave the page guessing.
  assert.ok(with_((s) => delete s.scenes[0].intent.action).some((i) => /Scene 1 intent is missing action/.test(i)));
  assert.ok(with_((s) => delete s.scenes[0].intent).some((i) => /Scene 1 needs intent with structure, action, focus/.test(i)));
  // A slot the pack never declared is refused too, or the vocabulary would mean nothing.
  assert.ok(with_((s) => (s.scenes[0].intent.weather = "rain")).some((i) => /Scene 1 intent names "weather", which .* does not know/.test(i)));
});

// Composition: a subject the kit never modelled is built from primitives, not refused. docs/style-families.md, "parts".
test("a subject the kit never modelled is composed from parts, not refused", () => {
  const gate = [
    { kind: "walls", at: [1, 0, 0], size: [11, 7, 3], material: "mcl_core:stonebrick", openings: [{ at: [4, 0], w: 2, h: 4 }] },
    { kind: "cylinder", at: [0, 0, 0], radius: 2, height: 12, material: "mcl_core:cobble" },
    { kind: "roof", at: [0, 12, 0], size: [5, 5], style: "hip", rise: 3, material: "mcl_core:wood" },
  ];
  const spec = { scenes: [{ ...storySpec().scenes[0], intent: { parts: gate, action: "build", focus: "structure" } }] };
  const ok = validateSceneSpec(spec, { contract: STORY, noteCount: NOTES.length });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.value.scenes[0].intent, { parts: gate, action: "build", focus: "structure" });
  // The review card says what it is, not "[object Object]".
  assert.match(sceneSpecLines(ok.value)[0], /Story: parts: 3 pieces \(walls, cylinder, roof\), action: build, focus: structure\./);
  // Parts travel to the render payload exactly as reviewed, and a stored spec keeps them.
  assert.deepEqual(sceneSpecShots(ok.value)[0].intent, { parts: gate, action: "build", focus: "structure" });
  assert.deepEqual(readSceneSpec(JSON.parse(JSON.stringify(ok.value)))?.scenes[0].intent, { parts: gate, action: "build", focus: "structure" });
});

test("parts are checked for shape, not for subject", () => {
  const check = (parts: unknown) =>
    validateSceneSpec({ scenes: [{ ...storySpec().scenes[0], intent: { parts, action: "build", focus: "structure" } }] }, { contract: STORY, noteCount: NOTES.length });
  const issuesOf = (parts: unknown) => {
    const r = check(parts);
    return r.ok ? [] : r.issues;
  };
  assert.ok(issuesOf([{ kind: "space-elevator" }]).some((i) => /parts\[0\]\.kind is "space-elevator", not one of box, walls, roof/.test(i)));
  assert.ok(issuesOf([{ kind: "box", at: [0, 0, 999] }]).some((i) => /parts\[0\]\.at is outside -96\.\.96/.test(i)));
  assert.ok(issuesOf([{ kind: "box", material: "stone" }]).some((i) => /parts\[0\]\.material is "stone", not a block name/.test(i)));
  assert.ok(issuesOf(Array.from({ length: 65 }, () => ({ kind: "box" }))).some((i) => /more than 64/.test(i)));
  // Both at once is allowed: the kit name is a shortcut, and the page draws the parts.
  const both = validateSceneSpec(
    { scenes: [{ ...storySpec().scenes[0], intent: { structure: "church", parts: [{ kind: "box" }], action: "build", focus: "structure" } }] },
    { contract: STORY, noteCount: NOTES.length },
  );
  assert.ok(both.ok);
  assert.deepEqual(Object.keys(both.value.scenes[0].intent!), ["parts", "structure", "action", "focus"]);
});

test("a look without a vocabulary takes no intent, and the prompt asks for none", () => {
  const issues = validateSceneSpec({ scenes: [{ ...goodSpec().scenes[0], intent: { structure: "church" } }] }, { contract: CONTRACT, noteCount: NOTES.length });
  assert.ok(!issues.ok && issues.issues.some((i) => /Scene 1 names an intent, but Line Graph takes no story vocabulary/.test(i)));
  const plain = sceneSpecPrompt({} as DirectorContext, "Solar power grew.", NOTES, CONTRACT).map((m) => m.content).join("\n");
  assert.ok(!/intent/.test(plain), "no vocabulary, no intent in the ask");
  const withStory = sceneSpecPrompt({} as DirectorContext, "The village woke to smoke.", NOTES, STORY).map((m) => m.content).join("\n");
  assert.match(withStory, /every scene says how to build it in "intent"/);
  assert.match(withStory, /Shortcut, when the kit already has the thing: "structure" is one of well, farm/);
  assert.match(withStory, /These are closed lists: use one of the listed values, nothing else\./);
  assert.match(withStory, /"intent":\{"structure":"<one of well\|farm/);
  assert.match(withStory, /"parts":\[\{"kind":"<box\|walls\|roof/);
});

test("the story words reach the shot, the review card and the render payload; a stored spec keeps them", () => {
  const shots = sceneSpecShots(storySpec() as never);
  assert.deepEqual(shots[0].intent, { structure: "church", action: "build", focus: "structure" });
  assert.match(sceneSpecLines(storySpec() as never)[1], /Story: structure: church, action: damage, focus: villager\./);
  const back = readSceneSpec(JSON.parse(JSON.stringify(storySpec())));
  assert.deepEqual(back?.scenes[0].intent, { structure: "church", action: "build", focus: "structure" });
  // A stored spec from before the vocabulary has no intent, and is still readable.
  const old = readSceneSpec({ scenes: [{ seconds: 4, beat: "body", elements: [{ kind: "heading", text: "Village" }], tokens: ["pop"], caption: "Once." }] });
  assert.equal(old?.scenes[0].intent, undefined);
  const plan = buildRenderPayload({
    fontAssetId: null,
    format: "short",
    shots: sceneSpecShots(storySpec() as never).map((s) => ({ shotRef: "s", seconds: s.seconds, ...(s.intent ? { intent: s.intent } : {}) })),
    shotAssets: { s: "00000000-0000-4000-8000-000000000001" },
    narrationAssetId: "00000000-0000-4000-8000-000000000002",
    narrationSec: 8,
    captions: [],
    targetLufs: -14,
    maxShotSeconds: 6,
    engine: "html-capture",
    transitionSec: 0,
  });
  assert.ok(plan.ok, plan.ok ? "" : plan.issues.join("; "));
  assert.deepEqual(plan.payload.shots[0].intent, { structure: "church", action: "build", focus: "structure" });
});
