import { db } from "@/lib/server/db.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db()`SELECT 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
