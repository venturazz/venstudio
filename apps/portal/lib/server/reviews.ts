import "server-only";
import { db } from "./db.ts";
import type { GateId, GateResult } from "../studio/qc.ts";
import type { ReviewKind, ReviewMedia, ReviewPayload, ReviewState } from "../studio/review.ts";
import { parseProviderRows } from "../studio/terms-review.ts";
import { parseVoiceFix } from "../studio/voice-fit.ts";

export interface ReviewCard {
  id: string;
  runId: string;
  stage: string;
  kind: ReviewKind;
  state: ReviewState;
  payload: ReviewPayload;
  note: string;
  createdAt: Date;
  topic: string;
  channelName: string;
  /** Newest result per gate for the run. */
  gates: GateResult[];
  /** The run was started with a Trial style pack (pipeline_runs.config.stylePack.trial): research only. */
  trial: boolean;
  /** The run's pack renders with Hermes (research only, never published). */
  hermesRender: boolean;
}

function toPayload(raw: unknown): ReviewPayload {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const payload: ReviewPayload = { summary: typeof p.summary === "string" ? p.summary : "" };
  if (Array.isArray(p.ideas)) {
    payload.ideas = p.ideas.flatMap((i) => {
      const r = (typeof i === "object" && i !== null ? i : {}) as Record<string, unknown>;
      if (typeof r.title !== "string" || typeof r.hook !== "string" || typeof r.angle !== "string" || typeof r.score !== "number") return [];
      return [{ title: r.title, hook: r.hook, angle: r.angle, score: r.score }];
    });
  }
  if (Array.isArray(p.issues)) payload.issues = p.issues.filter((i): i is string => typeof i === "string");
  if (typeof p.error === "string") payload.error = p.error;
  if (typeof p.reason === "string") payload.reason = p.reason;
  if (Array.isArray(p.checks)) payload.checks = p.checks.filter((i): i is string => typeof i === "string");
  if (typeof p.media === "object" && p.media !== null) {
    const m = p.media as Record<string, unknown>;
    const media: ReviewMedia = {};
    if (Array.isArray(m.images)) {
      media.images = m.images.flatMap((i) => {
        const r = (typeof i === "object" && i !== null ? i : {}) as Record<string, unknown>;
        if (typeof r.assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(r.assetId)) return [];
        const item: { assetId: string; shotRef: string; provider: string; plugin?: string } = {
          assetId: r.assetId,
          shotRef: typeof r.shotRef === "string" ? r.shotRef : "",
          provider: typeof r.provider === "string" ? r.provider : "",
        };
        // The Hermes plugin in front of the backend, so the card reads "canva via 9router".
        if (typeof r.plugin === "string" && r.plugin) item.plugin = r.plugin.slice(0, 80);
        return [item];
      });
    }
    const id = (v: unknown): string | undefined => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    const audio = id(m.audioAssetId);
    const video = id(m.videoAssetId);
    if (audio) media.audioAssetId = audio;
    if (video) media.videoAssetId = video;
    if (typeof m.voiceProvider === "string") media.voiceProvider = m.voiceProvider;
    payload.media = media;
  }
  const providers = parseProviderRows(p.providers);
  if (providers.length > 0) payload.providers = providers;
  if (typeof p.recheckedAt === "string" && !Number.isNaN(Date.parse(p.recheckedAt))) payload.recheckedAt = p.recheckedAt;
  if (Array.isArray(p.notes)) {
    const notes = p.notes.filter((i): i is string => typeof i === "string").slice(0, 10);
    if (notes.length > 0) payload.notes = notes;
  }
  const voice = parseVoiceFix(p.voice);
  if (voice) payload.voice = voice;
  return payload;
}

/** The newest report of each gate for the given runs, keyed by run id. */
export async function latestGatesByRun(runIds: string[]): Promise<Map<string, GateResult[]>> {
  const out = new Map<string, GateResult[]>();
  if (runIds.length === 0) return out;
  const sql = db();
  const rows = await sql`
    SELECT DISTINCT ON (run_id, gate) run_id, gate, passed, score, details, executor
    FROM qc_reports WHERE run_id IN ${sql(runIds)}
    ORDER BY run_id, gate, created_at DESC
  `;
  for (const r of rows) {
    const details = (typeof r.details === "object" && r.details !== null ? r.details : {}) as { issues?: unknown };
    const gate: GateResult = {
      gate: r.gate as GateId,
      passed: r.passed as boolean,
      score: typeof r.score === "number" ? r.score : undefined,
      issues: Array.isArray(details.issues) ? details.issues.filter((i): i is string => typeof i === "string") : [],
      executor: (r.executor as string | null) ?? "",
    };
    const runId = r.run_id as string;
    out.set(runId, [...(out.get(runId) ?? []), gate]);
  }
  return out;
}

/** Open review items, newest last within each kind is decided by the page with sortReviews. */
export async function listOpenReviews(): Promise<ReviewCard[]> {
  const rows = await db()`
    SELECT ri.id, ri.run_id, ri.stage, ri.kind, ri.state, ri.payload, ri.note, ri.created_at, r.topic, c.name AS channel_name,
      coalesce((r.config->'stylePack'->>'trial')::boolean, false) OR coalesce(r.config->'stylePack'->>'engine' = 'hermes', false) AS trial,
      coalesce(r.config->'stylePack'->>'engine' = 'hermes', false) AS hermes_render
    FROM review_items ri
    JOIN pipeline_runs r ON r.id = ri.run_id
    LEFT JOIN channels c ON c.id = r.channel_id
    WHERE ri.state = 'open'
    ORDER BY ri.created_at
    LIMIT 100
  `;
  const gates = await latestGatesByRun([...new Set(rows.map((r) => r.run_id as string))]);
  return rows.map((r): ReviewCard => ({
    id: r.id as string,
    runId: r.run_id as string,
    stage: r.stage as string,
    kind: r.kind as ReviewKind,
    state: r.state as ReviewState,
    payload: toPayload(r.payload),
    note: (r.note as string | null) ?? "",
    createdAt: r.created_at as Date,
    topic: (r.topic as string | null) ?? "",
    channelName: (r.channel_name as string | null) ?? "",
    gates: gates.get(r.run_id as string) ?? [],
    trial: r.trial === true,
    hermesRender: r.hermes_render === true,
  }));
}

/** Number of items waiting for the owner, for the nav badge. Never throws: a badge must not break a page. */
export async function countOpenReviews(): Promise<number> {
  try {
    const [r] = await db()`SELECT count(*)::int AS n FROM review_items WHERE state = 'open'`;
    return (r?.n as number | undefined) ?? 0;
  } catch {
    return 0;
  }
}
