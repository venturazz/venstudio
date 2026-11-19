import { db } from "@/lib/server/db.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db()`SELECT 1`;
    return Response.json({ ok: true });
  } catch (err) {
    console.error("health check failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false }, { status: 503 });
  }
}
