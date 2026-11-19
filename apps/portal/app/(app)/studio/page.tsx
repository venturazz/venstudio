import Link from "next/link";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { listProductions } from "@/lib/server/productions.ts";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import type { ProductionPlan } from "@/lib/studio/planner.ts";
import { THEMES } from "@/lib/studio/catalog.ts";
import { PlanView, StudioForm } from "./studio-form.tsx";
import { queuePreviewAction } from "./actions.ts";

export const metadata = { title: "Studio" };

const THEME_LABEL: Record<string, string> = Object.fromEntries(THEMES.map((t) => [t.id, t.label]));
const JOB_STATUS: Record<string, { tone: "neutral" | "ok" | "warn" | "danger" | "info"; label: string }> = {
  queued: { tone: "neutral", label: "queued" },
  running: { tone: "info", label: "rendering" },
  succeeded: { tone: "ok", label: "done" },
  failed: { tone: "danger", label: "failed" },
  cancelled: { tone: "warn", label: "cancelled" },
};

export default async function StudioPage() {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  const [channels, references, productions] = await Promise.all([
    db()`SELECT id, name, category FROM channels ORDER BY name`,
    db()`SELECT id, title FROM assets WHERE kind IN ('video', 'reference-video') ORDER BY created_at DESC LIMIT 100`,
    listProductions(),
  ]);

  return (
    <>
      <PageHeader
        title="Studio"
        description="Pick a format and a style, describe the video, and preview its plan. Then queue a test render to check the whole path."
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/studio/runs" variant="primary">
              Hermes runs
            </LinkButton>
            <LinkButton href="/assets" variant="secondary">
              Assets
            </LinkButton>
            <LinkButton href="/workers" variant="secondary">
              Workers
            </LinkButton>
            <LinkButton href="/studio/templates" variant="secondary">
              Templates
            </LinkButton>
            <LinkButton href="/studio/styles" variant="secondary">
              Style library
            </LinkButton>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title="New production" description="Planning only for now. Test renders check the path end to end." />
          <CardBody>
            {canEdit ? (
              <StudioForm
                channels={channels.map((c) => ({
                  id: c.id,
                  label: c.category ? `${c.name} · ${THEME_LABEL[c.category] ?? c.category}` : `${c.name} · category not set`,
                }))}
                references={references.map((r) => ({ id: r.id, title: r.title }))}
              />
            ) : (
              <p className="text-sm text-muted">You have view-only access. Ask an editor to create productions.</p>
            )}
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardHeader title="Productions" />
          {productions.length === 0 ? (
            <EmptyState title="No productions yet" description="Save a plan and it appears here." />
          ) : (
            <ul className="divide-y divide-border">
              {productions.map((p) => {
                const plan = p.plan as ProductionPlan;
                const job = JOB_STATUS[p.preview_status ?? ""];
                return (
                  <li key={p.id} className="space-y-3 px-4 py-3 sm:px-5">
                    <details>
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{p.title}</span>
                          <span className="block text-xs text-muted">
                            {plan.styleLabel ?? p.style_id} · {p.format === "long" ? "Long" : "Short"} · {p.channel ?? "No channel"} · {timeAgo(p.created_at)}
                          </span>
                        </span>
                        <Badge tone={p.status === "planned" ? "neutral" : "info"}>{p.status}</Badge>
                      </summary>
                      {plan.stages && (
                        <div className="mt-3">
                          <PlanView plan={plan} />
                        </div>
                      )}
                    </details>
                    <div className="flex flex-wrap items-center gap-2">
                      {p.preview_job_id && (
                        <Link href={`/jobs/${p.preview_job_id}`} className="inline-flex items-center gap-2 text-xs">
                          <Badge tone={job?.tone ?? "neutral"}>Test render: {job?.label ?? "queued"}</Badge>
                          <span className="text-accent underline-offset-2 hover:underline">open</span>
                        </Link>
                      )}
                      {canEdit && (
                        <form action={queuePreviewAction.bind(null, p.id)}>
                          <SubmitButton className="min-h-8 text-xs" pendingLabel="Queuing…">
                            {p.preview_job_id ? "Queue another test render" : "Queue test render"}
                          </SubmitButton>
                        </form>
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
