/**
 * Workflows ("recipes"), pure. A style pack names the recipe its runs follow (style.json `workflow`, styles/FORMAT.md
 * "Workflows"): the stage kinds in order, plus `review`, the stages where the owner always reviews. startRun fixes the
 * run's list from the pack and stores it in `pipeline_runs.config.workflow` (additive); the engine reads that list for
 * the next stage, revision targets, the run page and Review. A run without one (started before workflows) keeps
 * RUN_STAGES, which is also the image-sequence list, so those runs behave exactly as before.
 *
 * The recipe table mirrors RECIPES in styles/tools/validate.mjs (recipes.test.ts checks they agree). Reserved recipes
 * are names only: the validator refuses them and so does workflowForPack.
 */
import { RUN_STAGES, isRunStage, type RunStage } from "./engine.ts";
import { PUBLISH_GATES, type GateId } from "./qc.ts";
import { stageLabel } from "./review.ts";

export const RECIPE_IDS = ["image-sequence", "scene-spec", "hermes-skill", "html-design", "engine-project", "clip-sequence"] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];
/** The recipes the engine runs today. */
export type BuiltRecipe = "image-sequence" | "scene-spec" | "hermes-skill" | "html-design";
export const BUILT_RECIPES: readonly BuiltRecipe[] = ["image-sequence", "scene-spec", "hermes-skill", "html-design"];
/**
 * Research-only recipes (owner decision, mirror of RESEARCH_RECIPES in styles/tools/validate.mjs): html-design runs a
 * page Hermes wrote, so its runs are always trials, never published, and its packs never go above Trial.
 */
export const RESEARCH_RECIPES: readonly RecipeId[] = ["html-design"];
/**
 * Stages the autonomy policy never approves, whatever the level or the pack says: the page Hermes wrote and the still
 * frames of a page. The owner looks at them every time.
 */
export const OWNER_ONLY_STAGES: readonly RunStage[] = ["html-design", "preview"];

export function isResearchRecipe(v: unknown): boolean {
  return typeof v === "string" && (RESEARCH_RECIPES as readonly string[]).includes(v);
}

export interface Recipe {
  id: RecipeId;
  /** What the owner reads on New Video, the run page and Template Lab. */
  label: string;
  implemented: boolean;
  /** Stage kinds in order. A reserved recipe names kinds the engine does not have yet. */
  stages: readonly string[];
  /** Stages a pack may leave out (hermes-skill: the voice, when the skill voices itself). */
  optional: readonly RunStage[];
  /** Earlier stage lists of this recipe that runs already under way may hold (portal only, not in the styles table). */
  legacy?: readonly (readonly RunStage[])[];
  summary: string;
}

export const RECIPES: Record<RecipeId, Recipe> = {
  "image-sequence": {
    id: "image-sequence",
    label: "Image sequence",
    implemented: true,
    stages: ["idea", "research", "script", "storyboard", "assets", "voice", "render", "qc"],
    optional: [],
    summary: "A storyboard with an image prompt per shot, one picture per shot, then voice, render and quality check (the original pipeline).",
  },
  "scene-spec": {
    id: "scene-spec",
    label: "Scene spec (data-driven, no pictures)",
    implemented: true,
    stages: ["idea", "research", "script", "scene-spec", "preview", "voice", "render", "qc"],
    optional: [],
    // Runs started before the still-frame preview keep their list (no preview stage).
    legacy: [["idea", "research", "script", "scene-spec", "voice", "render", "qc"]],
    summary: "Data-driven: Hermes writes a scene spec (seconds, beat, on-screen elements with sourced numbers, motion tokens, captions) that the page renders directly, and the owner sees still frames of the page before the voice and the render. No pictures are generated.",
  },
  "hermes-skill": {
    id: "hermes-skill",
    label: "Hermes skill (research only, no pictures)",
    implemented: true,
    stages: ["idea", "research", "script", "skill-brief", "voice", "render", "qc"],
    optional: ["voice"],
    summary: "Research only: Hermes turns the approved script into the input the pack's skill expects, then renders with that skill. No pictures are generated; the voice stage is left out when the skill makes its own voice (hermes.voice skill).",
  },
  "html-design": {
    id: "html-design",
    label: "Hermes-designed page (research only, no pictures)",
    implemented: true,
    stages: ["idea", "research", "script", "html-design", "preview", "voice", "render", "qc"],
    optional: [],
    summary: "Research only (owner decision): Hermes writes the HTML page for each video (one self-contained index.html, checked before anything runs), the owner approves still frames of it, then the worker captures it with html-capture. Always a trial, never published.",
  },
  "engine-project": {
    id: "engine-project",
    label: "Engine project (reserved)",
    implemented: false,
    stages: ["idea", "research", "script", "project-build", "voice", "render", "qc"],
    optional: [],
    summary: "Reserved, not built: a render project for a scene engine (Godot, Manim, Blender) built per video.",
  },
  "clip-sequence": {
    id: "clip-sequence",
    label: "Clip sequence (reserved)",
    implemented: false,
    stages: ["idea", "research", "script", "storyboard", "clips", "voice", "render", "qc"],
    optional: [],
    summary: "Reserved, not built: a video clip per shot instead of a picture.",
  },
};

export function isRecipeId(v: unknown): v is RecipeId {
  return typeof v === "string" && (RECIPE_IDS as readonly string[]).includes(v);
}

export function isBuiltRecipe(v: unknown): v is BuiltRecipe {
  return typeof v === "string" && (BUILT_RECIPES as readonly string[]).includes(v);
}

/** style.json `workflow`, as the portal reads it. The sync script already validated it. */
export interface PackWorkflow {
  recipe: RecipeId;
  /** Stages where the owner always reviews, whatever the autonomy level. */
  review: RunStage[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads style.json `workflow`, or null when absent or unreadable (the recipe is then inferred). */
export function parsePackWorkflow(raw: unknown): PackWorkflow | null {
  if (!isRecord(raw) || !isRecipeId(raw.recipe)) return null;
  const review = Array.isArray(raw.review) ? raw.review.filter((k): k is RunStage => typeof k === "string" && isRunStage(k)) : [];
  return { recipe: raw.recipe, review: [...new Set(review)] };
}

/** The recipe a pack without `workflow` gets, from its engine and asset model (the styles validator infers the same). */
export function inferRecipe(engine: string, assetModel: string | undefined): BuiltRecipe {
  if (engine === "hermes") return "hermes-skill";
  if (engine === "html-capture" && assetModel !== "image-per-shot") return "scene-spec";
  return "image-sequence";
}

/** A run's workflow, fixed at start (pipeline_runs.config.workflow). */
export interface RunWorkflow {
  recipe: BuiltRecipe;
  stages: RunStage[];
  review: RunStage[];
}

/** What workflowForPack reads from a pack (StylePack has these fields). */
export interface WorkflowSource {
  engine: string;
  plan?: { assetModel: string };
  hermes?: { voice?: "run" | "skill" } | null;
  workflow?: PackWorkflow | null;
}

/**
 * The workflow a run of this pack follows: the pack's recipe (or the inferred one), its stages (without the voice
 * when a hermes skill voices itself) and its review points. An error for a recipe that is not built.
 */
export function workflowForPack(p: WorkflowSource): { ok: true; workflow: RunWorkflow } | { ok: false; error: string } {
  const id: RecipeId = p.workflow?.recipe ?? inferRecipe(p.engine, p.plan?.assetModel);
  const recipe = RECIPES[id];
  if (!isBuiltRecipe(id) || !recipe.implemented) return { ok: false, error: `This style needs a workflow that isn't built yet: ${id}. ${recipe.summary}` };
  const skillVoice = id === "hermes-skill" && p.hermes?.voice === "skill";
  const stages = recipe.stages.filter((k): k is RunStage => isRunStage(k) && !(skillVoice && k === "voice"));
  // The owner-only stages are review points of every list that has them, whatever the pack names.
  const review = [...new Set([...(p.workflow?.review ?? []), ...OWNER_ONLY_STAGES])].filter((k) => stages.includes(k));
  if (id === "html-design" && p.engine !== "html-capture") return { ok: false, error: `This style names the html-design workflow but renders with ${p.engine}; a page Hermes writes is captured by html-capture only.` };
  return { ok: true, workflow: { recipe: id, stages, review } };
}

/**
 * The studio records the narration even for a hermes skill that could voice itself (SKILL_VOICE=studio, the default):
 * the voice stage goes back into the list, so the narration is made by the studio's voice paths (Kokoro on a worker
 * first, never queued behind Hermes), the skill is asked for picture and captions only, and a worker lays the
 * narration on (hermes-mux). A list that already has the voice is returned as is. Pure.
 */
export function withStudioVoice(workflow: RunWorkflow): RunWorkflow {
  if (workflow.recipe !== "hermes-skill" || workflow.stages.includes("voice")) return workflow;
  const full = RECIPES["hermes-skill"].stages.filter((k): k is RunStage => isRunStage(k));
  return { ...workflow, stages: full };
}

/** The stage lists a stored workflow may hold: its recipe's, or that without the stages the recipe lets a pack drop. */
function allowedLists(recipe: BuiltRecipe): RunStage[][] {
  const r = RECIPES[recipe];
  const full = r.stages.filter((k): k is RunStage => isRunStage(k));
  const lists = [full];
  for (const o of r.optional) lists.push(full.filter((k) => k !== o));
  for (const l of r.legacy ?? []) lists.push([...l]);
  return lists;
}

/**
 * Reads `config.workflow` back. Null for anything that is not a built recipe with one of its own stage lists, so a
 * damaged config never invents a stage order; such a run (like a run from before workflows) uses RUN_STAGES.
 */
export function parseRunWorkflow(raw: unknown): RunWorkflow | null {
  if (!isRecord(raw) || !isBuiltRecipe(raw.recipe) || !Array.isArray(raw.stages)) return null;
  const stages = raw.stages.filter((k): k is RunStage => typeof k === "string" && isRunStage(k));
  if (stages.length !== raw.stages.length) return null;
  if (!allowedLists(raw.recipe).some((l) => l.length === stages.length && l.every((k, i) => k === stages[i]))) return null;
  const review = Array.isArray(raw.review) ? raw.review.filter((k): k is RunStage => typeof k === "string" && isRunStage(k) && stages.includes(k)) : [];
  return { recipe: raw.recipe, stages, review: [...new Set(review)] };
}

/** The run's stage list: its workflow's, or RUN_STAGES for a run from before workflows. */
export function runStagesOf(config: { workflow?: RunWorkflow | null }): readonly RunStage[] {
  return config.workflow?.stages ?? RUN_STAGES;
}

/** The run's recipe: image-sequence for a run from before workflows (its stages are that recipe's). */
export function runRecipeOf(config: { workflow?: RunWorkflow | null }): BuiltRecipe {
  return config.workflow?.recipe ?? "image-sequence";
}

/**
 * True when the owner reviews this stage every time, whatever the autonomy level: the pack's workflow says so, or it is
 * an owner-only stage (the page Hermes wrote, the still frames), which no stored config can turn off.
 */
export function alwaysReviewed(config: { workflow?: RunWorkflow | null }, stage: RunStage): boolean {
  return OWNER_ONLY_STAGES.includes(stage) || config.workflow?.review.includes(stage) === true;
}

/** "Idea → Research → Script → Scene spec → Voice → Video → Quality check", for the owner. */
export function stagesText(stages: readonly string[]): string {
  return stages.map((s) => stageLabel(s)).join(" → ");
}

/** One line for New Video and the run page: the recipe and its stages. */
export function workflowText(w: { recipe: RecipeId; stages: readonly string[] }): string {
  return `${RECIPES[w.recipe].label}: ${stagesText(w.stages)}`;
}

/**
 * The gates the final decision waits for: every publish gate, without G-assets for a workflow that makes no assets
 * (its run never stores one, so waiting for it would only say "has not run yet").
 */
export function finalGatesFor(stages: readonly RunStage[]): GateId[] {
  return stages.includes("assets") ? PUBLISH_GATES : PUBLISH_GATES.filter((g) => g !== "G-assets");
}

/** Template Lab: what the owner is told about a recommended recipe. */
export interface RecipeVerdict {
  recipe: RecipeId;
  label: string;
  implemented: boolean;
  text: string;
}

export function recipeVerdict(id: RecipeId): RecipeVerdict {
  const r = RECIPES[id];
  return {
    recipe: id,
    label: r.label,
    implemented: r.implemented,
    text: r.implemented ? `${r.label}: ${stagesText(r.stages)}` : `needs a workflow that isn't built yet: ${id} (${r.summary})`,
  };
}

/** The recipe an engine can run with (for a Template Lab draft): the checks the styles validator applies. */
export function recipeFitIssue(recipe: RecipeId, engine: string, elementAnimation: boolean, assetModel: string): string | null {
  if (recipe === "scene-spec" && !(engine === "html-capture" || (engine === "remotion-2d" && elementAnimation))) {
    return "scene-spec needs html-capture, or remotion-2d with element animation (the page draws the spec)";
  }
  if (recipe === "hermes-skill" && engine !== "hermes") return "hermes-skill needs the hermes renderer";
  if (recipe === "html-design" && engine !== "html-capture") return "html-design needs html-capture (the worker captures the page Hermes writes)";
  if (recipe === "image-sequence" && !["image-per-shot", "plates-and-diagrams"].includes(assetModel)) return "image-sequence needs a picture per shot";
  return null;
}
