import "server-only";
import { db } from "./db.ts";
import { startRun } from "./director.ts";
import { listTemplates } from "./templates.ts";
import {
  defaultTimesFor,
  nextSlots,
  parseCadence,
  parseScheduleSettings,
  slotGate,
  slotKey,
  type CadenceDays,
} from "../studio/schedule.ts";

/**
 * AutoStudio's server side: the schedule list, the state of a schedule, and the tick that turns a due slot into a run.
 *
 * The tick is the only place where something is created, and everything it does is guarded in this order: is the slot
 * already claimed, is the schedule armed, is the channel active, is the worker busy, is there budget. A slot that fails
 * a guard is *recorded as skipped with its reason* (returned to the caller and shown on the page) rather than silently
 * passed over — a scheduler that quietly does nothing is indistinguishable from one that is broken.
 *
 * Idempotency lives in the database, not in this file: `pipeline_runs (schedule_id, slot_at)` is unique. The advisory
 * lock below only keeps two concurrent ticks from racing to the same answer; the unique index is what makes the answer
 * true even if they do.
 */

export interface ScheduleRow {
  id: string;
  channelId: string;
  channelName: string;
  channelStatus: "planning" | "active" | "paused";
  videosPerDay: number;
  name: string;
  kind: "series" | "one-off";
  days: CadenceDays;
  timesOfDay: string[];
  timezone: string;
  slotsAhead: number;
  state: "draft" | "armed" | "paused";
  budgetHours: number;
  settings: ReturnType<typeof parseScheduleSettings>;
  briefTopic: string;
  /** Who a run started by this schedule is recorded against. No owner, no run: a run with no author is not a run. */
  createdBy: string | null;
}

export interface ScheduledRunNext {
  at: Date;
  /** Why it will be skipped, when it will be. Null means it is expected to run. */
  blocked: string | null;
}

const DAY = 86_400_000;

/** How long a worker needs per video second, when nothing has been measured yet. Documented, not hidden. */
export const DEFAULT_SECONDS_PER_VIDEO_SECOND = 8;

export async function listSchedules(): Promise<ScheduleRow[]> {
  const rows = await db()`
    SELECT s.id, s.channel_id, c.name AS channel_name, c.status AS channel_status, c.videos_per_day,
           s.name, s.kind, s.days, s.times_of_day, s.timezone, s.slots_ahead, s.state, s.budget, s.settings, s.brief,
           s.created_by
    FROM schedules s
    JOIN channels c ON c.id = s.channel_id
    ORDER BY c.name, s.created_at
  `;
  return rows.map((r) => {
    const budget = (r.budget ?? {}) as { maxWorkerHoursPerDay?: number };
    const brief = (r.brief ?? {}) as { topic?: string };
    return {
      id: String(r.id),
      channelId: String(r.channel_id),
      channelName: String(r.channel_name),
      channelStatus: r.channel_status as ScheduleRow["channelStatus"],
      videosPerDay: Number(r.videos_per_day),
      name: String(r.name),
      kind: r.kind as ScheduleRow["kind"],
      days: String(r.days) as CadenceDays,
      timesOfDay: Array.isArray(r.times_of_day) ? (r.times_of_day as string[]) : [],
      timezone: String(r.timezone),
      slotsAhead: Number(r.slots_ahead),
      state: r.state as ScheduleRow["state"],
      budgetHours: typeof budget.maxWorkerHoursPerDay === "number" ? budget.maxWorkerHoursPerDay : 2,
      settings: parseScheduleSettings(r.settings),
      briefTopic: typeof brief.topic === "string" ? brief.topic : "",
      createdBy: r.created_by ? String(r.created_by) : null,
    };
  });
}

/** What the next slot will do, computed the same way the tick does — so the page and the tick cannot disagree. */
export function upcoming(row: ScheduleRow, now: Date, count = 3): ScheduledRunNext[] {
  const parsed = parseCadence(row.days, row.timesOfDay);
  if (!parsed.ok) return [];
  return nextSlots(parsed.cadence, row.timezone, now, count).map((at) => ({
    at,
    blocked: gateFor(row, null).skip ? gateFor(row, null).reason : null,
  }));
}

function gateFor(row: ScheduleRow, workerBusy: boolean | null) {
  return slotGate({
    scheduleState: row.state,
    channelStatus: row.channelStatus,
    workerBusy: workerBusy ?? false,
    workerMinutesUsed: 0,
    workerMinutesBudget: 60 * row.budgetHours,
  });
}

export interface ArmResult {
  ok: boolean;
  error?: string;
}

export async function setScheduleState(id: string, state: ScheduleRow["state"]): Promise<ArmResult> {
  const rows = await db()`
    UPDATE schedules SET state = ${state}, updated_at = now()
    WHERE id = ${id}
    RETURNING id
  `;
  return rows.length > 0 ? { ok: true } : { ok: false, error: "That schedule no longer exists." };
}

export interface TickOutcome {
  scheduleId: string;
  scheduleName: string;
  slotAt: string;
  action: "started" | "skipped" | "exists" | "failed";
  runId?: string;
  reason?: string;
}

export interface TickResult {
  now: string;
  outcomes: TickOutcome[];
}

/**
 * One pass over every armed schedule. Safe to call as often as you like: a slot either becomes exactly one run or it
 * does not become a run at all.
 */
export async function tickSchedules(now = new Date()): Promise<TickResult> {
  const schedules = (await listSchedules()).filter((s) => s.state === "armed");
  const templates = await listTemplates();
  const outcomes: TickOutcome[] = [];

  for (const row of schedules) {
    const parsed = parseCadence(row.days, row.timesOfDay);
    if (!parsed.ok) {
      outcomes.push({ scheduleId: row.id, scheduleName: row.name, slotAt: now.toISOString(), action: "skipped", reason: parsed.error });
      continue;
    }
    // Only the last day of slots is considered: a slot missed on Monday is not worth producing on Thursday, and a backlog
    // would arrive as a burst of videos the worker cannot render faster than one at a time.
    const due = nextSlots(parsed.cadence, row.timezone, new Date(now.getTime() - DAY), 100).filter((at) => at.getTime() <= now.getTime());

    if (!row.createdBy) {
      outcomes.push({
        scheduleId: row.id,
        scheduleName: row.name,
        slotAt: now.toISOString(),
        action: "skipped",
        reason: "the schedule has no owner on record to attribute a run to",
      });
      continue;
    }

    for (const at of due) {
      const key = `${row.id}:${slotKey(at)}`;
      const lock = await db()`SELECT pg_try_advisory_lock(hashtext(${key})) AS ok`.catch(() => [{ ok: false }] as Array<{ ok: boolean }>);
      if (!lock[0]?.ok) continue;
      try {
        const already = await db()`
          SELECT id FROM pipeline_runs WHERE schedule_id = ${row.id} AND slot_at = ${at.toISOString()} LIMIT 1
        `;
        if (already.length > 0) {
          outcomes.push({ scheduleId: row.id, scheduleName: row.name, slotAt: at.toISOString(), action: "exists" });
          continue;
        }

        const busy = await workerBusy(row.channelId);
        const usedMinutes = await workerMinutesToday(row.channelId, row.settings.durationSec);
        const gate = slotGate({
          scheduleState: row.state,
          channelStatus: row.channelStatus,
          workerBusy: busy,
          workerMinutesUsed: usedMinutes,
          workerMinutesBudget: 60 * row.budgetHours,
        });
        if (gate.skip) {
          outcomes.push({ scheduleId: row.id, scheduleName: row.name, slotAt: at.toISOString(), action: "skipped", reason: gate.reason });
          continue;
        }

        const template = templates.find((t) => t.styleId === row.settings.styleId) ?? templates.find((t) => t.id === row.settings.styleId);
        if (!template) {
          outcomes.push({
            scheduleId: row.id,
            scheduleName: row.name,
            slotAt: at.toISOString(),
            action: "skipped",
            reason: `no style "${row.settings.styleId}" is installed any more`,
          });
          continue;
        }

        const started = await startRun({
          channelId: row.channelId,
          templateId: template.id,
          format: row.settings.durationSec > 180 ? "long" : "short",
          durationSec: row.settings.durationSec,
          language: row.settings.language,
          themeId: row.settings.themeId,
          purposes: row.settings.purposes,
          subtitles: row.settings.subtitles,
          brief: row.briefTopic,
          sound: row.settings.sound,
          thinkOnMuse: false,
          userId: row.createdBy,
        });

        if (!started.ok) {
          outcomes.push({
            scheduleId: row.id,
            scheduleName: row.name,
            slotAt: at.toISOString(),
            action: "failed",
            reason: started.error ?? "the run could not be started",
          });
          continue;
        }

        // Stamp the run with its slot. If another tick slipped past the lock, the unique index rejects this and the run
        // it created is cancelled rather than left as a second video for the same slot.
        try {
          await db()`
            UPDATE pipeline_runs SET schedule_id = ${row.id}, slot_at = ${at.toISOString()} WHERE id = ${started.runId}
          `;
        } catch {
          await db()`
            UPDATE pipeline_runs SET status = 'cancelled', updated_at = now() WHERE id = ${started.runId}
          `.catch(() => undefined);
          outcomes.push({ scheduleId: row.id, scheduleName: row.name, slotAt: at.toISOString(), action: "exists" });
          continue;
        }

        outcomes.push({ scheduleId: row.id, scheduleName: row.name, slotAt: at.toISOString(), action: "started", runId: started.runId });
      } finally {
        await db()`SELECT pg_advisory_unlock(hashtext(${key}))`.catch(() => undefined);
      }
    }
  }

  return { now: now.toISOString(), outcomes };
}

/** One worker renders one video at a time: anything queued or running for this channel keeps the next slot at bay. */
async function workerBusy(channelId: string): Promise<boolean> {
  const rows = await db()`
    SELECT 1 FROM jobs
    WHERE channel_id = ${channelId} AND status IN ('queued', 'running')
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Minutes the channel's worker has plausibly spent today. Estimated from the length of the videos it started, at the
 * documented rate, because nothing has measured this style's real render time yet. When measurement lands, this becomes
 * a median instead of a constant — the callers do not change.
 */
async function workerMinutesToday(channelId: string, durationSec: number): Promise<number> {
  const rows = await db()`
    SELECT count(*)::int AS n FROM pipeline_runs
    WHERE channel_id = ${channelId} AND created_at >= date_trunc('day', now())
  `;
  const started = Number(rows[0]?.n ?? 0);
  return started * Math.round((durationSec * DEFAULT_SECONDS_PER_VIDEO_SECOND) / 60);
}

/** Creates a schedule. The number of times follows the channel's videos_per_day unless the owner overrides it. */
export async function createSchedule(i: {
  channelId: string;
  name: string;
  styleId: string;
  durationSec: number;
  language: string;
  days: string;
  timesOfDay: string[] | null;
  timezone: string;
  budgetHours: number;
  briefTopic: string;
  state: "draft" | "armed";
  userId: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const channel = await db()`SELECT id, videos_per_day, format, language FROM channels WHERE id = ${i.channelId} LIMIT 1`;
  if (channel.length === 0) return { ok: false, error: "Pick a channel first." };
  const videosPerDay = Number(channel[0].videos_per_day) || 1;
  const times = i.timesOfDay && i.timesOfDay.length > 0 ? i.timesOfDay : defaultTimesFor(videosPerDay);
  const parsed = parseCadence(i.days, times);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const rows = await db()`
    INSERT INTO schedules (channel_id, name, kind, settings, brief, days, times_of_day, timezone, budget, state, created_by)
    VALUES (
      ${i.channelId}, ${i.name}, 'series',
      ${JSON.stringify({ styleId: i.styleId, durationSec: i.durationSec, language: i.language, sound: { bed: "auto", sfx: "sparse", ambience: true } })}::jsonb,
      ${JSON.stringify({ topicSource: i.briefTopic ? "owner" : "plan", topic: i.briefTopic })}::jsonb,
      ${parsed.cadence.days}, ${times}::text[], ${i.timezone},
      ${JSON.stringify({ maxWorkerHoursPerDay: i.budgetHours })}::jsonb,
      ${i.state}, ${i.userId}
    )
    RETURNING id
  `;
  return { ok: true, id: String(rows[0].id) };
}