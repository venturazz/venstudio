import { z } from "zod";
import type { EnrollResponse } from "@venstudio/protocol";
import { enrollWorker, sanitizeCapabilities } from "@/lib/server/workers.ts";
import { ipFromHeaders } from "@/lib/server/request.ts";
import { jsonError, parseJson } from "@/lib/server/worker-api.ts";

const schema = z.object({
  code: z.string().min(8).max(40),
  name: z.string().max(80).default(""),
  host: z.enum(["muse", "vps", "local"]).optional(),
  capabilities: z.array(z.string().max(80)).max(100),
  version: z.string().max(40),
});

export async function POST(req: Request) {
  try {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const result = await enrollWorker({
      code: input.code,
      name: input.name,
      capabilities: sanitizeCapabilities(input.capabilities),
      version: input.version,
      ip: ipFromHeaders(req.headers),
    });
    if (!result) return jsonError(403, "Enrollment code is invalid, expired or already used");
    return Response.json(result satisfies EnrollResponse, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("enroll error", err);
    return jsonError(500, "Internal error");
  }
}
