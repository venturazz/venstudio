import {
  ENGINES,
  LANGUAGE_BY_CODE,
  PURPOSE_BY_ID,
  STYLE_BY_ID,
  STYLES,
  THEME_BY_ID,
  THEMES,
  VIDEO_FORMATS,
  type Executor,
  type Family,
  type Format,
  type Language,
  type MusePlacement,
  type RenderTier,
  type Style,
  type Theme,
  type Workflow,
} from "./catalog.ts";
import { engineIssues } from "./render-engine.ts";

export interface PlanStage {
  id: string;
  label: string;
  executor: Executor;
  /** Hermes skill role, worker capability, or 9router task. Mapped to real skill names later. */
  role: string;
  /** True only when the portal can run this stage today. */
  runnable: boolean;
  detail: string;
}

export interface ProductionPlan {
  version: 1;
  styleId: string;
  styleLabel: string;
  family: Family;
  format: Format;
  formatLabel: string;
  durationSec: [number, number];
  targetShots: number;
  themeId: string | null;
  themeLabel: string | null;
  purposes: Array<{ id: string; label: string }>;
  language: { code: string; label: string; tts: Language["tts"]; ttsNote: string };
  subtitles: Array<{ code: string; label: string }>;
  workflow: Workflow;
  engineId: string;
  engineLabel: string;
  engineTier: RenderTier;
  muse: MusePlacement;
  stages: PlanStage[];
  warnings: string[];
  cautions: string[];
  policy: string[];
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Whole-word or whole-phrase match: "ai" matches "AI tools" but not "chair". */
export function hasPhrase(haystack: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  return needle.length > 0 && ` ${normalizeText(haystack)} `.includes(` ${needle} `);
}

/** The theme whose keywords appear most often in the brief, or undefined when none match. */
export function detectTheme(brief: string): Theme | undefined {
  let best: { theme: Theme; hits: number } | undefined;
  for (const theme of THEMES) {
    const hits = theme.keywords.filter((k) => hasPhrase(brief, k)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { theme, hits };
  }
  return best?.theme;
}

export interface StyleSuggestion {
  style: Style;
  score: number;
  matched: string[];
}

/**
 * Ranks styles for a brief. Each matched keyword scores 2, and a style that suits the chosen theme scores 2 more.
 * Styles that don't support the format are never suggested.
 */
export function suggestStyles(brief: string, format: Format, themeId?: string, limit = 5): StyleSuggestion[] {
  const theme = themeId ? THEME_BY_ID[themeId] : undefined;
  const results: StyleSuggestion[] = [];
  for (const style of STYLES) {
    if (!style.formats.includes(format)) continue;
    const matched = style.keywords.filter((k) => hasPhrase(brief, k));
    let score = matched.length * 2;
    if (theme && style.themes.includes(theme.id)) score += 2;
    if (score > 0) results.push({ style, score, matched });
  }
  return results
    .sort((a, b) => b.score - a.score || a.style.label.localeCompare(b.style.label))
    .slice(0, limit);
}

export interface BuildInput {
  brief: string;
  format: Format;
  styleId: string;
  themeId?: string;
  purposeIds?: string[];
  /** Narration language code (default English). */
  language?: string;
  /** Extra subtitle language codes. */
  subtitles?: string[];
  workflow?: Workflow;
  hasReference?: boolean;
  /**
   * Capabilities a worker reported. When given, a style whose engine no worker can run is planned
   * with a warning instead of looking ready to go.
   */
  workerCapabilities?: readonly string[];
}

export type BuildResult = { ok: true; plan: ProductionPlan } | { ok: false; error: string };

function visualStage(style: Style): Pick<PlanStage, "label" | "role" | "detail"> | undefined {
  if (style.assetKinds.includes("model-3d")) {
    return { label: "3D models and scenes", role: "3d-assets", detail: "Models and textures with licences on record (CC0 or your own), plus the scene layout." };
  }
  if (style.assetKinds.includes("sprite-sheet")) {
    return { label: "Character and sprite sheets", role: "character-sheet", detail: "One sheet per character, kept in Assets so the look stays the same across episodes." };
  }
  if (style.assetKinds.includes("video")) {
    return { label: "AI video clips", role: "ai-clip", detail: "One clip per shot. Each output's terms are logged with it." };
  }
  if (style.assetKinds.includes("image")) {
    return { label: "Images and stills", role: "image", detail: "Generated or licensed images, one art style per series." };
  }
  return undefined;
}

function buildStages(style: Style, workflow: Workflow, format: Format, targetShots: number, purposeStages: PlanStage[], primary: Language, subtitles: Language[]): PlanStage[] {
  const engine = ENGINES[style.engine];
  const stages: PlanStage[] = [];
  if (workflow === "copycat-structure") {
    stages.push({
      id: "analyze",
      label: "Analyze reference",
      executor: "worker",
      role: "analyze-video",
      runnable: true,
      detail: "Cuts, pacing, hook timing and loudness of the reference. Stored with the reference. Study only.",
    });
    stages.push({
      id: "blueprint",
      label: "Structure blueprint",
      executor: "hermes",
      role: "structure",
      runnable: false,
      detail: "Beats and timing for your own story. The reference's script, footage, characters and music are never reused.",
    });
  }
  const [minSec, maxSec] = VIDEO_FORMATS[format].durationSec;
  stages.push({ id: "research", label: "Research", executor: "hermes", role: "research", runnable: false, detail: "Facts for the brief, each with a source link saved to Assets." });
  stages.push(...purposeStages);
  stages.push({ id: "script", label: "Script", executor: "hermes", role: "script", runnable: false, detail: `Script in this style's voice, sized for ${minSec}–${maxSec} s.` });
  if (primary.code !== "en") {
    stages.push({ id: "translate", label: `Translate script to ${primary.label}`, executor: "hermes", role: "translate", runnable: false, detail: "Keeps timing, names and product claims. A native speaker checks the result before recording." });
  }
  stages.push({ id: "storyboard", label: "Storyboard", executor: "hermes", role: "storyboard", runnable: false, detail: `About ${targetShots} shots, each with a visual prompt, a duration and on-screen text.` });
  const visual = visualStage(style);
  if (visual) stages.push({ id: "visuals", executor: "hermes", runnable: false, ...visual });
  if (style.narration) {
    stages.push({
      id: "voice",
      label: `Narration (${primary.label})`,
      executor: "9router",
      role: "tts",
      runnable: false,
      detail: `Voice with word timings for captions and lip sync. ${primary.ttsNote}`,
    });
  }
  if (subtitles.length > 0) {
    stages.push({
      id: "subtitles",
      label: "Subtitles",
      executor: "hermes",
      role: "translate",
      runnable: false,
      detail: `Caption files for ${subtitles.map((l) => l.label).join(", ")}, timed from the narration. Each file is checked before upload.`,
    });
  }
  stages.push({ id: "music", label: "Music and sound", executor: "worker", role: "audio", runnable: false, detail: "Self-composed or licensed tracks only. Each one is logged with its licence." });
  stages.push({
    id: "render",
    label: "Render",
    executor: engine.capability === "provider" ? "provider" : "worker",
    role: engine.capability,
    runnable: false,
    detail: `${engine.label}. ${engine.note}`,
  });
  if (primary.code !== "en" || subtitles.length > 0) {
    stages.push({ id: "localize-meta", label: "Localized title and description", executor: "hermes", role: "translate", runnable: false, detail: "Titles and descriptions for each language, checked against the video before publishing." });
  }
  stages.push({ id: "review", label: "Your review", executor: "human", role: "approve", runnable: false, detail: "Watch the cut and approve it. Nothing is scheduled before approval." });
  stages.push({ id: "publish", label: "Publish", executor: "human", role: "youtube", runnable: false, detail: "Upload as private first, then schedule. The YouTube connection comes in the next phase." });
  return stages;
}

function buildWarnings(style: Style, format: Format, workflow: Workflow, primary: Language, purposes: string[]): string[] {
  const engine = ENGINES[style.engine];
  const warnings: string[] = [];
  if (engine.muse === "muse-slow") {
    warnings.push(`Muse has no GPU, so ${engine.label} renders on 2 CPU cores. It works, but expect long renders: batch it instead of promising a fixed publish time.`);
  }
  if (engine.muse === "gpu-preferred") warnings.push("Best on a GPU worker (a VPS or your own PC). Muse can only run this as a slow fallback.");
  if (engine.muse === "muse-test") warnings.push("Not verified on Muse yet. Run a smoke test with this engine before the first real video.");
  if (engine.muse === "external") warnings.push("Clips come from a paid AI provider. Check its commercial-use terms for every output.");
  if (format === "long" && engine.tier === "heavy") warnings.push("A long video with a heavy engine can take many hours to render. Split it into chapters.");
  if (workflow === "copycat-structure") warnings.push("Copy-cat mode learns structure only. Script, footage, characters and music must be your own.");
  if (style.narration && primary.tts !== "kokoro") warnings.push(`Narration in ${primary.label}: ${primary.ttsNote}`);
  for (const id of purposes) {
    const purpose = PURPOSE_BY_ID[id];
    for (const p of purpose.policy) warnings.push(`${purpose.label}: ${p}`);
  }
  return warnings;
}

/** Builds the stage plan for one production. Pure: no database or network. */
export function buildPlan(input: BuildInput): BuildResult {
  const style = STYLE_BY_ID[input.styleId];
  if (!style) return { ok: false, error: "Choose a style from the list." };
  if (!style.formats.includes(input.format)) {
    const supported = style.formats.map((f) => VIDEO_FORMATS[f].label).join(" or ");
    return { ok: false, error: `${style.label} is made for ${supported}. Pick another format or style.` };
  }
  if (!normalizeText(input.brief)) return { ok: false, error: "Describe the video, or type a few keywords." };
  const workflow: Workflow = input.workflow ?? "original";
  if (workflow === "copycat-structure" && !input.hasReference) {
    return { ok: false, error: "The copy-cat workflow needs a reference video. Upload one in Assets, then pick it here." };
  }
  const theme = input.themeId ? THEME_BY_ID[input.themeId] : undefined;
  if (input.themeId && !theme) return { ok: false, error: "Unknown theme." };

  const purposeIds = [...new Set(input.purposeIds ?? [])];
  const purposes = purposeIds.map((id) => PURPOSE_BY_ID[id]);
  if (purposes.some((p) => !p)) return { ok: false, error: "Unknown purpose." };

  const primary = LANGUAGE_BY_CODE[input.language ?? "en"];
  if (!primary) return { ok: false, error: "Choose a narration language from the list." };
  const subtitleCodes = [...new Set(input.subtitles ?? [])].filter((c) => c !== primary.code);
  const subtitles = subtitleCodes.map((c) => LANGUAGE_BY_CODE[c]);
  if (subtitles.some((l) => !l)) return { ok: false, error: "Unknown subtitle language." };

  const engine = ENGINES[style.engine];
  const [minSec, maxSec] = VIDEO_FORMATS[input.format].durationSec;
  const targetShots = Math.max(1, Math.round((minSec + maxSec) / 2 / ((style.shotSeconds[0] + style.shotSeconds[1]) / 2)));
  const purposeStages = purposes.flatMap((p) => p.extraStages.map((st) => ({ ...st, runnable: false })));

  const warnings = buildWarnings(style, input.format, workflow, primary, purposeIds);
  if (input.workerCapabilities) warnings.push(...engineIssues({ engine: style.engine, reported: input.workerCapabilities }));
  if (theme) warnings.push(...theme.policy.map((p) => `${theme.label}: ${p}`));

  return {
    ok: true,
    plan: {
      version: 1,
      styleId: style.id,
      styleLabel: style.label,
      family: style.family,
      format: input.format,
      formatLabel: VIDEO_FORMATS[input.format].label,
      durationSec: [minSec, maxSec],
      targetShots,
      themeId: theme?.id ?? null,
      themeLabel: theme?.label ?? null,
      purposes: purposes.map((p) => ({ id: p.id, label: p.label })),
      language: { code: primary.code, label: primary.label, tts: primary.tts, ttsNote: primary.ttsNote },
      subtitles: subtitles.map((l) => ({ code: l.code, label: l.label })),
      workflow,
      engineId: engine.id,
      engineLabel: engine.label,
      engineTier: engine.tier,
      muse: engine.muse,
      stages: buildStages(style, workflow, input.format, targetShots, purposeStages, primary, subtitles),
      warnings,
      cautions: style.cautions,
      policy: theme?.policy ?? [],
    },
  };
}
