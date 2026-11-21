import Link from "next/link";
import { z } from "zod";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { ensureSeedTemplates, listTemplates } from "@/lib/server/templates.ts";
import { getSavedPlan, listSavedPlans, type SavedPlanRow } from "@/lib/server/productions.ts";
import { reportedCapabilities } from "@/lib/server/workers.ts";
import { Alert, Card, CardBody, CardHeader, PageHeader, timeAgo } from "@/components/ui.tsx";
import { THEME_BY_ID } from "@/lib/studio/catalog.ts";
import { autonomyText, EMPTY_PREFILL, prefillFromProduction, type RunFormPrefill } from "@/lib/studio/run-config.ts";
import { RunForm, type RunFormChannel, type RunFormTemplate } from "../runs/run-form.tsx";
import { StudioNav } from "../studio-nav.tsx";

export const metadata = { title: "New video" };
export const dynamic = "force-dynamic";

export default async function NewVideoPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  const { from } = await searchParams;

  let channels: RunFormChannel[] = [];
  let templates: RunFormTemplate[] = [];
  let capabilities: string[] = [];
  let saved: SavedPlanRow[] = [];
  let prefill: RunFormPrefill = EMPTY_PREFILL;
  let loadError = "";
  try {
    await ensureSeedTemplates();
    const [channelRows, templateList, caps, plans] = await Promise.all([
      db()`SELECT id, name, category, plan, autonomy_level, autonomy_paused FROM channels ORDER BY name`,
      listTemplates(),
      // Stored worker rows only: no call to a worker while the page renders.
      reportedCapabilities().catch(() => [] as string[]),
      listSavedPlans().catch(() => [] as SavedPlanRow[]),
    ]);
    channels = channelRows.map((c) => {
      const category = (c.category as string | null) ?? "";
      return {
        id: c.id as string,
        name: c.name as string,
        category,
        categoryLabel: category ? (THEME_BY_ID[category]?.label ?? category) : "",
        plan: ((c.plan as string | null) ?? "").slice(0, 600),
        autonomy: autonomyText(Number(c.autonomy_level), c.autonomy_paused === true),
      };
    });
    templates = templateList
      .filter((t) => t.status !== "retired")
      .map((t) => ({ id: t.id, label: t.label, styleId: t.styleId, formats: [...t.formats] }));
    capabilities = caps;
    saved = plans;
    if (from && z.uuid().safeParse(from).success) {
      const p = await getSavedPlan(from);
      if (p) prefill = prefillFromProduction(p);
    }
  } catch (err) {
    console.error("new video page: could not load", err);
    loadError = "The form could not be loaded. The latest database update may not be applied yet.";
  }

  return (
    <>
      <PageHeader title="New video" description="Only the channel is needed. Hermes proposes ideas, and you pick one in Review." actions={<StudioNav current="new" />} />
      {loadError && (
        <div className="mb-4">
          <Alert tone="warn">{loadError}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title="Start a video" description={prefill.productionId ? "Filled in from your saved plan. Change anything before you start." : undefined} />
          <CardBody>
            {!canEdit ? (
              <p className="text-sm text-muted">You have view-only access. Ask an editor to start videos.</p>
            ) : channels.length === 0 ? (
              <p className="text-sm text-muted">
                Create a channel first in{" "}
                <Link href="/channels/new" className="text-accent underline-offset-2 hover:underline">
                  Channels
                </Link>
                .
              </p>
            ) : (
              <RunForm key={prefill.productionId || "blank"} channels={channels} templates={templates} capabilities={capabilities} prefill={prefill} />
            )}
          </CardBody>
        </Card>
        {saved.length > 0 && canEdit && (
          <Card className="h-fit" data-testid="saved-plans">
            <CardHeader title="Start from a saved plan" description="Plans saved with the old planner. Picking one fills in the form." />
            <ul className="divide-y divide-border">
              {saved.map((p) => (
                <li key={p.id}>
                  <Link href={`/studio/new?from=${p.id}`} className="block min-h-12 px-4 py-3 hover:bg-surface-2 sm:px-5">
                    <span className="block break-words text-sm font-medium">{p.title}</span>
                    <span className="block text-xs text-muted">
                      {p.format === "long" ? "Long" : "Short"} · {timeAgo(p.created_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
