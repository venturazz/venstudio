// Workflows (recipes): the stage list per recipe and per vendored pack, inference, stored lists, and the engine's
// next stage, revision target and stuck detection over a run's own list. docs/style-packs.md, "Workflows".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUN_STAGES, STAGE_KINDS, isOrphaned, isRunStage, nextRunStage, revisionTarget, stageIndex, stageInRun, type RunStage } from "./engine.ts";
import {
  BUILT_RECIPES,
  RECIPES,
  RECIPE_IDS,
  alwaysReviewed,
  finalGatesFor,
  inferRecipe,
  parsePackWorkflow,
  parseRunWorkflow,
  recipeFitIssue,
  recipeVerdict,
  runRecipeOf,
  runStagesOf,
  workflowForPack,
  workflowText,
} from "./recipes.ts";
import { parseRunConfig, runSettings } from "./run-config.ts";
import { PUBLISH_GATES } from "./qc.ts";
import { parsePack, type StylePack } from "./style-registry.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const rawStyle = (id: string) => JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", id, "style.json"), "utf8")) as Record<string, unknown>;
const vendored: StylePack[] = lock.packs.map((p) => parsePack(rawStyle(p.id), p.sha256)!);
const pack = (id: string) => {
  const p = vendored.find((x) => x.id === id);
  assert.ok(p, id);
  return p;
};
interface Validator {
  RECIPES: Record<string, { implemented: boolean; stages: string[]; optional: string[] }>;
  STAGE_KINDS: string[];
  recipeOf: (s: unknown) => string;
  workflowStages: (s: unknown) => string[];
}
const V = (await import(pathToFileURL(path.join(STYLES_DIR, "tools/validate.mjs")).href)) as Validator;

const IMAGE: RunStage[] = ["idea", "research", "script", "storyboard", "assets", "voice", "render", "qc"];
const SCENE: RunStage[] = ["idea", "research", "script", "scene-spec", "voice", "render", "qc"];
const SKILL: RunStage[] = ["idea", "research", "script", "skill-brief", "voice", "render", "qc"];
const SKILL_VOICED: RunStage[] = ["idea", "research", "script", "skill-brief", "render", "qc"];

test("the recipe table is the styles validator's, and the engine knows every stage a built recipe names", () => {
  assert.deepEqual([...RECIPE_IDS], Object.keys(V.RECIPES));
  for (const id of RECIPE_IDS) {
    assert.deepEqual([...RECIPES[id].stages], V.RECIPES[id].stages, id);
    assert.equal(RECIPES[id].implemented, V.RECIPES[id].implemented, id);
    assert.deepEqual([...RECIPES[id].optional], V.RECIPES[id].optional, id);
    if (RECIPES[id].implemented) for (const k of RECIPES[id].stages) assert.ok(isRunStage(k), `${id}: ${k}`);
  }
  assert.deepEqual([...STAGE_KINDS], V.STAGE_KINDS);
  assert.deepEqual([...BUILT_RECIPES], ["image-sequence", "scene-spec", "hermes-skill"]);
  // image-sequence is exactly the list every run had before workflows.
  assert.deepEqual([...RECIPES["image-sequence"].stages], [...RUN_STAGES]);
});

test("stage list per vendored pack: stills and the explainer image-sequence, data pages scene-spec, hermes packs hermes-skill", () => {
  const want: Record<string, RunStage[]> = {
    "ambient-loop": IMAGE,
    "documentary-stills": IMAGE,
    "explainer-flat-vector": IMAGE,
    "horror-story": IMAGE,
    "mystery-narration": IMAGE,
    "story-read-aloud": IMAGE,
    "travel-documentary": IMAGE,
    "animated-line-graph": SCENE,
    "minimal-line-art": SCENE,
    "probe-line-graph": SCENE,
    "hermes-stick-figure": SKILL_VOICED,
    "hermes-zach-d-films": SKILL_VOICED,
  };
  for (const p of vendored) {
    const flow = workflowForPack(p);
    assert.ok(flow.ok, p.id);
    const expected = want[p.id] ?? (p.engine === "hermes" ? SKILL : undefined);
    assert.ok(expected, `no expectation for ${p.id}`);
    assert.deepEqual(flow.workflow.stages, expected, p.id);
    // The portal and the styles validator agree on every pack.
    assert.deepEqual(flow.workflow.stages, V.workflowStages(rawStyle(p.id)), `${p.id} (validator)`);
    assert.equal(flow.workflow.recipe, V.recipeOf(rawStyle(p.id)), `${p.id} recipe (validator)`);
  }
  assert.deepEqual(workflowForPack(pack("animated-line-graph")).ok && workflowForPack(pack("animated-line-graph")), { ok: true, workflow: { recipe: "scene-spec", stages: SCENE, review: ["scene-spec"] } });
  assert.equal(pack("hermes-stick-figure").hermes?.voice, "skill");
  assert.equal(pack("hermes-graph").hermes?.voice, "run");
});

test("a pack without workflow gets the recipe its engine and asset model imply; a reserved recipe is refused by name", () => {
  for (const p of vendored) {
    const bare = { ...p, workflow: null };
    const flow = workflowForPack(bare);
    assert.ok(flow.ok, p.id);
    assert.equal(flow.workflow.recipe, workflowForPack(p).ok ? (workflowForPack(p) as { workflow: { recipe: string } }).workflow.recipe : "", `${p.id}: inference agrees with the pack`);
    assert.deepEqual(flow.workflow.review, [], "no review points without a workflow");
  }
  assert.equal(inferRecipe("hermes", "image-per-shot"), "hermes-skill");
  assert.equal(inferRecipe("html-capture", "plates-and-diagrams"), "scene-spec");
  assert.equal(inferRecipe("html-capture", "image-per-shot"), "image-sequence");
  assert.equal(inferRecipe("remotion-2d", "plates-and-diagrams"), "image-sequence");
  assert.equal(inferRecipe("ffmpeg-stills", undefined), "image-sequence");
  const reserved = workflowForPack({ engine: "html-capture", workflow: { recipe: "html-design", review: [] } });
  assert.equal(reserved.ok, false);
  assert.match(!reserved.ok ? reserved.error : "", /^This style needs a workflow that isn't built yet: html-design\. .*owner's explicit approval/);
  assert.deepEqual(parsePackWorkflow({ recipe: "scene-spec", review: ["scene-spec", "approval", "scene-spec"] }), { recipe: "scene-spec", review: ["scene-spec"] });
  assert.equal(parsePackWorkflow({ recipe: "slideshow" }), null);
  assert.equal(parsePackWorkflow(undefined), null);
});

test("old runs keep RUN_STAGES; a stored workflow is read back only when it is a built recipe's own list", () => {
  const old = parseRunConfig({ format: "short", styleId: "documentary-stills", stylePack: { id: "documentary-stills", version: "1.0.0", status: "trial", trial: true } });
  assert.equal(old.workflow, undefined);
  assert.equal(runStagesOf(old), RUN_STAGES);
  assert.equal(runRecipeOf(old), "image-sequence");
  assert.ok(!runSettings(old).some((r) => r.label === "Workflow"), "a run from before workflows shows no workflow row");
  const scene = parseRunConfig({ workflow: { recipe: "scene-spec", stages: SCENE, review: ["scene-spec", "assets"] } });
  assert.deepEqual(scene.workflow, { recipe: "scene-spec", stages: SCENE, review: ["scene-spec"] });
  assert.deepEqual(runStagesOf(scene), SCENE);
  assert.ok(alwaysReviewed(scene, "scene-spec") && !alwaysReviewed(scene, "voice") && !alwaysReviewed(old, "scene-spec"));
  assert.ok(runSettings(scene).some((r) => r.label === "Workflow" && r.value === "Scene spec (data-driven, no pictures): Idea → Research → Script → Scene spec → Voice → Video → Quality check"));
  // The voice may only be left out where the recipe allows it, and nothing may be reordered or invented.
  assert.deepEqual(parseRunWorkflow({ recipe: "hermes-skill", stages: SKILL_VOICED, review: [] })?.stages, SKILL_VOICED);
  assert.equal(parseRunWorkflow({ recipe: "scene-spec", stages: SCENE.filter((s) => s !== "voice") }), null);
  assert.equal(parseRunWorkflow({ recipe: "scene-spec", stages: [...SCENE].reverse() }), null);
  assert.equal(parseRunWorkflow({ recipe: "image-sequence", stages: [...IMAGE, "upload"] }), null);
  assert.equal(parseRunWorkflow({ recipe: "html-design", stages: ["idea"] }), null);
  assert.equal(parseRunWorkflow({ recipe: "scene-spec", stages: "idea,qc" }), null);
  assert.equal(runStagesOf(parseRunConfig({ workflow: { recipe: "scene-spec", stages: ["qc"] } })), RUN_STAGES, "a damaged list falls back to the original pipeline");
});

test("next stage over a run's own list; the image-sequence list moves exactly as before", () => {
  for (let i = 0; i < RUN_STAGES.length; i++) assert.equal(nextRunStage(RUN_STAGES[i], IMAGE), nextRunStage(RUN_STAGES[i]));
  assert.equal(nextRunStage("script", SCENE), "scene-spec");
  assert.equal(nextRunStage("scene-spec", SCENE), "voice");
  assert.equal(nextRunStage("skill-brief", SKILL_VOICED), "render");
  assert.equal(nextRunStage("qc", SCENE), null);
  assert.equal(nextRunStage("storyboard", SCENE), null, "a stage the run does not have has no next stage");
  assert.equal(stageIndex("assets", SCENE), -1);
  assert.equal(stageIndex("scene-spec", SCENE), 3);
});

test("revision targets land on a stage of the run's own list, never later than the card's stage", () => {
  // Image sequence: as before.
  assert.equal(revisionTarget(null, "The pictures are too dark", "voice", IMAGE), "assets");
  assert.equal(revisionTarget(null, "The pictures are too dark", "voice"), "assets");
  assert.equal(revisionTarget("storyboard", "", "qc", IMAGE), "storyboard");
  // Scene spec: the storyboard and the pictures are the scene spec there.
  assert.equal(revisionTarget(null, "The pictures are too dark", "voice", SCENE), "scene-spec");
  assert.equal(revisionTarget(null, "Change the scene order", "render", SCENE), "scene-spec");
  assert.equal(revisionTarget("storyboard", "", "qc", SCENE), "scene-spec");
  assert.equal(revisionTarget(null, "The voice is too fast", "qc", SCENE), "voice");
  assert.equal(revisionTarget(null, "Rewrite the hook", "qc", SCENE), "script");
  assert.equal(revisionTarget(null, "Fix the pictures", "scene-spec", SCENE), "scene-spec");
  assert.equal(revisionTarget(null, "nothing that matches", "scene-spec", SCENE), "scene-spec", "no keyword: the stage the owner looked at");
  // A skill that voices itself: a voice note goes to the brief, the stage before the render.
  assert.equal(revisionTarget(null, "The voice is too fast", "qc", SKILL_VOICED), "skill-brief");
  assert.equal(revisionTarget(null, "Fewer shots please", "render", SKILL), "skill-brief");
  // Never later than the card's stage.
  assert.equal(revisionTarget(null, "The voice is too fast", "scene-spec", SCENE), "scene-spec");
  assert.equal(stageInRun("assets", SKILL), "skill-brief");
  assert.equal(stageInRun("voice", SKILL), "voice");
});

test("stuck and orphan detection treat the new stage kinds like any stage", () => {
  assert.ok(isOrphaned("running", [{ stage: "scene-spec", state: "pending" }]));
  assert.ok(isOrphaned("running", [{ stage: "skill-brief", state: "pending" }]));
  assert.ok(!isOrphaned("running", [{ stage: "scene-spec", state: "pending" }, { stage: "script", state: "running" }]));
  assert.ok(!isOrphaned("running", [{ stage: "page-design", state: "pending" }]), "a reserved kind is not a stage the engine runs");
  assert.ok(isRunStage("scene-spec") && isRunStage("skill-brief") && !isRunStage("page-design") && !isRunStage("frame-preview"));
});

test("the final decision waits for G-assets only in a workflow that makes assets", () => {
  assert.equal(finalGatesFor(IMAGE), PUBLISH_GATES);
  assert.equal(finalGatesFor(RUN_STAGES), PUBLISH_GATES);
  assert.deepEqual(finalGatesFor(SCENE), PUBLISH_GATES.filter((g) => g !== "G-assets"));
  assert.deepEqual(finalGatesFor(SKILL_VOICED), PUBLISH_GATES.filter((g) => g !== "G-assets"));
});

test("Template Lab: a recipe verdict is honest about what is not built, and fit follows the validator's rules", () => {
  assert.equal(recipeVerdict("scene-spec").text, "Scene spec (data-driven, no pictures): Idea → Research → Script → Scene spec → Voice → Video → Quality check");
  assert.match(recipeVerdict("html-design").text, /^needs a workflow that isn't built yet: html-design \(/);
  assert.equal(recipeVerdict("html-design").implemented, false);
  assert.equal(recipeFitIssue("scene-spec", "html-capture", true, "plates-and-diagrams"), null);
  assert.equal(recipeFitIssue("scene-spec", "remotion-2d", true, "plates-and-diagrams"), null);
  assert.match(recipeFitIssue("scene-spec", "remotion-2d", false, "plates-and-diagrams") ?? "", /element animation/);
  assert.match(recipeFitIssue("hermes-skill", "html-capture", true, "plates-and-diagrams") ?? "", /hermes renderer/);
  assert.equal(workflowText({ recipe: "hermes-skill", stages: SKILL_VOICED }), "Hermes skill (research only, no pictures): Idea → Research → Script → Skill brief → Video → Quality check");
});
