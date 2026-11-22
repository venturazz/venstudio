import Link from "next/link";
import { z } from "zod";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { ensureSeedTemplates, listTemplates } from "@/lib/server/templates.ts";
import { getSavedPlan, listSavedPlans, type SavedPlanRow } from "@/lib/server/productions.ts";
import { reportedCapabilities } from "@/lib/server/workers.ts";
import { styleRegistry } from "@/lib/server/style-packs.ts";
import { isResearchEngine, newVideoStyles } from "@/lib/studio/style-registry.ts";
import { env } from "@/lib/server/env.ts";
import { Alert, Card, CardBody, CardHeader, PageHeader, timeAgo } from "@/components/ui.tsx";
import { THEME_BY_ID } from "@/lib/studio/catalog.ts";
import { autonomyText, EMPTY_PREFILL, prefillFromProduction, type RunFormPrefill } from "@/lib/studio/run-config.ts";
import { RunForm, type RunFormChannel, type RunFormTemplate } from "../runs/run-form.tsx";
import { StudioNav } from "../studio-nav.tsx";
import { getStudy, studyTrialState } from "@/lib/server/lab-studies.ts";

export const metadata = { title: "New video" };
export const dynamic = "force-dynamic";

export default async function NewVideoPage({ searchParams }: { searchParams: Promise<{ from?: string; study?: string }> }) {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  const { from, study: studyParam } = await searchParams;

  let channels: RunFormChannel[] = [];
  let templates: RunFormTemplate[] = [];
  let trialTemplates: RunFormTemplate[] = [];
  let waiting: string[] = [];
  let capabilities: string[] = [];
  let saved: SavedPlanRow[] = [];
  let prefill: RunFormPrefill = EMPTY_PREFILL;
  let loadError = "";
  let studyNote: { tone: "warn" | "info"; title: string; text: string } | null = null;
  try {
    await ensureSeedTemplates();
    const [channelRows, templateList, caps, plans, registry] = await Promise.all([
      db()`SELECT id, name, category, plan, autonomy_level, autonomy_paused FROM channels ORDER BY name`,
      listTemplates(),
      // Stored worker rows only: no call to a worker while the page renders.
      reportedCapabilities().catch(() => [] as string[]),
      listSavedPlans().catch(() => [] as SavedPlanRow[]),
      // The vendored style packs, read from disk once per process.
      styleRegistry(),
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
    // Listed packs a worker reports, and Trial packs (research only) in their own section. Planned, draft, lab,
    // proven and retired styles are never offered.
    // Research-only packs (engine hermes) are rendered by the portal through Hermes: offered, in the Trial section only,
    // when Hermes is set up.
    const hermes = Boolean(env().HERMES_BASE_URL);
    const offer = newVideoStyles(registry, caps, { hermes });
    const usable = templateList.filter((t) => t.status !== "retired");
    const toForm = (ids: string[], trial: boolean) =>
      ids.flatMap((styleId) => {
        const t = usable.find((x) => x.styleId === styleId);
        const e = registry.find((x) => x.id === styleId);
        return t && e?.pack
          ? [{ id: t.id, label: e.label, styleId, formats: [...e.pack.formats], trial, version: e.pack.version, ...(isResearchEngine(e.pack.engine) ? { research: true } : {}) }]
          : [];
      });
    templates = toForm(offer.listed.map((e) => e.id), false);
    trialTemplates = toForm(offer.trial.map((e) => e.id), true);
    waiting = offer.waiting.map((e) =>
      isResearchEngine(e.engine)
        ? `${e.label} (Trial, needs Hermes: set HERMES_BASE_URL)`
        : `${e.label} (${e.pack?.status === "trial" ? "Trial" : "Listed"}, needs pack:${e.id}@${e.pack?.version ?? "?"})`,
    );
    capabilities = caps;
    saved = plans;
    if (from && z.uuid().safeParse(from).success) {
      const p = await getSavedPlan(from);
      if (p) prefill = prefillFromProduction(p);
    }
    // "Start a trial video with the closest pack" on a Template Lab study: the closest pack and the study's notes as
    // the brief. The run is a trial linked to the study (startRun checks the study and marks the pack trial).
    if (studyParam && z.uuid().safeParse(studyParam).success) {
      const study = await getStudy(studyParam);
      if (study) {
        const t = await studyTrialState(study);
        if (t.option.ok && [...templates, ...trialTemplates].some((x) => x.id === (t.option.ok ? t.option.templateId : ""))) {
          prefill = { ...EMPTY_PREFILL, templateId: t.option.templateId, brief: t.brief, labStudyId: study.id };
          studyNote = { tone: "info", title: study.title, text: `Trial for the lab study "${study.title}" with the closest pack, ${t.option.packId}. The run is marked as a trial linked to the study; its result shows on the study page.` };
        } else {
          studyNote = { tone: "warn", title: study.title, text: `A trial for the lab study "${study.title}" cannot start: ${t.option.ok ? "New Video does not offer its closest pack" : t.option.reason}.` };
        }
      }
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
      {studyNote && (
        <div className="mb-4" data-testid="lab-study-trial-note">
          <Alert tone={studyNote.tone}>
            <span className="break-words">{studyNote.text}</span>
          </Alert>
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
              <RunForm
                key={prefill.productionId || prefill.labStudyId || "blank"}
                channels={channels}
                templates={templates}
                trialTemplates={trialTemplates}
                waiting={waiting}
                capabilities={capabilities}
                prefill={prefill}
              />
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
