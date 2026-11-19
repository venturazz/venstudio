import { Inbox } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { reapStuckStages } from "@/lib/server/director.ts";
import { listOpenReviews } from "@/lib/server/reviews.ts";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { Alert, Card, EmptyState, PageHeader, timeAgo } from "@/components/ui.tsx";
import { describeGateIssues, sortReviews } from "@/lib/studio/review.ts";
import { ReviewCard, type ReviewCardView } from "./review-card.tsx";

export const metadata = { title: "Review" };
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  await requireUser("editor");
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("review page: reaper failed", err);
  }
  let loadError = "";
  let views: ReviewCardView[] = [];
  try {
    const items = sortReviews(await listOpenReviews());
    views = items.map(
      (r): ReviewCardView => ({
        id: r.id,
        runId: r.runId,
        stage: r.stage,
        kind: r.kind,
        payload: r.payload,
        topic: r.topic,
        channelName: r.channelName,
        gateLines: r.kind === "gate-failure" ? describeGateIssues(r.gates.filter((g) => !g.passed)) : [],
        age: timeAgo(r.createdAt),
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
