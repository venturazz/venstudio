import Link from "next/link";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { reapStuckStages } from "@/lib/server/director.ts";
import { listRuns, type RunSummary } from "@/lib/server/runs.ts";
import { ensureSeedTemplates, listTemplates } from "@/lib/server/templates.ts";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { Alert, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import { stageLabel } from "@/lib/studio/review.ts";
import { HermesTest, RunForm } from "./run-form.tsx";
import { RunStateBadge } from "./run-status.tsx";

export const metadata = { title: "Hermes runs" };
export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("runs page: reaper failed", err);
  }
  let runs: RunSummary[] = [];
  let channels: Array<{ id: string; label: string }> = [];
  let templates: Array<{ id: string; label: string }> = [];
  let loadError = "";
  try {
    await ensureSeedTemplates();
    const [channelRows, templateList, runList] = await Promise.all([
      db()`SELECT id, name FROM channels ORDER BY name`,
      listTemplates(),
      listRuns(),
    ]);
    channels = channelRows.map((c) => ({ id: c.id as string, label: c.name as string }));
    templates = templateList
      .filter((t) => t.status !== "retired")
      .map((t) => ({ id: t.id, label: `${t.label} (${t.formats.join(", ")})` }));
    runs = runList;
  } catch (err) {
    console.error("runs page: could not load", err);
    loadError = "Runs could not be loaded. The latest database update may not be applied yet.";
  }
  const active = runs.some((r) => r.state === "running");

  return (
    <>
      <AutoRefresh active={active} seconds={5} />
      <PageHeader
        title="Hermes runs"
        description="Hermes proposes ideas, researches, writes the script and the storyboard. You decide in Review."
        actions={
          <LinkButton href="/review" variant="secondary">
            Review inbox
          </LinkButton>
        }
      />
      {loadError && (
        <div className="mb-4">
          <Alert tone="warn">{loadError}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Start a run" description="Hermes first proposes ideas for you to pick from." />
            <CardBody>
              {canEdit ? (
                channels.length === 0 ? (
                  <p className="text-sm text-muted">Create a channel first.</p>
                ) : (
                  <RunForm channels={channels} templates={templates} />
                )
              ) : (
                <p className="text-sm text-muted">You have view-only access. Ask an editor to start runs.</p>
              )}
            </CardBody>
          </Card>
          {canEdit && (
            <Card>
              <CardHeader title="Check Hermes" description="Asks a tiny question and checks that the answer is valid JSON." />
              <CardBody>
                <HermesTest />
              </CardBody>
            </Card>
          )}
        </div>
        <Card className="h-fit">
          <CardHeader title="Recent runs" />
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Start a run and it appears here." />
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((r) => (
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
          )}
        </Card>
      </div>
    </>
  );
}
