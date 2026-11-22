import { getSession, hasRole } from "@/lib/server/auth.ts";
import { studyExport } from "@/lib/server/lab-studies.ts";
import { isUuid, jsonError } from "@/lib/server/worker-api.ts";

/**
 * "Download draft pack": the study's draft as one JSON file (style.json, README.md and fixtures/expect.json for
 * packs/<id>/, the provenance and the steps to open it as a PR in venstudio-styles). Editors and the owner only.
 * No GitHub token is involved: the file goes to whoever opens the PR.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  if (!hasRole(session.role, "editor")) return jsonError(403, "Editors and the owner only");
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Not found");
  const out = await studyExport(id);
  if (!out) return jsonError(404, "This study has no draft yet");
  return new Response(`${JSON.stringify(out, null, 2)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${out.packId}.draft.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
