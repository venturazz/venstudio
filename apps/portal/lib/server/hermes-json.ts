import "server-only";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { reportHermesBusy, reportHermesOk, withHermesSlot } from "./hermes-gate.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";
import { extractJson, retryNote, type ChatMessage, type Validated } from "../studio/director.ts";
import { classifyReplyFailure, classifyStatus, type FailureClass } from "../studio/pacing.ts";

export type HermesJsonFailure = {
  ok: false;
  error: string;
  /** Why it failed. "busy" means nothing is wrong with the work: Hermes is rate limited until `busyUntil`. */
  cause: FailureClass;
  busyUntil?: Date;
};

export type HermesJsonResult<T> = { ok: true; value: T; attempts: number } | HermesJsonFailure;

export interface HermesCallOptions {
  retries?: number;
  timeoutMs?: number;
  /** How long to wait for a free gate slot before answering busy. Owner clicks use a short one. */
  queueTimeoutMs?: number;
  /**
   * Media turns (image, voice, CC0 search) set this: a reply that fails validation and says the provider chain is rate
   * limited (replySaysRateLimited) is a wait, not a bad answer. Director stages leave it off.
   */
  busyFromReply?: boolean;
  /** Pictures (data: URLs) attached to the first user turn, for a vision answer (the presentation advisory). */
  images?: readonly string[];
}

const TIMEOUT_MS = 180_000;
const INTERNAL = "http://<hermes container name>:8642";

/**
 * Asks Hermes for structured output. The reply is parsed as data and checked by `validate`; it is never executed.
 * On a server error, a timeout, unparseable JSON or a failed validation it asks again, up to `retries` more times,
 * feeding the validation issues back. A rate limit (429, 503, or a reply that says so) is not retried here: the call
 * returns cause "busy" with the time Hermes is free again, so the caller can wait instead of failing. Returns an error
 * text that is safe to show the owner (no key, no host path).
 */
export async function hermesJson<T>(
  messages: ChatMessage[],
  validate: (value: unknown) => Validated<T>,
  opts: HermesCallOptions = {},
): Promise<HermesJsonResult<T>> {
  return hermesText(messages, (reply) => validate(extractJson(reply)), opts);
}

/**
 * The conversation as sent: with `images` (data: URLs), the first user turn becomes OpenAI-style content parts, the
 * text first and then each picture. Every other turn, and every call without images, is sent exactly as before.
 */
export function withImages(convo: readonly ChatMessage[], images: readonly string[] | undefined): unknown[] {
  if (!images || images.length === 0) return [...convo];
  const first = convo.findIndex((m) => m.role === "user");
  return convo.map((m, i) =>
    i === first ? { role: m.role, content: [{ type: "text", text: m.content }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] } : m,
  );
}

type Answer =
  | { kind: "reply"; text: string }
  | { kind: "status"; status: number; retryAfter: string | null; body: string }
  | { kind: "busy"; status: number; until: Date; text: string }
  | { kind: "error"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same loop as hermesJson, but the validator gets the raw reply text and may be async. Media turns use it: the
 * reply may be JSON, a markdown image link or a bare URL, and the validator downloads and checks the real bytes
 * so a bad answer is fed back to Hermes like any other validation issue. This file and the chat skills fallback in
 * hermes.ts are the only places that talk to Hermes for model turns, and both go through the shared gate.
 */
export async function hermesText<T>(
  messages: ChatMessage[],
  validate: (reply: string) => Validated<T> | Promise<Validated<T>>,
  opts: HermesCallOptions = {},
): Promise<HermesJsonResult<T>> {
  const { HERMES_BASE_URL, HERMES_API_KEY } = env();
  if (!HERMES_BASE_URL) {
    return { ok: false, cause: "auth", error: "Hermes is not configured. Set HERMES_BASE_URL and HERMES_API_KEY in Settings or the environment." };
  }
  const base = normalizeGatewayBase(HERMES_BASE_URL);
  const url = `${base}/v1/chat/completions`;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const convo: ChatMessage[] = [...messages];
  let lastError = "Hermes did not answer";
  let lastCause: FailureClass = "unreachable";

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const slot = await withHermesSlot(async (): Promise<Answer> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(HERMES_API_KEY ? { authorization: `Bearer ${HERMES_API_KEY}` } : {}) },
          body: JSON.stringify({ model: "hermes-agent", stream: false, messages: withImages(convo, opts.images) }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (classifyStatus(res.status) === "busy") {
            // Recorded while this call still holds its slot, so a queued turn sees the busy time before it calls.
            const b = await reportHermesBusy({ status: res.status, retryAfter: res.headers.get("retry-after"), detail: `HTTP ${res.status}` });
            return { kind: "busy", status: res.status, until: b.until, text: b.text };
          }
          return { kind: "status", status: res.status, retryAfter: res.headers.get("retry-after"), body: body.slice(0, 2000) };
        }
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = body.choices?.[0]?.message?.content;
        return { kind: "reply", text: typeof content === "string" ? content : "" };
      } catch (err) {
        const e = explainFetchError(err, url, { name: "Hermes", internal: INTERNAL }, timeoutMs);
        return { kind: "error", message: e.hint ? `${e.error}. ${e.hint}` : e.error };
      }
    }, { queueTimeoutMs: opts.queueTimeoutMs });
    if (!slot.ok) return { ok: false, cause: "busy", busyUntil: slot.busy.until, error: slot.busy.text };
    const answer = slot.value;

    if (answer.kind === "error") {
      lastError = answer.message;
      lastCause = "unreachable";
      continue;
    }
    if (answer.kind === "busy") {
      return { ok: false, cause: "busy", busyUntil: answer.until, error: `Hermes answered HTTP ${answer.status} (rate limited). ${answer.text}` };
    }
    if (answer.kind === "status") {
      const cls = classifyStatus(answer.status) ?? "server";
      if (cls === "auth") {
        return { ok: false, cause: "auth", error: `Hermes rejected the key (HTTP ${answer.status}). HERMES_API_KEY must equal Hermes's API_SERVER_KEY.` };
      }
      lastError = `Hermes answered HTTP ${answer.status}`;
      lastCause = cls;
      // A short pause before asking again, so a failing Hermes is not hammered.
      if (attempt <= retries) await sleep(Math.min(10_000, 2_000 * attempt));
      continue;
    }

    const reply = answer.text;
    let issues: string[];
    try {
      const checked = await validate(reply);
      if (checked.ok) {
        await reportHermesOk();
        return { ok: true, value: checked.value, attempts: attempt };
      }
      issues = checked.issues;
    } catch (err) {
      issues = [err instanceof Error ? err.message : "The reply is not valid JSON"];
    }
    // Hermes answered, but its provider chain may have been rate limited: that is a wait, not a bad answer.
    if (opts.busyFromReply && classifyReplyFailure(reply) === "busy") {
      const b = await reportHermesBusy({ status: 200, retryAfter: null, detail: reply.replace(/\s+/g, " ").slice(0, 200) });
      return { ok: false, cause: "busy", busyUntil: b.until, error: `Hermes said it is rate limited. ${b.text}` };
    }
    await reportHermesOk();
    lastError = `Hermes replied, but the answer was not usable: ${issues.slice(0, 3).join("; ")}`;
    lastCause = "content";
    convo.push({ role: "assistant", content: reply.slice(0, 20_000) }, retryNote(issues));
  }
  return { ok: false, cause: lastCause, error: lastError };
}
