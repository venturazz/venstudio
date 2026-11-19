import "server-only";
import { db } from "./db.ts";
import { latestGatesByRun } from "./reviews.ts";
import type { GateResult } from "../studio/qc.ts";
import type { ReviewKind, ReviewPayload, ReviewState } from "../studio/review.ts";

export interface RunSummary {
  id: string;
  topic: string;
  state: string;
  channelName: string;
  templateId: string;
  level: number;
  createdAt: Date;
  finishedAt: Date | null;
  /** The stage the run is at, from the newest stage row. */
  currentStage: string;
}

export interface StageView {
  id: string;
  stage: string;
  attempt: number;
  state: string;
  output: Record<string, unknown>;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface WorkOrderView {
  id: string;
  stage: string;
  shotRef: string;
  executor: string;
  state: string;
  spec: Record<string, unknown>;
}

export interface RunReviewView {
  id: string;
  stage: string;
  kind: ReviewKind;
  state: ReviewState;
  payload: ReviewPayload;
  note: string;
  createdAt: Date;
}

export interface RunDetail {
  run: RunSummary & { config: Record<string, unknown> };
  /** The newest attempt of each stage, in pipeline order. */
  stages: StageView[];
  attempts: number;
  workOrders: WorkOrderView[];
  reviews: RunReviewView[];
  gates: GateResult[];
}

const STAGE_ORDER = ["idea", "research", "script", "storyboard", "assets", "voice", "draft", "render", "qc", "approval", "upload", "claim-watch", "publish", "learn"];

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function summaryFrom(r: Record<string, unknown>): RunSummary {
  return {
    id: r.id as string,
    topic: (r.topic as string | null) ?? "",
    state: r.state as string,
    channelName: (r.channel_name as string | null) ?? "",
    templateId: (r.template_id as string | null) ?? "",
    level: Number(r.autonomy_level),
    createdAt: r.created_at as Date,
    finishedAt: (r.finished_at as Date | null) ?? null,
    currentStage: (r.current_stage as string | null) ?? "",
  };
}

export async function listRuns(limit = 30): Promise<RunSummary[]> {
  const rows = await db()`
    SELECT r.id, r.topic, r.state, r.template_id, r.autonomy_level, r.created_at, r.finished_at, c.name AS channel_name,
      (SELECT s.stage FROM pipeline_stages s WHERE s.run_id = r.id ORDER BY s.started_at DESC NULLS FIRST, s.attempt DESC LIMIT 1) AS current_stage
    FROM pipeline_runs r LEFT JOIN channels c ON c.id = r.channel_id
    WHERE r.kind = 'production'
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => summaryFrom(r));
}

export async function getRun(id: string): Promise<RunDetail | null> {
  const sql = db();
  const [r] = await sql`
    SELECT r.id, r.topic, r.state, r.template_id, r.autonomy_level, r.created_at, r.finished_at, r.config, c.name AS channel_name
    FROM pipeline_runs r LEFT JOIN channels c ON c.id = r.channel_id
    WHERE r.id = ${id}
  `;
  if (!r) return null;
  const [stageRows, orderRows, reviewRows, gates] = await Promise.all([
    sql`SELECT id, stage, attempt, state, output, error, started_at, finished_at FROM pipeline_stages WHERE run_id = ${id} ORDER BY attempt`,
    sql`SELECT id, stage, shot_ref, executor, state, spec FROM work_orders WHERE run_id = ${id} ORDER BY shot_ref`,
    sql`SELECT id, stage, kind, state, payload, note, created_at FROM review_items WHERE run_id = ${id} ORDER BY created_at DESC`,
    latestGatesByRun([id]),
  ]);
  const newest = new Map<string, StageView>();
  for (const s of stageRows) {
    const view: StageView = {
      id: s.id as string,
      stage: s.stage as string,
      attempt: s.attempt as number,
      state: s.state as string,
      output: obj(s.output),
      error: (s.error as string | null) ?? null,
      startedAt: (s.started_at as Date | null) ?? null,
      finishedAt: (s.finished_at as Date | null) ?? null,
    };
    const prev = newest.get(view.stage);
    if (!prev || view.attempt > prev.attempt) newest.set(view.stage, view);
  }
  const stages = [...newest.values()].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
  const current = [...stages].reverse().find((s) => s.state !== "skipped");
  return {
    run: { ...summaryFrom({ ...r, current_stage: current?.stage ?? "" }), config: obj(r.config) },
    stages,
    attempts: stageRows.length,
    workOrders: orderRows.map((w): WorkOrderView => ({
      id: w.id as string,
      stage: w.stage as string,
      shotRef: (w.shot_ref as string | null) ?? "",
      executor: w.executor as string,
      state: w.state as string,
      spec: obj(w.spec),
    })),
    reviews: reviewRows.map((v): RunReviewView => {
      const p = obj(v.payload);
      return {
        id: v.id as string,
        stage: v.stage as string,
        kind: v.kind as ReviewKind,
        state: v.state as ReviewState,
        payload: { summary: typeof p.summary === "string" ? p.summary : "", error: typeof p.error === "string" ? p.error : undefined },
        note: (v.note as string | null) ?? "",
        createdAt: v.created_at as Date,
      };
    }),
    gates: gates.get(id) ?? [],
  };
}
