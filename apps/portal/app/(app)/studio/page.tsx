import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { listProductions } from "@/lib/server/productions.ts";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import type { ProductionPlan } from "@/lib/studio/planner.ts";
import { PlanView, StudioForm } from "./studio-form.tsx";

export const metadata = { title: "Studio" };

export default async function StudioPage() {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  const [channels, references, productions] = await Promise.all([
    db()`SELECT id, name FROM channels ORDER BY name`,
    db()`SELECT id, title FROM assets WHERE kind IN ('video', 'reference-video') ORDER BY created_at DESC LIMIT 100`,
    listProductions(),
  ]);

  return (
    <>
      <PageHeader
        title="Studio"
        description="Pick a format and a style, describe the video, and preview its plan. Nothing runs until you save and its workers are connected."
        actions={
          <LinkButton href="/studio/styles" variant="secondary">
            Style library
          </LinkButton>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title="New production" description="Planning only for now. Stages marked Runs now can run today." />
          <CardBody>
            {canEdit ? (
              <StudioForm channels={channels.map((c) => ({ id: c.id, name: c.name }))} references={references.map((r) => ({ id: r.id, title: r.title }))} />
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
                return (
                  <li key={p.id} className="px-4 py-3 sm:px-5">
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
