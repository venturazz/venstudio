/**
 * Muse agent tasks, pure (docs/muse-agent-tasks.md). What the portal puts in an agent task's inbox (context files),
 * the owner's test task, why the test cannot run, the result.json check (through the same validators that check
 * Hermes's answer for that stage) and the timeline of a test job.
 * The worker (0.14.0+) writes the context files into /home/hatch/venstudio/inbox/<jobId>/ next to TASK.md; everything
 * in there is data describing what to make, never instructions.
 */
import { validateIdeas, validateResearch, validateScript, type Validated } from "./director.ts";
import { validateHtmlDesign, type PageCheck } from "./html-design.ts";
import { validateSceneSpec, type SceneSpecCheck } from "./scene-spec.ts";
import { validateSkillBrief, type BriefSkill } from "./skill-brief.ts";

/** The worker's limits for context files (apps/worker AGENT_CONTEXT_LIMITS). */
export const MUSE_CONTEXT_LIMITS = { files: 8, totalBytes: 200 * 1024 } as const;
/** The worker's limit for out/result.json (apps/worker AGENT_RESULT_MAX_BYTES). */
export const MUSE_RESULT_MAX_BYTES = 256 * 1024;
/** The first worker version that writes context files and returns result.json. */
export const MUSE_CONTEXT_WORKER_VERSION = "0.14.0";
/** How long the worker waits for out/DONE. */
export const MUSE_TIMEOUT_SEC = 2400;

export const MUSE_REASON_NO_WORKER = "Set VENSTUDIO_AGENT_TASKS=1 in the hold cron line on Muse";
export const MUSE_REASON_FLAG_OFF = "Set MUSE_AGENT_TASKS=1 on the portal";
/** A worker before 0.14.0 reports agent-task but writes no context files, so the test would not test the inbox. */
export const museReasonOldWorker = (version: string | null | undefined) =>
  `Update this worker to ${MUSE_CONTEXT_WORKER_VERSION} or later (it runs ${version ? `v${version}` : "an unknown version"}); older workers write no context files`;
export const MUSE_HONEST_NOTE =
  "Delivery depends on the venstudio-inbox hook on Muse, which looks for a new TASK.md every 60 s and then wakes the agent. " +
  "Waking takes minutes, not seconds. The job times out after 40 min.";

export interface ContextFile {
  name: string;
  text: string;
}

const CONTEXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}\.(md|json|txt)$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Cuts text to at most `max` UTF-8 bytes, saying so at the end. Pure. */
export function clipText(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const note = "\n\n[cut: longer than this file may be]\n";
  let s = text.slice(0, Math.max(0, max - note.length));
  while (bytes(s) + bytes(note) > max) s = s.slice(0, Math.floor(s.length * 0.95));
  return s + note;
}

/** Same checks as the worker (parseAgentContext), so the portal never queues a context the worker refuses. Pure. */
export function contextIssues(files: readonly ContextFile[]): string[] {
  const issues: string[] = [];
  if (files.length > MUSE_CONTEXT_LIMITS.files) issues.push(`${files.length} context files; at most ${MUSE_CONTEXT_LIMITS.files}`);
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!CONTEXT_NAME_RE.test(f.name) || f.name.toLowerCase() === "task.md") issues.push(`${f.name}: not a plain .md, .json or .txt name`);
    if (seen.has(f.name.toLowerCase())) issues.push(`${f.name} is named twice`);
    seen.add(f.name.toLowerCase());
    if (f.text.includes("\0")) issues.push(`${f.name} is not text`);
    if (f.name.endsWith(".json")) {
      try {
        JSON.parse(f.text);
      } catch {
        issues.push(`${f.name} is not valid JSON`);
      }
    }
    total += bytes(f.text);
  }
  if (total > MUSE_CONTEXT_LIMITS.totalBytes) issues.push(`context holds ${total} bytes; at most ${MUSE_CONTEXT_LIMITS.totalBytes}`);
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// result.json: checked with the validator that checks Hermes's answer for the same stage

export const MUSE_RESULT_STAGES = ["test", "idea", "research", "script", "scene-spec", "skill-brief", "html-design"] as const;
export type MuseResultStage = (typeof MUSE_RESULT_STAGES)[number];

/** The shape each stage's result.json must have (the same schema Hermes is given for that stage). */
export const MUSE_RESULT_SCHEMA: Record<MuseResultStage, string> = {
  test: '{"text":"VenStudio test","filesRead":[string]} where filesRead names the files of this folder you read',
  idea: '{"ideas":[{"title":string,"hook":string,"angle":string,"score":number}]} with 5 to 10 ideas, score 0 to 100',
  research: '{"notes":[{"claim":string,"sourceUrl":string,"sourced":boolean,"summary":string}]} with 1 to 30 notes',
  script: '{"hooks":[string],"chosenHook":number,"script":string} with 3 to 10 hooks; chosenHook is an index into hooks',
  "scene-spec":
    '{"scenes":[{"seconds":number,"beat":string,"elements":[{"kind":string,"text"?:string,"value"?:number,"series"?:number[],"labels"?:string[],"source"?:number}],"tokens":[string],"caption":string}]}',
  "skill-brief": '{"shots":[{"beat":string,"seconds":number,"description":string,"onScreenText"?:string,"spec"?:object}],"text"?:string}',
  "html-design":
    '{"note":string,"scenes":[{"beat":string,"seconds":number,"caption":string}]}; the page itself goes in out/ as index.html plus .js, .css and .svg files',
};

export function isMuseResultStage(v: unknown): v is MuseResultStage {
  return typeof v === "string" && (MUSE_RESULT_STAGES as readonly string[]).includes(v);
}

export interface MuseTestResult {
  text: string;
  filesRead: string[];
}

/** The test step's tiny schema: the agent says the test text and which files of the inbox it read. Pure. */
export function validateMuseTestResult(value: unknown, folder: readonly string[]): Validated<MuseTestResult> {
  const issues: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, issues: ['Expected an object: {"text": "VenStudio test", "filesRead": [...]}'] };
  const v = value as Record<string, unknown>;
  if (v.text !== "VenStudio test") issues.push('text must be exactly "VenStudio test"');
  const filesRead: string[] = [];
  if (!Array.isArray(v.filesRead) || v.filesRead.length === 0) issues.push("filesRead must list the files of the folder you read");
  else
    for (const f of v.filesRead.slice(0, 20)) {
      if (typeof f !== "string") issues.push("filesRead must hold file names");
      else if (!folder.includes(f)) issues.push(`filesRead names ${JSON.stringify(f.slice(0, 60))}, which is not in the folder (${folder.join(", ")})`);
      else filesRead.push(f);
    }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { text: "VenStudio test", filesRead } };
}

export interface MuseResultCheck {
  /** test: the files TASK.md listed (TASK.md and the context files). */
  folder?: readonly string[];
  /** scene-spec: the pack contract and the run's research notes, as for Hermes. */
  sceneSpec?: SceneSpecCheck;
  /** skill-brief: the run's skill, as for Hermes (null: the default text brief). */
  skill?: BriefSkill | null;
  /** html-design: the pack's vendored files, as for Hermes. */
  page?: PageCheck;
}

/**
 * Parses the text of result.json and checks it with the stage's own validator: validateIdeas, validateResearch,
 * validateScript, validateSceneSpec, validateSkillBrief or validateHtmlDesign. For html-design the page files the
 * agent left in out/ (a page bundle) take the place of Hermes's html and files. Pure.
 */
export function validateMuseResult(stage: MuseResultStage, text: string, check: MuseResultCheck = {}, page?: ReadonlyArray<{ path: string; text: string }> | null): Validated<unknown> {
  if (bytes(text) > MUSE_RESULT_MAX_BYTES) return { ok: false, issues: [`result.json is larger than ${MUSE_RESULT_MAX_BYTES} bytes`] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [`result.json is not valid JSON: ${(err as Error).message.slice(0, 120)}`] };
  }
  switch (stage) {
    case "test":
      return validateMuseTestResult(value, check.folder ?? []);
    case "idea":
      return validateIdeas(value);
    case "research":
      return validateResearch(value);
    case "script":
      return validateScript(value);
    case "scene-spec":
      if (!check.sceneSpec) return { ok: false, issues: ["A scene spec is checked against the run's style contract, which this check was not given"] };
      return validateSceneSpec(value, check.sceneSpec);
    case "skill-brief":
      return validateSkillBrief(value, check.skill ?? null);
    case "html-design": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return validateHtmlDesign(value, check.page ?? { vendored: [] });
      const v = { ...(value as Record<string, unknown>) };
      if (page && page.length > 0) {
        v.html = page.find((f) => f.path === "index.html")?.text ?? "";
        v.files = page.filter((f) => f.path !== "index.html").map((f) => ({ path: f.path, text: f.text }));
      }
      return validateHtmlDesign(v, check.page ?? { vendored: [] });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The owner's test task (Workers page)

export type MuseTestVariant = "picture" | "json";
export const MUSE_TEST_VARIANTS: readonly MuseTestVariant[] = ["picture", "json"];
export const MUSE_TEST_LABEL: Record<MuseTestVariant, string> = { picture: "Send a test task to Muse", json: "Test a JSON result" };
export const MUSE_TEST_FRAME = { name: "test-frame.png", width: 720, height: 1280 } as const;

const TEST_CONTRACT = [
  "# Style contract: VenStudio test card",
  "",
  "This is a test of the VenStudio inbox. It is not a real video.",
  "",
  "- Picture: a plain test card. Flat light grey background (#EEEEEE), no photo, no gradient, no logo.",
  '- Text: the words "VenStudio test" in black, centred, large and easy to read.',
  "- Nothing else on the card: no people, no brand, no other words.",
  "- Licence: you make it yourself; nothing copied from the web.",
  "",
].join("\n");

/** SPEC.json of the test variant: the exact deliverable. Pure. */
export function museTestSpec(variant: MuseTestVariant): Record<string, unknown> {
  if (variant === "picture") {
    return {
      kind: "image",
      files: [{ name: MUSE_TEST_FRAME.name, format: "png", width: MUSE_TEST_FRAME.width, height: MUSE_TEST_FRAME.height }],
      content: "A plain test card with the text VenStudio test",
    };
  }
  return { kind: "result", files: [{ name: "result.json", format: "json" }], stage: "test", schema: MUSE_RESULT_SCHEMA.test };
}

/**
 * The payload of the owner's test task: a tiny CONTRACT.md and SPEC.json, the deliverable and the output file named,
 * hold mode. No run, work order or input: nothing in production waits on it. Pure.
 */
export function museTestPayload(variant: MuseTestVariant): Record<string, unknown> {
  const picture = variant === "picture";
  const context: ContextFile[] = [
    { name: "CONTRACT.md", text: TEST_CONTRACT },
    { name: "SPEC.json", text: JSON.stringify(museTestSpec(variant), null, 2) + "\n" },
  ];
  return {
    inputs: [],
    mode: "hold",
    museTest: variant,
    project: "VenStudio test",
    runId: "test",
    stage: picture ? "test-picture" : "test",
    shotRef: picture ? "test-frame" : "test-result",
    deliverable: picture
      ? `${MUSE_TEST_FRAME.name}: a ${MUSE_TEST_FRAME.width}x${MUSE_TEST_FRAME.height} PNG, a plain test card with the text VenStudio test`
      : `result.json: ${MUSE_RESULT_SCHEMA.test}`,
    outputs: [picture ? MUSE_TEST_FRAME.name : "result.json"],
    prompt: picture
      ? `Make ${MUSE_TEST_FRAME.name}: a ${MUSE_TEST_FRAME.width}x${MUSE_TEST_FRAME.height} PNG test card with the text "VenStudio test", following CONTRACT.md and SPEC.json.`
      : `Write result.json as SPEC.json says: ${MUSE_RESULT_SCHEMA.test}. Do not make a picture.`,
    context,
    timeoutSec: MUSE_TIMEOUT_SEC,
  };
}

export interface MuseWorkerFacts {
  id: string;
  name: string;
  status: string;
  jobTypes: readonly string[];
  /** The version it last reported; absent in tests that do not care. */
  version?: string | null;
}

/** a < b for dotted numeric versions ("0.13.0" < "0.14.0"). Pure. */
function versionBefore(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** Workers that may take a test: active and naming agent-task in their claims (only hold mode with the flag does). */
export function museTaskWorkers<T extends MuseWorkerFacts>(workers: readonly T[]): T[] {
  return workers.filter((w) => w.status === "active" && w.jobTypes.includes("agent-task"));
}

/**
 * Why the test button is disabled, or [] when it can run. Each reason is the exact thing to change. A worker that
 * does not report agent-task gets the worker reason even when others do. Pure.
 */
export function museTestDisabledReasons(o: { portalFlag: boolean; worker?: MuseWorkerFacts | null; anyWorker: boolean }): string[] {
  const reasons: string[] = [];
  if (!o.portalFlag) reasons.push(MUSE_REASON_FLAG_OFF);
  const reports = o.worker ? o.worker.status === "active" && o.worker.jobTypes.includes("agent-task") : o.anyWorker;
  if (!reports) reasons.push(MUSE_REASON_NO_WORKER);
  else if (o.worker && o.worker.version !== undefined && (!o.worker.version || versionBefore(o.worker.version, MUSE_CONTEXT_WORKER_VERSION))) {
    reasons.push(museReasonOldWorker(o.worker.version));
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline of an agent task

export interface MuseJobFacts {
  status: string;
  createdAt: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  /** job_events, any order. */
  events: ReadonlyArray<{ message: string; createdAt: Date | string }>;
}

export type MuseStepKey = "queued" | "claimed" | "task" | "done" | "uploaded" | "finished";
export interface MuseStep {
  key: MuseStepKey;
  label: string;
  at: Date | null;
  /** "worker": the time comes from the worker's clock (its result); "portal": from the portal's. */
  clock: "portal" | "worker" | null;
}

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The six steps of an agent task with their times, from the job row, its events and the worker's result. Pure. */
export function museTimeline(j: MuseJobFacts): { steps: MuseStep[]; wakeSec: number | null } {
  const r = j.result ?? {};
  const events = [...j.events].map((e) => ({ message: e.message, at: toDate(e.createdAt) })).sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  const firstEvent = (re: RegExp) => events.find((e) => re.test(e.message))?.at ?? null;
  const pick = (worker: unknown, re: RegExp): { at: Date | null; clock: MuseStep["clock"] } => {
    const w = toDate(worker);
    if (w) return { at: w, clock: "worker" };
    const e = firstEvent(re);
    return { at: e, clock: e ? "portal" : null };
  };
  const claimedEvent = firstEvent(/^Claimed by /);
  const claimed = toDate(j.startedAt) ?? claimedEvent;
  const task = pick(r.taskWrittenAt, /^TASK\.md written/);
  const done = pick(r.doneAt, /^DONE seen/);
  const uploaded = pick(r.uploadedAt, /^Uploaded /);
  const finished = j.status === "succeeded" || j.status === "failed" || j.status === "cancelled" ? toDate(j.finishedAt) : null;
  const steps: MuseStep[] = [
    { key: "queued", label: "Queued", at: toDate(j.createdAt), clock: "portal" },
    { key: "claimed", label: "Claimed by the Muse worker", at: claimed, clock: claimed ? "portal" : null },
    { key: "task", label: "TASK.md written in the inbox", ...task },
    { key: "done", label: "DONE seen (the agent finished)", ...done },
    { key: "uploaded", label: "Files uploaded", ...uploaded },
    { key: "finished", label: j.status === "succeeded" ? "Finished" : j.status === "failed" ? "Failed" : j.status === "cancelled" ? "Cancelled" : "Finished", at: finished, clock: finished ? "portal" : null },
  ];
  // Wake latency = claimed to DONE. The worker measures both ends on its own clock (wakeSec); before its result is in,
  // the portal's times are used.
  let wakeSec: number | null = typeof r.wakeSec === "number" && Number.isFinite(r.wakeSec) ? r.wakeSec : null;
  if (wakeSec === null && claimed && done.at) wakeSec = Math.round((done.at.getTime() - claimed.getTime()) / 100) / 10;
  return { steps, wakeSec };
}

/** "3 min 12 s", "45 s". Pure. */
export function durationText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/** One line per step, as the Workers page shows it: "Claimed by the Muse worker: +4 s" or "...: waiting". Pure. */
export function museTimelineText(j: MuseJobFacts): string[] {
  const { steps, wakeSec } = museTimeline(j);
  const start = steps[0].at;
  const ended = j.status === "failed" || j.status === "cancelled";
  const lines = steps.map((s) => {
    if (!s.at) return `${s.label}: ${ended ? "did not happen" : "waiting"}`;
    const rel = start ? `+${durationText((s.at.getTime() - start.getTime()) / 1000)}` : s.at.toISOString();
    return `${s.label}: ${s.key === "queued" ? s.at.toISOString().replace(".000Z", "Z") : rel}${s.clock === "worker" ? " (worker clock)" : ""}`;
  });
  lines.push(wakeSec === null ? "Wake latency (claimed to DONE): not yet" : `Wake latency (claimed to DONE): ${durationText(wakeSec)}`);
  if (j.status === "failed" && j.error) lines.push(`Error: ${j.error.slice(0, 300)}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Picture fallback: the shot prompt, the style contract and the run's plan as context files

export interface PlanShot {
  beatRole: string;
  seconds: number;
  description: string;
  imagePrompt?: string;
}

/** PLAN.md of a run: topic, approved script and the shot list with the shot this task is for marked. Pure. */
export function planMarkdown(o: { topic: string; styleId: string; script: string | null; shots: readonly PlanShot[] | null; shotRef: string; shotIndex: number | null }): string {
  const lines = ["# Run plan (approved)", "", `Topic: ${o.topic || "not given"}`, `Style: ${o.styleId || "not given"}`, `This task is for shot: ${o.shotRef}`, ""];
  lines.push("## Script", "", o.script?.trim() || "(no approved script yet)", "");
  lines.push("## Shot list", "");
  if (!o.shots || o.shots.length === 0) lines.push("(no approved shot list yet)");
  else
    o.shots.forEach((s, i) => {
      const mark = o.shotIndex === i ? " <- THIS SHOT" : "";
      lines.push(`${i + 1}. [${s.beatRole}, ${s.seconds} s]${mark} ${s.description}`);
      if (s.imagePrompt) lines.push(`   Picture: ${s.imagePrompt}`);
    });
  lines.push("");
  return lines.join("\n");
}

/** CONTRACT.md from a style pack's contract (style.json), or from the style id when the run has no pack. Pure. */
export function contractMarkdown(o: { styleId: string; packId?: string | null; contract: Record<string, unknown> | null }): string {
  const head = ["# Style contract", "", `Style: ${o.styleId || "not given"}${o.packId ? ` (pack ${o.packId})` : ""}`, ""];
  if (!o.contract) return [...head, "No pack contract: match the look of the run's other pictures, plain and clear, no text burned in unless the shot asks for it.", ""].join("\n");
  return [...head, "The pack's contract (style.json contract), as JSON:", "", "```json", JSON.stringify(o.contract, null, 2), "```", ""].join("\n");
}

/**
 * The context of the agent-task picture fallback: PLAN.md (the run's approved script and shot list), CONTRACT.md
 * (the style contract) and SPEC.json (the exact deliverable), within the worker's 200 KB. Pure.
 */
export function pictureFallbackContext(o: {
  shotRef: string;
  prompt: string;
  format: string;
  width: number;
  height: number;
  plan: string;
  contract: string;
}): { context: ContextFile[]; outputs: string[]; deliverable: string } {
  const name = `${o.shotRef.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "").slice(0, 60) || "shot"}.png`;
  const spec = { kind: "image", shotRef: o.shotRef, files: [{ name, format: "png", width: o.width, height: o.height }], videoFormat: o.format, picture: o.prompt.slice(0, 1200) };
  const specText = JSON.stringify(spec, null, 2) + "\n";
  const room = MUSE_CONTEXT_LIMITS.totalBytes - bytes(specText) - 1024;
  const contract = clipText(o.contract, Math.floor(room * 0.3));
  const plan = clipText(o.plan, room - bytes(contract));
  return {
    context: [
      { name: "PLAN.md", text: plan },
      { name: "CONTRACT.md", text: contract },
      { name: "SPEC.json", text: specText },
    ],
    outputs: [name],
    deliverable: `${name}: a ${o.width}x${o.height} PNG picture for shot ${o.shotRef}`,
  };
}
