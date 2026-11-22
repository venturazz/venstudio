import { requireUser } from "@/lib/server/auth.ts";
import { Alert, Badge, Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui.tsx";
import { CopyButton } from "@/components/client.tsx";
import { ENGINES, FAMILY_LABELS, THEMES, VIDEO_FORMATS } from "@/lib/studio/catalog.ts";
import { listTemplates } from "@/lib/server/templates.ts";
import { reportedCapabilities } from "@/lib/server/workers.ts";
import { env } from "@/lib/server/env.ts";
import { listTrialOutcomes, styleRegistry, vendoredStyles } from "@/lib/server/style-packs.ts";
import {
  HERMES_RENDER_LABEL,
  PROMOTION_RULE_TEXT,
  STATUS_LABEL,
  TRIAL_LABEL,
  availabilityOf,
  isResearchEngine,
  curationRecord,
  packPromotionIssues,
  trialCounts,
  type RegistryEntry,
  type RegistryStatus,
  type TrialOutcome,
} from "@/lib/studio/style-registry.ts";
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

export default async function StyleLibraryPage() {
  await requireUser();
  let entries: RegistryEntry[] = [];
  let caps: string[] = [];
  let outcomes: TrialOutcome[] = [];
  let templates: Template[] = [];
  let commit: string | null = null;
  let problems: string[] = [];
  let loadError = "";
  try {
    const vendored = await vendoredStyles();
    commit = vendored.commit;
    problems = vendored.problems;
    entries = await styleRegistry();
    // Stored rows only: no call to a worker or to GitHub while the page renders.
    [caps, outcomes, templates] = await Promise.all([
      reportedCapabilities().catch(() => [] as string[]),
      listTrialOutcomes().catch(() => [] as TrialOutcome[]),
      listTemplates().catch(() => [] as Template[]),
    ]);
  } catch (err) {
    console.error("styles page: could not load", err);
    loadError = "The style registry could not be loaded.";
  }
  const packs = entries.filter((e) => e.pack).sort((a, b) => PACK_ORDER.indexOf(a.status) - PACK_ORDER.indexOf(b.status));
  const planned = entries.filter((e) => !e.pack);

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

      <section className="space-y-3" data-testid="style-packs">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Style packs</h2>
        {packs.length === 0 && <p className="text-sm text-muted">No style pack is vendored.</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          {packs.map((e) => (
            <PackCard key={e.id} entry={e} caps={caps} hermes={Boolean(env().HERMES_BASE_URL)} outcomes={outcomes.filter((o) => o.packId === e.id)} template={templates.find((t) => t.styleId === e.id) ?? null} />
          ))}
        </div>
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
}: {
  entry: RegistryEntry;
  caps: string[];
  hermes: boolean;
  outcomes: TrialOutcome[];
  template: Template | null;
}) {
  const pack = e.pack!;
  const engine = ENGINES[pack.engine];
  const avail = availabilityOf(e, caps, { hermes });
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
      </div>

      {pack.status === "trial" && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-border p-3 text-xs" data-testid="trial-record">
          <p className="font-medium">
            Trial runs of v{pack.version}: {counts.trials} · technical pass {Math.round(counts.passRate * 100)}% · mean presentation{" "}
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
              {o.createdAt.slice(0, 10)} <Badge>portal trial</Badge>{" "}
              <Badge tone={o.qcPassed ? "ok" : "danger"}>{o.qcPassed ? "QC pass" : "QC fail"}</Badge> v{o.packVersion}, decision {o.ownerDecision ?? "pending"}
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
