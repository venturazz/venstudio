"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/server/auth.ts";
import { createSchedule, setScheduleState, tickSchedules } from "@/lib/server/schedules.ts";
import { defaultTimesFor, parseCadence } from "@/lib/studio/schedule.ts";

function text(fd: FormData, key: string, max = 200): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function num(fd: FormData, key: string, fallback: number): number {
  const n = Number(text(fd, key, 12));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ScheduleFormState {
  error?: string;
  ok?: string;
}

export async function tickNowAction(): Promise<ScheduleFormState> {
  await requireUser("editor");
  const result = await tickSchedules(new Date());
  revalidatePath("/studio/automation");
  const started = result.outcomes.filter((o) => o.action === "started").length;
  const skipped = result.outcomes.filter((o) => o.action === "skipped");
  if (started === 0 && skipped.length === 0) return { ok: "Nothing was due. Every armed slot is either already made or not yet here." };
  if (started === 0) return { error: `Nothing started: ${skipped.map((s) => s.reason).filter(Boolean).join("; ")}` };
  return { ok: `Started ${started} run${started === 1 ? "" : "s"}.` };
}

export async function setScheduleStateAction(_prev: ScheduleFormState | undefined, fd: FormData): Promise<ScheduleFormState> {
  await requireUser("editor");
  const id = text(fd, "id", 60);
  const state = text(fd, "state", 12);
  if (!id || !["draft", "armed", "paused"].includes(state)) return { error: "Unknown schedule or state." };
  const result = await setScheduleState(id, state as "draft" | "armed" | "paused");
  if (!result.ok) return { error: result.error };
  revalidatePath("/studio/automation");
  return { ok: state === "armed" ? "Armed. It fills the New Video form by itself from now on." : state === "paused" ? "Paused. No new slot will start." : "Back to draft." };
}

export async function createScheduleAction(_prev: ScheduleFormState | undefined, fd: FormData): Promise<ScheduleFormState> {
  const user = await requireUser("editor");
  const channelId = text(fd, "channelId", 60);
  if (!channelId) return { error: "Pick a channel. A schedule belongs to one channel, because that is whose worker and whose videos_per_day it uses." };

  const videosPerDay = Number(text(fd, "videosPerDay", 3)) || 1;
  const rawTimes = text(fd, "timesOfDay", 200);
  const times = rawTimes
    ? rawTimes.split(",").map((t) => t.trim()).filter(Boolean)
    : defaultTimesFor(videosPerDay);

  const days = text(fd, "days", 40) || "daily";
  const parsed = parseCadence(days, times);
  if (!parsed.ok) return { error: parsed.error };

  const result = await createSchedule({
    channelId,
    name: text(fd, "name", 80) || "Untitled schedule",
    styleId: text(fd, "styleId", 60),
    durationSec: num(fd, "durationSec", 45),
    language: text(fd, "language", 10) || "en",
    days: parsed.cadence.days,
    timesOfDay: parsed.cadence.timesOfDay,
    timezone: text(fd, "timezone", 60) || "Asia/Jakarta",
    budgetHours: num(fd, "budgetHours", 2),
    briefTopic: text(fd, "briefTopic", 400),
    state: text(fd, "arm", 4) === "on" ? "armed" : "draft",
    userId: user.id ?? null,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/studio/automation");
  return { ok: "Schedule created. Arm it when the times and the length look right." };
}