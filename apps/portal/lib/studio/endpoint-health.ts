/**
 * Per-endpoint health, pure. Every real call and every Settings test records its outcome per model (see
 * lib/server/endpoint-health.ts). A model counts as proven only after a real call worked; a listing is not proof.
 * A 4xx client error (for example "prompt is required" or "Invalid model format") sets the model aside
 * (quarantine), because sending the same request to it again cannot work.
 */
import { classifyStatus, type FailureClass } from "./pacing.ts";

export type EndpointKind = "image" | "tts" | "video";
/** "9router" for models called straight through 9router, "hermes" for providers Hermes reports from its own chain. */
export type EndpointName = "9router" | "hermes";

export interface EndpointHealth {
  endpoint: EndpointName;
  model: string;
  kind: EndpointKind;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureClass: FailureClass | null;
  lastError: string;
  quarantinedAt: number | null;
  successes: number;
  failures: number;
}

/** A quarantined model is left alone this long, then it may be tried again. A success lifts it at once. */
export const QUARANTINE_MS = 7 * 24 * 60 * 60_000;
export const HEALTH_ERROR_MAX = 300;

export function shouldQuarantine(cls: FailureClass | null | undefined): boolean {
  return cls === "client";
}

export function findHealth(
  list: readonly EndpointHealth[],
  endpoint: EndpointName,
  model: string,
  kind: EndpointKind,
): EndpointHealth | undefined {
  return list.find((h) => h.endpoint === endpoint && h.model === model && h.kind === kind);
}

export function isQuarantined(h: EndpointHealth | undefined, nowMs: number): boolean {
  return Boolean(h && h.quarantinedAt !== null && nowMs - h.quarantinedAt < QUARANTINE_MS);
}

export function isProven(h: EndpointHealth | undefined, nowMs: number): boolean {
  return Boolean(h && h.lastSuccessAt !== null && !isQuarantined(h, nowMs));
}

export type Proof = "proven" | "listed" | "quarantined";

export function proofOf(h: EndpointHealth | undefined, nowMs: number): Proof {
  if (isQuarantined(h, nowMs)) return "quarantined";
  return isProven(h, nowMs) ? "proven" : "listed";
}

/** One short phrase for a chip or a list line. */
export function proofText(p: Proof): string {
  if (p === "proven") return "proven by a real call";
  if (p === "quarantined") return "set aside after a request error";
  return "listed, not proven yet";
}

/** The class for a failed HTTP call, from its status. A missing status means no answer came back. */
export function failureFromStatus(status: number | null | undefined): FailureClass {
  if (typeof status !== "number") return "unreachable";
  return classifyStatus(status) ?? "content";
}

/** "Cloudflare" for Workers AI names, otherwise the provider name with a capital first letter. */
export function providerLabel(provider: string): string {
  const p = provider.trim();
  if (/^(cf|cloudflare|workers-?ai|cloudflare-workers-ai)$/i.test(p)) return "Cloudflare";
  if (!p) return "9router";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The innermost message (and code) of a provider error body. Handles the nesting 9router adds around provider errors. */
function innerMessage(value: unknown, depth = 0): { message: string; code: string; cloudflare: boolean } | null {
  if (depth > 10) return null;
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const nested = innerMessage(tryJson(value.slice(start, end + 1)), depth + 1);
      if (nested) return nested;
    }
    return value.trim() ? { message: value, code: "", cloudflare: false } : null;
  }
  if (Array.isArray(value)) return value.length > 0 ? innerMessage(value[0], depth + 1) : null;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    const first = value.errors[0];
    const inner = innerMessage(first, depth + 1);
    const code = isRecord(first) && (typeof first.code === "number" || typeof first.code === "string") ? String(first.code) : "";
    if (inner) return { message: inner.message, code: inner.code || code, cloudflare: true };
  }
  const msg = value.message ?? value.error ?? value.detail;
  const inner = innerMessage(msg, depth + 1);
  if (!inner) return null;
  const code = typeof value.code === "number" || (typeof value.code === "string" && /^\d+$/.test(value.code)) ? String(value.code) : "";
  return { message: inner.message, code: inner.code || code, cloudflare: inner.cloudflare };
}

/** Removes noise from a provider message: "[400]: " heads, repeated "AiError: " prefixes, a trailing request id. */
function cleanMessage(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/^\[\d{3}\]:?\s*/, "");
  for (let i = 0; i < 5 && /^[A-Za-z]*Error:\s*/.test(t); i++) t = t.replace(/^[A-Za-z]*Error:\s*/, "");
  t = t.replace(/\s*\((?:[0-9a-f]{8}-[0-9a-f-]{4,}|[0-9a-f-]{8,}\.{0,3})\)\s*$/i, "");
  t = t.replace(/\s*\([0-9a-f]{6,}[^)]*\)\s*$/i, "");
  return t.trim();
}

/**
 * A short, readable error for a failed 9router call: the provider's own message, without the JSON wrapping, for
 * example "Cloudflare: prompt is required (code 3030)". Never longer than `max`.
 */
export function shortProviderError(status: number, body: string, provider: string, max: number = 200): string {
  const raw = (body ?? "").trim();
  const parsed = raw ? innerMessage(tryJson(raw) ?? raw) : null;
  const cleaned = parsed ? cleanMessage(parsed.message) : "";
  const cloudflare = Boolean(parsed?.cloudflare) || /AiError/.test(raw);
  const label = cloudflare && (provider.trim() === "" || /cf|cloud|workers/i.test(provider)) ? "Cloudflare" : providerLabel(provider);
  let text: string;
  if (cleaned && !cleaned.startsWith("{")) {
    text = `${label}: ${cleaned}${parsed?.code ? ` (code ${parsed.code})` : ""}`;
  } else {
    const snippet = raw.replace(/\s+/g, " ").slice(0, 120);
    text = `${label} answered HTTP ${status}${snippet ? `: ${snippet}` : ""}`;
  }
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
