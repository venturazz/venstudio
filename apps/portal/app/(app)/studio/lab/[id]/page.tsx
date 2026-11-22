import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { getStudy, LOOKING, refreshPendingUploads, studySources, studyTrials, studyTrialState, videoAssetsForLab, type LabSource } from "@/lib/server/lab-studies.ts";
import { Alert, Badge, Card, CardBody, CardHeader, Field, Input, LinkButton, PageHeader, Select, Textarea, timeAgo } from "@/components/ui.tsx";
import { AutoRefresh, SubmitButton } from "@/components/client.tsx";
import { EXPORT_STEPS, isYouTubeUrl, LAB_SOURCE_LABEL, MAX_LAB_REVISIONS, MAX_NOTE_CHARS, MAX_URL_CHARS, NOTE_FIELDS, NOTE_LABEL } from "@/lib/studio/lab-study.ts";
import { StudioNav } from "../../studio-nav.tsx";
import { addSourceAction, retryPendingAction, retrySourceAction, synthesizeAction } from "../actions.ts";

export const metadata = { title: "Lab study" };
export const dynamic = "force-dynamic";

const STATUS_TONE = { pending: "warn", analyzed: "ok", failed: "danger" } as const;
const STATUS_LABEL = { pending: "Pending", analyzed: "Analyzed", failed: "Failed" } as const;

function SourceFindingsView({ s }: { s: LabSource }) {
  const f = s.findings;
  if (!f) return null;
  if (f.kind === "measured" && f.fingerprint) {
    const fp = f.fingerprint;
    return (
      <p className="text-xs" data-testid="source-measured">
        Measured: shots {fp.shotSeconds.p10}-{fp.shotSeconds.p90} s (median {fp.shotSeconds.p50} s), first cut at {fp.firstCutSeconds} s, {fp.cutsPerMinute} cuts a minute
        {fp.loudnessLufs !== null ? `, ${fp.loudnessLufs} LUFS` : ", no audio"}. Numbers only.
      </p>
    );
  }
  if (f.kind === "hermes-notes" && f.notes) {
    const n = f.notes;
    return (
      <div className="space-y-1 text-xs" data-testid="source-notes">
        <p className="break-words">{n.summary}</p>
        <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1fr)]">
          {NOTE_FIELDS.filter((k) => n.notes[k]).map((k) => (
            <div key={k} className="contents">
              <dt className="text-muted">{NOTE_LABEL[k]}</dt>
              <dd className="break-words">{n.notes[k]}</dd>
            </div>
          ))}
        </dl>
        {n.techniques.length > 0 && <p className="break-words text-muted">Techniques: {n.techniques.join("; ")}</p>}
      </div>
    );
  }
  return null;
}

export default async function StudyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireUser("editor");
  const { id } = await params;
  const { error, ok } = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  // Database only: an upload's state comes from its analyze-video job; nothing calls a worker or Hermes here.
  await refreshPendingUploads(id).catch((err) => console.error("lab: could not refresh uploads", err));
  const study = await getStudy(id);
  if (!study) notFound();
  const [sources, trials, trial, videos] = await Promise.all([studySources(id), studyTrials(id), studyTrialState(study), videoAssetsForLab()]);
  // Refresh by itself only while something is moving: an upload's analysis, a source Hermes is reading, a draft.
  const waiting = sources.some((s) => s.status === "pending" && (s.type === "upload" || s.reason === LOOKING)) || study.draftState === "working";
  const analyzed = sources.filter((s) => s.status === "analyzed").length;
  const draft = study.draft;
  const add = addSourceAction.bind(null, study.id);
  const formCls = "space-y-3 rounded-lg border border-border p-3";

  return (
    <>
      {waiting && <AutoRefresh everyMs={4000} />}
      <PageHeader title={study.title} description={study.goal === "improve" ? `Improve ${study.basePack ?? "a style"}` : "Toward a new style"} actions={<StudioNav current="lab" />} />
      <div className="mb-4 space-y-2">
        <p className="text-sm">
          <Link href="/studio/lab" className="text-accent underline-offset-2 hover:underline">
            All studies
          </Link>
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {ok && <Alert tone="ok">{ok}</Alert>}
        {study.notes && <p className="break-words text-sm text-muted">Your notes: {study.notes}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <Card data-testid="lab-sources">
            <CardHeader title="Sources" description={`${analyzed} of ${sources.length} analyzed. Links are stored as links: Hermes looks at them with its own tools and only its notes are kept.`} />
            {sources.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No source yet. Add one with the forms.</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {sources.map((s) => (
                  <li key={s.id} className="space-y-1.5 px-4 py-3 sm:px-5" data-testid="lab-source" data-type={s.type} data-status={s.status}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge>{LAB_SOURCE_LABEL[s.type]}</Badge>
                      {s.type === "link" && isYouTubeUrl(s.ref) && <Badge tone="info">YouTube: watched, never downloaded</Badge>}
                      <Badge tone={STATUS_TONE[s.status]}>
                        <span data-testid="source-status">{STATUS_LABEL[s.status]}</span>
                      </Badge>
                    </div>
                    <p className="break-all text-sm" data-testid="source-ref">
                      {s.type === "upload" ? `${s.assetTitle ?? "Upload"} (asset ${s.ref.slice(0, 8)})` : s.type === "owner-note" ? s.ref : s.ref}
                      {s.refPath ? ` · path ${s.refPath}` : ""}
                    </p>
                    <p className="break-words text-xs text-muted">
                      Licence: <span data-testid="source-licence">{s.licence}</span> · added {timeAgo(s.createdAt)}
                    </p>
                    {s.reason && <p className="break-words text-xs text-muted" data-testid="source-reason">{s.reason}</p>}
                    <SourceFindingsView s={s} />
                    {s.status === "failed" && s.type !== "owner-note" && (
                      <form action={retrySourceAction.bind(null, study.id, s.id)}>
                        <SubmitButton className="min-h-11 text-xs">Ask again</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {sources.some((s) => s.status === "pending" && s.type !== "upload") && (
              <CardBody>
                <form action={retryPendingAction.bind(null, study.id)}>
                  <SubmitButton className="min-h-11">Ask Hermes about the waiting sources</SubmitButton>
                </form>
              </CardBody>
            )}
          </Card>

          <Card data-testid="lab-draft">
            <CardHeader title="Draft pack" description={`Hermes combines the analyzed sources into a draft pack spec. Numbers measured from uploads override its estimates. Revision ${study.revision} of ${MAX_LAB_REVISIONS}.`} />
            <CardBody className="space-y-4">
              {study.draftState === "working" && (
                <Alert tone="info">
                  <span data-testid="draft-working">Hermes is drafting. This page refreshes by itself.</span>
                </Alert>
              )}
              {study.draftState === "failed" && study.draftError && <Alert tone="danger">{study.draftError}</Alert>}
              {!draft ? (
                <form action={synthesizeAction.bind(null, study.id)}>
                  <SubmitButton variant="primary" className="min-h-12 w-full sm:w-auto" disabled={analyzed === 0 || study.draftState === "working"} pendingLabel="Asking Hermes…">
                    Synthesize a draft pack
                  </SubmitButton>
                  {analyzed === 0 && <p className="mt-2 text-xs text-muted">Add a source and wait until it is analyzed.</p>}
                </form>
              ) : (
                <>
                  <div className="space-y-2 text-sm" data-testid="draft-summary">
                    <p className="font-medium">
                      <span data-testid="draft-name">{draft.name}</span> <span className="text-xs text-muted">({draft.packId}, draft)</span>
                    </p>
                    <p className="break-words">{draft.description}</p>
                    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                      <dt className="text-muted">Renderer</dt>
                      <dd className="break-words">
                        {draft.renderer}: <span data-testid="renderer-verdict">{trial.verdict?.text}</span>
                      </dd>
                      <dt className="text-muted">Pacing</dt>
                      <dd>
                        shots {draft.contract.pacing.shotSeconds[0]}-{draft.contract.pacing.shotSeconds[1]} s, first cut within {draft.contract.pacing.hookWithinMs} ms, {draft.contract.pacing.cutsPerMinute[0]}-{draft.contract.pacing.cutsPerMinute[1]} cuts a minute
                      </dd>
                      <dt className="text-muted">On screen</dt>
                      <dd className="break-words">
                        {draft.contract.onScreen.elements.join(", ")}; motion {draft.contract.onScreen.motionTokens.join(", ") || "none"}
                      </dd>
                      <dt className="text-muted">Audio</dt>
                      <dd>
                        {draft.contract.audio.narrated ? "narrated" : "not narrated"}, {draft.contract.audio.targetLufs} LUFS, music {draft.contract.audio.musicPolicy}
                      </dd>
                      <dt className="text-muted">From uploads</dt>
                      <dd className="break-words" data-testid="draft-measured">
                        {draft.measured.length ? draft.measured.join(", ") : "nothing measured; the numbers are Hermes's estimates"}
                      </dd>
                      <dt className="text-muted">Closest pack</dt>
                      <dd className="break-words" data-testid="draft-closest">
                        {draft.closestPack ?? "none"}
                        {draft.closestReason ? `: ${draft.closestReason}` : ""}
                      </dd>
                    </dl>
                    <p className="break-words text-xs">Why: {draft.rationale}</p>
                  </div>

                  <div className="space-y-2" data-testid="draft-export">
                    <a
                      href={`/studio/lab/${study.id}/draft`}
                      download={`${draft.packId}.draft.json`}
                      className="inline-flex min-h-12 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:opacity-90"
                    >
                      Download draft pack
                    </a>
                    <p className="text-xs text-muted">One JSON file with style.json, README.md and fixtures/expect.json for packs/{draft.packId}/, every source&apos;s provenance and licence. The portal has no GitHub token and needs none. To open it as a PR in venstudio-styles:</p>
                    <ol className="list-decimal space-y-1 pl-5 text-xs" data-testid="export-steps">
                      {EXPORT_STEPS(draft.packId).map((s) => (
                        <li key={s} className="break-words">
                          <code className="whitespace-pre-wrap break-all">{s}</code>
                        </li>
                      ))}
                    </ol>
                  </div>

                  <form action={synthesizeAction.bind(null, study.id)} className="space-y-2" data-testid="revise-form">
                    <Field label={`Ask for a revision (${study.revision} of ${MAX_LAB_REVISIONS} used)`} htmlFor="revise-note" hint="Your note goes to Hermes as material with the current draft.">
                      <Textarea id="revise-note" name="note" rows={3} maxLength={MAX_NOTE_CHARS} required disabled={study.revision >= MAX_LAB_REVISIONS} />
                    </Field>
                    <SubmitButton className="min-h-11" disabled={study.revision >= MAX_LAB_REVISIONS || study.draftState === "working"} pendingLabel="Asking Hermes…">
                      Revise the draft
                    </SubmitButton>
                    {study.revision >= MAX_LAB_REVISIONS && <p className="text-xs text-muted">The lab stops after {MAX_LAB_REVISIONS} revisions; edit the exported draft in the styles repository.</p>}
                  </form>
                  {study.revisions.length > 0 && (
                    <ul className="space-y-1 text-xs text-muted" data-testid="revisions">
                      {study.revisions.map((r) => (
                        <li key={r.revision} className="break-words">
                          Revision {r.revision}: {r.note}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </CardBody>
          </Card>

          <Card data-testid="lab-trials">
            <CardHeader title="Trials" description="Trial videos started from this study. They are never published; QC and your presentation score show here." />
            <CardBody className="space-y-3">
              {trial.option.ok ? (
                <LinkButton href={`/studio/new?study=${study.id}`} variant="primary" className="min-h-12">
                  Start a trial video with the closest pack
                </LinkButton>
              ) : (
                <p className="break-words text-sm text-muted" data-testid="trial-unavailable">
                  No trial yet: {trial.option.reason}.
                </p>
              )}
              {trials.length === 0 ? (
                <p className="text-xs text-muted">No trial video yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {trials.map((t) => (
                    <li key={t.runId} className="space-y-1 px-3 py-2 text-sm" data-testid="lab-trial">
                      <Link href={`/studio/runs/${t.runId}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        Trial run with {t.packId} {t.packVersion}
                      </Link>
                      <p className="text-xs text-muted">
                        <span data-testid="trial-state">{t.state}</span> · {timeAgo(t.createdAt)}
                      </p>
                      <p className="text-xs" data-testid="trial-outcome">
                        QC: {t.qcPassed === null ? "not run yet" : t.qcPassed ? "passed G-technical" : "failed G-technical"} · presentation{" "}
                        {t.presentationScore === null ? "not scored" : `${t.presentationScore}/100`} · decision {t.ownerDecision ?? "none yet"}
                        {t.renderer ? ` · rendered with ${t.renderer}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit" data-testid="add-sources">
          <CardHeader title="Add a source" description="Every source records its licence. Links and articles say unknown unless you know it." />
          <CardBody className="space-y-4">
            <form action={add} className={formCls} data-testid="add-upload">
              <input type="hidden" name="type" value="upload" />
              <Field label="Upload (with rights)" htmlFor="src-upload" hint="A video from Assets with its licence. The worker measures cuts and loudness; numbers only.">
                <Select id="src-upload" name="ref" defaultValue="" required>
                  <option value="" disabled>
                    {videos.length ? "Choose a video" : "No video in Assets yet"}
                  </option>
                  {videos.map((v) => (
                    <option key={v.id} value={v.id} disabled={!v.licence}>
                      {v.title}
                      {v.licence ? "" : " (no licence recorded)"}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton className="min-h-11">Add the upload</SubmitButton>
            </form>
            <form action={add} className={formCls} data-testid="add-link">
              <input type="hidden" name="type" value="link" />
              <Field label="Public link (YouTube included)" htmlFor="src-link" hint="Stored as a link. Hermes watches it with its own tools; nothing is downloaded.">
                <Input id="src-link" name="ref" type="url" required maxLength={MAX_URL_CHARS} placeholder="https://www.youtube.com/watch?v=..." />
              </Field>
              <SubmitButton className="min-h-11">Add the link</SubmitButton>
            </form>
            <form action={add} className={formCls} data-testid="add-repo">
              <input type="hidden" name="type" value="repo" />
              <Field label="Public repository" htmlFor="src-repo" hint="Hermes reads it and reports its techniques and licence.">
                <Input id="src-repo" name="ref" type="url" required maxLength={MAX_URL_CHARS} placeholder="https://github.com/owner/repo" />
              </Field>
              <Field label="Path inside it (optional)" htmlFor="src-repo-path">
                <Input id="src-repo-path" name="path" maxLength={200} placeholder="skills/graph" />
              </Field>
              <SubmitButton className="min-h-11">Add the repository</SubmitButton>
            </form>
            <form action={add} className={formCls} data-testid="add-skill">
              <input type="hidden" name="type" value="skill" />
              <Field label="Hermes skill" htmlFor="src-skill" hint="Hermes reads the skill's instructions without running it.">
                <Input id="src-skill" name="ref" required maxLength={80} placeholder="minimalistic-graphics" />
              </Field>
              <SubmitButton className="min-h-11">Add the skill</SubmitButton>
            </form>
            <form action={add} className={formCls} data-testid="add-article">
              <input type="hidden" name="type" value="article" />
              <Field label="Article" htmlFor="src-article">
                <Input id="src-article" name="ref" type="url" required maxLength={MAX_URL_CHARS} placeholder="https://..." />
              </Field>
              <Field label="Licence, if you know it" htmlFor="src-article-licence">
                <Input id="src-article-licence" name="licence" maxLength={200} placeholder="unknown" />
              </Field>
              <SubmitButton className="min-h-11">Add the article</SubmitButton>
            </form>
            <form action={add} className={formCls} data-testid="add-note">
              <input type="hidden" name="type" value="owner-note" />
              <Field label="Your note" htmlFor="src-note">
                <Textarea id="src-note" name="ref" rows={3} required maxLength={MAX_NOTE_CHARS} />
              </Field>
              <SubmitButton className="min-h-11">Add the note</SubmitButton>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
