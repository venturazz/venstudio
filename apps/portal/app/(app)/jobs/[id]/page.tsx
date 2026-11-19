import { notFound } from "next/navigation";
import { z } from "zod";
import { Download } from "lucide-react";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { JOB_TYPES, reapExpiredLeases } from "@/lib/server/jobs.ts";
import { explainQueuedJob } from "@/lib/server/queue-reasons.ts";
import { Card, CardBody, CardHeader, PageHeader, cn, timeAgo } from "@/components/ui.tsx";
import { ConfirmButton, SubmitButton } from "@/components/client.tsx";
import { JobStatus } from "@/components/status.tsx";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { cancelJobAction, retryJobAction } from "../actions.ts";
import { promoteArtifactAction } from "../../assets/actions.ts";

export const metadata = { title: "Job" };

const LEVEL: Record<string, string> = { info: "text-muted", warn: "text-warn", error: "text-danger" };

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await reapExpiredLeases();
  const sql = db();
  const [[job], events, artifacts] = await Promise.all([
    sql`
      SELECT j.*, c.name AS channel, w.name AS worker, pw.name AS preferred_worker
      FROM jobs j
      LEFT JOIN channels c ON c.id = j.channel_id
      LEFT JOIN workers w ON w.id = j.worker_id
      LEFT JOIN workers pw ON pw.id = j.preferred_worker_id
      WHERE j.id = ${id}`,
    sql`SELECT id, level, message, created_at FROM job_events WHERE job_id = ${id} ORDER BY id DESC LIMIT 200`,
    sql`SELECT id, name, content_type, bytes, created_at FROM artifacts WHERE job_id = ${id} ORDER BY created_at`,
  ]);
  if (!job) notFound();
  const active = job.status === "queued" || job.status === "running";
  const canEdit = hasRole(user.role, "editor");
  const label = JOB_TYPES[job.type as keyof typeof JOB_TYPES]?.label ?? job.type;
  const waiting = job.status === "queued" ? await explainQueuedJob(id) : [];

  return (
    <>
      <AutoRefresh active={active} seconds={5} />
      <PageHeader
        title={label}
        description={`Job ${String(job.id).slice(0, 8)} · created ${timeAgo(job.created_at)}`}
        actions={
          canEdit && (
            <>
              {active && (
                <form action={cancelJobAction.bind(null, id)}>
                  <ConfirmButton variant="danger" message="Cancel this job?">
                    Cancel
                  </ConfirmButton>
                </form>
              )}
              {(job.status === "failed" || job.status === "cancelled") && (
                <form action={retryJobAction.bind(null, id)}>
                  <SubmitButton variant="primary">Retry</SubmitButton>
                </form>
              )}
            </>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {waiting.length > 0 && (
            <Card>
              <CardHeader title="Why it's waiting" />
              <CardBody>
                <ul className="list-disc space-y-1.5 pl-5 text-sm">
                  {waiting.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardBody className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <JobStatus status={job.status} />
                <span className="text-sm tabular-nums text-muted">{Math.round(job.progress * 100)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={cn("h-full rounded-full transition-all", job.status === "failed" ? "bg-danger" : "bg-accent")}
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
              {job.message && <p className="text-sm text-muted">{job.message}</p>}
              {job.error && <p className="rounded-lg bg-danger/10 p-3 font-mono text-xs text-danger">{job.error}</p>}
            </CardBody>
          </Card>

          {artifacts.length > 0 && (
            <Card>
              <CardHeader title="Outputs" />
              <CardBody className="space-y-4">
                {artifacts.map((a) => (
                  <div key={a.id} className="space-y-2">
                    {String(a.content_type).startsWith("video/") && (
                      <video
                        src={`/api/artifacts/${a.id}`}
                        controls
                        playsInline
                        preload="metadata"
                        className="mx-auto max-h-[70vh] rounded-lg bg-black"
                      />
                    )}
                    {String(a.content_type).startsWith("image/") && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/artifacts/${a.id}`} alt={a.name} className="mx-auto max-h-[70vh] rounded-lg" />
                    )}
                    <a
                      href={`/api/artifacts/${a.id}?download=1`}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2"
                    >
                      <span className="truncate font-mono text-xs">{a.name}</span>
                      <span className="flex items-center gap-2 text-xs text-muted">
                        {(Number(a.bytes) / 1024 / 1024).toFixed(2)} MB <Download className="size-4" aria-hidden />
                      </span>
                    </a>
                    {canEdit && (
                      <form action={promoteArtifactAction.bind(null, a.id)} className="flex justify-end">
                        <SubmitButton className="min-h-8 text-xs">Save to Assets</SubmitButton>
                      </form>
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {job.result && Object.keys(job.result).length > 0 && (
            <Card>
              <CardHeader title="Result" />
              <CardBody>
                <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{JSON.stringify(job.result, null, 2)}</pre>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Activity" />
            <ol className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3 px-4 py-2 text-sm sm:px-5">
                  <span className="w-20 shrink-0 text-xs text-muted tabular-nums">{timeAgo(e.created_at)}</span>
                  <span className={cn("min-w-0 break-words", LEVEL[e.level])}>{e.message}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Details" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              {[
                ["Type", job.type],
                ["Needs", job.capability],
                ["Channel", job.channel ?? "None"],
                ["Home worker", job.preferred_worker ?? "Any"],
                ["Running on", job.worker ?? "—"],
                ["Attempts", `${job.attempts} / ${job.max_attempts}`],
                ["Started", job.started_at ? timeAgo(job.started_at) : "—"],
                ["Finished", job.finished_at ? timeAgo(job.finished_at) : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate text-right font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
