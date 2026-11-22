import Link from "next/link";
import { z } from "zod";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { getSavedPlan, listSavedPlans, type SavedPlanRow } from "@/lib/server/productions.ts";
import { newVideoOffer, offeredTemplate, trialQueue, type TrialQueueBatch } from "@/lib/server/trial-queue.ts";
import { LAB_TRIAL_BADGE, LIFECYCLE_TEXT, environmentLine, labTrialOption } from "@/lib/studio/style-registry.ts";
import { workerEnvironmentRows } from "@/lib/server/workers.ts";
import { Alert, Card, CardBody, CardHeader, PageHeader, timeAgo } from "@/components/ui.tsx";
import { THEME_BY_ID } from "@/lib/studio/catalog.ts";
import { autonomyText, EMPTY_PREFILL, prefillFromProduction, type RunFormPrefill } from "@/lib/studio/run-config.ts";
import { RunForm, type RunFormChannel, type RunFormTemplate } from "../runs/run-form.tsx";
import { StudioNav } from "../studio-nav.tsx";
import { TrialQueue } from "../trial-queue.tsx";
import { getStudy, studyTrialState } from "@/lib/server/lab-studies.ts";

export const metadata = { title: "New video" };
export const dynamic = "force-dynamic";

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export default async function NewVideoPage({ searchParams }: { searchParams: Promise<{ from?: string; study?: string; lab?: string; style?: string }> }) {
  const user = await requireUser();
  const canEdit = hasRole(user.role, "editor");
  const { from, study: studyParam, lab: labParam, style: styleParam } = await searchParams;

  let channels: RunFormChannel[] = [];
  let templates: RunFormTemplate[] = [];
  let trialTemplates: RunFormTemplate[] = [];
  let labTemplates: RunFormTemplate[] = [];
  let waiting: string[] = [];
  let capabilities: string[] = [];
  let saved: SavedPlanRow[] = [];
  let queue: TrialQueueBatch[] = [];
  let prefill: RunFormPrefill = EMPTY_PREFILL;
  let loadError = "";
  let studyNote: { tone: "warn" | "info"; title: string; text: string } | null = null;
  let labNote: { tone: "warn" | "info"; text: string } | null = null;
  try {
    const [channelRows, offer, plans, batches, envWorkers] = await Promise.all([
      db()`SELECT id, name, category, plan, autonomy_level, autonomy_paused FROM channels ORDER BY name`,
      // Listed and Trial styles from the vendored packs and stored worker rows: no call to a worker while the page renders.
      // Research-only packs (engine hermes) are rendered by the portal through Hermes: offered, in the Trial section only,
      // when Hermes is set up, grouped by their source.
      newVideoOffer(),
      listSavedPlans().catch(() => [] as SavedPlanRow[]),
      trialQueue(),
      workerEnvironmentRows().catch(() => []),
    ]);
    // A pack with an environment: the engine line also says whether a worker has it (stored rows only).
    const withEnv = (t: RunFormTemplate): RunFormTemplate => {
      const line = environmentLine(offer.registry.find((e) => e.id === t.styleId)?.pack, envWorkers);
      return line ? { ...t, environment: line } : t;
    };
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
    templates = offer.listed.map(withEnv);
    trialTemplates = offer.trial.map(withEnv);
    waiting = offer.waiting;
    capabilities = offer.capabilities;
    saved = plans;
    queue = batches;
    if (from && z.uuid().safeParse(from).success) {
      const p = await getSavedPlan(from);
      if (p) prefill = prefillFromProduction(p);
    }
    // "Try the Hermes research variant" (Styles): preselect an offered style by its id.
    if (styleParam && PACK_ID_RE.test(styleParam)) {
      const t = [...templates, ...trialTemplates].find((x) => x.styleId === styleParam);
      if (t) prefill = { ...prefill, templateId: t.id };
    }
    // "Try it (lab trial)" from Styles or a Template Lab study: a Draft or Lab pack, research only, when a worker (or
    // Hermes) can render it. The reason and the fix are shown when it cannot.
    if (labParam && PACK_ID_RE.test(labParam)) {
      const entry = offer.registry.find((e) => e.id === labParam);
      const option = labTrialOption(entry, offer.capabilities, { hermes: offer.hermes });
      const t = entry && option.ok ? offeredTemplate(entry, offer.templates, true) : null;
      if (entry && option.ok && t) {
        labTemplates = [withEnv({ ...t, lab: true })];
        prefill = { ...EMPTY_PREFILL, templateId: t.id, labTrialPackId: entry.id, brief: `Lab trial of the ${entry.label} pack (${entry.pack?.version ?? "?"}).` };
        labNote = { tone: "info", text: `${LAB_TRIAL_BADGE}: ${entry.label} ${entry.pack?.version ?? ""} is ${entry.pack?.status ?? "?"}. The run is research only, never published, and its result is counted apart from the pack's promotion.` };
      } else {
        labNote = { tone: "warn", text: `A lab trial of ${entry?.label ?? labParam} cannot start: ${option.ok ? "it has no template yet" : `${option.reason}. ${option.fix}`}` };
      }
    }
    // "Start a trial video with the closest pack" on a Template Lab study: the closest pack and the study's notes as
    // the brief. The run is a trial linked to the study (startRun checks the study and marks the pack trial). With
    // `lab` too, the study's lab trial of a Draft or Lab pack.
    if (studyParam && z.uuid().safeParse(studyParam).success) {
      const study = await getStudy(studyParam);
      if (study) {
        const t = await studyTrialState(study);
        if (labTemplates.length > 0) {
          prefill = { ...prefill, brief: t.brief, labStudyId: study.id };
          studyNote = { tone: "info", title: study.title, text: `Lab trial for the lab study "${study.title}". The run is linked to the study; its result shows on the study page.` };
        } else if (t.option.ok && [...templates, ...trialTemplates].some((x) => x.id === (t.option.ok ? t.option.templateId : ""))) {
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
      <ul className="mb-4 space-y-0.5 text-xs text-muted" data-testid="lifecycle">
        {LIFECYCLE_TEXT.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {labNote && (
        <div className="mb-4" data-testid="lab-trial-start-note">
          <Alert tone={labNote.tone}>
            <span className="break-words">{labNote.text}</span>
          </Alert>
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
                key={prefill.productionId || prefill.labTrialPackId || prefill.labStudyId || prefill.templateId || "blank"}
                channels={channels}
                templates={templates}
                trialTemplates={trialTemplates}
                labTemplates={labTemplates}
                waiting={waiting}
                capabilities={capabilities}
                prefill={prefill}
              />
            )}
          </CardBody>
        </Card>
        <div className="min-w-0 space-y-6">
          {queue.length > 0 && <TrialQueue batches={queue} />}
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
      </div>
    </>
  );
}
