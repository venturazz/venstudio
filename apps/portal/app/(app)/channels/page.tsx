import Link from "next/link";
import { Plus, Tv } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { formatLabel } from "@/lib/formats.ts";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui.tsx";
import { ChannelStatus } from "@/components/status.tsx";

export const metadata = { title: "Channels" };

export default async function ChannelsPage() {
  await requireUser();
  const channels = await db()`
    SELECT c.id, c.name, c.handle, c.niche, c.format, c.status, c.videos_per_day, c.google_account,
           w.name AS worker,
           (SELECT count(*)::int FROM jobs j WHERE j.channel_id = c.id AND j.status IN ('queued', 'running')) AS active_jobs
    FROM channels c LEFT JOIN workers w ON w.id = c.home_worker_id
    ORDER BY c.created_at
  `;

  return (
    <>
      <PageHeader
        title="Channels"
        description="Each channel has its own niche, format and home worker."
        actions={
          <LinkButton href="/channels/new" variant="primary">
            <Plus className="size-4" aria-hidden /> Add channel
          </LinkButton>
        }
      />
      {channels.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tv className="size-8" />}
            title="No channels yet"
            description="Plan: 5 Google accounts with 2 channels each. Add them here as you create them."
            action={<LinkButton href="/channels/new" variant="primary">Add channel</LinkButton>}
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {channels.map((c) => (
            <Link key={c.id} href={`/channels/${c.id}`} className="group">
              <Card className="h-full p-4 transition group-hover:border-accent/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted">{c.handle ?? "No handle yet"}</p>
                  </div>
                  <ChannelStatus status={c.status} />
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-muted">{c.niche || "No niche set"}</p>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Format</dt>
                    <dd className="truncate font-medium">{formatLabel(c.format)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Home worker</dt>
                    <dd className="truncate font-medium">{c.worker ?? "Any"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Per day</dt>
                    <dd className="font-medium">{c.videos_per_day} videos</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Active jobs</dt>
                    <dd className="font-medium">{c.active_jobs}</dd>
                  </div>
                </dl>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
