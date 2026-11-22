/**
 * The style registry: the vendored style packs (styles/, see docs/style-packs.md) merged with the catalogue.
 * Pure, so New Video, the Styles page, the run start and the render stage share one rule and the tests cover it.
 *
 * A pack overrides the catalogue entry with its id. Catalogue styles without a pack are "planned": shown on the
 * Styles page with the engine they would need, never selectable for a run. Only Listed packs appear in New Video's
 * main list, and Trial packs in its separate research-only section, each only once a worker reports the pack.
 */
import { ENGINES, type Family, type Format, type Frame, type Style } from "./catalog.ts";
import type { GateId } from "./qc.ts";
import { rubricText, type PresentationAdvisory, type Rubric } from "./presentation.ts";
import { PROMOTION_MIN_PRESENTATION, PROMOTION_MIN_TRIALS, promotionIssues, type Template, type TemplateEvidence } from "./templates.ts";

export const PACK_STATUSES = ["draft", "lab", "trial", "proven", "listed", "retired"] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];
export type RegistryStatus = PackStatus | "planned";

export const STATUS_LABEL: Record<RegistryStatus, string> = {
  draft: "Draft",
  lab: "Lab",
  trial: "Trial",
  proven: "Proven",
  listed: "Listed",
  retired: "Retired",
  planned: "Planned",
};

/** What the Trial section of New Video and the Trial badge say. */
export const TRIAL_LABEL = "Trial styles (research only, not for publishing)";
export const TRIAL_BADGE = "Trial style";

/**
 * Renderers that are research only (owner decision): hermes renders with Hermes's own tools. A pack with such an
 * engine is never above Trial (the styles validator refuses it, and parsePack leaves it out), every run of it is a
 * trial, and New Video shows it only in the Trial section under this label.
 */
export const RESEARCH_ENGINES: readonly string[] = ["hermes"];
export const RESEARCH_MAX_STATUSES: readonly PackStatus[] = ["draft", "lab", "trial", "retired"];
export const HERMES_RENDER_LABEL = "Hermes render (research only)";

export function isResearchEngine(engine: string | null | undefined): boolean {
  return typeof engine === "string" && RESEARCH_ENGINES.includes(engine);
}

export interface PackProvenance {
  type: string;
  ref: string;
  licence: string;
  notes: string;
}

export interface PackCuration {
  date: string;
  kind: string;
  ref: string;
  result: string;
  notes: string;
}

/** A vendored pack, as the portal uses it. The full style.json stays in `raw` for the Styles page. */
export interface StylePack {
  id: string;
  name: string;
  description: string;
  version: string;
  status: PackStatus;
  family: Family;
  formats: Format[];
  naturalFrame: Frame;
  engine: string;
  minWorkerVersion: string;
  composition: string | null;
  /** html-capture: the page draws the captions it is given (true) or the worker burns them (false); null otherwise. */
  drawsCaptions: boolean | null;
  provenance: PackProvenance[];
  curation: PackCuration[];
  /** Pack digest from styles/lock.json (checked against the files when loaded). */
  sha256: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/**
 * Reads a style.json the sync script already validated. Returns null for anything the portal cannot use (wrong
 * format, unknown engine, bad id or version) instead of guessing, so a broken pack is absent, not half-shown.
 */
export function parsePack(raw: unknown, sha256: string): StylePack | null {
  if (!isRecord(raw) || raw.format !== 1) return null;
  const id = str(raw.id);
  const version = str(raw.version);
  const status = PACK_STATUSES.find((s) => s === raw.status);
  const r = isRecord(raw.renderer) ? raw.renderer : {};
  const f = isRecord(raw.formats) ? raw.formats : {};
  const engine = str(r.engine);
  if (!ID_RE.test(id) || !SEMVER_RE.test(version) || !status || !ENGINES[engine]) return null;
  // Research-only engines never go above Trial: a pack that says otherwise is left out, not shown as Listed.
  if (isResearchEngine(engine) && !RESEARCH_MAX_STATUSES.includes(status)) return null;
  const formats = (Array.isArray(f.supported) ? f.supported : []).filter((x): x is Format => x === "short" || x === "long");
  const frame: Frame = f.naturalFrame === "landscape" || f.naturalFrame === "portrait" ? f.naturalFrame : "both";
  const list = <T,>(v: unknown, pick: (x: Record<string, unknown>) => T): T[] => (Array.isArray(v) ? v.filter(isRecord).map(pick) : []);
  return {
    id,
    name: str(raw.name) || id,
    description: str(raw.description),
    version,
    status,
    family: str(raw.family) as Family,
    formats,
    naturalFrame: frame,
    engine,
    minWorkerVersion: str(r.minWorkerVersion),
    composition: typeof r.composition === "string" ? r.composition : null,
    drawsCaptions: engine === "html-capture" ? r.drawsCaptions === true : null,
    provenance: list(raw.provenance, (p) => ({ type: str(p.type), ref: str(p.ref), licence: str(p.licence), notes: str(p.notes) })),
    curation: list(raw.curation, (e) => ({ date: str(e.date), kind: str(e.kind), ref: str(e.ref), result: str(e.result), notes: str(e.notes) })),
    sha256,
  };
}

/** The capability a worker (0.9.0+) reports once it installed this pack version and its probe passed. */
export function packCapability(id: string, version: string): string {
  return `pack:${id}@${version}`;
}

export const PACK_CAPABILITY_RE = /^pack:[a-z0-9][a-z0-9-]{1,62}@\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export interface RegistryEntry {
  id: string;
  label: string;
  description: string;
  family: Family;
  engine: string;
  formats: Format[];
  status: RegistryStatus;
  /** The vendored pack, or null for a planned catalogue style. */
  pack: StylePack | null;
  /** The catalogue entry, when there is one (planner keywords, cautions, sources). */
  style: Style | null;
}

/**
 * Catalogue order first, a pack replacing the entry with its id; packs the catalogue does not know come after, by id.
 * Retired packs stay in the registry (old runs stay explainable) but are never offered.
 */
export function mergeRegistry(styles: readonly Style[], packs: readonly StylePack[]): RegistryEntry[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const fromPack = (p: StylePack, s: Style | null): RegistryEntry => ({
    id: p.id,
    label: p.name,
    description: p.description,
    family: p.family,
    engine: p.engine,
    formats: [...p.formats],
    status: p.status,
    pack: p,
    style: s,
  });
  const out = styles.map((s): RegistryEntry => {
    const p = byId.get(s.id);
    if (p) return fromPack(p, s);
    return { id: s.id, label: s.label, description: s.description, family: s.family, engine: s.engine, formats: [...s.formats], status: "planned", pack: null, style: s };
  });
  const known = new Set(styles.map((s) => s.id));
  for (const p of [...packs].sort((a, b) => (a.id < b.id ? -1 : 1))) if (!known.has(p.id)) out.push(fromPack(p, null));
  return out;
}

/** Statuses a run may be started with. */
export const STARTABLE: readonly PackStatus[] = ["listed", "trial"];

/** Why a style cannot start a run, or null when it can. Availability on a worker is checked at render time. */
export function startRefusal(entry: RegistryEntry | undefined): string | null {
  if (!entry) return "Unknown style";
  if (!entry.pack) return `${entry.label} is planned, not a style pack yet. It cannot be used for a run.`;
  if (!STARTABLE.includes(entry.pack.status)) return `${entry.label} is ${STATUS_LABEL[entry.pack.status]}; only Listed and Trial styles can start a run.`;
  return null;
}

export interface Availability {
  /** Some worker reports the engine's capability. */
  renderer: boolean;
  /** Some worker reports this pack version (pack:<id>@<version>). */
  pack: boolean;
  capability: string | null;
}

export function availabilityOf(entry: RegistryEntry, reported: readonly string[], opts: { hermes?: boolean } = {}): Availability {
  // A research engine is run by the portal through Hermes, never by a worker: it is available when Hermes is set up.
  if (isResearchEngine(entry.engine)) {
    const ok = opts.hermes === true;
    return { renderer: ok, pack: ok && entry.pack !== null, capability: null };
  }
  const engineCap = ENGINES[entry.engine]?.capability ?? null;
  const capability = entry.pack ? packCapability(entry.pack.id, entry.pack.version) : null;
  return {
    renderer: engineCap !== null && reported.includes(engineCap),
    pack: capability !== null && reported.includes(capability),
    capability,
  };
}

export interface NewVideoStyles {
  /** Listed packs a worker reports: the main list. */
  listed: RegistryEntry[];
  /** Trial packs a worker reports: the research-only section. */
  trial: RegistryEntry[];
  /** Listed or Trial packs no worker reports yet: named, not selectable. */
  waiting: RegistryEntry[];
}

/**
 * What New Video offers. Draft, Lab, Proven, Retired and planned styles never appear. A research-only pack (engine
 * hermes) is offered only in the Trial section, once Hermes is set up (`hermes`), and never in the main list.
 */
export function newVideoStyles(entries: readonly RegistryEntry[], reported: readonly string[], opts: { hermes?: boolean } = {}): NewVideoStyles {
  const out: NewVideoStyles = { listed: [], trial: [], waiting: [] };
  for (const e of entries) {
    if (!e.pack || !STARTABLE.includes(e.pack.status)) continue;
    if (!availabilityOf(e, reported, opts).pack) out.waiting.push(e);
    else if (e.pack.status === "listed" && !isResearchEngine(e.pack.engine)) out.listed.push(e);
    else out.trial.push(e);
  }
  return out;
}

/** What a run records about its style pack in pipeline_runs.config (additive). */
export interface RunStylePack {
  id: string;
  version: string;
  status: PackStatus;
  /** True for a Trial pack: research only; later publishing must refuse the run. */
  trial: boolean;
  /** The pack's renderer (since Phase 2). A research engine (hermes) makes the run a trial whatever else it says. */
  engine?: string;
}

export function runStylePack(pack: StylePack): RunStylePack {
  return { id: pack.id, version: pack.version, status: pack.status, trial: pack.status === "trial" || isResearchEngine(pack.engine), engine: pack.engine };
}

export function parseRunStylePack(raw: unknown): RunStylePack | null {
  if (!isRecord(raw)) return null;
  const status = PACK_STATUSES.find((s) => s === raw.status);
  if (!ID_RE.test(str(raw.id)) || !SEMVER_RE.test(str(raw.version)) || !status) return null;
  const engine = str(raw.engine);
  // A hermes render is always a trial, even if a stored config claims otherwise.
  return { id: str(raw.id), version: str(raw.version), status, trial: raw.trial === true || isResearchEngine(engine), ...(engine ? { engine } : {}) };
}

/**
 * Why a run may not be published, or null. Trial runs are research only, and a run rendered by a research engine
 * (hermes) never is published, whatever its pack says. Publishing, auto-publishing and any later upload stage call
 * this; there is no bypass.
 */
export function publishRefusal(pack: RunStylePack | null, renderer?: string | null): string | null {
  if (isResearchEngine(renderer) || isResearchEngine(pack?.engine)) return `${HERMES_RENDER_LABEL}: a video Hermes rendered is never published.`;
  if (pack?.trial) return `Trial style ${pack.id} ${pack.version}: research only, not for publishing.`;
  return null;
}

/**
 * The publishing guard on a run's final video: the autonomy policy may never approve or publish a trial or a Hermes
 * render by itself. The owner scores it (Review card) and decides. Other decisions pass through unchanged.
 */
export function guardFinalDecision<D extends { action: string; reason: string }>(decision: D, pack: RunStylePack | null | undefined, renderer?: string | null): D {
  const refusal = publishRefusal(pack ?? null, renderer);
  if (!refusal || (decision.action !== "auto-approve" && decision.action !== "auto-publish")) return decision;
  return { ...decision, action: "ask-owner", reason: `${refusal} The owner scores the video and decides.` };
}

// ---------------------------------------------------------------------------------------------------------------
// Trial outcomes (style_trial_outcomes, migration 0015) and the promotion rule

export type OwnerDecision = "approved" | "rejected" | "revised" | "auto-approved";

export interface TrialGate {
  gate: GateId;
  passed: boolean;
  score: number | null;
}

export interface TrialOutcome {
  runId: string;
  packId: string;
  packVersion: string;
  /** G-technical passed; null until the quality check ran. */
  qcPassed: boolean | null;
  gates: TrialGate[];
  presentationScore: number | null;
  ownerDecision: OwnerDecision | null;
  videoAssetId: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** The owner's rating behind presentationScore (migration 0016), when the owner scored it. */
  ownerRubric?: Rubric | null;
  /** Hermes's vision advisory (migration 0016). Never part of the rule. */
  hermesAdvisory?: PresentationAdvisory | null;
  /** The renderer that drew the video (migration 0016): ffmpeg-stills, remotion-2d, html-capture, hermes. */
  renderer?: string | null;
}

/** The QC part of an outcome, from the run's latest gate results. */
export function qcPartOf(gates: readonly TrialGate[]): Pick<TrialOutcome, "qcPassed" | "presentationScore"> {
  const tech = gates.find((g) => g.gate === "G-technical");
  const pres = gates.find((g) => g.gate === "G-presentation");
  return { qcPassed: tech ? tech.passed : null, presentationScore: pres && typeof pres.score === "number" ? pres.score : null };
}

/** The owner's final decision from the qc review item's state and whether the autonomy policy approved it. */
export function ownerDecisionOf(reviewState: string | null, autoApproved: boolean): OwnerDecision | null {
  if (reviewState === "approved") return "approved";
  if (reviewState === "rejected") return "rejected";
  if (reviewState === "revision") return "revised";
  return autoApproved ? "auto-approved" : null;
}

export interface TrialCounts extends TemplateEvidence {
  /** Outcomes of this version with a QC result. */
  measured: number;
  /** Trials with a presentation score (G-presentation). The mean is over these only. */
  presentationScored: number;
  approved: number;
  rejected: number;
  undecided: number;
}

/** Evidence for the promotion rule from one pack version's outcomes. Runs whose QC has not run yet do not count. */
export function trialCounts(outcomes: readonly TrialOutcome[], version: string): TrialCounts {
  const mine = outcomes.filter((o) => o.packVersion === version && o.qcPassed !== null);
  const failed = (o: TrialOutcome, gate: GateId) => o.gates.some((g) => g.gate === gate && !g.passed);
  const scores = mine.flatMap((o) => (o.presentationScore === null ? [] : [o.presentationScore]));
  return {
    trials: mine.length,
    passRate: mine.length ? mine.filter((o) => o.qcPassed).length / mine.length : 0,
    meanPresentationScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    assetFailures: mine.filter((o) => failed(o, "G-assets")).length,
    complianceFailures: mine.filter((o) => failed(o, "G-compliance")).length,
    claims: mine.filter((o) => failed(o, "G-claims")).length,
    measured: mine.length,
    presentationScored: scores.length,
    approved: mine.filter((o) => o.ownerDecision === "approved").length,
    rejected: mine.filter((o) => o.ownerDecision === "rejected").length,
    undecided: mine.filter((o) => o.ownerDecision === null).length,
  };
}

/**
 * What still blocks promoting a Trial pack, by the rule in templates.ts (trials, technical pass rate, presentation,
 * asset and compliance failures, claims, the owner's copyright checklist). The checklist comes from the style's
 * template; without one the checklist counts as unsigned.
 */
export function packPromotionIssues(pack: StylePack, template: Template | null, counts: TrialCounts): string[] {
  if (pack.status !== "trial") return [`Only a Trial pack is promoted from the portal's record (this one is ${STATUS_LABEL[pack.status]})`];
  const checklist = template?.copyrightChecklist ?? [];
  const base: Template = template ?? ({ copyrightChecklist: [] } as unknown as Template);
  const issues = promotionIssues({ ...base, status: "candidate", copyrightChecklist: checklist, evidence: counts });
  // A run without a presentation score is not counted as 0 and not as a pass: the rule needs the score measured.
  const unscored = counts.trials - counts.presentationScored;
  if (unscored > 0) issues.push(`${unscored} of ${counts.trials} trial run(s) have no presentation score yet (G-presentation); the rule needs it measured`);
  return issues;
}

export const PROMOTION_RULE_TEXT = `At least ${PROMOTION_MIN_TRIALS} trial runs, every one passing the technical gate, a mean presentation score of at least ${PROMOTION_MIN_PRESENTATION}, no asset or compliance failures, no open claims, and the owner's copyright checklist signed.`;

/**
 * The curation entries to copy into the pack's style.json when it is ready: one trial-run entry per measured run of
 * this version, and one qc summary. The owner's own owner-review entry is added in the PR, never here.
 */
export function curationRecord(pack: StylePack, outcomes: readonly TrialOutcome[], counts: TrialCounts): PackCuration[] {
  const mine = outcomes
    .filter((o) => o.packVersion === pack.version && o.qcPassed !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const day = (iso: string) => iso.slice(0, 10);
  const entries: PackCuration[] = mine.map((o) => ({
    date: day(o.decidedAt ?? o.createdAt),
    kind: "trial-run",
    ref: `venstudio run ${o.runId}${o.videoAssetId ? `, video asset ${o.videoAssetId}` : ""}`,
    result: o.qcPassed ? "pass" : "fail",
    notes: [
      `pack ${pack.id}@${o.packVersion}`,
      `G-technical ${o.qcPassed ? "passed" : "failed"}`,
      o.presentationScore !== null ? `presentation ${o.presentationScore}${o.ownerRubric ? ` (owner: ${rubricText(o.ownerRubric)})` : ""}` : "no presentation score",
      ...(o.hermesAdvisory ? [`Hermes advisory ${o.hermesAdvisory.score} (not counted)`] : []),
      ...(o.renderer ? [`renderer ${o.renderer}`] : []),
      `owner decision: ${o.ownerDecision ?? "none yet"}`,
    ].join("; "),
  }));
  const last = mine.length ? day(mine[mine.length - 1].decidedAt ?? mine[mine.length - 1].createdAt) : "";
  if (last) {
    entries.push({
      date: last,
      kind: "qc",
      ref: `venstudio Styles page, ${pack.id}@${pack.version}`,
      result: counts.passRate === 1 ? "pass" : "fail",
      notes: `${counts.trials} trials, ${Math.round(counts.passRate * 100)}% technical pass, mean presentation ${Math.round(counts.meanPresentationScore)}, ${counts.assetFailures} asset and ${counts.complianceFailures} compliance failures, ${counts.claims} claims; owner approved ${counts.approved}, rejected ${counts.rejected}.`,
    });
  }
  return entries;
}
