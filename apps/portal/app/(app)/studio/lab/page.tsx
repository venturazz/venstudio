import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { listStudies } from "@/lib/server/lab-studies.ts";
import { styleRegistry } from "@/lib/server/style-packs.ts";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea, timeAgo } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { MAX_LAB_REVISIONS, MAX_NOTE_CHARS, MAX_TITLE_CHARS } from "@/lib/studio/lab-study.ts";
import { StudioNav } from "../studio-nav.tsx";
import { createStudyAction } from "./actions.ts";

export const metadata = { title: "Template Lab" };
export const dynamic = "force-dynamic";

export default async function LabPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser("editor");
  const { error } = await searchParams;
  let studies: Awaited<ReturnType<typeof listStudies>> = [];
  let packs: Array<{ id: string; label: string }> = [];
  let loadError = "";
  try {
    [studies, packs] = await Promise.all([listStudies(), styleRegistry().then((r) => r.filter((e) => e.pack).map((e) => ({ id: e.id, label: e.label })))]);
  } catch (err) {
    console.error("lab page: could not load", err);
    loadError = "The Template Lab could not be loaded. The latest database update (migration 0017) may not be applied yet.";
  }
  return (
    <>
      <PageHeader
        title="Template Lab"
        description="Study uploads, public links, repositories, Hermes skills, articles and your notes toward a new or improved style. Hermes only looks at links; nothing is downloaded."
        actions={<StudioNav current="lab" />}
      />
      {(error || loadError) && (
        <div className="mb-4">
          <Alert tone="danger">{error ?? loadError}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader title="Studies" />
          {studies.length === 0 ? (
            <CardBody>
              <EmptyState icon={<FlaskConical className="size-5" aria-hidden />} title="No study yet" description="Start one with the form. Add sources, let Hermes take notes, then ask for a draft pack." />
            </CardBody>
          ) : (
            <ul className="divide-y divide-border" data-testid="lab-studies">
              {studies.map((s) => (
                <li key={s.id}>
                  <Link href={`/studio/lab/${s.id}`} className="block min-h-12 px-4 py-3 hover:bg-surface-2 sm:px-5" data-testid="lab-study-row">
                    <span className="block break-words text-sm font-medium">{s.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Badge>{s.goal === "improve" ? "Improve a style" : "New style"}</Badge>
                      <span>
                        {s.analyzed} of {s.sources} source{s.sources === 1 ? "" : "s"} analyzed
                      </span>
                      <span>{s.draftName ? `Draft: ${s.draftName} (revision ${s.revision} of ${MAX_LAB_REVISIONS})` : "No draft yet"}</span>
                      {s.trials > 0 && <span>{s.trials} trial{s.trials === 1 ? "" : "s"}</span>}
                      <span>{timeAgo(s.createdAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="h-fit">
          <CardHeader title="Start a lab study" description="A study collects sources and turns them into a draft style pack you can open as a PR in venstudio-styles." />
          <CardBody>
            <form action={createStudyAction} className="space-y-4" data-testid="new-study-form">
              <Field label="Name" htmlFor="study-title">
                <Input id="study-title" name="title" required maxLength={MAX_TITLE_CHARS} placeholder="e.g. Calm count-up graphs" />
              </Field>
              <Field label="Goal" htmlFor="study-goal">
                <Select id="study-goal" name="goal" defaultValue="new">
                  <option value="new">A new style</option>
                  <option value="improve">Improve an existing style</option>
                </Select>
              </Field>
              <Field label="Style to improve (only for Improve)" htmlFor="study-base">
                <Select id="study-base" name="basePack" defaultValue="">
                  <option value="">None</option>
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.id})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Your notes (optional)" htmlFor="study-notes" hint="What you want from the look. Sent to Hermes as material, never as instructions.">
                <Textarea id="study-notes" name="notes" rows={3} maxLength={MAX_NOTE_CHARS} />
              </Field>
              <SubmitButton variant="primary" className="min-h-12 w-full sm:w-auto" pendingLabel="Starting…">
                Start the study
              </SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
