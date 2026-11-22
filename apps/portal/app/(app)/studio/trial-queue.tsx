import Link from "next/link";
import { Badge, Card, CardHeader, timeAgo } from "@/components/ui.tsx";
import type { TrialQueueBatch } from "@/lib/server/trial-queue.ts";

/**
 * The batch trials queue (New Video and Styles): each run of the newest batches, in batch order, with where it is.
 * Hermes takes one ask at a time through its gate, so the runs move in turn.
 */
export function TrialQueue({ batches }: { batches: TrialQueueBatch[] }) {
  return (
    <Card className="h-fit min-w-0" data-testid="trial-queue">
      <CardHeader title="Trial queue" description="Batch trials started from one brief. Hermes works through them one ask at a time." />
      <div className="space-y-4 px-4 pb-4 sm:px-5">
        {batches.map((b) => (
          <div key={b.id} className="space-y-1.5" data-testid="trial-batch">
            <p className="text-xs text-muted">
              {b.lines.length} style{b.lines.length === 1 ? "" : "s"}
              {b.createdAt ? `, started ${timeAgo(b.createdAt)}` : ""}
            </p>
            <ol className="space-y-1.5">
              {b.lines.map((l) => (
                <li key={l.runId} className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid="trial-queue-run" data-run-id={l.runId}>
                  <span className="text-xs text-muted">{l.position}</span>
                  <Link href={`/studio/runs/${l.runId}`} className="min-w-0 break-words text-accent underline-offset-2 hover:underline">
                    {l.label}
                  </Link>
                  <Badge tone={l.tone}>
                    <span data-testid="trial-queue-status">{l.status}</span>
                  </Badge>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </Card>
  );
}
