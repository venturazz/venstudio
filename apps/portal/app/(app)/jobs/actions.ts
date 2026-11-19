"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { JobType } from "@venstudio/protocol";
import { requireUser } from "@/lib/server/auth.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { cancelJob, createJob, JOB_TYPES, retryJob, URGENT_PRIORITY } from "@/lib/server/jobs.ts";
import { fail, str, type FormState } from "@/lib/form.ts";

const schema = z.object({
  type: z.enum(Object.keys(JOB_TYPES) as [JobType, ...JobType[]]),
  channelId: z.union([z.uuid(), z.literal("")]),
  seconds: z.coerce.number().int().min(1).max(60),
});

export async function createJobAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  const p = schema.safeParse({
    type: str(fd, "type", 30),
    channelId: str(fd, "channelId", 40),
    seconds: str(fd, "seconds", 3) || "5",
  });
  if (!p.success) return fail(fd, p.error.issues[0]?.message ?? "Invalid input");
  const payload = p.data.type === "smoke-test" ? { seconds: p.data.seconds, width: 1080, height: 1920, fps: 30 } : {};
  const urgent = fd.get("urgent") === "on";
  const id = await createJob({
    type: p.data.type,
    payload,
    channelId: p.data.channelId || null,
    priority: urgent ? URGENT_PRIORITY : 0,
    createdBy: user.id,
  });
  await audit({ userId: user.id, action: "job.create", target: id, detail: { type: p.data.type, urgent }, ip: (await requestMeta()).ip });
  revalidatePath("/jobs");
  redirect(`/jobs/${id}`);
}

export async function cancelJobAction(id: string) {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(id).success) return;
  await cancelJob(id);
  await audit({ userId: user.id, action: "job.cancel", target: id, ip: (await requestMeta()).ip });
  revalidatePath(`/jobs/${id}`);
}

export async function retryJobAction(id: string) {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(id).success) return;
  await retryJob(id);
  await audit({ userId: user.id, action: "job.retry", target: id, ip: (await requestMeta()).ip });
  revalidatePath(`/jobs/${id}`);
}
