"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { advanceRun, decideReview, recheckReview, recheckTermsReviews } from "@/lib/server/director.ts";
import { saveProviderTerms } from "@/lib/server/provider-terms.ts";
import { PROVIDER_NAME_MAX } from "@/lib/studio/asset-plan.ts";
import { fail, str } from "@/lib/form.ts";
import type { FormState } from "@/lib/form.ts";

const schema = z.object({
  reviewId: z.uuid("Unknown review item"),
  decision: z.enum(["approve", "revise", "reject", "retry", "recheck"]),
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
  if (d.decision === "recheck") {
    // Only the gate runs again on the work that is already made; terms are read, never written.
    const r = await recheckReview({ reviewId: d.reviewId, userId: user.id });
    revalidatePath("/review");
    if (!r.ok) return fail(fd, r.error);
    revalidatePath(`/studio/runs/${r.runId}`);
    if (r.action === "approved") {
      const runId = r.runId;
      after(() => advanceRun(runId));
    }
    return { ok: r.message };
  }
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

const STATUS_TEXT = { yes: "Commercial use OK", no: "Not for commercial use", unknown: "Not confirmed" } as const;

/**
 * The owner sets a provider's terms right on a Review card. Same write and same owner-only rule as Settings
 * (saveProviderTerms). The save commits first; then the open cards held up only by terms that use this row are
 * checked again before the page reloads, so the card the owner is looking at updates at once. That check reads the
 * database only (no Hermes, no worker), is bounded, and a failure in it is reported without undoing the save.
 */
export async function setTermsOnCardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const owner = await requireUser("owner");
  const saved = await saveProviderTerms(owner, {
    name: str(fd, "name", PROVIDER_NAME_MAX),
    kind: str(fd, "kind", 10),
    status: str(fd, "status", 10),
    note: str(fd, "note", 300),
  });
  if (!saved.ok) return fail(fd, saved.error);
  const line = `Saved: ${saved.name} is ${STATUS_TEXT[saved.status]}.`;
  let checked = 0;
  try {
    const r = await recheckTermsReviews({ name: saved.name, kind: saved.kind }, owner.id);
    checked = r.checked;
    for (const runId of r.runIds) after(() => advanceRun(runId));
  } catch (err) {
    console.error("setTermsOnCardAction: re-check failed", err);
  }
  revalidatePath("/review");
  revalidatePath("/settings");
  return { ok: checked > 0 ? `${line} The card was checked again; nothing was made again.` : line };
}
