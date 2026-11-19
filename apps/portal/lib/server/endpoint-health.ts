import "server-only";
import { db } from "./db.ts";
import { HEALTH_ERROR_MAX, shouldQuarantine, type EndpointHealth, type EndpointKind, type EndpointName } from "../studio/endpoint-health.ts";
import { isFailureClass, type FailureClass } from "../studio/pacing.ts";

/**
 * Stores what real calls showed per endpoint and model (endpoint_health). Productions and Settings tests call
 * recordEndpointResult after every 9router image or speech call, and for each provider Hermes reports from its own
 * image chain. Pages only read the table. A database problem is logged and never fails the call that was recorded.
 */

export type EndpointOutcome =
  | { ok: true }
  | { ok: false; failureClass: FailureClass; error: string };

export async function recordEndpointResult(endpoint: EndpointName, model: string, kind: EndpointKind, outcome: EndpointOutcome): Promise<void> {
  const name = model.trim().slice(0, 200);
  if (!name) return;
  try {
    if (outcome.ok) {
      await db()`
        INSERT INTO endpoint_health (endpoint, model, kind, last_success_at, successes, updated_at)
        VALUES (${endpoint}, ${name}, ${kind}, now(), 1, now())
        ON CONFLICT (endpoint, model, kind) DO UPDATE SET
          last_success_at = now(), successes = endpoint_health.successes + 1, quarantined_at = NULL, updated_at = now()
      `;
      return;
    }
    const quarantine = shouldQuarantine(outcome.failureClass);
    const error = outcome.error.replace(/\s+/g, " ").trim().slice(0, HEALTH_ERROR_MAX);
    await db()`
      INSERT INTO endpoint_health (endpoint, model, kind, last_failure_at, failure_class, last_error, quarantined_at, failures, updated_at)
      VALUES (${endpoint}, ${name}, ${kind}, now(), ${outcome.failureClass}, ${error}, ${quarantine ? new Date() : null}, 1, now())
      ON CONFLICT (endpoint, model, kind) DO UPDATE SET
        last_failure_at = now(),
        failure_class = EXCLUDED.failure_class,
        last_error = EXCLUDED.last_error,
        quarantined_at = COALESCE(EXCLUDED.quarantined_at, endpoint_health.quarantined_at),
        failures = endpoint_health.failures + 1,
        updated_at = now()
    `;
  } catch (err) {
    console.error("could not record endpoint health", endpoint, name, err);
  }
}

function ms(v: unknown): number | null {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v.getTime() : null;
}

/** Every stored health row, newest first, mapped to typed objects. An unreadable table gives an empty list. */
export async function listEndpointHealth(kind?: EndpointKind): Promise<EndpointHealth[]> {
  try {
    const rows = kind
      ? await db()`SELECT * FROM endpoint_health WHERE kind = ${kind} ORDER BY updated_at DESC LIMIT 200`
      : await db()`SELECT * FROM endpoint_health ORDER BY updated_at DESC LIMIT 200`;
    const out: EndpointHealth[] = [];
    for (const r of rows) {
      const endpoint: EndpointName | null = r.endpoint === "9router" ? "9router" : r.endpoint === "hermes" ? "hermes" : null;
      const k: EndpointKind | null = r.kind === "image" ? "image" : r.kind === "tts" ? "tts" : null;
      if (!endpoint || !k) continue;
      const cls: unknown = r.failure_class;
      const h: EndpointHealth = {
        endpoint,
        model: String(r.model ?? ""),
        kind: k,
        lastSuccessAt: ms(r.last_success_at),
        lastFailureAt: ms(r.last_failure_at),
        failureClass: isFailureClass(cls) ? cls : null,
        lastError: typeof r.last_error === "string" ? r.last_error : "",
        quarantinedAt: ms(r.quarantined_at),
        successes: Number(r.successes) || 0,
        failures: Number(r.failures) || 0,
      };
      out.push(h);
    }
    return out;
  } catch (err) {
    console.error("could not read endpoint health", err);
    return [];
  }
}
