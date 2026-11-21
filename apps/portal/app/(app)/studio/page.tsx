import Link from "next/link";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { reapStuckStages } from "@/lib/server/director.ts";
import { listRuns, type RunSummary } from "@/lib/server/runs.ts";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { Alert, Card, CardHeader, EmptyState, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import { stageLabel } from "@/lib/studio/review.ts";
import { runGroup, type RunGroup } from "@/lib/studio/run-config.ts";
import { RunStateBadge } from "./runs/run-status.tsx";
import { StudioNav } from "./studio-nav.tsx";

export const metadata = { title: "Studio" };
export const dynamic = "force-dynamic";

const GROUPS: Array<{ id: RunGroup; title: string; description: string }> = [
  { id: "waiting", title: "Waiting for you", description: "Open Review to pick an idea, approve or ask for changes." },
  { id: "working", title: "Working", description: "Hermes and the workers are on it." },
  { id: "finished", title: "Finished", description: "Done, cancelled or failed." },
];

export default async function StudioPage() {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("studio page: reaper failed", err);
  }
  let runs: RunSummary[] = [];
  let loadError = "";
  try {
    runs = await listRuns();
  } catch (err) {
    console.error("studio page: could not load runs", err);
    loadError = "Runs could not be loaded. The latest database update may not be applied yet.";
  }
  const active = runs.some((r) => r.state === "running");

  return (
    <>
      <AutoRefresh active={active} seconds={5} />
      <PageHeader
        title="Studio"
        description="Start a video. Hermes finds the idea, writes it and makes it; you decide in Review."
        actions={<StudioNav current="runs" />}
      />
      {loadError && (
        <div className="mb-4">
          <Alert tone="warn">{loadError}</Alert>
        </div>
      )}
      {runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No videos yet"
            description={canEdit ? "Press New video, choose a channel, and Hermes proposes ideas for you to pick from." : "An editor starts videos here."}
          />
        </Card>
      ) : (
        <div className="space-y-6" data-testid="studio-runs">
          {GROUPS.map((g) => {
            const list = runs.filter((r) => runGroup(r.state) === g.id);
            if (list.length === 0) return null;
            return (
              <Card key={g.id} data-group={g.id}>
                <CardHeader
                  title={`${g.title} (${list.length})`}
                  description={g.description}
                  actions={
                    g.id === "waiting" ? (
                      <LinkButton href="/review" variant="primary" className="shrink-0">
                        Review
                      </LinkButton>
                    ) : undefined
                  }
                />
                <ul className="divide-y divide-border">
                  {list.map((r) => (
                    <li key={r.id}>
                      <Link href={`/studio/runs/${r.id}`} className="flex min-h-14 items-start justify-between gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                        <span className="min-w-0">
                          <span className="block break-words text-sm font-medium">{r.topic || "Waiting for an idea"}</span>
                          <span className="block break-words text-xs text-muted">
                            {r.channelName || "No channel"} · {r.currentStage ? stageLabel(r.currentStage) : "Starting"} · {timeAgo(r.createdAt)}
                          </span>
                        </span>
                        <RunStateBadge state={r.state} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-6 text-xs text-muted">
        Also:{" "}
        <Link href="/assets" className="text-accent underline-offset-2 hover:underline">
          Assets
        </Link>{" "}
        ·{" "}
        <Link href="/workers" className="text-accent underline-offset-2 hover:underline">
          Workers
        </Link>
      </p>
    </>
  );
}
