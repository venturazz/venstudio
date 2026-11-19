import { requireUser } from "@/lib/server/auth.ts";
import { ensureSeedTemplates, listTemplates } from "@/lib/server/templates.ts";
import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui.tsx";
import { FAMILY_LABELS } from "@/lib/studio/catalog.ts";
import { isAutonomyEligible, seedTemplates, type Template, type TemplateStatus } from "@/lib/studio/templates.ts";

export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

const STATUS_ORDER: TemplateStatus[] = ["proven", "candidate", "draft", "retired"];
const STATUS_HEADING: Record<TemplateStatus, string> = {
  proven: "Ready for autopilot",
  candidate: "Waiting for proof",
  draft: "Learned drafts",
  retired: "Retired",
};
const STATUS_BADGE: Record<TemplateStatus, { tone: "ok" | "warn" | "neutral"; text: string }> = {
  proven: { tone: "ok", text: "Proven" },
  candidate: { tone: "warn", text: "Candidate: not yet proven" },
  draft: { tone: "neutral", text: "Draft: still being learned" },
  retired: { tone: "neutral", text: "Retired" },
};

/** Reads the templates; if the database is not ready the seed list is shown so the page never crashes. */
async function loadTemplates(): Promise<{ templates: Template[]; stored: boolean }> {
  try {
    await ensureSeedTemplates();
    return { templates: await listTemplates(), stored: true };
  } catch (err) {
    console.error("templates page: could not load templates", err);
    return { templates: seedTemplates(), stored: false };
  }
}

export default async function TemplatesPage() {
  await requireUser();
  const { templates, stored } = await loadTemplates();
  return (
    <>
      <PageHeader
        title="Templates"
        description="Every style becomes a final template. A template starts as a candidate and is proven by test runs and your copyright sign-off."
        actions={
          <LinkButton href="/studio/styles" variant="secondary">
            Style library
          </LinkButton>
        }
      />
      <div className="mb-6 space-y-3">
        <Alert tone="info">Only proven templates with a fully signed checklist can run without you. Candidates always wait for your approval.</Alert>
        {!stored && <Alert tone="warn">The template store is not ready yet. This is the built-in list; nothing is saved.</Alert>}
      </div>
      <div className="space-y-8">
        {STATUS_ORDER.map((status) => {
          const items = templates.filter((t) => t.status === status);
          if (items.length === 0) return null;
          return (
            <section key={status} className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
                {STATUS_HEADING[status]} ({items.length})
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {items.map((t) => (
                  <TemplateCard key={`${t.id}-${t.version}`} template={t} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function TemplateCard({ template: t }: { template: Template }) {
  const badge = STATUS_BADGE[t.status];
  const signed = t.copyrightChecklist.filter((i) => i.signedOff !== null).length;
  const e = t.evidence;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 break-words font-medium">{t.label}</p>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted">
        {FAMILY_LABELS[t.family]} · {t.formats.map((f) => (f === "short" ? "Short" : "Long")).join(" and ")} · version {t.version}
        {t.derivedFrom ? ` · learned from ${t.derivedFrom.sampleCount} sample${t.derivedFrom.sampleCount === 1 ? "" : "s"}` : ""}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Copyright checklist</dt>
        <dd>
          {signed} of {t.copyrightChecklist.length} signed
        </dd>
        <dt className="text-muted">Test runs</dt>
        <dd>{e.trials}</dd>
        <dt className="text-muted">Quality score</dt>
        <dd>{e.trials > 0 ? Math.round(e.meanPresentationScore) : "none yet"}</dd>
        <dt className="text-muted">Copyright claims</dt>
        <dd>{e.claims}</dd>
        <dt className="text-muted">Runs without you</dt>
        <dd>{isAutonomyEligible(t) ? "Allowed" : "Not allowed"}</dd>
      </dl>
      {t.demotionReason && <p className="mt-2 text-xs text-warn">Moved back to candidate: {t.demotionReason}</p>}
    </Card>
  );
}
