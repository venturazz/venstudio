import "server-only";
import { env } from "./env.ts";
import { explainFetchFailure, type ServiceInfo } from "../fetch-error.ts";

/**
 * Client for 9router (or any OpenAI-compatible gateway).
 * Only the portal talks to the gateway; Muse workers never get the key.
 */

export interface GatewayStatus {
  configured: boolean;
  ok: boolean;
  /** The models URL that was tried, for troubleshooting. */
  url?: string;
  models: string[];
  latencyMs?: number;
  error?: string;
  hint?: string;
  checkedAt?: string;
  /** The first check is still running (page rendering stopped waiting for it). */
  pending?: boolean;
}

// 9router builds /v1/models by asking its providers, which can take 10+ s. The check runs in the
// background and is cached, so a long limit never slows pages down.
const STATUS_TIMEOUT_MS = 60_000;
/** Above this the card shows "slow" so the owner knows why the first check takes a while. */
export const SLOW_MS = 5_000;
const CACHE_OK_MS = 5 * 60_000;
const CACHE_FAIL_MS = 60_000;

import { normalizeGatewayBase } from "../gateway-url.ts";
export { normalizeGatewayBase };

function config() {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  if (!NINEROUTER_BASE_URL) return null;
  return { base: normalizeGatewayBase(NINEROUTER_BASE_URL), key: NINEROUTER_API_KEY };
}

function headers(key?: string): HeadersInit {
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/**
 * Turns fetch failures into a reason and a fix the owner can act on (lib/fetch-error.ts). The "use the internal
 * address" hint is only given for a public domain; a request that was taken but not finished in time is called slow,
 * not unreachable. `retryAt` is said in the text when the studio asks again by itself.
 */
export function explainFetchError(
  err: unknown,
  url: string,
  service: ServiceInfo = { name: "9router", internal: "http://<9router container name>:20128" },
  timeoutMs = STATUS_TIMEOUT_MS,
  opts: { retryAt?: number } = {},
): { error: string; hint: string } {
  const { error, hint } = explainFetchFailure(err, url, service, timeoutMs, opts);
  return { error, hint };
}

let cache: { at: number; status: GatewayStatus } | undefined;
let inflight: Promise<GatewayStatus> | undefined;

async function checkGateway(): Promise<GatewayStatus> {
  const cfg = config();
  if (!cfg) return { configured: false, ok: false, models: [] };
  const url = `${cfg.base}/v1/models`;
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS), cache: "no-store" });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "9router rejected the API key. Copy a key from the 9router dashboard into NINEROUTER_API_KEY."
          : res.status === 404
            ? "Nothing at /v1/models. NINEROUTER_BASE_URL should be the 9router address, e.g. https://9router.example.com or …/v1."
            : "";
      return { configured: true, ok: false, url, models: [], latencyMs, error: `HTTP ${res.status}`, hint, checkedAt };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
    return { configured: true, ok: true, url, models, latencyMs, checkedAt };
  } catch (err) {
    return { configured: true, ok: false, url, models: [], checkedAt, ...explainFetchError(err, url) };
  }
}

function refresh(): Promise<GatewayStatus> {
  inflight ??= checkGateway()
    .then((status) => {
      cache = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/**
 * Cached gateway status: fresh for 5 min when healthy, 1 min after a failure. After that the last result is
 * still returned at once while a new check runs in the background (stale-while-revalidate), so only the very
 * first check after a restart is waited for. Concurrent page loads share one check.
 */
export async function gatewayStatus(opts: { fresh?: boolean } = {}): Promise<GatewayStatus> {
  if (opts.fresh || !cache) return refresh();
  const ttl = cache.status.ok ? CACHE_OK_MS : CACHE_FAIL_MS;
  if (Date.now() - cache.at >= ttl) void refresh().catch(() => {});
  return cache.status;
}

/** How long a page render waits for the very first check before it shows "checking" and lets the page refresh itself. */
const PAGE_WAIT_MS = 3_000;

/**
 * For page rendering. Same as gatewayStatus, but when there is no cached result yet it waits only briefly, so a
 * 9router that hangs cannot keep the streamed page open. The check keeps running and fills the cache.
 */
export async function gatewayStatusForPage(waitMs = PAGE_WAIT_MS): Promise<GatewayStatus> {
  if (cache) return gatewayStatus();
  const check = refresh();
  check.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<GatewayStatus>((resolve) => {
    timer = setTimeout(() => resolve({ configured: Boolean(config()), ok: false, models: [], pending: true }), waitMs);
  });
  try {
    return await Promise.race([check, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal chat completion call. Used by planning steps (script, shot plan) in later phases. */
export async function chat(model: string, messages: ChatMessage[], opts: { temperature?: number; timeoutMs?: number } = {}) {
  const cfg = config();
  if (!cfg) throw new Error("9router is not configured (NINEROUTER_BASE_URL)");
  const res = await fetch(`${cfg.base}/v1/chat/completions`, {
    method: "POST",
    headers: headers(cfg.key),
    body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.7 }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`9router returned HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}
