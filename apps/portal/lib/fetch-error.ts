/**
 * Plain reasons for a failed request to a service the owner configured (Hermes, 9router, Kokoro). Pure: no sockets,
 * no env, so node --test can load it. lib/server/ai-gateway.ts (explainFetchError) and lib/server/hermes-json.ts use it.
 *
 * The point is to tell "the portal can't reach that address" apart from "it took the request and is still working":
 * - connect failures (refused, DNS, a connect timeout: UND_ERR_CONNECT_TIMEOUT, ETIMEDOUT) mean unreachable;
 * - a timeout after the connection was made (UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, or a timeout the caller
 *   marked with phase "response") means the service is busy or the work is long.
 * A bare AbortSignal timeout from fetch cannot tell the two apart; it is "timeout" and the text says both.
 */
import { blockedAddressReason } from "./net-address.ts";
import { clockUtc, durationText } from "./studio/pacing.ts";

export type FetchFailureKind = "connect-timeout" | "response-timeout" | "timeout" | "dns" | "refused" | "tls" | "other";

/** Where a request was when it timed out, for transports that know it (hermes-json.ts sets it on its errors). */
export type RequestPhase = "connect" | "response";

const CONNECT_TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ECONNABORTED"]);
const RESPONSE_TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

interface ErrorShape {
  name?: string;
  message?: string;
  code?: string;
  phase?: unknown;
  cause?: { code?: string; message?: string; name?: string };
}

export function classifyFetchError(err: unknown): FetchFailureKind {
  const e = (typeof err === "object" && err !== null ? err : {}) as ErrorShape;
  const code = String(e.cause?.code ?? e.code ?? "");
  if (RESPONSE_TIMEOUT_CODES.has(code)) return "response-timeout";
  if (CONNECT_TIMEOUT_CODES.has(code)) return "connect-timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code.startsWith("ERR_TLS") || code.includes("CERT") || /certificate/i.test(e.cause?.message ?? "")) return "tls";
  const timedOut = e.name === "TimeoutError" || e.name === "AbortError" || e.cause?.name === "TimeoutError";
  if (timedOut) return e.phase === "response" ? "response-timeout" : e.phase === "connect" ? "connect-timeout" : "timeout";
  return "other";
}

/** The host:port of a URL, or the text itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * True for an address that is already internal: a name without a dot (a Docker container name, localhost) or a
 * private, loopback or link-local IP. A public domain (hermes.example.com) or a public IP is not.
 */
export function isInternalHost(hostOrUrl: string): boolean {
  let name = hostOrUrl.trim().toLowerCase();
  try {
    if (name.includes("://")) name = new URL(name).hostname;
  } catch {
    // keep the raw text
  }
  if (name.startsWith("[")) name = name.slice(1, name.indexOf("]") > 0 ? name.indexOf("]") : undefined);
  else if (/^[^:]+:\d+$/.test(name)) name = name.replace(/:\d+$/, "");
  if (!name) return false;
  const reason = blockedAddressReason(name);
  if (reason && reason !== "not a valid IP address") return true;
  if (reason === null) return false;
  return !name.includes(".");
}

export interface ServiceInfo {
  name: string;
  /** The internal address to suggest, e.g. "http://<9router container name>:20128". */
  internal: string;
}

export interface FetchExplanation {
  kind: FetchFailureKind;
  error: string;
  hint: string;
}

/**
 * The reason and a fix the owner can act on. `timeoutMs` is the call timeout; `retryAt` (epoch ms) is when the studio
 * asks again, said in the text when the failure is a slow answer.
 */
export function explainFetchFailure(err: unknown, url: string, service: ServiceInfo, timeoutMs: number, opts: { retryAt?: number } = {}): FetchExplanation {
  const kind = classifyFetchError(err);
  const host = hostOf(url);
  const internal = isInternalHost(url);
  const within = durationText(timeoutMs);
  const useInternal =
    `If ${service.name} runs on the same server, use its internal address instead of the public domain ` +
    `(${service.internal}, with both apps on the coolify network). Also check a firewall or Cloudflare rule isn't blocking the server itself.`;
  switch (kind) {
    case "response-timeout": {
      const again = opts.retryAt !== undefined ? ` The studio will try again at ${clockUtc(opts.retryAt)} UTC.` : "";
      return {
        kind,
        error: `${service.name} accepted the request but hadn't finished after ${within}`,
        hint: `It may be busy (another chat or render) or the step is long.${again}`,
      };
    }
    case "connect-timeout":
      return {
        kind,
        error: `Could not connect to ${host} in time`,
        hint: internal
          ? `That is an internal address, so check that ${service.name} is running and that both apps share the Docker network (coolify).`
          : `The portal container can't reach that address. ${useInternal}`,
      };
    case "timeout":
      return {
        kind,
        error: `No answer from ${host} within ${within}`,
        hint: internal
          ? `${service.name} may be busy or slow, or stopped. The address is already internal, so the address is not the problem.`
          : `${service.name} may be busy or slow, or the portal container can't reach that address. ${useInternal}`,
      };
    case "dns":
      return {
        kind,
        error: `The name ${host} doesn't resolve`,
        hint: `Check the spelling. A container name only resolves when ${service.name} and VenStudio share a Docker network (coolify).`,
      };
    case "refused":
      return {
        kind,
        error: `${host} refused the connection`,
        hint: `${service.name} isn't listening on that address and port. If it only listens on 127.0.0.1, containers can't reach it.`,
      };
    case "tls":
      return { kind, error: `TLS certificate problem for ${host}`, hint: "Use the internal http:// address, or fix the certificate." };
    default: {
      const e = (typeof err === "object" && err !== null ? err : {}) as ErrorShape;
      return { kind, error: e.message ?? "Request failed", hint: "" };
    }
  }
}
