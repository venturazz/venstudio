"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { advanceRun, decideReview } from "@/lib/server/director.ts";
import { fail, str } from "@/lib/form.ts";
import type { FormState } from "@/lib/form.ts";

const schema = z.object({
  reviewId: z.uuid("Unknown review item"),
  decision: z.enum(["approve", "revise", "reject", "retry"]),
  note: z.string().max(1000),
  ideaIndex: z.union([z.literal(""), z.coerce.number().int().min(0).max(50)]),
});

/** Records the owner's decision, then lets the engine continue in the background. */
export async function decideReviewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("editor");
  const parsed = schema.safeParse({
    reviewId: str(fd, "reviewId", 40),
    decision: str(fd, "decision", 10),
    note: str(fd, "note", 1000),
    ideaIndex: str(fd, "ideaIndex", 3),
  });
  if (!parsed.success) return fail(fd, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const d = parsed.data;
  const result = await decideReview({
    reviewId: d.reviewId,
    decision: d.decision,
    note: d.note,
    ideaIndex: d.ideaIndex === "" ? undefined : d.ideaIndex,
    userId: user.id,
  });
  revalidatePath("/review");
  if (!result.ok) return fail(fd, result.error);
  revalidatePath(`/studio/runs/${result.runId}`);
  if (d.decision !== "reject") {
    const runId = result.runId;
    after(() => advanceRun(runId));
  }
  return { ok: result.message };
}
