import "server-only";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";
import { extractJson, retryNote, type ChatMessage, type Validated } from "../studio/director.ts";

export type HermesJsonResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: string };

const TIMEOUT_MS = 180_000;
const INTERNAL = "http://<hermes container name>:8642";

/**
 * Asks Hermes for structured output. The reply is parsed as data and checked by `validate`; it is never executed.
 * On an HTTP error, a timeout, unparseable JSON or a failed validation it asks again, up to `retries` more times,
 * feeding the validation issues back. Returns an error text that is safe to show the owner (no key, no host path).
 */
export async function hermesJson<T>(
  messages: ChatMessage[],
  validate: (value: unknown) => Validated<T>,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<HermesJsonResult<T>> {
  return hermesText(messages, (reply) => validate(extractJson(reply)), opts);
}

/**
 * Same loop as hermesJson, but the validator gets the raw reply text and may be async. Media turns use it: the
 * reply may be JSON, a markdown image link or a bare URL, and the validator downloads and checks the real bytes
 * so a bad answer is fed back to Hermes like any other validation issue. This file stays the only place that
 * talks to Hermes for generation.
 */
export async function hermesText<T>(
  messages: ChatMessage[],
  validate: (reply: string) => Validated<T> | Promise<Validated<T>>,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<HermesJsonResult<T>> {
  const { HERMES_BASE_URL, HERMES_API_KEY } = env();
  if (!HERMES_BASE_URL) {
    return { ok: false, error: "Hermes is not configured. Set HERMES_BASE_URL and HERMES_API_KEY in Settings or the environment." };
  }
  const base = normalizeGatewayBase(HERMES_BASE_URL);
  const url = `${base}/v1/chat/completions`;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const convo: ChatMessage[] = [...messages];
  let lastError = "Hermes did not answer";

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let reply = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(HERMES_API_KEY ? { authorization: `Bearer ${HERMES_API_KEY}` } : {}) },
        body: JSON.stringify({ model: "hermes-agent", stream: false, messages: convo }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Hermes rejected the key (HTTP ${res.status}). HERMES_API_KEY must equal Hermes's API_SERVER_KEY.` };
      }
      if (!res.ok) {
        lastError = `Hermes answered HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      reply = typeof content === "string" ? content : "";
    } catch (err) {
      const e = explainFetchError(err, url, { name: "Hermes", internal: INTERNAL }, timeoutMs);
      lastError = e.hint ? `${e.error}. ${e.hint}` : e.error;
      continue;
    }

    let issues: string[];
    try {
      const checked = await validate(reply);
      if (checked.ok) return { ok: true, value: checked.value, attempts: attempt };
      issues = checked.issues;
    } catch (err) {
      issues = [err instanceof Error ? err.message : "The reply is not valid JSON"];
    }
    lastError = `Hermes replied, but the answer was not usable: ${issues.slice(0, 3).join("; ")}`;
    convo.push({ role: "assistant", content: reply.slice(0, 20_000) }, retryNote(issues));
  }
  return { ok: false, error: lastError };
}
