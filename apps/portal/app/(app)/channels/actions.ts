"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { FORMATS } from "@/lib/formats.ts";
import { LANGUAGE_BY_CODE, THEMES } from "@/lib/studio/catalog.ts";
import { str, type FormState } from "@/lib/form.ts";

const schema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  handle: z
    .string()
    .max(40)
    .regex(/^(@[A-Za-z0-9._-]{3,30})?$/, "Handle looks like @mychannel"),
  niche: z.string().max(120),
  category: z.union([z.literal(""), z.enum(THEMES.map((t) => t.id) as [string, ...string[]])]),
  format: z.enum(FORMATS.map((f) => f.id) as [string, ...string[]]),
  language: z.string().refine((c) => Boolean(LANGUAGE_BY_CODE[c]), "Choose a language from the list"),
  googleAccount: z.string().max(120),
  status: z.enum(["planning", "active", "paused"]),
  videosPerDay: z.coerce.number().int().min(0).max(24),
  homeWorkerId: z.union([z.uuid(), z.literal("")]),
  notes: z.string().max(4000),
  plan: z.string().max(4000),
});

function read(fd: FormData) {
  return schema.safeParse({
    name: str(fd, "name", 80),
    handle: str(fd, "handle", 40),
    niche: str(fd, "niche", 120),
    category: str(fd, "category", 40),
    format: str(fd, "format", 40) || "other",
    language: str(fd, "language", 10) || "en",
    googleAccount: str(fd, "googleAccount", 120),
    status: str(fd, "status", 20) || "planning",
    videosPerDay: str(fd, "videosPerDay", 3) || "2",
    homeWorkerId: str(fd, "homeWorkerId", 40),
    notes: str(fd, "notes", 4000),
    plan: str(fd, "plan", 4000),
  });
}

export async function createChannel(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  const p = read(fd);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;
  const [row] = await db()`
    INSERT INTO channels (name, handle, niche, category, format, language, google_account, status, videos_per_day, home_worker_id, notes, plan)
    VALUES (${d.name}, ${d.handle || null}, ${d.niche}, ${d.category}, ${d.format}, ${d.language}, ${d.googleAccount},
            ${d.status}, ${d.videosPerDay}, ${d.homeWorkerId || null}, ${d.notes}, ${d.plan})
    RETURNING id
  `;
  await audit({ userId: user.id, action: "channel.create", target: row.id, detail: { name: d.name, category: d.category }, ip: (await requestMeta()).ip });
  revalidatePath("/channels");
  redirect(`/channels/${row.id}`);
}

export async function updateChannel(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(id).success) return { error: "Unknown channel" };
  const p = read(fd);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;
  await db()`
    UPDATE channels SET name = ${d.name}, handle = ${d.handle || null}, niche = ${d.niche}, category = ${d.category},
      format = ${d.format}, language = ${d.language}, google_account = ${d.googleAccount}, status = ${d.status},
      videos_per_day = ${d.videosPerDay}, home_worker_id = ${d.homeWorkerId || null}, notes = ${d.notes}, plan = ${d.plan},
      updated_at = now()
    WHERE id = ${id}
  `;
  await audit({ userId: user.id, action: "channel.update", target: id, detail: { category: d.category }, ip: (await requestMeta()).ip });
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
