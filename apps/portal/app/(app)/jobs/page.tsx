import Link from "next/link";
import { ListVideo } from "lucide-react";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { JOB_TYPES, reapExpiredLeases } from "@/lib/server/jobs.ts";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, cn, timeAgo } from "@/components/ui.tsx";
import { JobStatus } from "@/components/status.tsx";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { JobForm } from "./job-form.tsx";

export const metadata = { title: "Jobs" };

const FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "succeeded", label: "Done" },
  { id: "failed", label: "Failed" },
] as const;

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await requireUser();
  const { status = "all" } = await searchParams;
  const filter = FILTERS.some((f) => f.id === status) ? status : "all";
  await reapExpiredLeases();
  const sql = db();

  const where =
    filter === "active"
      ? sql`WHERE j.status IN ('queued', 'running')`
      : filter === "succeeded"
        ? sql`WHERE j.status = 'succeeded'`
        : filter === "failed"
          ? sql`WHERE j.status IN ('failed', 'cancelled')`
          : sql``;

  const [jobs, channels] = await Promise.all([
    sql`
      SELECT j.id, j.type, j.status, j.progress, j.message, j.attempts, j.created_at, j.finished_at,
             c.name AS channel, w.name AS worker
      FROM jobs j LEFT JOIN channels c ON c.id = j.channel_id LEFT JOIN workers w ON w.id = j.worker_id
      ${where}
      ORDER BY j.created_at DESC LIMIT 100`,
    sql`SELECT id, name FROM channels ORDER BY name`,
  ]);
  const anyActive = jobs.some((j) => j.status === "queued" || j.status === "running");

  return (
    <>
      <AutoRefresh active={anyActive} />
      <PageHeader title="Jobs" description="Every render and test, newest first." />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-2">
            {FILTERS.map((f) => (
              <Link
                key={f.id}
                href={f.id === "all" ? "/jobs" : `/jobs?status=${f.id}`}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium",
                  filter === f.id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
          {jobs.length === 0 ? (
            <EmptyState icon={<ListVideo className="size-8" />} title="Nothing here" />
          ) : (
            <ul className="divide-y divide-border">
              {jobs.map((j) => (
                <li key={j.id}>
                  <Link href={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{JOB_TYPES[j.type as keyof typeof JOB_TYPES]?.label ?? j.type}</p>
                      <p className="truncate text-xs text-muted">
                        {j.channel ?? "No channel"} · {j.worker ?? "unassigned"} · {timeAgo(j.created_at)}
                        {j.status === "running" ? ` · ${Math.round(j.progress * 100)}%` : ""}
                      </p>
                    </div>
                    <JobStatus status={j.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {hasRole(user.role, "editor") && (
          <Card className="h-fit">
            <CardHeader title="New job" description="Production pipelines arrive in the next phase. These test the fleet." />
            <CardBody>
              <JobForm
                types={Object.entries(JOB_TYPES)
                  .filter(([id]) => id === "echo" || id === "smoke-test") // the others are started from Assets and Studio
                  .map(([id, t]) => ({ id, label: t.label, description: t.description }))}
                channels={channels.map((c) => ({ id: c.id, name: c.name }))}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
