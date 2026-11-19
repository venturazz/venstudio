"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { installFileSha256, portalUrl } from "@/lib/server/install-files.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { createEnrollmentCode, ENROLLMENT_MINUTES } from "@/lib/server/workers.ts";
import { str } from "@/lib/form.ts";

export type EnrollState =
  | { error?: string; code?: string; expiresAt?: string; prompt?: string; command?: string; installSha256?: string }
  | undefined;

const enrollSchema = z.object({
  label: z.string().min(1, "Give the worker a name, e.g. Muse 01").max(80),
  host: z.enum(["muse", "vps", "local"]),
  channelId: z.union([z.uuid(), z.literal("")]),
});

export async function createEnrollment(_prev: EnrollState, fd: FormData): Promise<EnrollState> {
  const user = await requireUser("owner");
  const p = enrollSchema.safeParse({
    label: str(fd, "label", 80),
    host: str(fd, "host", 10) || "muse",
    channelId: str(fd, "channelId", 40),
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Invalid input" };
  const { code, expiresAt } = await createEnrollmentCode({
    label: p.data.label,
    host: p.data.host,
    channelId: p.data.channelId || null,
    createdBy: user.id,
  });
  await audit({ userId: user.id, action: "worker.enrollment_created", detail: { label: p.data.label }, ip: (await requestMeta()).ip });

  const url = portalUrl();
  const name = p.data.label.replace(/["`$\\]/g, "");
  const installSha256 = (await installFileSha256("install.sh")) ?? "";
  // Written as the owner's own request with every command spelled out, so the Muse agent can review exactly
  // what it runs. Muse rightly refuses to follow instructions from a fetched web page.
  const prompt = [
    `I'm setting up a render worker for my own video production portal (${url}) on this VM. ` +
      `It's a small Node.js program that asks my portal for render jobs over HTTPS and renders them with ffmpeg. ` +
      `Everything installs under /home/hatch/venstudio. Please run these commands and show me the output:`,
    ``,
    `mkdir -p /home/hatch/venstudio && cd /home/hatch/venstudio`,
    `curl -fsSL ${url}/install/install.sh -o install.sh`,
    `sha256sum install.sh`,
    `bash install.sh --portal ${url} --code ${code} --name "${name}" --mode hold`,
    ``,
    `The sha256 should be ${installSha256}. If it's different, stop and tell me. ` +
      `The script downloads Node.js from nodejs.org and ffmpeg from johnvansickle.com if they're missing, and checks their checksums. ` +
      `${code} is a one-time code from my portal, valid for ${ENROLLMENT_MINUTES} minutes.`,
    ``,
    `Then create a recurring scheduled task named "VenStudio worker" that runs every hour and does this: ` +
      `run /home/hatch/venstudio/run.sh hold in the foreground and wait for it to finish (it stays online up to about 55 minutes, ` +
      `then exits by itself), then read the last 5 lines of /home/hatch/venstudio/logs/worker.log. ` +
      `Only message me if those lines contain "fatal"; "already running" is normal.`,
    ``,
    `When done, show me the last 5 lines of /home/hatch/venstudio/logs/worker.log and confirm the scheduled task exists.`,
  ].join("\n");
  const command =
    `curl -fsSL ${url}/install/install.sh -o install.sh && sha256sum install.sh && ` +
    `bash install.sh --portal ${url} --code ${code} --name "${name}" --mode daemon`;
  return { code, expiresAt: expiresAt.toISOString(), prompt, command, installSha256 };
}

const idSchema = z.uuid();

export async function setWorkerStatus(id: string, status: "active" | "draining") {
  const user = await requireUser("owner");
  if (!idSchema.safeParse(id).success) return;
  await db()`UPDATE workers SET status = ${status} WHERE id = ${id} AND status <> 'revoked'`;
  await audit({ userId: user.id, action: `worker.${status === "active" ? "resume" : "drain"}`, target: id, ip: (await requestMeta()).ip });
  revalidatePath("/workers");
}

/** Revoke: the token stops working immediately; running jobs return to the queue when their lease expires. */
export async function revokeWorker(id: string) {
  const user = await requireUser("owner");
  if (!idSchema.safeParse(id).success) return;
  const sql = db();
  await sql`UPDATE workers SET status = 'revoked', token_hash = NULL, revoked_at = now() WHERE id = ${id}`;
  await sql`UPDATE channels SET home_worker_id = NULL WHERE home_worker_id = ${id}`;
  await sql`UPDATE jobs SET lease_expires_at = now() WHERE worker_id = ${id} AND status = 'running'`;
  await audit({ userId: user.id, action: "worker.revoke", target: id, ip: (await requestMeta()).ip });
  revalidatePath("/workers");
}

export async function deleteWorker(id: string) {
  const user = await requireUser("owner");
  if (!idSchema.safeParse(id).success) return;
  await db()`DELETE FROM workers WHERE id = ${id} AND status = 'revoked'`;
  await audit({ userId: user.id, action: "worker.delete", target: id, ip: (await requestMeta()).ip });
  revalidatePath("/workers");
}
