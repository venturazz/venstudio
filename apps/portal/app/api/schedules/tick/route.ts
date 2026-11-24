import { NextResponse } from "next/server";
import { tickSchedules } from "@/lib/server/schedules.ts";

/**
 * The tick. Called by whatever clock the deployment has — a Coolify scheduled task, a worker cron, or the Automation page
 * when it is opened — and safe to call as often as anyone likes: a slot becomes exactly one run or it does not become a
 * run at all, because `pipeline_runs (schedule_id, slot_at)` is unique.
 *
 * Guarded by a shared token rather than a session: it creates runs, so it must not be open, and it must not depend on a
 * browser being logged in. If no token is configured the route refuses everything, so an unconfigured deployment fails
 * closed instead of quietly starting videos.
 */
export async function POST(request: Request) {
  const expected = process.env.AUTOSTUDIO_TICK_TOKEN ?? "";
  const given = request.headers.get("x-autostudio-token") ?? "";
  if (expected === "" || given !== expected) {
    return NextResponse.json({ error: "Not authorised. Set AUTOSTUDIO_TICK_TOKEN and send it as x-autostudio-token." }, { status: 401 });
  }
  const result = await tickSchedules(new Date());
  return NextResponse.json(result);
}

/** A GET would look like a health check and start videos when someone reloads it. Say so instead. */
export async function GET() {
  return NextResponse.json({ error: "Use POST with x-autostudio-token." }, { status: 405 });
}