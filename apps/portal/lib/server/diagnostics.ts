import "server-only";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import net from "node:net";
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
  /** Ports that answered on the portal's public IP. Empty when none did or the check couldn't run. */
  exposed: Array<{ port: number; label: string; ip: string }>;
  exposureChecked: string | null;
}

/** Services that must never be reachable from the internet. */
const PRIVATE_PORTS: Array<{ port: number; label: string }> = [
  { port: 8642, label: "Hermes API (runs terminal commands)" },
  { port: 9119, label: "Hermes dashboard (no HTTPS)" },
  { port: 20128, label: "9router" },
  { port: 5432, label: "PostgreSQL" },
];

function canConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Tries the private ports on the IP the portal's own domain points at. Docker-published ports usually
 * answer there even from inside a container. Can miss exposure when the domain is behind a CDN proxy.
 */
async function publicExposure(): Promise<{ exposed: ServerHealth["exposed"]; checked: string | null }> {
  let host: string;
  try {
    host = new URL(env().APP_URL).hostname;
  } catch {
    return { exposed: [], checked: null };
  }
  if (host === "localhost" || host === "127.0.0.1") return { exposed: [], checked: null };
  let ips: string[];
  try {
    ips = [...new Set((await lookup(host, { all: true })).map((a) => a.address))].filter((ip) => net.isIPv4(ip)).slice(0, 2);
  } catch {
    return { exposed: [], checked: null };
  }
  if (ips.length === 0) return { exposed: [], checked: null };
  const checks = await Promise.all(
    ips.flatMap((ip) => PRIVATE_PORTS.map(async (p) => ((await canConnect(ip, p.port)) ? { ...p, ip } : null))),
  );
  return { exposed: checks.filter((c): c is NonNullable<typeof c> => c !== null), checked: ips.join(", ") };
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

  const { exposed, checked: exposureChecked } = await publicExposure();
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
  for (const e of exposed) {
    verdict.push({
      tone: "danger",
      text: `${e.label} answers on public IP ${e.ip}:${e.port}. Remove its "ports:" mapping in Coolify and redeploy it.`,
    });
  }
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
    exposed,
    exposureChecked,
  };
}
