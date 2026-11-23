/**
 * The "New video" form, pure: what a run is started with, how the stored `pipeline_runs.config` is read back, the
 * defaults taken from the channel, what the chosen style's engine needs, and the pre-fill from a saved plan.
 * No database or network, so it runs under `node --test`. Nothing here writes a channel: the theme default is read
 * from the channel category and an override is stored on the run only.
 */
import { ENGINES, LANGUAGE_BY_CODE, PURPOSE_BY_ID, STYLE_BY_ID, THEME_BY_ID, type Format, type MusePlacement } from "./catalog.ts";
import { DEFAULT_DURATION_SEC } from "./engine.ts";
import { NON_WORKER_CAPABILITIES, isPortalEngine } from "./render-engine.ts";
import { LAB_TRIAL_BADGE, parseRunStylePack, type RunStylePack } from "./style-registry.ts";
import { parseTrialBatch, type TrialBatch } from "./trial-batch.ts";
import { parseRunWorkflow, workflowText, type RunWorkflow } from "./recipes.ts";
import { executorsText, museThinkingExecutors, parseStageExecutors, type StageExecutors } from "./muse-stage.ts";

/** The brief the owner may type. Empty means Hermes picks ideas from the channel plan. */
export const MAX_BRIEF_CHARS = 2000;
export const MAX_PURPOSES = 7;
export const MAX_SUBTITLES = 20;

/** Where the run's theme came from: the channel category, an owner override for this run, or nothing. */
/** Form value for "no theme for this run", which differs from "use the channel category" (empty). */
export const NO_THEME = "none";

export type ThemeSource = "channel" | "owner" | "none";

/** `pipeline_runs.config`, set once at start. Fields after `topicHint` were added with the one-flow Studio. */
export interface RunConfig {
  format: Format;
  language: string;
  durationSec: number;
  themeId: string;
  styleId: string;
  purposes: string[];
  /** The owner's brief (older runs: the short topic hint). */
  topicHint: string;
  /** Subtitle language codes besides the narration language. */
  subtitles: string[];
  themeSource: ThemeSource;
  /**
   * The style pack the run was started with (additive, set by startRun). `trial` marks a research-only run: shown with
   * the Trial badge and recorded in the curation log; later publishing must refuse it. Absent on runs from before packs.
   */
  stylePack?: RunStylePack;
  /**
   * The Template Lab study this run is a trial for (additive, docs/template-lab.md). Such a run is always a trial:
   * startRun marks its stylePack trial, and the study page lists it with its QC and presentation scores.
   */
  labStudyId?: string;
  /** One run of a batch trial (several styles from one brief, trial-batch.ts). Additive. */
  trialBatch?: TrialBatch;
  /**
   * The run's workflow, fixed at start from its style pack (recipes.ts; additive). Absent on runs from before
   * workflows, which keep RUN_STAGES (the image-sequence list).
   */
  workflow?: RunWorkflow;
  /**
   * Thinking stages this run sends to the Muse agent instead of Hermes (muse-stage.ts; additive). Absent: Hermes does
   * them, as before. Set once at start from "Muse does the thinking" on New Video.
   */
  executors?: StageExecutors;
}

const STUDY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
}

/** Reads a stored config with safe defaults, so runs started before the new fields read the same as before. */
export function parseRunConfig(raw: unknown): RunConfig {
  const c = isRecord(raw) ? raw : {};
  const format: Format = c.format === "long" ? "long" : "short";
  const themeId = typeof c.themeId === "string" ? c.themeId : "";
  const source = c.themeSource === "owner" || c.themeSource === "channel" || c.themeSource === "none" ? c.themeSource : themeId ? "channel" : "none";
  return {
    format,
    language: typeof c.language === "string" && c.language ? c.language : "en",
    durationSec: typeof c.durationSec === "number" && c.durationSec > 0 ? c.durationSec : DEFAULT_DURATION_SEC[format],
    themeId,
    styleId: typeof c.styleId === "string" ? c.styleId : "",
    purposes: strings(c.purposes),
    topicHint: typeof c.topicHint === "string" ? c.topicHint : "",
    subtitles: strings(c.subtitles),
    themeSource: source,
    ...stylePackOf(c.stylePack, c.workflow),
    ...(typeof c.labStudyId === "string" && STUDY_ID_RE.test(c.labStudyId) ? { labStudyId: c.labStudyId } : {}),
    ...trialBatchOf(c.trialBatch),
    ...workflowOf(c.workflow),
    ...executorsOf(c.executors),
  };
}

function executorsOf(raw: unknown): { executors?: StageExecutors } {
  const e = parseStageExecutors(raw);
  return Object.keys(e).length > 0 ? { executors: e } : {};
}

function workflowOf(raw: unknown): { workflow?: RunWorkflow } {
  const w = parseRunWorkflow(raw);
  return w ? { workflow: w } : {};
}

function trialBatchOf(raw: unknown): { trialBatch?: TrialBatch } {
  const b = parseTrialBatch(raw);
  return b ? { trialBatch: b } : {};
}

function stylePackOf(raw: unknown, workflow: unknown): { stylePack?: RunStylePack } {
  const p = parseRunStylePack(raw);
  // A run on the html-design workflow draws a page Hermes wrote: research only, a trial whatever its stored pack says.
  const designed = parseRunWorkflow(workflow)?.recipe === "html-design";
  return p ? { stylePack: designed ? { ...p, trial: true, designed: true } : p } : {};
}

/** True when the run was started with a Trial style pack (research only, not for publishing). */
export function isTrialRun(config: Pick<RunConfig, "stylePack">): boolean {
  return config.stylePack?.trial === true;
}

/** The theme a run starts with when the owner does not pick one: the channel category, when it is a known theme. */
export function defaultThemeFor(category: string | null | undefined): string {
  const c = (category ?? "").trim();
  return c && c in THEME_BY_ID ? c : "";
}

export interface RunRequest {
  format: Format;
  language: string;
  /** Empty: use the channel category. "none": no theme for this run. Otherwise a theme id. */
  themeId: string;
  purposes: string[];
  subtitles: string[];
  brief: string;
  /** "Muse does the thinking": idea, research and script go to the Muse agent (the caller checked it is ready). */
  thinkOnMuse?: boolean;
}

export type RunConfigResult = { ok: true; config: RunConfig } | { ok: false; error: string };

/**
 * Turns the form into the run config. Unknown ids are refused (the form only offers catalog ids), duplicates are
 * dropped and the narration language is not repeated as a subtitle.
 */
export function buildRunConfig(req: RunRequest, channel: { category: string | null }, template: { styleId: string }): RunConfigResult {
  if (!LANGUAGE_BY_CODE[req.language]) return { ok: false, error: "Choose a narration language from the list." };
  const purposes = [...new Set(req.purposes)];
  if (purposes.length > MAX_PURPOSES) return { ok: false, error: "Choose fewer purposes." };
  if (purposes.some((p) => !PURPOSE_BY_ID[p])) return { ok: false, error: "Unknown purpose." };
  const subtitles = [...new Set(req.subtitles)].filter((c) => c !== req.language);
  if (subtitles.length > MAX_SUBTITLES) return { ok: false, error: "Choose fewer subtitle languages." };
  if (subtitles.some((c) => !LANGUAGE_BY_CODE[c])) return { ok: false, error: "Unknown subtitle language." };
  let themeId = "";
  let themeSource: ThemeSource = "none";
  if (req.themeId === NO_THEME) {
    themeSource = channel.category ? "owner" : "none";
  } else if (req.themeId) {
    if (!THEME_BY_ID[req.themeId]) return { ok: false, error: "Unknown theme." };
    themeId = req.themeId;
    // Picking the channel's own category is not an override.
    themeSource = req.themeId === (channel.category ?? "") ? "channel" : "owner";
  } else if (channel.category) {
    // As before: the run takes the channel category as is.
    themeId = channel.category;
    themeSource = "channel";
  }
  return {
    ok: true,
    config: {
      format: req.format,
      language: req.language,
      durationSec: DEFAULT_DURATION_SEC[req.format],
      themeId,
      styleId: template.styleId,
      purposes,
      topicHint: req.brief.trim().slice(0, MAX_BRIEF_CHARS),
      subtitles,
      themeSource,
      ...(req.thinkOnMuse ? { executors: museThinkingExecutors() } : {}),
    },
  };
}

/** The `pipeline_runs.topic` shown in run lists until an idea is chosen: the first line of the brief. */
export function topicFromBrief(brief: string): string {
  return brief.trim().split(/\r?\n/)[0].trim().slice(0, 300);
}

/** What the run form shows about the style's engine. Read from the catalog and the stored worker capabilities. */
export interface EngineView {
  engineId: string;
  label: string;
  muse: MusePlacement;
  capability: string;
  /** yes: an active worker reports the capability; no: none does; external: no worker runs this engine. */
  worker: "yes" | "no" | "external";
}

export function engineView(styleId: string, reported: readonly string[], packEngine?: string): EngineView | null {
  // A pack the catalogue does not know names its engine itself (New Video passes it).
  const style = STYLE_BY_ID[styleId];
  const engine = style ? ENGINES[style.engine] : packEngine ? ENGINES[packEngine] : undefined;
  if (!engine) return null;
  const worker = NON_WORKER_CAPABILITIES.includes(engine.capability) || isPortalEngine(engine.id) ? "external" : reported.includes(engine.capability) ? "yes" : "no";
  return { engineId: engine.id, label: engine.label, muse: engine.muse, capability: engine.capability, worker };
}

/** Form values for the run form. Strings and string lists only, so they cross to the client as is. */
export interface RunFormPrefill {
  channelId: string;
  templateId: string;
  format: Format;
  themeId: string;
  purposes: string[];
  language: string;
  subtitles: string[];
  brief: string;
  /** The saved plan this came from, kept on the run as `production_id`. */
  productionId: string;
  /** A Template Lab study the run is a trial for (from "Start a trial video with the closest pack"), or empty. */
  labStudyId?: string;
  /** "Try it (lab trial)": the Draft or Lab pack id the run is a lab trial of, or empty. */
  labTrialPackId?: string;
}

export const EMPTY_PREFILL: RunFormPrefill = {
  channelId: "",
  templateId: "",
  format: "short",
  themeId: "",
  purposes: [],
  language: "en",
  subtitles: [],
  brief: "",
  productionId: "",
};

/** Pre-fills the run form from a saved production. Values the catalog no longer knows are left out. */
export function prefillFromProduction(p: {
  id: string;
  brief: string;
  channel_id: string | null;
  format: string;
  style_id: string;
  theme_id: string;
  purposes: readonly string[] | null;
  language: string;
  subtitles: readonly string[] | null;
}): RunFormPrefill {
  const language = LANGUAGE_BY_CODE[p.language] ? p.language : "en";
  return {
    channelId: p.channel_id ?? "",
    templateId: STYLE_BY_ID[p.style_id] ? `tpl-${p.style_id}` : "",
    format: p.format === "long" ? "long" : "short",
    themeId: THEME_BY_ID[p.theme_id] ? p.theme_id : "",
    purposes: (p.purposes ?? []).filter((x) => Boolean(PURPOSE_BY_ID[x])),
    language,
    subtitles: (p.subtitles ?? []).filter((c) => Boolean(LANGUAGE_BY_CODE[c]) && c !== language),
    brief: p.brief.slice(0, MAX_BRIEF_CHARS),
    productionId: p.id,
  };
}

/** Groups runs for the Studio list: waiting for the owner first, then working, then finished. */
export type RunGroup = "waiting" | "working" | "finished";
export function runGroup(state: string): RunGroup {
  if (state === "waiting-human") return "waiting";
  if (state === "running") return "working";
  return "finished";
}

const AUTONOMY_TEXT = [
  "You approve every step",
  "You pick the idea and approve the pictures; later steps go on when their checks pass",
  "Hermes picks the idea; you approve the finished video",
  "May publish on its own when every check passes",
] as const;

/** Plain words for a channel's autonomy level, read only. The owner sets it on the channel. */
export function autonomyText(level: number, paused: boolean): string {
  const n = level >= 3 ? 3 : level === 2 ? 2 : level === 1 ? 1 : 0;
  return `Level ${n}: ${AUTONOMY_TEXT[n]}${paused && n > 1 ? " (paused, so it acts as level 1)" : paused ? " (paused)" : ""}`;
}

/** The run's settings in plain words, for the run page. Unknown ids are shown as stored. */
export function runSettings(config: RunConfig): Array<{ label: string; value: string }> {
  const lang = LANGUAGE_BY_CODE[config.language];
  const kokoro = lang ? (lang.tts === "kokoro" ? "Kokoro voice" : lang.tts === "verify" ? "check the Kokoro voice first" : "not in Kokoro") : "";
  const theme = config.themeId ? (THEME_BY_ID[config.themeId]?.label ?? config.themeId) : "";
  const from = config.themeSource === "owner" ? "chosen for this video" : config.themeSource === "channel" ? "from the channel" : "";
  return [
    { label: "Format", value: config.format === "long" ? "Long" : "Short" },
    { label: "Narration", value: lang ? `${lang.label} (${kokoro})` : config.language },
    { label: "Subtitles", value: config.subtitles.map((c) => LANGUAGE_BY_CODE[c]?.label ?? c).join(", ") || "None" },
    { label: "Theme", value: theme ? (from ? `${theme}, ${from}` : theme) : from ? `None, ${from}` : "None" },
    { label: "Purpose", value: config.purposes.map((p) => PURPOSE_BY_ID[p]?.label ?? p).join(", ") || "None" },
    { label: "Brief", value: config.topicHint || "None: Hermes picks from the channel plan" },
    ...(config.stylePack
      ? [{ label: "Style pack", value: `${config.stylePack.id} ${config.stylePack.version}${config.stylePack.lab ? `, ${LAB_TRIAL_BADGE}: research only, never published` : config.stylePack.trial ? ", Trial: research only, not for publishing" : ""}` }]
      : []),
    ...(config.labStudyId ? [{ label: "Lab study", value: config.labStudyId }] : []),
    ...(config.trialBatch ? [{ label: "Batch trial", value: `${config.trialBatch.index} of ${config.trialBatch.total}` }] : []),
    ...(config.workflow ? [{ label: "Workflow", value: workflowText(config.workflow) }] : []),
    ...(executorsText(config.executors) ? [{ label: "Muse", value: executorsText(config.executors) as string }] : []),
  ];
}
