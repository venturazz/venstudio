"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { getProduction, insertProduction, setPreviewJob } from "@/lib/server/productions.ts";
import { createJob, URGENT_PRIORITY } from "@/lib/server/jobs.ts";
import { previewSpec } from "@/lib/studio/preview.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { fail, str, type FormValues } from "@/lib/form.ts";
import { buildPlan } from "@/lib/studio/planner.ts";

export type TestRenderState = { error?: string; values?: FormValues } | undefined;

const testSchema = z.object({
  styleId: z.string().min(1, "Choose a style").max(60),
  format: z.enum(["short", "long"]),
  note: z.string().max(140),
});

/**
 * Queues a test render: placeholder cards and a test tone, to check that a worker can render (plan -> job -> worker
 * -> video). It saves a small plan marked `testRender` so the job page and the list can show it, then opens the job.
 * It never asks Hermes and is not a video for a channel.
 */
export async function testRenderAction(_prev: TestRenderState, fd: FormData): Promise<TestRenderState> {
  const user = await requireUser("editor");
  const parsed = testSchema.safeParse({ styleId: str(fd, "styleId", 60), format: str(fd, "format", 10) || "short", note: str(fd, "note", 140) });
  if (!parsed.success) return fail(fd, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const d = parsed.data;
  const brief = d.note || "Test render";
  const built = buildPlan({ brief, format: d.format, styleId: d.styleId });
  if (!built.ok) return fail(fd, built.error);
  const id = await insertProduction({
    title: `Test render: ${built.plan.styleLabel}`,
    brief,
    channelId: "",
    format: d.format,
    styleId: d.styleId,
    themeId: "",
    purposes: [],
    language: built.plan.language.code,
    subtitles: [],
    workflow: "original",
    referenceAssetId: "",
    plan: { ...built.plan, testRender: true },
    createdBy: user.id,
  });
  await audit({ userId: user.id, action: "production.create", target: id, detail: { style: d.styleId, format: d.format, testRender: true }, ip: (await requestMeta()).ip });
  const jobId = await queuePreview(id, user.id);
  if (!jobId) return fail(fd, "The test render could not be queued.");
  revalidatePath("/studio/test-render");
  redirect(`/jobs/${jobId}`);
}

async function queuePreview(productionId: string, userId: string): Promise<string | null> {
  const production = await getProduction(productionId);
  if (!production) return null;
  const spec = previewSpec(production.plan, production.brief);
  // The newest font in the library gives the cards real text; without one the render still runs, without text.
  const [font] = await db()`SELECT id FROM assets WHERE kind = 'font' AND storage_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  const fontAssetId = font ? (font.id as string) : null;
  const jobId = await createJob({
    type: "render-preview",
    payload: { ...spec, productionId, fontAssetId, inputs: fontAssetId ? [fontAssetId] : [] },
    channelId: production.channel_id,
    // Urgent: a test render starts on the first free worker instead of waiting for the channel's home worker.
    priority: URGENT_PRIORITY,
    createdBy: userId,
  });
  await setPreviewJob(productionId, jobId);
  await audit({ userId, action: "production.preview", target: productionId, detail: { jobId }, ip: (await requestMeta()).ip });
  return jobId;
}

/** Queues another test render for a saved plan, then opens the job so its progress and video can be checked. */
export async function queuePreviewAction(productionId: string) {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(productionId).success) return;
  const jobId = await queuePreview(productionId, user.id);
  if (!jobId) return;
  revalidatePath("/studio/test-render");
  redirect(`/jobs/${jobId}`);
}
