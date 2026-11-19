"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { advanceRun, cancelRun, startRun, testHermesJson } from "@/lib/server/director.ts";
import { fail, str, type FormValues } from "@/lib/form.ts";
import { LANGUAGE_BY_CODE } from "@/lib/studio/catalog.ts";

export type RunFormState = { error?: string; ok?: string; runId?: string; values?: FormValues } | undefined;
export type HermesTestState = { ok: boolean; detail: string } | undefined;

const startSchema = z.object({
  channelId: z.uuid("Choose a channel"),
  templateId: z.string().min(1, "Choose a template").max(80),
  format: z.enum(["short", "long"]),
  language: z.string().max(10).refine((c) => Boolean(LANGUAGE_BY_CODE[c]), "Choose a language from the list"),
  topic: z.string().max(300),
});

/** Starts a run and returns at once. Hermes works in the background after the response is sent. */
export async function startRunAction(_prev: RunFormState, fd: FormData): Promise<RunFormState> {
  const user = await requireUser("editor");
  const parsed = startSchema.safeParse({
    channelId: str(fd, "channelId", 40),
    templateId: str(fd, "templateId", 80),
    format: str(fd, "format", 10) || "short",
    language: str(fd, "language", 10) || "en",
    topic: str(fd, "topic", 300),
  });
  if (!parsed.success) return fail(fd, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const result = await startRun({ ...parsed.data, userId: user.id });
  if (!result.ok) return fail(fd, result.error);
  const runId = result.runId;
  after(() => advanceRun(runId));
  revalidatePath("/studio/runs");
  return { ok: "Run started. Hermes is working on ideas.", runId };
}

export async function cancelRunAction(runId: string): Promise<void> {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(runId).success) return;
  await cancelRun(runId, user.id);
  revalidatePath("/studio/runs");
  revalidatePath(`/studio/runs/${runId}`);
  revalidatePath("/review");
}

/** Asks Hermes a tiny structured question so the owner can see whether JSON replies work. */
export async function testHermesAction(): Promise<HermesTestState> {
  await requireUser("editor");
  return testHermesJson();
}
