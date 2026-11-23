import "server-only";
import { db } from "./db.ts";
import { busyDelayMs, GATE_QUEUE_TIMEOUT_SEC, gateConcurrency, parseRetryAfter, waitingText, type WaitReason } from "../studio/pacing.ts";

/**
 * The one gate every portal call to a Hermes model turn goes through (director stages, images, CC0 search, voice
 * through Hermes, the capability scan, Check skills, the chat skills fallback). It does two things:
 * - bounded concurrency in this process: one model turn at a time by default (HERMES_MAX_CONCURRENCY overrides, 1..8);
 * - a shared "busy until" time stored in Postgres (hermes_gate), set when Hermes answers 429 or 503 or says it is
 *   rate limited. While it is in the future no call is made at all; callers get a busy answer with the time instead.
 * The state lives on globalThis because Next.js may load this module more than once (route handlers, server actions).
 */

export interface HermesBusy {
  until: Date;
  reason: WaitReason;
  /** A plain line for the owner, e.g. "Waiting for Hermes (rate limited), next try at 14:05 UTC, in about 3 min". */
  text: string;
}

export type GateResult<T> = { ok: true; value: T } | { ok: false; busy: HermesBusy };

interface GateState {
  active: number;
  queue: Array<() => void>;
  /** Last consecutive count read from or written to the database, so a success only writes when needed. */
  consecutive: number;
}

declare global {
  var __venstudioHermesGate: GateState | undefined;
}

function state(): GateState {
  globalThis.__venstudioHermesGate ??= { active: 0, queue: [], consecutive: 0 };
  return globalThis.__venstudioHermesGate;
}

/** A turn waiting this long for a free slot gives up and is treated as busy (with a one-minute not-before). */
const QUEUE_TIMEOUT_MS = GATE_QUEUE_TIMEOUT_SEC * 1000;
const QUEUE_RETRY_MS = 60_000;

function busy(untilMs: number, reason: WaitReason): HermesBusy {
  return { until: new Date(untilMs), reason, text: waitingText(untilMs, Date.now(), reason) };
}

/** The stored busy-until time when it is still in the future. A database problem never blocks a call. */
export async function hermesBusyNow(): Promise<HermesBusy | null> {
  try {
    const [row] = await db()`SELECT busy_until, consecutive FROM hermes_gate WHERE id = 'hermes'`;
    if (!row) return null;
    state().consecutive = Number(row.consecutive) || 0;
    const until = row.busy_until instanceof Date ? row.busy_until.getTime() : null;
    return until !== null && until > Date.now() ? busy(until, "rate-limit") : null;
  } catch (err) {
    console.error("hermes gate: could not read the busy time", err);
    return null;
  }
}

/** Records a rate limit and returns how long everyone waits. Retry-After wins; otherwise exponential backoff. */
export async function reportHermesBusy(input: { status: number | null; retryAfter: string | null; detail: string }): Promise<HermesBusy> {
  const now = Date.now();
  const askedMs = parseRetryAfter(input.retryAfter, now);
  const consecutive = state().consecutive + 1;
  const untilMs = now + busyDelayMs(askedMs, consecutive);
  state().consecutive = consecutive;
  try {
    const [row] = await db()`
      INSERT INTO hermes_gate (id, busy_until, consecutive, last_status, last_reason, updated_at)
      VALUES ('hermes', ${new Date(untilMs)}, 1, ${input.status}, ${input.detail.slice(0, 300)}, now())
      ON CONFLICT (id) DO UPDATE SET
        busy_until = GREATEST(COALESCE(hermes_gate.busy_until, EXCLUDED.busy_until), EXCLUDED.busy_until),
        consecutive = hermes_gate.consecutive + 1,
        last_status = EXCLUDED.last_status,
        last_reason = EXCLUDED.last_reason,
        updated_at = now()
      RETURNING busy_until, consecutive
    `;
    if (row) {
      state().consecutive = Number(row.consecutive) || consecutive;
      const stored = row.busy_until instanceof Date ? row.busy_until.getTime() : untilMs;
      return busy(Math.max(stored, untilMs), "rate-limit");
    }
  } catch (err) {
    console.error("hermes gate: could not store the busy time", err);
  }
  return busy(untilMs, "rate-limit");
}

/** Clears the backoff after a call that Hermes answered normally. Writes only when a rate limit was recorded. */
export async function reportHermesOk(): Promise<void> {
  if (state().consecutive === 0) return;
  state().consecutive = 0;
  try {
    await db()`UPDATE hermes_gate SET consecutive = 0, busy_until = NULL, updated_at = now() WHERE id = 'hermes' AND (consecutive > 0 OR busy_until IS NOT NULL) AND (busy_until IS NULL OR busy_until <= now())`;
  } catch (err) {
    console.error("hermes gate: could not clear the busy time", err);
  }
}

/** True when every slot of this process is taken, so a new ask would queue behind another. Read only. */
export function hermesGateFull(): boolean {
  return state().active >= gateConcurrency(process.env.HERMES_MAX_CONCURRENCY);
}

function acquire(timeoutMs: number): Promise<boolean> {
  const s = state();
  const limit = gateConcurrency(process.env.HERMES_MAX_CONCURRENCY);
  if (s.active < limit) {
    s.active++;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const grant = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.active++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const at = s.queue.indexOf(grant);
      if (at >= 0) s.queue.splice(at, 1);
      resolve(false);
    }, timeoutMs);
    s.queue.push(grant);
  });
}

function release(): void {
  const s = state();
  s.active = Math.max(0, s.active - 1);
  const next = s.queue.shift();
  if (next) next();
}

/**
 * Runs one Hermes HTTP request inside the gate. Returns busy without calling when Hermes is known to be busy, or when
 * no slot frees up within the queue timeout. `fn` must report a rate limit itself (reportHermesBusy) when it sees one.
 */
export async function withHermesSlot<T>(fn: () => Promise<T>, opts: { queueTimeoutMs?: number } = {}): Promise<GateResult<T>> {
  const before = await hermesBusyNow();
  if (before) return { ok: false, busy: before };
  const got = await acquire(opts.queueTimeoutMs ?? QUEUE_TIMEOUT_MS);
  if (!got) return { ok: false, busy: busy(Date.now() + QUEUE_RETRY_MS, "queue") };
  try {
    // Another caller may have hit a rate limit while this one queued.
    const after = await hermesBusyNow();
    if (after) return { ok: false, busy: after };
    return { ok: true, value: await fn() };
  } finally {
    release();
  }
}
