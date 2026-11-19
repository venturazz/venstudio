"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { audit } from "@/lib/server/audit.ts";
import { getAssetRow, promoteArtifact, queueAnalysis, VIDEO_KINDS } from "@/lib/server/assets.ts";
import { requestMeta } from "@/lib/server/request.ts";

const idSchema = z.uuid();

/** Starts the study job for a reference video, then opens its job page. */
export async function analyzeAssetAction(id: string) {
  const user = await requireUser("editor");
  if (!idSchema.safeParse(id).success) return;
  const asset = await getAssetRow(id);
  if (!asset || !VIDEO_KINDS.includes(asset.kind)) return;
  const jobId = await queueAnalysis(id, user.id);
  await audit({ userId: user.id, action: "asset.analyze", target: id, detail: { jobId }, ip: (await requestMeta()).ip });
  revalidatePath("/assets");
  redirect(`/jobs/${jobId}`);
}

/** Makes a worker output visible in the library (the file is not copied). */
export async function promoteArtifactAction(artifactId: string) {
  const user = await requireUser("editor");
  if (!idSchema.safeParse(artifactId).success) return;
  const assetId = await promoteArtifact(artifactId, user.id);
  if (assetId) await audit({ userId: user.id, action: "asset.promote", target: assetId, detail: { artifactId }, ip: (await requestMeta()).ip });
  revalidatePath("/assets");
  redirect("/assets");
}
