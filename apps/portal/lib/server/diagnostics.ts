import "server-only";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { db } from "./db.ts";
import { env } from "./env.ts";

export interface ServerHealth {
  dbRoundTripMs: number;
  dbQueryMs: number;
  cpus: number;
  load1: number;
  memTotalGb: number;
  memFreeGb: number;
  processRssMb: number;
  uptimeHours: number;
  artifactsFreeGb: number | null;
  artifactsTotalGb: number | null;
  verdict: { tone: "ok" | "warn" | "danger"; text: string }[];
}

const gb = (b: number) => Math.round((b / 1024 ** 3) * 10) / 10;

/** Numbers that separate "the server is too small or busy" from "the app is slow". */
export async function serverHealth(): Promise<ServerHealth> {
  const sql = db();
  let t = performance.now();
  await sql`SELECT 1`;
  const dbRoundTripMs = Math.round(performance.now() - t);
  t = performance.now();
  await sql`SELECT count(*) FROM jobs`;
  const dbQueryMs = Math.round(performance.now() - t);

  let artifactsFreeGb: number | null = null;
  let artifactsTotalGb: number | null = null;
  try {
    const s = await statfs(env().ARTIFACT_DIR);
    artifactsFreeGb = gb(s.bavail * s.bsize);
    artifactsTotalGb = gb(s.blocks * s.bsize);
  } catch {}

  const cpus = os.cpus().length;
  const load1 = Math.round(os.loadavg()[0] * 100) / 100;
  const memTotalGb = gb(os.totalmem());
  const memFreeGb = gb(os.freemem());

  const verdict: ServerHealth["verdict"] = [];
  if (load1 > cpus * 1.5) verdict.push({ tone: "danger", text: `CPU is overloaded (load ${load1} on ${cpus} cores). Something else on the server is busy, or it needs more CPU.` });
  else if (load1 > cpus) verdict.push({ tone: "warn", text: `CPU is busy (load ${load1} on ${cpus} cores).` });
  if (memFreeGb < 0.3) verdict.push({ tone: "danger", text: `Only ${memFreeGb} GB RAM free. The server is swapping or close to it; add RAM or stop other apps.` });
  if (dbRoundTripMs > 20) verdict.push({ tone: "warn", text: `The database answers slowly (${dbRoundTripMs} ms; under 5 ms is normal on one server).` });
  if (artifactsFreeGb !== null && artifactsFreeGb < 5) verdict.push({ tone: "warn", text: `Only ${artifactsFreeGb} GB disk left for videos.` });
  if (verdict.length === 0) verdict.push({ tone: "ok", text: "Server resources look healthy." });

  return {
    dbRoundTripMs,
    dbQueryMs,
    cpus,
    load1,
    memTotalGb,
    memFreeGb,
    processRssMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    artifactsFreeGb,
    artifactsTotalGb,
    verdict,
  };
}
