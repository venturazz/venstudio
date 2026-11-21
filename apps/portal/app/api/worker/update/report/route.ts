import { z } from "zod";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { parseJson, withWorker } from "@/lib/server/worker-api.ts";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["ok", "refused", "rolled_back", "failed"]),
  version: z.string().max(40),
  detail: z.string().max(500).default(""),
});

/** A worker reports what it did with an update: installed it, refused it, or rolled it back. Shown on Workers. */
export async function POST(req: Request) {
  return withWorker(req, async (worker, ip) => {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const sql = db();
    if (input.status === "ok") {
      // Installed. The offer is cleared until the worker's next check says what is still pending (a Remotion bundle
      // may follow the worker file). The approval stays: it names one release, so it stops matching when the portal
      // serves a newer one, and the bundle half of the same release must not need a second approval.
      await sql`
        UPDATE workers SET update_status = 'ok', update_detail = ${input.detail || null}, update_result_version = ${input.version},
          update_result_at = now(), update_offered_version = NULL, update_offered_release = NULL
        WHERE id = ${worker.id}
      `;
    } else {
      await sql`
        UPDATE workers SET update_status = ${input.status}, update_detail = ${input.detail || null},
          update_result_version = ${input.version}, update_result_at = now()
        WHERE id = ${worker.id}
      `;
    }
    await audit({
      workerId: worker.id,
      action: `worker.update.${input.status}`,
      target: worker.name,
      detail: { version: input.version, detail: input.detail },
      ip,
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  });
}
