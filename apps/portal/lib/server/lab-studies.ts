import "server-only";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { hermesJson } from "./hermes-json.ts";
import { getAssetRow, queueAnalysis, VIDEO_KINDS } from "./assets.ts";
import { fingerprintOfJob } from "./template-lab.ts";
import { styleRegistry } from "./style-packs.ts";
import { reportedCapabilities } from "./workers.ts";
import { ensureSeedTemplates, listTemplates } from "./templates.ts";
import { ENGINES } from "../studio/catalog.ts";
import { availabilityOf, newVideoStyles } from "../studio/style-registry.ts";
import { blendFingerprints, type StructureFingerprint } from "../studio/template-lab.ts";
import {
  analystFor,
  applyMeasured,
  draftExport,
  isYouTubeUrl,
  LAB_SOURCE_TYPES,
  MAX_NOTE_CHARS,
  MAX_SOURCES_PER_STUDY,
  MAX_TITLE_CHARS,
  parseDraftSpec,
  parseSourceInput,
  parseSourceNotes,
  readDraft,
  rendererVerdict,
  revisionRefusal,
  sourceMessages,
  studyBrief,
  synthesisMessages,
  trialOption,
  type DraftExport,
  type DraftSpec,
  type LabSourceStatus,
  type LabSourceType,
  type RendererVerdict,
  type SourceFindings,
  type SourceInput,
  type TrialOption,
} from "../studio/lab-study.ts";

/**
 * Template Lab storage and the Hermes turns behind it (docs/template-lab.md). Every Hermes call goes through
 * hermesJson (the shared gate, validated JSON, retries); untrusted text (links, notes, findings) is sent only inside
 * DATA blocks (lib/studio/lab-study.ts). Nothing here fetches a link: Hermes does the looking.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asDate = (v: unknown): Date | null => (v instanceof Date ? v : null);
const HERMES_OPTS = { retries: 2, timeoutMs: 300_000, queueTimeoutMs: 60_000 } as const;
/**
 * Longer than the longest Hermes turn (3 attempts of 300 s plus the queue). A draft still "working" or a source still
 * being looked at after this was interrupted (a portal restart): it may be asked again.
 */
const STALE_MINUTES = 20;

export interface StudyRevision {
  revision: number;
  note: string;
  at: string;
}

export interface Study {
  id: string;
  title: string;
  goal: "new" | "improve";
  basePack: string | null;
  notes: string;
  draft: DraftSpec | null;
  draftState: "none" | "working" | "ready" | "failed";
  draftError: string | null;
  draftAt: Date | null;
  revision: number;
  revisions: StudyRevision[];
  createdAt: Date | null;
}

export interface LabSource {
  id: string;
  studyId: string;
  type: LabSourceType;
  ref: string;
  refPath: string | null;
  licence: string;
  assetId: string | null;
  assetTitle: string | null;
  analysisJobId: string | null;
  status: LabSourceStatus;
  reason: string | null;
  findings: SourceFindings | null;
  createdAt: Date | null;
}

export interface StudyTrial {
  runId: string;
  state: string;
  createdAt: Date | null;
  packId: string;
  packVersion: string;
  qcPassed: boolean | null;
  presentationScore: number | null;
  ownerDecision: string | null;
  renderer: string | null;
}

async function packIds(): Promise<string[]> {
  return (await styleRegistry()).filter((e) => e.pack).map((e) => e.id);
}

function toStudy(r: Record<string, unknown>, ids: readonly string[]): Study {
  const revisions = Array.isArray(r.revisions)
    ? r.revisions.filter(isRecord).map((x) => ({ revision: Number(x.revision) || 0, note: typeof x.note === "string" ? x.note : "", at: typeof x.at === "string" ? x.at : "" }))
    : [];
  let state: Study["draftState"] = r.draft_state === "working" || r.draft_state === "ready" || r.draft_state === "failed" ? r.draft_state : "none";
  let draftError = typeof r.draft_error === "string" ? r.draft_error : null;
  const draft = readDraft(r.draft, ids);
  if (state === "working" && r.stale === true) {
    state = "failed";
    draftError = "The last drafting did not finish (the portal may have restarted). Ask again.";
  } else if (r.draft && !draft && state !== "working") {
    state = "failed";
    draftError = "The stored draft no longer passes the pack format's checks. Synthesize it again.";
  }
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    goal: r.goal === "improve" ? "improve" : "new",
    basePack: typeof r.base_pack === "string" ? r.base_pack : null,
    notes: String(r.notes ?? ""),
    draft,
    draftState: state,
    draftError,
    draftAt: asDate(r.draft_at),
    revision: Number(r.revision) || 0,
    revisions,
    createdAt: asDate(r.created_at),
  };
}

function readFindings(raw: unknown): SourceFindings | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind === "hermes-notes" || raw.kind === "measured" || raw.kind === "owner-note" ? raw.kind : null;
  if (!kind) return null;
  return {
    kind,
    ...(isRecord(raw.notes) ? { notes: raw.notes as unknown as SourceFindings["notes"] } : {}),
    ...(isRecord(raw.fingerprint) ? { fingerprint: raw.fingerprint as unknown as StructureFingerprint } : {}),
    ...(typeof raw.analysisJobId === "string" ? { analysisJobId: raw.analysisJobId } : {}),
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

function toSource(r: Record<string, unknown>): LabSource {
  const type = LAB_SOURCE_TYPES.find((t) => t === r.type) ?? "owner-note";
  const status: LabSourceStatus = r.status === "analyzed" || r.status === "failed" ? r.status : "pending";
  return {
    id: String(r.id),
    studyId: String(r.study_id),
    type,
    ref: String(r.ref ?? ""),
    refPath: typeof r.ref_path === "string" ? r.ref_path : null,
    licence: String(r.licence ?? ""),
    assetId: typeof r.asset_id === "string" ? r.asset_id : null,
    assetTitle: typeof r.asset_title === "string" ? r.asset_title : null,
    analysisJobId: typeof r.analysis_job_id === "string" ? r.analysis_job_id : null,
    status,
    reason: typeof r.reason === "string" ? r.reason : null,
    findings: readFindings(r.findings),
    createdAt: asDate(r.created_at),
  };
}

export async function listStudies(): Promise<Array<{ id: string; title: string; goal: string; draftName: string | null; revision: number; sources: number; analyzed: number; trials: number; createdAt: Date | null }>> {
  const rows = await db()`
    SELECT s.id, s.title, s.goal, s.draft->>'name' AS draft_name, s.revision, s.created_at,
           (SELECT count(*) FROM lab_sources x WHERE x.study_id = s.id) AS sources,
           (SELECT count(*) FROM lab_sources x WHERE x.study_id = s.id AND x.status = 'analyzed') AS analyzed,
           (SELECT count(*) FROM pipeline_runs r WHERE r.config ? 'labStudyId' AND r.config->>'labStudyId' = s.id::text) AS trials
    FROM lab_studies s ORDER BY s.created_at DESC LIMIT 100
  `;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    goal: String(r.goal),
    draftName: typeof r.draft_name === "string" ? r.draft_name : null,
    revision: Number(r.revision) || 0,
    sources: Number(r.sources) || 0,
    analyzed: Number(r.analyzed) || 0,
    trials: Number(r.trials) || 0,
    createdAt: asDate(r.created_at),
  }));
}

export async function getStudy(id: string): Promise<Study | null> {
  const [r] = await db()`
    SELECT *, (draft_state = 'working' AND updated_at < now() - make_interval(mins => ${STALE_MINUTES})) AS stale FROM lab_studies WHERE id = ${id}
  `;
  return r ? toStudy(r as Record<string, unknown>, await packIds()) : null;
}

export async function studySources(studyId: string): Promise<LabSource[]> {
  const rows = await db()`
    SELECT x.*, a.title AS asset_title FROM lab_sources x LEFT JOIN assets a ON a.id = x.asset_id
    WHERE x.study_id = ${studyId} ORDER BY x.created_at, x.id
  `;
  return rows.map((r) => toSource(r as Record<string, unknown>));
}

async function getSource(id: string): Promise<LabSource | null> {
  const [r] = await db()`SELECT * FROM lab_sources WHERE id = ${id}`;
  return r ? toSource(r as Record<string, unknown>) : null;
}

/** Runs started as trials from this study, with their curation outcome (style_trial_outcomes, once QC ran). */
export async function studyTrials(studyId: string): Promise<StudyTrial[]> {
  const rows = await db()`
    SELECT r.id, r.state, r.created_at, r.config->'stylePack'->>'id' AS pack_id, r.config->'stylePack'->>'version' AS pack_version,
           o.qc_passed, o.presentation_score, o.owner_decision, o.renderer
    FROM pipeline_runs r LEFT JOIN style_trial_outcomes o ON o.run_id = r.id
    WHERE r.config ? 'labStudyId' AND r.config->>'labStudyId' = ${studyId}
    ORDER BY r.created_at DESC LIMIT 50
  `;
  return rows.map((r) => ({
    runId: String(r.id),
    state: String(r.state),
    createdAt: asDate(r.created_at),
    packId: String(r.pack_id ?? ""),
    packVersion: String(r.pack_version ?? ""),
    qcPassed: typeof r.qc_passed === "boolean" ? r.qc_passed : null,
    presentationScore: typeof r.presentation_score === "number" ? r.presentation_score : null,
    ownerDecision: typeof r.owner_decision === "string" ? r.owner_decision : null,
    renderer: typeof r.renderer === "string" ? r.renderer : null,
  }));
}

export type LabResult = { ok: true; id: string } | { ok: false; error: string };

export async function createStudy(input: { title: string; goal: string; basePack: string; notes: string; userId: string }): Promise<LabResult> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  if (!title) return { ok: false, error: "Name the study" };
  const goal = input.goal === "improve" ? "improve" : "new";
  let basePack: string | null = null;
  if (goal === "improve") {
    const ids = await packIds();
    if (!ids.includes(input.basePack)) return { ok: false, error: "Choose the pack to improve" };
    basePack = input.basePack;
  }
  const notes = input.notes.replace(/\r\n/g, "\n").trim().slice(0, MAX_NOTE_CHARS);
  const [row] = await db()`
    INSERT INTO lab_studies (title, goal, base_pack, notes, created_by) VALUES (${title}, ${goal}, ${basePack}, ${notes}, ${input.userId}) RETURNING id
  `;
  return { ok: true, id: String(row.id) };
}

/** The newest analyze-video job of an asset that has not failed, or null. */
async function latestAnalysis(assetId: string): Promise<{ id: string; status: string } | null> {
  const [j] = await db()`
    SELECT id, status FROM jobs WHERE type = 'analyze-video' AND payload->'inputs' @> to_jsonb(ARRAY[${assetId}::text])
      AND status IN ('queued', 'running', 'succeeded')
    ORDER BY (status = 'succeeded') DESC, created_at DESC LIMIT 1
  `;
  return j ? { id: String(j.id), status: String(j.status) } : null;
}

/**
 * Adds a source. An upload reuses the asset's analysis when it has one, and queues analyze-video otherwise. A link,
 * an article, a repository or a skill is stored as a reference and waits for Hermes (processSource).
 */
export async function addSource(studyId: string, input: SourceInput, userId: string): Promise<LabResult> {
  const sql = db();
  const [study] = await sql`SELECT id, (SELECT count(*) FROM lab_sources WHERE study_id = ${studyId}) AS n FROM lab_studies WHERE id = ${studyId}`;
  if (!study) return { ok: false, error: "Unknown study" };
  if (Number(study.n) >= MAX_SOURCES_PER_STUDY) return { ok: false, error: `A study holds at most ${MAX_SOURCES_PER_STUDY} sources` };
  let assetLicence: string | null = null;
  let assetId: string | null = null;
  let jobId: string | null = null;
  if (input.type === "upload") {
    const asset = /^[0-9a-f-]{36}$/i.test(input.ref) ? await getAssetRow(input.ref) : undefined;
    if (!asset || !VIDEO_KINDS.includes(asset.kind)) return { ok: false, error: "Pick an uploaded video from Assets" };
    assetLicence = asset.license;
    assetId = asset.id;
  }
  const parsed = parseSourceInput(input, { assetLicence });
  if (!parsed.ok) return { ok: false, error: parsed.issues[0] ?? "Check the source" };
  const s = parsed.value;
  if (assetId) jobId = (await latestAnalysis(assetId))?.id ?? (await queueAnalysis(assetId, userId));
  const findings: SourceFindings | null = s.type === "owner-note" ? { kind: "owner-note", at: new Date().toISOString() } : null;
  const reason = analystFor(s.type) === "hermes" ? "Waiting for Hermes" : analystFor(s.type) === "worker" ? "Waiting for the worker's analysis" : null;
  const [row] = await sql`
    INSERT INTO lab_sources (study_id, type, ref, ref_path, licence, asset_id, analysis_job_id, status, reason, findings, created_by)
    VALUES (${studyId}, ${s.type}, ${s.ref}, ${s.refPath}, ${s.licence}, ${assetId}, ${jobId}, ${s.status}, ${reason},
            ${findings ? JSON.stringify(findings) : null}::text::jsonb, ${userId})
    RETURNING id
  `;
  await sql`UPDATE lab_studies SET updated_at = now() WHERE id = ${studyId}`;
  return { ok: true, id: String(row.id) };
}

async function setSource(id: string, status: LabSourceStatus, reason: string | null, findings: SourceFindings | null, licence?: string): Promise<void> {
  await db()`
    UPDATE lab_sources SET status = ${status}, reason = ${reason ? reason.slice(0, 600) : null},
      findings = ${findings ? JSON.stringify(findings) : null}::text::jsonb,
      licence = COALESCE(${licence ?? null}, licence), updated_at = now()
    WHERE id = ${id}
  `;
}

/** An upload's state from its analyze-video job: numbers once it succeeded, the job's error once it failed. Database only. */
async function refreshUpload(src: LabSource): Promise<void> {
  if (!src.analysisJobId) {
    if (src.status === "pending") await setSource(src.id, "failed", "The upload has no analysis job; add it again", null);
    return;
  }
  const [job] = await db()`SELECT status, error FROM jobs WHERE id = ${src.analysisJobId}`;
  const status = typeof job?.status === "string" ? job.status : "missing";
  if (status === "succeeded") {
    const fp = await fingerprintOfJob(src.analysisJobId);
    if (fp) await setSource(src.id, "analyzed", null, { kind: "measured", fingerprint: fp, analysisJobId: src.analysisJobId, at: new Date().toISOString() });
    else await setSource(src.id, "failed", "The analysis finished but its analysis.json could not be read", null);
  } else if (status === "failed" || status === "cancelled" || status === "missing") {
    await setSource(src.id, "failed", `The worker's analysis ${status === "missing" ? "is gone" : status}${typeof job?.error === "string" && job.error ? `: ${job.error.slice(0, 300)}` : ""}`, null);
  } else {
    const reason = `Waiting for the worker's analysis (job ${status})`;
    if (src.reason !== reason) await setSource(src.id, "pending", reason, null);
  }
}

/** Updates every pending upload of a study from its analysis job. Database only: safe to call while a page renders. */
export async function refreshPendingUploads(studyId: string): Promise<void> {
  for (const s of await studySources(studyId)) if (s.type === "upload" && s.status === "pending") await refreshUpload(s);
}

/**
 * Looks at one source: refreshes an upload, or asks Hermes (through the gate) for pattern notes on a link, an
 * article, a repository or a skill. Hermes rate limits leave it pending with the wait; other failures are recorded
 * with their reason. Never throws.
 */
export async function processSource(sourceId: string, studyId?: string): Promise<void> {
  try {
    const src = await getSource(sourceId);
    if (!src || (studyId && src.studyId !== studyId) || src.status === "analyzed") return;
    const analyst = analystFor(src.type);
    if (analyst === "worker") return await refreshUpload(src);
    if (analyst !== "hermes") return;
    if (!env().HERMES_BASE_URL) return await setSource(src.id, "failed", "Hermes is not set up (HERMES_BASE_URL), so nobody can look at this source", null);
    // Claim it, so two clicks never send Hermes the same source twice (an interrupted claim goes stale).
    const [claimed] = await db()`
      UPDATE lab_sources SET status = 'pending', reason = ${LOOKING}, updated_at = now()
      WHERE id = ${src.id} AND status <> 'analyzed'
        AND NOT (status = 'pending' AND reason = ${LOOKING} AND updated_at > now() - make_interval(mins => ${STALE_MINUTES}))
      RETURNING id
    `;
    if (!claimed) return;
    const [st] = await db()`SELECT title, goal FROM lab_studies WHERE id = ${src.studyId}`;
    const linkKind = src.type === "link" ? (isYouTubeUrl(src.ref) ? "youtube" : "web") : null;
    const answer = await hermesJson(
      sourceMessages({ type: src.type, ref: src.ref, refPath: src.refPath, linkKind }, { title: String(st?.title ?? ""), goal: String(st?.goal ?? "new") }),
      (v) => parseSourceNotes(v, src.type),
      HERMES_OPTS,
    );
    if (!answer.ok) {
      if (answer.cause === "busy") return await setSource(src.id, "pending", answer.error, null);
      return await setSource(src.id, "failed", answer.error, null);
    }
    const found = src.type === "repo" ? answer.value.licence : null;
    await setSource(src.id, "analyzed", null, { kind: "hermes-notes", notes: answer.value, at: new Date().toISOString() }, found ? `${found} (read by Hermes)`.slice(0, 200) : undefined);
  } catch (err) {
    console.error("lab source failed", sourceId, err);
    await setSource(sourceId, "failed", `Could not study the source: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`, null).catch(() => {});
  }
}

/** The reason a source shows while Hermes is looking at it (also its claim). */
export const LOOKING = "Hermes is looking at it";

/** The sources Hermes still has to look at (new ones, and ones that waited for a rate limit). */
export async function sourcesForHermes(studyId: string): Promise<string[]> {
  return (await studySources(studyId)).filter((s) => analystFor(s.type) === "hermes" && s.status === "pending").map((s) => s.id);
}

/** Marks the study as drafting before the background turn starts, so the page shows it. Refuses what cannot run. */
export async function beginSynthesis(studyId: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const study = await getStudy(studyId);
  if (!study) return { ok: false, error: "Unknown study" };
  if (study.draftState === "working") return { ok: false, error: "Hermes is already drafting" };
  if (!env().HERMES_BASE_URL) return { ok: false, error: "Hermes is not set up (HERMES_BASE_URL)" };
  if (note) {
    if (!study.draft) return { ok: false, error: "There is no draft to revise yet" };
    const why = revisionRefusal(study.revision, note);
    if (why) return { ok: false, error: why };
  }
  const sources = await studySources(studyId);
  if (!sources.some((s) => s.status === "analyzed")) return { ok: false, error: "No source is analyzed yet" };
  const [r] = await db()`
    UPDATE lab_studies SET draft_state = 'working', draft_error = NULL, updated_at = now()
    WHERE id = ${studyId} AND (draft_state <> 'working' OR updated_at < now() - make_interval(mins => ${STALE_MINUTES}))
    RETURNING id
  `;
  return r ? { ok: true } : { ok: false, error: "Hermes is already drafting" };
}

/**
 * Asks Hermes to combine the analyzed sources into a draft pack spec (or to revise the current one by the owner's
 * note), validates it, and lets the numbers measured from uploads override Hermes's estimates. Never throws.
 */
export async function synthesize(studyId: string, note: string): Promise<void> {
  try {
    const study = await getStudy(studyId);
    if (!study) return;
    const sources = (await studySources(studyId)).filter((s) => s.status === "analyzed" && s.findings);
    const fps = sources.flatMap((s) => (s.findings?.fingerprint ? [s.findings.fingerprint] : []));
    const registry = await styleRegistry();
    const caps = await reportedCapabilities().catch(() => [] as string[]);
    const hermes = Boolean(env().HERMES_BASE_URL);
    const ids = registry.filter((e) => e.pack).map((e) => e.id);
    const revising = Boolean(note && study.draft);
    const measured = fps.length ? blendFingerprints(fps) : null;
    const answer = await hermesJson(
      synthesisMessages({
        study,
        sources: sources.map((s) => ({ type: s.type, ref: s.ref, licence: s.licence, findings: s.findings as SourceFindings })),
        engines: Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, reported: e.id === "hermes" ? hermes : caps.includes(e.capability) })),
        packs: registry.filter((e) => e.pack).map((e) => ({ id: e.id, name: e.label, engine: e.engine, status: e.pack!.status })),
        measured,
        current: revising ? study.draft : null,
        revisionNote: note,
      }),
      (v) => parseDraftSpec(v, { packIds: ids, allowId: revising ? study.draft!.packId : study.basePack }),
      HERMES_OPTS,
    );
    if (!answer.ok) {
      await db()`UPDATE lab_studies SET draft_state = 'failed', draft_error = ${answer.error.slice(0, 600)}, updated_at = now() WHERE id = ${studyId}`;
      return;
    }
    let draft = applyMeasured(answer.value, fps);
    // A revision keeps the pack id, so the export stays one pack across revisions.
    if (revising) draft = { ...draft, packId: study.draft!.packId };
    // What is stored must read back (the page and the export re-validate it).
    if (!readDraft(JSON.parse(JSON.stringify(draft)), ids)) {
      await db()`UPDATE lab_studies SET draft_state = 'failed', draft_error = ${"Hermes's draft did not pass the pack format's checks after the measured numbers were applied"}, updated_at = now() WHERE id = ${studyId}`;
      return;
    }
    const revision = revising ? study.revision + 1 : study.revision;
    const revisions = revising ? [...study.revisions, { revision, note: note.slice(0, MAX_NOTE_CHARS), at: new Date().toISOString() }] : study.revisions;
    await db()`
      UPDATE lab_studies SET draft = ${JSON.stringify(draft)}::text::jsonb, draft_state = 'ready', draft_error = NULL, draft_at = now(),
        revision = ${revision}, revisions = ${JSON.stringify(revisions)}::text::jsonb, updated_at = now()
      WHERE id = ${studyId}
    `;
  } catch (err) {
    console.error("lab synthesis failed", studyId, err);
    await db()`UPDATE lab_studies SET draft_state = 'failed', draft_error = ${`Could not draft: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`}, updated_at = now() WHERE id = ${studyId}`.catch(() => {});
  }
}

export interface StudyTrialState {
  verdict: RendererVerdict | null;
  option: TrialOption;
  brief: string;
}

/**
 * Whether the study can start a trial video now, from stored worker capabilities only (no call to a worker): the
 * recommended renderer must be available and New Video must offer the closest pack (Listed or Trial, reported, with a
 * template), the same rule New Video uses.
 */
export async function studyTrialState(study: Study): Promise<StudyTrialState> {
  const draft = study.draft;
  const caps = await reportedCapabilities().catch(() => [] as string[]);
  const hermes = Boolean(env().HERMES_BASE_URL);
  const verdict = draft ? rendererVerdict(draft.renderer, caps, { hermes }) : null;
  const registry = await styleRegistry();
  const entry = draft?.closestPack ? registry.find((e) => e.id === draft.closestPack) : undefined;
  let templateId: string | null = null;
  if (entry?.pack) {
    const offer = newVideoStyles(registry, caps, { hermes });
    if ([...offer.listed, ...offer.trial].some((e) => e.id === entry.id)) {
      await ensureSeedTemplates();
      templateId = (await listTemplates()).find((t) => t.styleId === entry.id && t.status !== "retired")?.id ?? null;
    }
  }
  const option = trialOption({
    draft,
    verdict,
    closest: entry?.pack ? { id: entry.id, status: entry.pack.status, packReported: availabilityOf(entry, caps, { hermes }).pack } : null,
    templateId,
  });
  return { verdict, option, brief: studyBrief(study, draft) };
}

/** The one-file draft pack for "Download draft pack", or null without a draft. */
export async function studyExport(studyId: string): Promise<DraftExport | null> {
  const study = await getStudy(studyId);
  if (!study?.draft) return null;
  const caps = await reportedCapabilities().catch(() => [] as string[]);
  const verdict = rendererVerdict(study.draft.renderer, caps, { hermes: Boolean(env().HERMES_BASE_URL) });
  const sources = await studySources(studyId);
  return draftExport({ id: study.id, title: study.title }, study.draft, sources, verdict);
}

/** True when the id names a study; startRun checks it before linking a run. */
export async function studyExists(id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [r] = await db()`SELECT 1 AS ok FROM lab_studies WHERE id = ${id}`;
  return Boolean(r);
}

/** Videos in Assets the owner can study (the asset picker), with the licence recorded on each. */
export async function videoAssetsForLab(): Promise<Array<{ id: string; title: string; kind: string; licence: string }>> {
  const rows = await db()`
    SELECT id, title, kind, license FROM assets WHERE kind = ANY(${VIDEO_KINDS}::text[]) AND storage_path IS NOT NULL
    ORDER BY created_at DESC LIMIT 100
  `;
  return rows.map((r) => ({ id: String(r.id), title: String(r.title ?? ""), kind: String(r.kind), licence: String(r.license ?? "") }));
}
