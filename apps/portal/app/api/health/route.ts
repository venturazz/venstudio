import { db } from "@/lib/server/db.ts";

export const dynamic = "force-dynamic";

/**
 * The one honest answer to "is the code I merged actually running?": Coolify hands the build its commit, and a deploy
 * that never happened keeps saying the old one. Without it the only way to tell two images apart is to guess from
 * behaviour, which is how a prompt fix looks like it did nothing.
 */
export async function GET() {
  const commit = (process.env.SOURCE_COMMIT ?? process.env.GIT_COMMIT ?? process.env.COOLIFY_COMMIT ?? "").trim();
  try {
    await db()`SELECT 1`;
    return Response.json({ ok: true, commit: commit ? commit.slice(0, 7) : "unknown" });
  } catch (err) {
    console.error("health check failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false, commit: commit ? commit.slice(0, 7) : "unknown" }, { status: 503 });
  }
}
