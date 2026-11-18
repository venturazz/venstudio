"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { env } from "@/lib/server/env.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { createEnrollmentCode, ENROLLMENT_MINUTES } from "@/lib/server/workers.ts";
import { str } from "@/lib/form.ts";

export type EnrollState =
  | { error?: string; code?: string; expiresAt?: string; prompt?: string; command?: string }
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

  const url = env().APP_URL.replace(/\/+$/, "");
  const prompt =
    `Set up a VenStudio render worker on this VM. Read ${url}/install/AGENT_DEPLOY.md and follow it step by step. ` +
    `Portal URL: ${url}. Enrollment code: ${code} (valid ${ENROLLMENT_MINUTES} minutes). Worker name: ${p.data.label}.`;
  const command =
    `curl -fsSL ${url}/install/install.sh | bash -s -- --portal ${url} --code ${code} --name "${p.data.label.replace(/"/g, "")}" --mode daemon`;
  return { code, expiresAt: expiresAt.toISOString(), prompt, command };
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
