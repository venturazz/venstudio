import "server-only";
import { env } from "./env.ts";

/**
 * Client for 9router (or any OpenAI-compatible gateway).
 * Only the portal talks to the gateway; Muse workers never get the key.
 */

export interface GatewayStatus {
  configured: boolean;
  ok: boolean;
  baseUrl?: string;
  models: string[];
  latencyMs?: number;
  error?: string;
}

function config() {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  if (!NINEROUTER_BASE_URL) return null;
  return { base: NINEROUTER_BASE_URL.replace(/\/+$/, ""), key: NINEROUTER_API_KEY };
}

function headers(key?: string): HeadersInit {
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

export async function gatewayStatus(): Promise<GatewayStatus> {
  const cfg = config();
  if (!cfg) return { configured: false, ok: false, models: [] };
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.base}/v1/models`, {
      headers: headers(cfg.key),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { configured: true, ok: false, baseUrl: cfg.base, models: [], latencyMs, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
    return { configured: true, ok: true, baseUrl: cfg.base, models, latencyMs };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      baseUrl: cfg.base,
      models: [],
      error: err instanceof Error ? err.message : "Request failed",
    };
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
