"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { FORMATS } from "@/lib/formats.ts";
import { fail, str, type FormState } from "@/lib/form.ts";

const schema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  handle: z
    .string()
    .max(40)
    .regex(/^(@[A-Za-z0-9._-]{3,30})?$/, "Handle looks like @mychannel"),
  niche: z.string().max(120),
  format: z.enum(FORMATS.map((f) => f.id) as [string, ...string[]]),
  language: z.string().min(2).max(10),
  googleAccount: z.string().max(120),
  status: z.enum(["planning", "active", "paused"]),
  videosPerDay: z.coerce.number().int().min(0).max(24),
  homeWorkerId: z.union([z.uuid(), z.literal("")]),
  notes: z.string().max(4000),
});

function read(fd: FormData) {
  return schema.safeParse({
    name: str(fd, "name", 80),
    handle: str(fd, "handle", 40),
    niche: str(fd, "niche", 120),
    format: str(fd, "format", 40) || "other",
    language: str(fd, "language", 10) || "en",
    googleAccount: str(fd, "googleAccount", 120),
    status: str(fd, "status", 20) || "planning",
    videosPerDay: str(fd, "videosPerDay", 3) || "2",
    homeWorkerId: str(fd, "homeWorkerId", 40),
    notes: str(fd, "notes", 4000),
  });
}

export async function createChannel(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  const p = read(fd);
  if (!p.success) return fail(fd, p.error.issues[0]?.message ?? "Invalid input");
  const d = p.data;
  const [row] = await db()`
    INSERT INTO channels (name, handle, niche, format, language, google_account, status, videos_per_day, home_worker_id, notes)
    VALUES (${d.name}, ${d.handle || null}, ${d.niche}, ${d.format}, ${d.language}, ${d.googleAccount}, ${d.status},
            ${d.videosPerDay}, ${d.homeWorkerId || null}, ${d.notes})
    RETURNING id
  `;
  await audit({ userId: user.id, action: "channel.create", target: row.id, detail: { name: d.name }, ip: (await requestMeta()).ip });
  revalidatePath("/channels");
  redirect(`/channels/${row.id}`);
}

export async function updateChannel(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(id).success) return { error: "Unknown channel" };
  const p = read(fd);
  if (!p.success) return fail(fd, p.error.issues[0]?.message ?? "Invalid input");
  const d = p.data;
  await db()`
    UPDATE channels SET name = ${d.name}, handle = ${d.handle || null}, niche = ${d.niche}, format = ${d.format},
      language = ${d.language}, google_account = ${d.googleAccount}, status = ${d.status},
      videos_per_day = ${d.videosPerDay}, home_worker_id = ${d.homeWorkerId || null}, notes = ${d.notes},
      updated_at = now()
    WHERE id = ${id}
  `;
  await audit({ userId: user.id, action: "channel.update", target: id, ip: (await requestMeta()).ip });
  revalidatePath("/channels");
  revalidatePath(`/channels/${id}`);
  return { ok: "Saved" };
}

export async function deleteChannel(id: string) {
  const user = await requireUser("owner");
  if (!z.uuid().safeParse(id).success) return;
  await db()`DELETE FROM channels WHERE id = ${id}`;
  await audit({ userId: user.id, action: "channel.delete", target: id, ip: (await requestMeta()).ip });
  revalidatePath("/channels");
  redirect("/channels");
}
