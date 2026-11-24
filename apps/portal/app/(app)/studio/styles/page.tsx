import { requireUser } from "@/lib/server/auth.ts";
import { Alert, Badge, Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui.tsx";
import { CopyButton } from "@/components/client.tsx";
import { ENGINES, FAMILY_LABELS, THEMES, VIDEO_FORMATS } from "@/lib/studio/catalog.ts";
import { listTemplates } from "@/lib/server/templates.ts";
import { reportedCapabilities, workerEnvironmentRows } from "@/lib/server/workers.ts";
import { env } from "@/lib/server/env.ts";
import { listTrialOutcomes, styleRegistry, vendoredStyles } from "@/lib/server/style-packs.ts";
import { creditOf, newVideoOffer, trialQueue, type TrialQueueBatch } from "@/lib/server/trial-queue.ts";
import { db } from "@/lib/server/db.ts";
import {
  HERMES_RENDER_LABEL,
  LAB_TRIAL_BADGE,
  LIFECYCLE_TEXT,
  PROMOTION_RULE_TEXT,
  STATUS_LABEL,
  STYLE_GROUP_LABEL,
  TRIAL_LABEL,
  availabilityOf,
  environmentLine,
  isResearchEngine,
  curationRecord,
  labTrialCounts,
  labTrialOption,
  packPromotionIssues,
  researchGroupOf,
  researchSourceOf,
  researchVariantFor,
  styleGroup,
  trialCounts,
  type RegistryEntry,
  type RegistryStatus,
  type StyleGroup,
  type TrialOutcome,
  type WorkerEnvironment,
} from "@/lib/studio/style-registry.ts";
import { TrialQueue } from "../trial-queue.tsx";
import { BatchTrials } from "./batch-trials.tsx";
import type { Template } from "@/lib/studio/templates.ts";

export const metadata = { title: "Style library" };
export const dynamic = "force-dynamic";

const MUSE_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  "muse-ok": "ok",
  "muse-slow": "warn",
  "muse-test": "warn",
  "gpu-preferred": "danger",
  external: "neutral",
};
const MUSE_LABEL: Record<string, string> = {
  "muse-ok": "Muse: runs well",
  "muse-slow": "Muse: slow, CPU only",
  "muse-test": "Muse: verify first",
  "gpu-preferred": "Needs a GPU worker",
  external: "AI provider",
};
const STATUS_TONE: Record<RegistryStatus, "ok" | "warn" | "danger" | "neutral" | "info" | "accent"> = {
  listed: "ok",
  proven: "accent",
  trial: "warn",
  lab: "info",
  draft: "neutral",
  retired: "danger",
  planned: "neutral",
};
const PACK_ORDER: RegistryStatus[] = ["listed", "proven", "trial", "lab", "draft", "retired"];
/** Styles page sections, in order: research styles first (what the owner tests now), then by lifecycle. */
const GROUP_ORDER: StyleGroup[] = ["research", "trial", "lab", "listed", "proven", "retired"];

export default async function StyleLibraryPage() {
  await requireUser();
  let entries: RegistryEntry[] = [];
  let caps: string[] = [];
  let outcomes: TrialOutcome[] = [];
  let templates: Template[] = [];
  let commit: string | null = null;
  let problems: string[] = [];
  let queue: TrialQueueBatch[] = [];
  let envWorkers: Array<{ name: string; capabilities: string[]; environments: WorkerEnvironment[] }> = [];
  let batchStyles: Array<{ id: string; label: string }> = [];
  let batchChannels: Array<{ id: string; name: string }> = [];
  let loadError = "";
  try {
    const vendored = await vendoredStyles();
    commit = vendored.commit;
    problems = vendored.problems;
    entries = await styleRegistry();
    // Stored rows only: no call to a worker or to GitHub while the page renders.
    [caps, outcomes, templates, queue, envWorkers] = await Promise.all([
      reportedCapabilities().catch(() => [] as string[]),
      listTrialOutcomes().catch(() => [] as TrialOutcome[]),
      listTemplates().catch(() => [] as Template[]),
      trialQueue(),
      workerEnvironmentRows().catch(() => []),
    ]);
  } catch (err) {
    console.error("styles page: could not load", err);
    loadError = "The style registry could not be loaded.";
  }
  const packs = entries.filter((e) => e.pack).sort((a, b) => PACK_ORDER.indexOf(a.status) - PACK_ORDER.indexOf(b.status));
  const planned = entries.filter((e) => !e.pack);
  const hermes = Boolean(env().HERMES_BASE_URL);
  const sections = GROUP_ORDER.map((g) => ({ group: g, items: packs.filter((e) => styleGroup(e) === g) })).filter((x) => x.items.length > 0);

  return (
    <>
      <PageHeader
        title="Style library"
        description="Style packs with their status, renderer, worker availability, provenance and curation, then the styles that are only planned."
        actions={
          <LinkButton href="/studio/templates" variant="secondary">
            Templates
          </LinkButton>
        }
      />
      {loadError && (
        <div className="mb-4">
          <Alert tone="danger">{loadError}</Alert>
        </div>
      )}
      {problems.length > 0 && (
        <div className="mb-4">
          <Alert tone="warn">{problems.join(" ")}</Alert>
        </div>
      )}
      <p className="mb-6 break-words text-sm text-muted" data-testid="styles-source">
        Packs vendored from venturazz/venstudio-styles{commit ? ` at ${commit.slice(0, 12)}` : ""} (styles/lock.json). Status changes happen there, by a
        pull request the owner merges; this page never changes a pack. New Video offers Listed packs a worker reports, and Trial packs in a separate
        section marked research only.
      </p>
      <ul className="mb-6 space-y-0.5 text-sm" data-testid="lifecycle">
        {LIFECYCLE_TEXT.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {queue.length > 0 && (
        <div className="mb-6">
          <TrialQueue batches={queue} />
          <BatchTrials channels={batchChannels} styles={batchStyles} defaultDurationSec={45} />
        </div>
      )}

      <section className="space-y-3" data-testid="style-packs">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Style packs</h2>
        {packs.length === 0 && <p className="text-sm text-muted">No style pack is vendored.</p>}
        {sections.map((sec) => (
          <div key={sec.group} className="space-y-3" data-testid={`style-group-${sec.group}`}>
            <h3 className="text-sm font-medium" data-testid="style-group-title">
              {STYLE_GROUP_LABEL[sec.group]} ({sec.items.length})
            </h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {sec.items.map((e) => (
                <PackCard
                  key={e.id}
                  entry={e}
                  caps={caps}
                  envWorkers={envWorkers}
                  hermes={hermes}
                  outcomes={outcomes.filter((o) => o.packId === e.id)}
                  template={templates.find((t) => t.styleId === e.id) ?? null}
                  variant={researchVariantFor(e, entries)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-10 space-y-3" data-testid="planned-styles">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Planned styles (not selectable)</h2>
        <p className="text-sm text-muted">In the catalogue, not packs yet. They cannot be used for a run until a pack for them is curated in the styles repository.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {planned.map((e) => (
            <PlannedCard key={e.id} entry={e} />
          ))}
        </div>
      </section>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Themes" description="Topics the studio knows how to frame, with their content rules." />
          <CardBody>
            <ul className="space-y-3 text-sm">
              {THEMES.map((t) => (
                <li key={t.id}>
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-muted">{t.policy.join(" ")}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Engines" description="What renders each style, and where it can run." />
          <CardBody>
            <ul className="space-y-3 text-sm">
              {Object.values(ENGINES).map((e) => (
                <li key={e.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{e.label}</p>
                    <Badge tone={MUSE_TONE[e.muse]}>{MUSE_LABEL[e.muse]}</Badge>
                    <Badge>{e.tier}</Badge>
                  </div>
                  <p className="text-xs text-muted">{e.note}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      <p className="mt-6 text-xs text-muted">
        Formats: short {VIDEO_FORMATS.short.width}×{VIDEO_FORMATS.short.height}, long {VIDEO_FORMATS.long.width}×{VIDEO_FORMATS.long.height}.
      </p>
    </>
  );
}

function PackCard({
  entry: e,
  caps,
  hermes,
  outcomes,
  template,
  variant,
  envWorkers,
}: {
  entry: RegistryEntry;
  caps: string[];
  /** Stored worker rows (capabilities and reported environments), for the environment line of a pack that has one. */
  envWorkers: Array<{ name: string; capabilities: string[]; environments: WorkerEnvironment[] }>;
  hermes: boolean;
  outcomes: TrialOutcome[];
  template: Template | null;
  /** The Hermes research variant of this style (a hermes pack whose variantOf names it), if any. */
  variant: RegistryEntry | null;
}) {
  const pack = e.pack!;
  const group = researchGroupOf(pack);
  const source = researchSourceOf(pack);
  const lab = labTrialCounts(outcomes);
  const labable = pack.status === "draft" || pack.status === "lab";
  const labOption = labable ? labTrialOption(e, caps, { hermes }) : null;
  const variantOffered = variant?.pack && variant.pack.status === "trial" && hermes;
  const engine = ENGINES[pack.engine];
  const avail = availabilityOf(e, caps, { hermes });
  const envLine = environmentLine(pack, envWorkers);
  const research = isResearchEngine(pack.engine);
  const counts = trialCounts(outcomes, pack.version);
  const issues = pack.status === "trial" ? packPromotionIssues(pack, template, counts) : [];
  const ready = pack.status === "trial" && issues.length === 0;
  const record = ready ? JSON.stringify(curationRecord(pack, outcomes, counts), null, 2) : "";
  return (
    <Card className="min-w-0 p-4" data-testid={`style-pack-${pack.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{pack.name}</p>
        <Badge tone={STATUS_TONE[pack.status]}>{STATUS_LABEL[pack.status]}</Badge>
        <span className="text-xs text-muted">
          v{pack.version} · {FAMILY_LABELS[pack.family] ?? pack.family} · {pack.formats.map((f) => (f === "short" ? "Short" : "Long")).join(", ")}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted">{pack.description}</p>
      {pack.status === "trial" && <p className="mt-1 text-xs font-medium text-warn">{research ? HERMES_RENDER_LABEL : TRIAL_LABEL}</p>}
      {research && pack.hermes && (
        <p className="mt-1 break-words text-xs text-muted" data-testid="pack-hermes-skill">
          Hermes skill {pack.hermes.skill}
          {pack.hermes.aliases.length ? ` (also ${pack.hermes.aliases.join(", ")})` : ""}, {pack.hermes.mode === "project" ? "a full reel with its own voice timing" : "a quick skill from a small spec"}
          {group ? ` · ${group}` : ""}
          {source ? ` · ${creditOf(e)}` : ""}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">
          Renderer: {engine?.label ?? pack.engine}
          {pack.composition ? ` (${pack.composition})` : ""}
          {research ? "" : `, worker ${pack.minWorkerVersion}+`}
        </span>
        {engine && <Badge tone={MUSE_TONE[engine.muse]}>{MUSE_LABEL[engine.muse]}</Badge>}
        <span data-testid="pack-availability">
          {research ? (
            <Badge tone={avail.pack ? "ok" : "warn"}>{avail.pack ? "Rendered by the portal through Hermes" : "Hermes is not set up (HERMES_BASE_URL)"}</Badge>
          ) : avail.pack ? (
            <Badge tone="ok">A worker reports {avail.capability}</Badge>
          ) : avail.renderer ? (
            <Badge tone="warn">A worker has {engine?.capability}, none has the pack yet</Badge>
          ) : (
            <Badge tone="warn">No worker reports {engine?.capability ?? pack.engine} yet</Badge>
          )}
        </span>
        {envLine && (
          <span data-testid="pack-environment">
            <Badge tone={envLine.state === "ready" ? "ok" : envLine.state === "failed" ? "danger" : "warn"}>{envLine.text}</Badge>
          </span>
        )}
      </div>

      {labable && labOption && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="lab-trial-action">
          {labOption.ok ? (
            <LinkButton href={`/studio/new?lab=${pack.id}`} variant="secondary">
              Try it (lab trial)
            </LinkButton>
          ) : (
            <>
              <button type="button" disabled className="min-h-11 cursor-not-allowed rounded-lg border border-border px-3 text-sm text-muted opacity-70" aria-describedby={`lab-why-${pack.id}`}>
                Try it (lab trial)
              </button>
              <span id={`lab-why-${pack.id}`} className="min-w-0 break-words text-muted" data-testid="lab-trial-unavailable">
                {labOption.reason}. {labOption.fix}
              </span>
            </>
          )}
          <span className="text-muted">{LAB_TRIAL_BADGE}: research only, never published, counted apart.</span>
        </div>
      )}
      {variantOffered && variant?.pack && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="research-variant">
          <LinkButton href={`/studio/new?style=${variant.id}`} variant="secondary">
            Try the Hermes research variant
          </LinkButton>
          <span className="text-muted">
            {variant.label} ({variant.pack.hermes?.skill ?? "Hermes"}), {HERMES_RENDER_LABEL}
          </span>
        </div>
      )}

      {pack.status === "trial" && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-border p-3 text-xs" data-testid="trial-record">
          <p className="font-medium">
            Trial runs of v{pack.version}: {counts.trials} · technical pass {Math.round(counts.passRate * 100)}%
            {counts.waived > 0 && <span data-testid="trial-waived">{` (${counts.waived} waived by the owner, not counted as a pass)`}</span>} · mean presentation{" "}
            {Math.round(counts.meanPresentationScore)} ({counts.presentationScored} scored) · owner approved {counts.approved}, rejected {counts.rejected}
          </p>
          <p className="text-muted">Promotion rule: {PROMOTION_RULE_TEXT}</p>
          {ready ? (
            <div className="space-y-2" data-testid="ready-to-promote">
              <p className="font-medium text-ok">Ready to promote: copy this curation record into the pack.</p>
              <p className="text-muted">
                Open a pull request in venturazz/venstudio-styles that appends these entries to packs/{pack.id}/style.json curation, adds your
                owner-review entry and sets status to proven. No GitHub access is needed here.
              </p>
              <pre className="max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px] leading-snug">{record}</pre>
              <CopyButton value={record} label="Copy curation record" />
            </div>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4 text-muted" data-testid="promotion-issues">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lab.runs > 0 && (
        <div className="mt-3 space-y-1 rounded-lg border border-dashed border-warn/60 p-3 text-xs" data-testid="lab-trial-record">
          <p className="font-medium">
            {LAB_TRIAL_BADGE} runs: {lab.runs} · mean presentation {lab.meanPresentationScore === null ? "not scored" : Math.round(lab.meanPresentationScore)} ({lab.scored}{" "}
            scored) · owner approved {lab.approved}, rejected {lab.rejected}
            {lab.waived > 0 && <span data-testid="lab-trial-waived">{` · quality check waived ${lab.waived}`}</span>}
          </p>
          <p className="text-muted">Counted apart: lab trials never count toward this pack&apos;s promotion. Once the pack is at Trial, its trial runs do.</p>
        </div>
      )}

      <details className="mt-3 text-xs">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">Provenance ({pack.provenance.length})</summary>
        <ul className="space-y-1.5">
          {pack.provenance.map((p, i) => (
            <li key={i} className="break-words">
              <Badge>{p.type}</Badge> {p.ref}. <span className="text-muted">Licence: {p.licence}.</span> {p.notes}
            </li>
          ))}
        </ul>
      </details>
      <details className="text-xs">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">Curation history ({pack.curation.length + outcomes.length})</summary>
        <ul className="space-y-1.5">
          {pack.curation.map((c, i) => (
            <li key={`p${i}`} className="break-words">
              {c.date} <Badge>{c.kind}</Badge> <Badge tone={c.result === "pass" || c.result === "approved" ? "ok" : c.result === "note" ? "neutral" : "danger"}>{c.result}</Badge> {c.ref}.{" "}
              <span className="text-muted">{c.notes}</span>
            </li>
          ))}
          {outcomes.map((o) => (
            <li key={o.runId} className="break-words">
              {o.createdAt.slice(0, 10)} <Badge>{o.labTrial ? "lab trial" : "portal trial"}</Badge>{" "}
              {o.qcWaived ? (
                <span data-testid="outcome-qc-waived" title={(o.waivedIssues ?? []).join(" ")}>
                  <Badge tone="warn">QC waived</Badge>
                </span>
              ) : (
                <Badge tone={o.qcPassed ? "ok" : "danger"}>{o.qcPassed ? "QC pass" : "QC fail"}</Badge>
              )}{" "}
              v{o.packVersion}, decision {o.ownerDecision ?? "pending"}
              {o.presentationScore !== null ? `, presentation ${o.presentationScore}` : ""}.{" "}
              <a href={`/studio/runs/${o.runId}`} className="text-accent underline-offset-2 hover:underline">
                Run
              </a>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function PlannedCard({ entry: e }: { entry: RegistryEntry }) {
  const engine = ENGINES[e.engine];
  return (
    <Card className="min-w-0 p-4" data-testid={`planned-style-${e.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{e.label}</p>
        <Badge>{STATUS_LABEL.planned}</Badge>
        <span className="text-xs text-muted">Not selectable for a run</span>
      </div>
      <p className="mt-1 text-sm text-muted">{e.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Would need: {engine?.label ?? e.engine}</span>
        {engine && <Badge tone={MUSE_TONE[engine.muse]}>{MUSE_LABEL[engine.muse]}</Badge>}
      </div>
      {e.style && e.style.cautions.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted">
          {e.style.cautions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
