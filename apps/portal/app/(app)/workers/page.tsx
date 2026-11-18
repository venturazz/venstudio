import { Cpu } from "lucide-react";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { reapExpiredLeases } from "@/lib/server/jobs.ts";
import { presence } from "@/lib/server/workers.ts";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, timeAgo } from "@/components/ui.tsx";
import { ConfirmButton, SubmitButton } from "@/components/client.tsx";
import { WorkerPresence } from "@/components/status.tsx";
import { EnrollForm } from "./enroll-form.tsx";
import { deleteWorker, revokeWorker, setWorkerStatus } from "./actions.ts";

export const metadata = { title: "Workers" };

const HOST_LABEL: Record<string, string> = { muse: "Muse VM", vps: "VPS", local: "Local PC" };

export default async function WorkersPage() {
  const user = await requireUser();
  await reapExpiredLeases();
  const sql = db();
  const [workers, channels] = await Promise.all([
    sql`
      SELECT w.*,
        (SELECT count(*)::int FROM jobs j WHERE j.worker_id = w.id AND j.status = 'running') AS running,
        (SELECT count(*)::int FROM jobs j WHERE j.worker_id = w.id AND j.status = 'succeeded'
           AND j.finished_at > now() - interval '24 hours') AS done24,
        (SELECT string_agg(c.name, ', ') FROM channels c WHERE c.home_worker_id = w.id) AS channels
      FROM workers w
      ORDER BY (w.status = 'revoked'), w.name`,
    sql`SELECT id, name FROM channels ORDER BY name`,
  ]);
  const isOwner = user.role === "owner";

  return (
    <>
      <PageHeader
        title="Workers"
        description="Machines that render. Muse VMs wake hourly, so “Sleeping” is normal for them."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {workers.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Cpu className="size-8" />}
                title="No workers enrolled"
                description="Create an enrollment code, then send the setup message to a Muse account."
              />
            </Card>
          ) : (
            workers.map((w) => {
              const p = presence(w.last_seen_at, w.running);
              return (
                <Card key={w.id} className={w.status === "revoked" ? "opacity-60" : undefined}>
                  <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{w.name}</p>
                        <WorkerPresence presence={p} status={w.status} />
                      </div>
                      <p className="text-xs text-muted">
                        {HOST_LABEL[w.host] ?? w.host}
                        {w.mode ? ` · ${w.mode} mode` : ""}
                        {w.version ? ` · v${w.version}` : ""} · seen {timeAgo(w.last_seen_at)}
                      </p>
                      <p className="text-xs text-muted">
                        Home channel: {w.channels ?? "none"} · {w.done24} done in 24 h
                      </p>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {(w.capabilities as string[]).length === 0 ? (
                          <span className="text-xs text-muted">No capabilities reported yet</span>
                        ) : (
                          (w.capabilities as string[]).map((c) => (
                            <Badge key={c} tone="accent">
                              {c}
                            </Badge>
                          ))
                        )}
                      </div>
                    </div>
                    {isOwner && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {w.status === "active" && (
                          <form action={setWorkerStatus.bind(null, w.id, "draining")}>
                            <SubmitButton>Drain</SubmitButton>
                          </form>
                        )}
                        {w.status === "draining" && (
                          <form action={setWorkerStatus.bind(null, w.id, "active")}>
                            <SubmitButton>Resume</SubmitButton>
                          </form>
                        )}
                        {w.status !== "revoked" ? (
                          <form action={revokeWorker.bind(null, w.id)}>
                            <ConfirmButton
                              variant="danger"
                              message={`Revoke ${w.name}? Its token stops working now and its running job goes back to the queue.`}
                            >
                              Revoke
                            </ConfirmButton>
                          </form>
                        ) : (
                          <form action={deleteWorker.bind(null, w.id)}>
                            <ConfirmButton variant="ghost" message={`Remove ${w.name} from the list?`}>
                              Remove
                            </ConfirmButton>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>

        {isOwner && (
          <Card className="h-fit">
            <CardHeader title="Add a worker" description="Creates a one-time code valid for 30 minutes." />
            <CardBody>
              <EnrollForm channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
