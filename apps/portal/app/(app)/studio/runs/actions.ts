"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { advanceRun, cancelRun, startRun, testHermesJson } from "@/lib/server/director.ts";
import { fail, str, type FormValues } from "@/lib/form.ts";
import { LANGUAGE_BY_CODE } from "@/lib/studio/catalog.ts";
import { MAX_BRIEF_CHARS, MAX_PURPOSES, MAX_SUBTITLES } from "@/lib/studio/run-config.ts";
import { getTemplate } from "@/lib/server/templates.ts";
import { LAB_TRIAL_BADGE } from "@/lib/studio/style-registry.ts";
import { MAX_BATCH_TRIALS, batchTrialIssues } from "@/lib/studio/trial-batch.ts";
import { batchOffers } from "@/lib/server/trial-queue.ts";
import { randomUUID } from "node:crypto";

export type RunFormState = { error?: string; ok?: string; runId?: string; values?: FormValues } | undefined;
export type BatchTrialState = { error?: string; ok?: string; runs?: Array<{ runId: string; label: string; position: string }> } | undefined;
export type HermesTestState = { ok: boolean; detail: string } | undefined;

const startSchema = z.object({
  channelId: z.uuid("Choose a channel"),
  templateId: z.string().min(1, "Choose a style").max(80),
  format: z.enum(["short", "long"]),
  language: z.string().max(10).refine((c) => Boolean(LANGUAGE_BY_CODE[c]), "Choose a language from the list"),
  brief: z.string().max(MAX_BRIEF_CHARS),
  themeId: z.string().max(40),
  purposes: z.array(z.string().max(40)).max(MAX_PURPOSES, "Choose fewer purposes"),
  subtitles: z.array(z.string().max(10)).max(MAX_SUBTITLES + 1, "Choose fewer subtitle languages"),
  productionId: z.union([z.uuid(), z.literal("")]),
  labStudyId: z.union([z.uuid(), z.literal("")]),
  labTrialPackId: z.union([z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), z.literal("")]),
  thinkOnMuse: z.boolean(),
});

function all(fd: FormData, key: string): string[] {
  return fd.getAll(key).filter((v): v is string => typeof v === "string");
}

/** Starts a run and returns at once. Hermes works in the background after the response is sent. */
export async function startRunAction(_prev: RunFormState, fd: FormData): Promise<RunFormState> {
  const user = await requireUser("editor");
  const parsed = startSchema.safeParse({
    channelId: str(fd, "channelId", 40),
    templateId: str(fd, "templateId", 80),
    format: str(fd, "format", 10) || "short",
    language: str(fd, "language", 10) || "en",
    // Older clients sent a one-line topic; it means the same as the brief.
    brief: str(fd, "brief", MAX_BRIEF_CHARS) || str(fd, "topic", 300),
    themeId: str(fd, "themeId", 40),
    purposes: all(fd, "purposes"),
    subtitles: all(fd, "subtitles"),
    productionId: str(fd, "productionId", 40),
    labStudyId: str(fd, "labStudyId", 40),
    labTrialPackId: str(fd, "labTrialPackId", 63),
    thinkOnMuse: str(fd, "thinkOnMuse", 4) === "on",
  });
  if (!parsed.success) return fail(fd, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const { labTrialPackId, ...data } = parsed.data;
  // A lab trial names its Draft or Lab pack; the chosen style must be that pack (startRun refuses any other status).
  let labTrial = false;
  if (labTrialPackId) {
    const template = await getTemplate(data.templateId);
    if (!template || template.styleId !== labTrialPackId) return fail(fd, `This lab trial is for ${labTrialPackId}; pick that style or start from Styles again.`);
    labTrial = true;
  }
  const result = await startRun({ ...data, labTrial, userId: user.id });
  if (!result.ok) return fail(fd, result.error);
  const runId = result.runId;
  after(() => advanceRun(runId));
  revalidatePath("/studio");
  if (parsed.data.labStudyId) revalidatePath(`/studio/lab/${parsed.data.labStudyId}`);
  if (labTrial) revalidatePath("/studio/styles");
  const worker = data.thinkOnMuse ? "Muse" : "Hermes";
  return { ok: labTrial ? `Lab trial started (${LAB_TRIAL_BADGE}, never published). ${worker} is working on ideas.` : `Run started. ${worker} is working on ideas.`, runId };
}

const batchSchema = startSchema.omit({ templateId: true, productionId: true, labStudyId: true, labTrialPackId: true }).extend({
  templateIds: z.array(z.string().min(1).max(80)).max(MAX_BATCH_TRIALS + 1, `Pick at most ${MAX_BATCH_TRIALS} styles in one batch`),
});

/**
 * "Try these styles": one brief, one trial run per picked Trial or research style, started in the order picked. Every
 * pick is checked against what New Video offers right now (batchTrialIssues) before any run starts. Hermes then works
 * through them one ask at a time through its gate; the queue shows where each run is.
 */
export async function startBatchTrialAction(_prev: BatchTrialState, fd: FormData): Promise<BatchTrialState> {
  const user = await requireUser("editor");
  const parsed = batchSchema.safeParse({
    channelId: str(fd, "channelId", 40),
    format: str(fd, "format", 10) || "short",
    language: str(fd, "language", 10) || "en",
    brief: str(fd, "brief", MAX_BRIEF_CHARS),
    themeId: str(fd, "themeId", 40),
    purposes: all(fd, "purposes"),
    subtitles: all(fd, "subtitles"),
    templateIds: all(fd, "batchTemplateIds"),
    thinkOnMuse: str(fd, "thinkOnMuse", 4) === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  const { templateIds, ...data } = parsed.data;
  const offered = await batchOffers();
  const issues = batchTrialIssues({ templateIds, offered, format: data.format });
  if (issues.length > 0) return { error: issues.join(". ") };
  const batchId = randomUUID();
  const runs: Array<{ runId: string; label: string; position: string }> = [];
  const errors: string[] = [];
  for (const [n, templateId] of templateIds.entries()) {
    const label = offered.find((o) => o.id === templateId)?.label ?? templateId;
    const result = await startRun({ ...data, templateId, productionId: "", labStudyId: "", trialBatch: { id: batchId, index: n + 1, total: templateIds.length }, userId: user.id });
    if (!result.ok) {
      errors.push(`${label}: ${result.error}`);
      continue;
    }
    const runId = result.runId;
    runs.push({ runId, label, position: `${n + 1} of ${templateIds.length}` });
    after(() => advanceRun(runId));
  }
  revalidatePath("/studio");
  revalidatePath("/studio/styles");
  if (runs.length === 0) return { error: `No trial started. ${errors.join(". ")}` };
  return {
    ok: `${runs.length} trial run${runs.length === 1 ? "" : "s"} started from one brief${errors.length ? ` (not started: ${errors.join("; ")})` : ""}. Hermes works through them one ask at a time.`,
    runs,
  };
}

export async function cancelRunAction(runId: string): Promise<void> {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(runId).success) return;
  await cancelRun(runId, user.id);
  revalidatePath("/studio");
  revalidatePath(`/studio/runs/${runId}`);
  revalidatePath("/review");
}

/** Asks Hermes a tiny structured question so the owner can see whether JSON replies work. */
export async function testHermesAction(): Promise<HermesTestState> {
  await requireUser("editor");
  return testHermesJson();
}
