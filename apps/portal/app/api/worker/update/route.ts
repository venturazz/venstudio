import { z } from "zod";
import type { UpdateCheckResponse, UpdateInfoResponse } from "@venstudio/protocol";
import { parseJson, withWorker } from "@/lib/server/worker-api.ts";
import { publicSigningKey } from "@/lib/server/update-key.ts";
import { updateOfferFor, updateSettings } from "@/lib/server/updates.ts";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const sha = z.string().regex(/^[0-9a-f]{64}$/);

const schema = z.object({
  version: z.string().max(40),
  files: z
    .object({
      "venstudio-worker.ts": sha,
      "render-remotion.json": z.union([sha, z.literal("unknown"), z.null()]),
    })
    .optional(),
  keyId: z.string().regex(/^[0-9a-f]{16}$/).optional(),
});

/** The worker's self-test: proves the token works and names the key and mode, without offering anything. */
export async function GET(req: Request) {
  return withWorker(req, async () => {
    const [key, settings] = await Promise.all([publicSigningKey(), updateSettings()]);
    return Response.json({ keyId: key.keyId, mode: settings.mode } satisfies UpdateInfoResponse, { headers: NO_STORE });
  });
}

/** Update check (worker 0.8.0+): a signed manifest when the owner's update mode allows one for this worker. */
export async function POST(req: Request) {
  return withWorker(req, async (worker) => {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const { manifest, decision } = await updateOfferFor(worker.id, {
      version: input.version,
      files: input.files,
      keyId: input.keyId,
    });
    return Response.json({ manifest, reason: decision.reason } satisfies UpdateCheckResponse, { headers: NO_STORE });
  });
}
