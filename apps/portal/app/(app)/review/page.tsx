import Link from "next/link";
import { Inbox } from "lucide-react";
import { hasRole, requireUser } from "@/lib/server/auth.ts";
import { listProviderTerms } from "@/lib/server/executors/persist.ts";
import type { ProviderTerms } from "@/lib/studio/asset-plan.ts";
import { blockingRows, providersFromPayload, termsHeld } from "@/lib/studio/terms-review.ts";
import { reapStuckStages } from "@/lib/server/director.ts";
import { narrationTempoReady } from "@/lib/server/production.ts";
import { listOpenReviews } from "@/lib/server/reviews.ts";
import { advisoryFor, presentationFor } from "@/lib/server/presentation.ts";
import { listWaitingRuns, type WaitingRun } from "@/lib/server/runs.ts";
import { isRenderingWait, stageWaitText } from "@/lib/studio/pacing.ts";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { Alert, Card, EmptyState, PageHeader, timeAgo } from "@/components/ui.tsx";
import { describeGateIssues, sortReviews, stageLabel } from "@/lib/studio/review.ts";
import { ReviewCard, type ReviewCardView } from "./review-card.tsx";

export const metadata = { title: "Review" };
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await requireUser("editor");
  const isOwner = hasRole(user.role, "owner");
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("review page: reaper failed", err);
  }
  let loadError = "";
  let views: ReviewCardView[] = [];
  let waiting: WaitingRun[] = [];
  try {
    waiting = await listWaitingRuns();
  } catch (err) {
    console.error("review page: could not load waiting runs", err);
  }
  const now = Date.now();
  try {
    const items = sortReviews(await listOpenReviews());
    // Read from the database only when a card needs it. A failed read shows the cards without the provider list.
    let terms: ProviderTerms[] | null = null;
    if (items.some((r) => termsHeld(r.kind, r.stage, r.payload.issues))) {
      terms = await listProviderTerms().catch((err) => {
        console.error("review page: could not load provider terms", err);
        return null;
      });
    }
    // Fit the narration needs every render worker to play a changed tempo. Read only when a card could offer it.
    let tempoReady = false;
    if (items.some((r) => r.kind === "gate-failure" && r.stage === "voice" && r.payload.voice?.fitTempo)) {
      tempoReady = await narrationTempoReady().catch(() => false);
    }
    // The final video's presentation score and Hermes's advisory, read only for quality-check cards.
    const scores = new Map<string, Pick<ReviewCardView, "presentation" | "advisory">>();
    for (const r of items) {
      if (r.stage !== "qc") continue;
      const video = r.payload.media?.videoAssetId ?? null;
      const [pres, adv] = await Promise.all([
        presentationFor(r.runId, video).catch(() => null),
        advisoryFor(r.runId, video).catch(() => null),
      ]);
      scores.set(r.id, {
        presentation: pres ? { score: pres.score, passed: pres.passed, rubric: pres.rubric, byOwner: pres.by === "owner" } : null,
        advisory: adv ? { score: adv.score, notes: adv.notes, frames: adv.frames } : null,
      });
    }
    views = items.map(
      (r): ReviewCardView => ({
        id: r.id,
        runId: r.runId,
        stage: r.stage,
        kind: r.kind,
        payload: r.payload,
        topic: r.topic,
        channelName: r.channelName,
        trial: r.trial,
        hermesRender: r.hermesRender,
        labTrial: r.labTrial,
        designed: r.designed,
        pictures: r.pictures,
        voiced: r.voiced,
        ...(scores.get(r.id) ?? {}),
        gateLines: r.kind === "gate-failure" ? describeGateIssues(r.gates.filter((g) => !g.passed)) : [],
        age: timeAgo(r.createdAt),
        blocking: terms && termsHeld(r.kind, r.stage, r.payload.issues) ? blockingRows(providersFromPayload(r.stage, r.payload), terms) : null,
        canSetTerms: isOwner,
        isOwner,
        tempoReady,
        recheckedAge: r.payload.recheckedAt ? timeAgo(new Date(r.payload.recheckedAt)) : "",
      }),
    );
  } catch (err) {
    console.error("review page: could not load", err);
    loadError = "The review list could not be loaded. Try again in a moment.";
  }

  return (
    <>
      <AutoRefresh active seconds={15} />
      <PageHeader title="Review" description="Hermes asks here when it needs your decision. Approve, ask for a change, or reject." />
      {loadError && (
        <div className="mb-4">
          <Alert tone="warn">{loadError}</Alert>
        </div>
      )}
      {waiting.length > 0 && (
        <ul className="mx-auto mb-4 flex max-w-2xl flex-col gap-2" data-testid="hermes-waiting">
          {waiting.map((w) => (
            <li key={`${w.runId}:${w.stage}`} className="min-w-0 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
              <p className="break-words font-medium">
                {stageLabel(w.stage)} · {w.topic || "Untitled run"}
                {w.channelName ? ` · ${w.channelName}` : ""}
              </p>
              <p className="mt-1 break-words text-muted">
                {stageWaitText(w.hermesWait, w.until.getTime(), now)}
                {isRenderingWait(w.hermesWait) ? "" : ". Nothing to do; it continues on its own."}
              </p>
              <Link href={`/studio/runs/${w.runId}`} className="inline-flex min-h-11 items-center text-accent underline-offset-2 hover:underline">
                Open the run
              </Link>
            </li>
          ))}
        </ul>
      )}
      {views.length === 0 && !loadError ? (
        <Card>
          <EmptyState icon={<Inbox className="size-8" aria-hidden />} title="Nothing waiting for you." description="New ideas and approvals show up here." />
        </Card>
      ) : (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {views.map((v) => (
            <ReviewCard key={v.id} item={v} />
          ))}
        </div>
      )}
    </>
  );
}
