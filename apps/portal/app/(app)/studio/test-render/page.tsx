import Link from "next/link";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { listProductions } from "@/lib/server/productions.ts";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import type { ProductionPlan } from "@/lib/studio/planner.ts";
import { PlanView, TestRenderForm } from "../studio-form.tsx";
import { HermesTest } from "../runs/run-form.tsx";
import { queuePreviewAction } from "../actions.ts";
import { StudioNav } from "../studio-nav.tsx";

export const metadata = { title: "Test render" };
export const dynamic = "force-dynamic";

const JOB_STATUS: Record<string, { tone: "neutral" | "ok" | "warn" | "danger" | "info"; label: string }> = {
  queued: { tone: "neutral", label: "queued" },
  running: { tone: "info", label: "rendering" },
  succeeded: { tone: "ok", label: "done" },
  failed: { tone: "danger", label: "failed" },
  cancelled: { tone: "warn", label: "cancelled" },
};

interface SavedItem {
  id: string;
  title: string;
  format: string;
  styleId: string;
  plan: ProductionPlan & { testRender?: boolean };
  createdAt: Date;
  previewJobId: string | null;
  previewStatus: string;
  channel: string;
}

export default async function TestRenderPage() {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  let productions: SavedItem[] = [];
  try {
    productions = (await listProductions()).map((r) => ({
      id: r.id as string,
      title: (r.title as string | null) ?? "",
      format: (r.format as string | null) ?? "short",
      styleId: (r.style_id as string | null) ?? "",
      plan: (r.plan ?? {}) as ProductionPlan & { testRender?: boolean },
      createdAt: r.created_at as Date,
      previewJobId: (r.preview_job_id as string | null) ?? null,
      previewStatus: (r.preview_status as string | null) ?? "",
      channel: (r.channel as string | null) ?? "",
    }));
  } catch (err) {
    console.error("test render page: could not load", err);
  }

  return (
    <>
      <PageHeader
        title="Test render"
        description="Checks that a worker can render, with placeholder cards and a test tone. It is not a real video and does not use Hermes."
        actions={<StudioNav current="test-render" />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Queue a test render" description="The first free worker renders it. The job page shows the video." />
            <CardBody>{canEdit ? <TestRenderForm /> : <p className="text-sm text-muted">You have view-only access.</p>}</CardBody>
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

        <Card className="h-fit" data-testid="saved-productions">
          <CardHeader title="Saved plans and test renders" />
          {productions.length === 0 ? (
            <EmptyState title="Nothing saved yet" description="Test renders you queue appear here." />
          ) : (
            <ul className="divide-y divide-border">
              {productions.map((p) => {
                const plan = p.plan;
                const job = JOB_STATUS[p.previewStatus];
                const id = p.id;
                return (
                  <li key={id} className="space-y-3 px-4 py-3 sm:px-5" data-testid="saved-production">
                    <details>
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block break-words text-sm font-medium">{p.title}</span>
                          <span className="block break-words text-xs text-muted">
                            {plan.styleLabel ?? p.styleId} · {p.format === "long" ? "Long" : "Short"} · {p.channel || "No channel"} · {timeAgo(p.createdAt)}
                          </span>
                        </span>
                        <Badge tone={plan.testRender ? "neutral" : "info"}>{plan.testRender ? "test" : "plan"}</Badge>
                      </summary>
                      {plan.stages && (
                        <div className="mt-3">
                          <PlanView plan={plan} />
                        </div>
                      )}
                    </details>
                    <div className="flex flex-wrap items-center gap-2">
                      {p.previewJobId && (
                        <Link href={`/jobs/${p.previewJobId}`} className="inline-flex min-h-8 items-center gap-2 text-xs">
                          <Badge tone={job?.tone ?? "neutral"}>Test render: {job?.label ?? "queued"}</Badge>
                          <span className="text-accent underline-offset-2 hover:underline">open</span>
                        </Link>
                      )}
                      {canEdit && (
                        <form action={queuePreviewAction.bind(null, id)}>
                          <SubmitButton className="min-h-8 text-xs" pendingLabel="Queuing…">
                            Queue another test render
                          </SubmitButton>
                        </form>
                      )}
                      {canEdit && !plan.testRender && (
                        <LinkButton href={`/studio/new?from=${id}`} className="min-h-8 text-xs">
                          Start a video from this plan
                        </LinkButton>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
