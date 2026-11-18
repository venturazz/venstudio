import "server-only";
import type { z } from "zod";
import { authenticateWorker, type AuthedWorker } from "./workers.ts";
import { ipFromHeaders } from "./request.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function jsonError(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export function isUuid(v: string) {
  return UUID_RE.test(v);
}

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 256 * 1024) return jsonError(413, "Body too large");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** Wraps a worker endpoint: authenticates the bearer token and converts thrown errors into JSON 500s. */
export async function withWorker(req: Request, fn: (worker: AuthedWorker, ip: string) => Promise<Response>) {
  try {
    const ip = ipFromHeaders(req.headers);
    const worker = await authenticateWorker(req, ip);
    if (!worker) return jsonError(401, "Invalid or revoked worker token");
    return await fn(worker, ip);
  } catch (err) {
    console.error("worker api error", err);
    return jsonError(500, "Internal error");
  }
}
