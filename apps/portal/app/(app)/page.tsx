import Link from "next/link";
import { ArrowRight, Cpu, ListVideo, Tv } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { JOB_TYPES, reapExpiredLeases } from "@/lib/server/jobs.ts";
import { presence } from "@/lib/server/workers.ts";
import { gatewayStatus } from "@/lib/server/ai-gateway.ts";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, Stat, timeAgo } from "@/components/ui.tsx";
import { JobStatus, WorkerPresence } from "@/components/status.tsx";

export const metadata = { title: "Overview" };

export default async function Overview({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const { denied } = await searchParams;
  await reapExpiredLeases();
  const sql = db();

  const [[channels], [jobs], workers, recent, gateway] = await Promise.all([
    sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM channels`,
    sql`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'succeeded' AND finished_at > now() - interval '24 hours')::int AS done24,
        count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed24
      FROM jobs`,
    sql`
      SELECT w.id, w.name, w.status, w.host, w.last_seen_at,
        (SELECT count(*)::int FROM jobs j WHERE j.worker_id = w.id AND j.status = 'running') AS running,
        (SELECT c.name FROM channels c WHERE c.home_worker_id = w.id LIMIT 1) AS channel
      FROM workers w WHERE w.status <> 'revoked' ORDER BY w.name`,
    sql`
      SELECT j.id, j.type, j.status, j.progress, j.created_at, c.name AS channel, w.name AS worker
      FROM jobs j LEFT JOIN channels c ON c.id = j.channel_id LEFT JOIN workers w ON w.id = j.worker_id
      ORDER BY j.created_at DESC LIMIT 8`,
    gatewayStatus(),
  ]);

  const presences = workers.map((w) => presence(w.last_seen_at, w.running));
  const healthy = presences.filter((p) => p !== "offline" && p !== "never").length;

  return (
    <>
      <PageHeader title={`Hi, ${user.name.split(" ")[0]}`} description="Everything the studio is doing right now." />
      {denied && (
        <div className="mb-4">
          <Alert tone="warn">Your role doesn&apos;t allow that action.</Alert>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Channels" value={`${channels.active}/${channels.total}`} hint="active / total" />
        <Stat
          label="Workers"
          value={`${healthy}/${workers.length}`}
          hint="reachable / enrolled"
          tone={workers.length > 0 && healthy < workers.length ? "warn" : undefined}
        />
        <Stat label="In queue" value={jobs.queued + jobs.running} hint={`${jobs.running} running`} />
        <Stat
          label="Last 24 h"
          value={jobs.done24}
          hint={`${jobs.failed24} failed`}
          tone={jobs.failed24 > 0 ? "danger" : undefined}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader
            title="Recent jobs"
            actions={
              <Link href="/jobs" className="flex items-center gap-1 text-xs font-medium text-accent">
                All jobs <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              icon={<ListVideo className="size-8" />}
              title="No jobs yet"
              description="Enroll a worker, then run a smoke test to check rendering end to end."
              action={<LinkButton href="/jobs" variant="primary">Create a job</LinkButton>}
            />
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{JOB_TYPES[j.type as keyof typeof JOB_TYPES]?.label ?? j.type}</p>
                      <p className="truncate text-xs text-muted">
                        {j.channel ?? "No channel"} · {j.worker ?? "unassigned"} · {timeAgo(j.created_at)}
                      </p>
                    </div>
                    <JobStatus status={j.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Worker fleet"
              actions={
                <Link href="/workers" className="flex items-center gap-1 text-xs font-medium text-accent">
                  Manage <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              }
            />
            {workers.length === 0 ? (
              <EmptyState icon={<Cpu className="size-8" />} title="No workers" description="Enroll your first Muse account." />
            ) : (
              <ul className="divide-y divide-border">
                {workers.map((w, i) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{w.name}</p>
                      <p className="truncate text-xs text-muted">
                        {w.channel ?? "No home channel"} · {timeAgo(w.last_seen_at)}
                      </p>
                    </div>
                    <WorkerPresence presence={presences[i]} status={w.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="AI gateway (9router)" />
            <CardBody className="space-y-2 text-sm">
              {!gateway.configured ? (
                <p className="text-muted">
                  Not configured. Set <code className="font-mono text-xs">NINEROUTER_BASE_URL</code> and{" "}
                  <code className="font-mono text-xs">NINEROUTER_API_KEY</code>.
                </p>
              ) : gateway.ok ? (
                <>
                  <Badge tone="ok" dot>Connected · {gateway.latencyMs} ms</Badge>
                  <p className="text-muted">{gateway.models.length} models available</p>
                </>
              ) : (
                <>
                  <Badge tone="danger" dot>Unreachable</Badge>
                  <p className="text-muted">{gateway.error}</p>
                </>
              )}
            </CardBody>
          </Card>

          {channels.total === 0 && (
            <Card>
              <EmptyState
                icon={<Tv className="size-8" />}
                title="Add your channels"
                description="Create the 10 channels first, then link each to a Muse worker."
                action={<LinkButton href="/channels/new" variant="primary">Add channel</LinkButton>}
              />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
