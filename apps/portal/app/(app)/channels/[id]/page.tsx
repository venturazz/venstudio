import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, timeAgo } from "@/components/ui.tsx";
import { ConfirmButton } from "@/components/client.tsx";
import { JobStatus } from "@/components/status.tsx";
import { ChannelForm } from "../channel-form.tsx";
import { deleteChannel, updateChannel } from "../actions.ts";

export const metadata = { title: "Channel" };

export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sql = db();
  const [[c], workers, jobs] = await Promise.all([
    sql`SELECT * FROM channels WHERE id = ${id}`,
    sql`SELECT id, name FROM workers WHERE status <> 'revoked' ORDER BY name`,
    sql`SELECT id, type, status, created_at FROM jobs WHERE channel_id = ${id} ORDER BY created_at DESC LIMIT 10`,
  ]);
  if (!c) notFound();
  const canEdit = hasRole(user.role, "editor");

  return (
    <>
      <PageHeader title={c.name} description={c.handle ?? undefined} />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Channel settings" />
          <CardBody>
            {canEdit ? (
              <ChannelForm
                action={updateChannel.bind(null, id)}
                workers={workers.map((w) => ({ id: w.id, name: w.name }))}
                submitLabel="Save changes"
                values={{
                  name: c.name,
                  handle: c.handle ?? "",
                  niche: c.niche,
                  category: c.category ?? "",
                  format: c.format,
                  language: c.language,
                  googleAccount: c.google_account,
                  status: c.status,
                  videosPerDay: c.videos_per_day,
                  homeWorkerId: c.home_worker_id ?? "",
                  notes: c.notes,
                  plan: c.plan ?? "",
                }}
              />
            ) : (
              <p className="text-sm text-muted">You have view-only access.</p>
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="YouTube connection" />
            <CardBody className="text-sm text-muted">
              {c.youtube_channel_id ? `Connected: ${c.youtube_channel_id}` : "Not connected yet. YouTube sign-in arrives in the next phase."}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recent jobs" />
            {jobs.length === 0 ? (
              <EmptyState title="No jobs for this channel" />
            ) : (
              <ul className="divide-y divide-border">
                {jobs.map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2">
                      <span className="text-sm">
                        {j.type} <span className="text-xs text-muted">· {timeAgo(j.created_at)}</span>
                      </span>
                      <JobStatus status={j.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {user.role === "owner" && (
            <form action={deleteChannel.bind(null, id)}>
              <ConfirmButton variant="danger" className="w-full" message={`Delete channel "${c.name}"? Jobs are kept.`}>
                Delete channel
              </ConfirmButton>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
