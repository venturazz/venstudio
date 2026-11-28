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
const SCENE: RunStage[] = ["idea", "research", "script", "scene-spec", "preview", "voice", "render", "qc"];
/** scene-spec without the still-frame preview (a page too heavy to photograph: workflow.skip ["preview"]). */
const SCENE_NO_PREVIEW: RunStage[] = ["idea", "research", "script", "scene-spec", "voice", "render", "qc"];
/** A scene-spec run started before the still-frame preview: its stored list is still read back. */
const SCENE_LEGACY: RunStage[] = ["idea", "research", "script", "scene-spec", "voice", "render", "qc"];
const HTML: RunStage[] = ["idea", "research", "script", "html-design", "preview", "voice", "render", "qc"];
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
  assert.deepEqual([...BUILT_RECIPES], ["image-sequence", "scene-spec", "hermes-skill", "html-design"]);
  // image-sequence is exactly the list every run had before workflows.
  assert.deepEqual([...RECIPES["image-sequence"].stages], [...RUN_STAGES]);
});

test("stage list per vendored pack: stills and the explainer image-sequence, data pages scene-spec, hermes packs hermes-skill", () => {
  const want: Record<string, RunStage[]> = {
    "ambient-loop": IMAGE,
    "documentary": IMAGE,
    "explainer-flat-vector": IMAGE,
    "horror-narration": IMAGE,
    "mystery-narration": IMAGE,
    "story-read-aloud": IMAGE,
    "travel-documentary": IMAGE,
    "low-poly-shapes": IMAGE,
    "full-frame": IMAGE,
    "line-graph": SCENE,
    // blocky-story still runs without the preview; voxel-build takes stills again — the still is the only place a composed
    // scene can be checked before the video exists.
    "blocky-story": SCENE_NO_PREVIEW,
    "voxel-build": SCENE,
    "minimal-line-art": SCENE,
    "probe-line-graph": SCENE,
    "designed-explainer": HTML,
    "stick-figure": SKILL_VOICED,
    "what-if-3d": SKILL_VOICED,
  };
  for (const p of vendored) {
    const flow = workflowForPack(p);
    assert.ok(flow.ok, p.id);
    const expected = want[p.id] ?? (p.engine === "hermes" ? SKILL : undefined);
    assert.ok(expected, `no expectation for ${p.id}`);
    assert.ok(expected, `no expectation for ${p.id}`);
    assert.deepEqual(flow.workflow.stages, expected, p.id);
    // The portal and the styles validator agree on every pack.
    assert.deepEqual(flow.workflow.stages, V.workflowStages(rawStyle(p.id)), `${p.id} (validator)`);
    assert.equal(flow.workflow.recipe, V.recipeOf(rawStyle(p.id)), `${p.id} recipe (validator)`);
  }
  // The still frames are always the owner's to approve, whatever the pack names (OWNER_ONLY_STAGES).
  assert.deepEqual(workflowForPack(pack("line-graph")).ok && workflowForPack(pack("line-graph")), { ok: true, workflow: { recipe: "scene-spec", stages: SCENE, review: ["scene-spec", "preview"] } });
  assert.deepEqual(workflowForPack(pack("designed-explainer")), { ok: true, workflow: { recipe: "html-design", stages: HTML, review: ["html-design", "preview"] } });
  assert.equal(pack("stick-figure").hermes?.voice, "skill");
  assert.equal(pack("line-graph-skill").hermes?.voice, "run");
});

test("a pack without workflow gets the recipe its engine and asset model imply; a reserved recipe is refused by name", () => {
  for (const p of vendored) {
    const bare = { ...p, workflow: null };
    const flow = workflowForPack(bare);
    assert.ok(flow.ok, p.id);
    // html-design is never inferred: without its workflow the Hermes-designed pack would be a plain scene-spec page.
    const named = (workflowForPack(p) as { workflow: { recipe: string } }).workflow.recipe;
    assert.equal(flow.workflow.recipe, named === "html-design" ? "scene-spec" : named, `${p.id}: inference agrees with the pack`);
    assert.deepEqual(flow.workflow.review, flow.workflow.stages.includes("preview") ? ["preview"] : [], "without a workflow only the owner-only stages are review points");
  }
  assert.equal(inferRecipe("hermes", "image-per-shot"), "hermes-skill");
  assert.equal(inferRecipe("html-capture", "plates-and-diagrams"), "scene-spec");
  assert.equal(inferRecipe("html-capture", "image-per-shot"), "image-sequence");
  assert.equal(inferRecipe("remotion-2d", "plates-and-diagrams"), "image-sequence");
  assert.equal(inferRecipe("ffmpeg-stills", undefined), "image-sequence");
  const reserved = workflowForPack({ engine: "godot-2d", workflow: { recipe: "engine-project", review: [], skip: [] } });
  assert.equal(reserved.ok, false);
  assert.match(!reserved.ok ? reserved.error : "", /^This style needs a workflow that isn't built yet: engine-project\. /);
  // html-design is built, for html-capture only; its review points are the page and the stills whatever a pack says.
  const designed = workflowForPack({ engine: "html-capture", workflow: { recipe: "html-design", review: [], skip: [] } });
  assert.deepEqual(designed, { ok: true, workflow: { recipe: "html-design", stages: HTML, review: ["html-design", "preview"] } });
  const wrongEngine = workflowForPack({ engine: "remotion-2d", workflow: { recipe: "html-design", review: [], skip: [] } });
  assert.match(!wrongEngine.ok ? wrongEngine.error : "", /captured by html-capture only/);
  assert.deepEqual(parsePackWorkflow({ recipe: "scene-spec", review: ["scene-spec", "approval", "scene-spec"] }), { recipe: "scene-spec", review: ["scene-spec"], skip: [] });
  assert.equal(parsePackWorkflow({ recipe: "slideshow" }), null);
  assert.equal(parsePackWorkflow(undefined), null);
});

test("old runs keep RUN_STAGES; a stored workflow is read back only when it is a built recipe's own list", () => {
  const old = parseRunConfig({ format: "short", styleId: "documentary", stylePack: { id: "documentary", version: "1.0.0", status: "trial", trial: true } });
  assert.equal(old.workflow, undefined);
  assert.equal(runStagesOf(old), RUN_STAGES);
  assert.equal(runRecipeOf(old), "image-sequence");
  assert.ok(!runSettings(old).some((r) => r.label === "Workflow"), "a run from before workflows shows no workflow row");
  const scene = parseRunConfig({ workflow: { recipe: "scene-spec", stages: SCENE, review: ["scene-spec", "assets"] } });
  assert.deepEqual(scene.workflow, { recipe: "scene-spec", stages: SCENE, review: ["scene-spec"] });
  assert.deepEqual(runStagesOf(scene), SCENE);
  assert.ok(alwaysReviewed(scene, "scene-spec") && !alwaysReviewed(scene, "voice") && !alwaysReviewed(old, "scene-spec"));
  // The page Hermes wrote and the still frames: always the owner's, even for a stored list that names no review point.
  assert.ok(alwaysReviewed(scene, "preview") && alwaysReviewed(old, "html-design") && alwaysReviewed({ workflow: { recipe: "html-design", stages: HTML, review: [] } }, "preview"));
  assert.ok(runSettings(scene).some((r) => r.label === "Workflow" && r.value === "Scene spec (data-driven, no pictures): Idea → Research → Script → Scene spec → Preview → Voice → Video → Quality check"));
  // A scene-spec run started before the preview keeps its list.
  assert.deepEqual(parseRunWorkflow({ recipe: "scene-spec", stages: SCENE_LEGACY, review: ["scene-spec"] })?.stages, SCENE_LEGACY);
  assert.deepEqual(parseRunWorkflow({ recipe: "html-design", stages: HTML, review: ["html-design", "preview"] })?.stages, HTML);
  // The voice may only be left out where the recipe allows it, and nothing may be reordered or invented.
  assert.deepEqual(parseRunWorkflow({ recipe: "hermes-skill", stages: SKILL_VOICED, review: [], skip: [] })?.stages, SKILL_VOICED);
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
  assert.equal(nextRunStage("scene-spec", SCENE), "preview");
  assert.equal(nextRunStage("preview", SCENE), "voice");
  assert.equal(nextRunStage("scene-spec", SCENE_LEGACY), "voice", "a run from before the preview goes on to its voice");
  assert.equal(nextRunStage("html-design", HTML), "preview");
  assert.equal(nextRunStage("preview", HTML), "voice");
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
  // A note on the still frames goes back to the plan they show (or earlier when it says so), never to the preview itself.
  assert.equal(revisionTarget(null, "nothing that matches", "preview", SCENE), "scene-spec");
  assert.equal(revisionTarget(null, "The colours are too loud", "preview", HTML), "html-design");
  assert.equal(revisionTarget(null, "Rewrite the hook", "preview", HTML), "script");
  assert.equal(revisionTarget(null, "The voice is too fast", "preview", HTML), "html-design", "never later than the plan");
  assert.equal(revisionTarget(null, "The pictures are too dark", "qc", HTML), "html-design");
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
  assert.ok(isRunStage("scene-spec") && isRunStage("skill-brief") && isRunStage("html-design") && isRunStage("preview") && !isRunStage("page-design") && !isRunStage("frame-preview"));
  assert.ok(isOrphaned("running", [{ stage: "preview", state: "pending" }]));
});

test("the final decision waits for G-assets only in a workflow that makes assets", () => {
  assert.equal(finalGatesFor(IMAGE), PUBLISH_GATES);
  assert.equal(finalGatesFor(RUN_STAGES), PUBLISH_GATES);
  assert.deepEqual(finalGatesFor(SCENE), PUBLISH_GATES.filter((g) => g !== "G-assets"));
  assert.deepEqual(finalGatesFor(SKILL_VOICED), PUBLISH_GATES.filter((g) => g !== "G-assets"));
});

test("Template Lab: a recipe verdict is honest about what is not built, and fit follows the validator's rules", () => {
  assert.equal(recipeVerdict("scene-spec").text, "Scene spec (data-driven, no pictures): Idea → Research → Script → Scene spec → Preview → Voice → Video → Quality check");
  assert.equal(recipeVerdict("html-design").text, "Hermes-designed page (research only, no pictures): Idea → Research → Script → HTML design → Preview → Voice → Video → Quality check");
  assert.equal(recipeVerdict("html-design").implemented, true);
  assert.match(recipeVerdict("engine-project").text, /^needs a workflow that isn't built yet: engine-project \(/);
  assert.equal(recipeFitIssue("html-design", "html-capture", true, "plates-and-diagrams"), null);
  assert.match(recipeFitIssue("html-design", "remotion-2d", true, "plates-and-diagrams") ?? "", /html-design needs html-capture/);
  assert.equal(recipeFitIssue("scene-spec", "html-capture", true, "plates-and-diagrams"), null);
  assert.equal(recipeFitIssue("scene-spec", "remotion-2d", true, "plates-and-diagrams"), null);
  assert.match(recipeFitIssue("scene-spec", "remotion-2d", false, "plates-and-diagrams") ?? "", /element animation/);
  assert.match(recipeFitIssue("hermes-skill", "html-capture", true, "plates-and-diagrams") ?? "", /hermes renderer/);
  assert.equal(workflowText({ recipe: "hermes-skill", stages: SKILL_VOICED }), "Hermes skill (research only, no pictures): Idea → Research → Script → Skill brief → Video → Quality check");
});

test("the studio's voice for a skill that could voice itself: the voice stage comes back; other lists are kept", async () => {
  const { withStudioVoice } = await import("./recipes.ts");
  const flow = workflowForPack(pack("stick-figure"));
  assert.ok(flow.ok);
  if (!flow.ok) return;
  assert.ok(!flow.workflow.stages.includes("voice"));
  const studio = withStudioVoice(flow.workflow);
  assert.deepEqual(studio.stages, ["idea", "research", "script", "skill-brief", "voice", "render", "qc"]);
  assert.deepEqual(studio.review, flow.workflow.review);
  // A stored run with the studio's voice reads back as a valid list.
  assert.deepEqual(parseRunWorkflow(JSON.parse(JSON.stringify(studio)))?.stages, studio.stages);
  const graph = workflowForPack(pack("line-graph-skill"));
  assert.ok(graph.ok);
  if (graph.ok) assert.equal(withStudioVoice(graph.workflow), graph.workflow);
  const stills = workflowForPack(pack("documentary"));
  if (stills.ok) assert.equal(withStudioVoice(stills.workflow), stills.workflow);
});

test("a pack whose page is too heavy to photograph drops the still-frame preview", () => {
  const base = { engine: "html-capture", plan: { assetModel: "plates-and-diagrams" } };
  const w = workflowForPack({ ...base, workflow: { recipe: "scene-spec", review: ["scene-spec"], skip: ["preview"] } });
  assert.ok(w.ok);
  assert.deepEqual([...w.workflow.stages], ["idea", "research", "script", "scene-spec", "voice", "render", "qc"]);
  assert.deepEqual([...w.workflow.review], ["scene-spec"], "a skipped stage cannot be a review point");
  // The stored list is one the recipe lists as its own, so the run reads it back.
  assert.deepEqual(parseRunWorkflow({ recipe: "scene-spec", stages: [...w.workflow.stages], review: ["scene-spec"] })?.stages, [...w.workflow.stages]);
  // A light page keeps the preview: it is the cheap gate before the voice and the render.
  const light = workflowForPack({ ...base, workflow: { recipe: "scene-spec", review: ["scene-spec"], skip: [] } });
  assert.ok(light.ok && light.workflow.stages.includes("preview"));
  // Only a stage the recipe calls optional can be dropped; anything else is ignored, never obeyed.
  assert.ok(!RECIPES["scene-spec"].optional.includes("qc" as RunStage));
  const bad = workflowForPack({ ...base, workflow: { recipe: "scene-spec", review: [], skip: ["qc" as RunStage] } });
  assert.ok(bad.ok && bad.workflow.stages.includes("qc"));
  assert.deepEqual([...parsePackWorkflow({ recipe: "scene-spec", skip: ["qc"] })!.skip], [], "the parser drops a skip the recipe does not allow");
  assert.deepEqual([...parsePackWorkflow({ recipe: "scene-spec", skip: ["preview"] })!.skip], ["preview"]);
});
