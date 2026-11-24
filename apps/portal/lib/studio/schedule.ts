/**
 * When AutoStudio's next runs happen — pure, no database, no cron parser.
 *
 * A schedule says two separate things, because they are two separate decisions: **which days** (`daily`,
 * `weekly:mon,thu`, `every:2`) and **which wall-clock times** (`['07:00','19:00']`). How many videos a day is not here
 * at all: that is `channels.videos_per_day`, and the schedule only holds that many times.
 *
 * Everything is computed in the schedule's own zone, not the server's and not the worker's. A 07:00 Jakarta slot on a
 * worker in Frankfurt still fires at 07:00 Jakarta; what moves is the queue, not the working day. Zones are IANA names,
 * so a country that changes its daylight-saving rule does not shift the schedule by an hour twice a year.
 *
 * The conversion is done with `Intl`, both ways: local wall-clock parts to read a slot, and an inverse search to turn a
 * local wall time back into an instant. That inverse is the part worth testing, because it is where DST hides: on the
 * day a zone skips 02:00–03:00, no instant has 02:30 local, and on the day it repeats 01:00–02:00, two instants do.
 */

export type CadenceDays = "daily" | `weekly:${string}` | `every:${number}`;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Cadence {
  days: CadenceDays;
  /** `HH:MM` in the schedule's zone, one per video the channel asks for. */
  timesOfDay: string[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type CadenceResult = { ok: true; cadence: Cadence } | { ok: false; error: string };

/** Reads a cadence, refusing anything that would silently do something else. */
export function parseCadence(days: unknown, timesOfDay: unknown): CadenceResult {
  const parsedDays = parseDays(days);
  if (!parsedDays.ok) return parsedDays;
  if (!Array.isArray(timesOfDay) || timesOfDay.length === 0) return { ok: false, error: "Pick at least one time of day." };
  const times: string[] = [];
  for (const raw of timesOfDay) {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (!TIME_RE.test(t)) return { ok: false, error: `"${t}" is not a time of day (use HH:MM, 24-hour).` };
    if (!times.includes(t)) times.push(t);
  }
  // Two videos at the same minute is not twice the work, it is one slot with a queue behind it.
  return { ok: true, cadence: { days: parsedDays.days, timesOfDay: times.sort() } };
}

function parseDays(value: unknown): { ok: true; days: CadenceDays } | { ok: false; error: string } {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "daily") return { ok: true, days: "daily" };
  if (raw.startsWith("every:")) {
    const n = Number(raw.slice("every:".length));
    if (!Number.isInteger(n) || n < 2 || n > 30) return { ok: false, error: "Every N days needs a whole number from 2 to 30." };
    return { ok: true, days: `every:${n}` as CadenceDays };
  }
  if (raw.startsWith("weekly:")) {
    const picked = raw
      .slice("weekly:".length)
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    if (picked.length === 0) return { ok: false, error: "Weekly needs at least one day." };
    const bad = picked.filter((d) => !(WEEKDAYS as readonly string[]).includes(d));
    if (bad.length > 0) return { ok: false, error: `Unknown day: ${bad.join(", ")}. Use mon, tue, wed, thu, fri, sat, sun.` };
    const unique = WEEKDAYS.filter((d) => picked.includes(d));
    return { ok: true, days: `weekly:${unique.join(",")}` as CadenceDays };
  }
  return { ok: false, error: "Pick daily, weekly or every N days." };
}

/** The local wall clock in a zone, as numbers. Never the server's zone. */
export function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = String(parts.weekday ?? "Mon").slice(0, 3).toLowerCase() as Weekday;
  const hour = Number(parts.hour === "24" ? "00" : parts.hour);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute), weekday };
}

/** How far a zone is from UTC at that instant, in minutes (Jakarta +420, London +60 in summer). */
function offsetMinutes(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * The instant at which a zone's wall clock reads `YYYY-MM-DD HH:MM`.
 *
 * Two passes: assume UTC, read the offset at that guess, correct by it, then read the offset again at the corrected
 * instant. The second pass is what makes a DST boundary land on the right hour; it is still a *choice* on the two days a
 * year when the wall time does not exist or exists twice, and the choice is the earlier one.
 */
export function instantAt(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let guess = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  guess = new Date(naive - offsetMinutes(guess, timeZone) * 60000);
  return guess;
}

/**
 * The next `count` slots strictly after `from`, in order, inside the schedule's zone.
 *
 * Scans forward day by day rather than solving a formula: a schedule repeats a handful of times a month, the horizon is
 * bounded, and a loop over at most `maxDays` days is both cheap and readable — and it makes "the 29th does not exist in
 * February" a non-issue.
 */
export function nextSlots(cadence: Cadence, timeZone: string, from: Date, count: number, maxDays = 400): Date[] {
  if (count <= 0) return [];
  const out: Date[] = [];
  const start = zonedParts(from, timeZone);
  for (let d = 0; d < maxDays && out.length < count; d++) {
    // Walk calendar days in the zone: take the start date, add d days as a UTC calendar date, then read it back.
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + d));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const dd = day.getUTCDate();
    if (!dayMatches(cadence.days, day, from, timeZone)) continue;
    for (const time of cadence.timesOfDay) {
      const [h, min] = time.split(":").map(Number);
      const at = instantAt(timeZone, y, m, dd, h, min);
      if (at.getTime() > from.getTime()) out.push(at);
      if (out.length >= count) break;
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime()).slice(0, count);
}

function dayMatches(days: CadenceDays, day: Date, from: Date, timeZone: string): boolean {
  if (days === "daily") return true;
  if (days.startsWith("every:")) {
    const n = Number(days.slice("every:".length));
    const a = new Date(Date.UTC(zonedParts(from, timeZone).year, zonedParts(from, timeZone).month - 1, zonedParts(from, timeZone).day));
    const diff = Math.round((day.getTime() - a.getTime()) / 86400000);
    return diff % n === 0;
  }
  const wanted = days.slice("weekly:".length).split(",");
  const weekday = WEEKDAYS[(day.getUTCDay() + 6) % 7];
  return wanted.includes(weekday);
}

/** The slot as a stable key, so `unique (schedule_id, slot_at)` has something to be unique about. */
export function slotKey(at: Date): string {
  return at.toISOString();
}

export interface SlotGate {
  /** Why this slot is not being produced, or null when it is. */
  skip: "worker-busy" | "budget" | "paused" | null;
  reason: string;
}

/**
 * Whether a slot may turn into a run, before anything is created.
 *
 * One worker renders one video at a time, and a render can take an hour or more, so a full queue is a reason to skip
 * today rather than to stack. Budget is checked here too — a slot over budget still shows on the page with its reason,
 * rather than disappearing and looking like a scheduler bug.
 */
export function slotGate(i: {
  scheduleState: "draft" | "armed" | "paused";
  channelStatus: "planning" | "active" | "paused";
  workerBusy: boolean;
  workerMinutesUsed: number;
  workerMinutesBudget: number;
}): SlotGate {
  if (i.scheduleState !== "armed") return { skip: "paused", reason: i.scheduleState === "draft" ? "the schedule is still a draft" : "the schedule is paused" };
  if (i.channelStatus !== "active") return { skip: "paused", reason: i.channelStatus === "planning" ? "the channel is still planning" : "the channel is paused" };
  if (i.workerBusy) return { skip: "worker-busy", reason: "its worker is still rendering the previous run" };
  if (i.workerMinutesUsed >= i.workerMinutesBudget) return { skip: "budget", reason: `the worker has used its ${Math.round(i.workerMinutesBudget)} minutes for today` };
  return { skip: null, reason: "" };
}

/** How many videos a day becomes which clock times, when the owner has not said otherwise. */
export function defaultTimesFor(videosPerDay: number): string[] {
  const n = Math.max(1, Math.min(24, Math.round(videosPerDay) || 1));
  if (n === 1) return ["07:00"];
  if (n === 2) return ["07:00", "19:00"];
  // Spread the rest across a 07:00–21:00 window rather than stacking them at one hour.
  const span = 14 * 60;
  return Array.from({ length: n }, (_, i) => {
    const minutes = 7 * 60 + Math.round((span / (n - 1)) * i);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
}

/** Said plainly when the channel asks for more videos than the schedule has times — or the other way round. */
export function timesMismatch(times: readonly string[], videosPerDay: number): string | null {
  if (times.length === videosPerDay) return null;
  if (times.length < videosPerDay) return `The channel asks for ${videosPerDay} videos a day; this schedule has ${times.length} time${times.length === 1 ? "" : "s"}. Add ${videosPerDay - times.length} more.`;
  return `This schedule has ${times.length} times but the channel asks for ${videosPerDay} videos a day; ${times.length - videosPerDay} of them will not be used.`;
}

/** The settings New Video would have collected, read back from a schedule. Tolerant: a hand-written row still works. */
export interface ScheduleSettings {
  styleId: string;
  durationSec: number;
  language: string;
  themeId: string;
  purposes: string[];
  subtitles: string[];
  sound: { bed: string; sfx: "off" | "sparse" | "rich"; ambience: boolean };
}

export function parseScheduleSettings(raw: unknown, fallbackDurationSec = 45): ScheduleSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const soundIn = o.sound && typeof o.sound === "object" ? (o.sound as Record<string, unknown>) : {};
  const sfx = soundIn.sfx === "off" || soundIn.sfx === "rich" ? soundIn.sfx : "sparse";
  return {
    styleId: typeof o.styleId === "string" ? o.styleId : "",
    durationSec: typeof o.durationSec === "number" && o.durationSec > 0 ? Math.round(o.durationSec) : fallbackDurationSec,
    language: typeof o.language === "string" && o.language ? o.language : "en",
    themeId: typeof o.themeId === "string" ? o.themeId : "",
    purposes: Array.isArray(o.purposes) ? o.purposes.filter((p): p is string => typeof p === "string") : [],
    subtitles: Array.isArray(o.subtitles) ? o.subtitles.filter((p): p is string => typeof p === "string") : [],
    sound: {
      bed: typeof soundIn.bed === "string" && soundIn.bed ? soundIn.bed : "auto",
      sfx,
      ambience: typeof soundIn.ambience === "boolean" ? soundIn.ambience : true,
    },
  };
}

/** The zones offered as countries, because an owner picks a country, not a tz database path. IANA names are stored. */
export const TIMEZONES: ReadonlyArray<{ label: string; zone: string }> = [
  { label: "Global (UTC)", zone: "UTC" },
  { label: "Indonesia (Jakarta)", zone: "Asia/Jakarta" },
  { label: "Indonesia (Bali)", zone: "Asia/Makassar" },
  { label: "Singapore / Malaysia", zone: "Asia/Singapore" },
  { label: "India", zone: "Asia/Kolkata" },
  { label: "Japan", zone: "Asia/Tokyo" },
  { label: "United Kingdom", zone: "Europe/London" },
  { label: "Central Europe", zone: "Europe/Berlin" },
  { label: "US East", zone: "America/New_York" },
  { label: "US West", zone: "America/Los_Angeles" },
  { label: "Australia East", zone: "Australia/Sydney" },
];
