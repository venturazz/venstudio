import { Cpu } from "lucide-react";
import { WORKER_VERSION } from "@venstudio/protocol";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { reapExpiredLeases } from "@/lib/server/jobs.ts";
import { installFileSha256, portalUrl } from "@/lib/server/install-files.ts";
import { publicSigningKey } from "@/lib/server/update-key.ts";
import { servedRelease, updateSettings, type UpdateSettings } from "@/lib/server/updates.ts";
import { needsAttention, presence, RUN_NOW_MESSAGE } from "@/lib/server/workers.ts";
import { compareVersions, describeUpdateResult, UPDATE_MODE_LABEL, UPDATE_MODES, type ServedRelease } from "@/lib/update-manifest.ts";
import { manualUpdateMessage } from "@/lib/worker-update-message.ts";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, timeAgo } from "@/components/ui.tsx";
import { ConfirmButton, CopyButton, SubmitButton } from "@/components/client.tsx";
import { WorkerPresence } from "@/components/status.tsx";
import { EnrollForm } from "./enroll-form.tsx";
import {
  approveAllWorkerUpdates,
  approveWorkerUpdate,
  deleteWorker,
  revokeWorker,
  setPinnedVersion,
  setUpdateMode,
  setWorkerStatus,
} from "./actions.ts";

export const metadata = { title: "Workers" };

const MODE_HINT: Record<string, string> = {
  hold: "hold mode (online ~55 of every 60 min)",
  tick: "tick mode",
  daemon: "always on",
};

const HOST_LABEL: Record<string, string> = { muse: "Muse VM", vps: "VPS", local: "Local PC" };

const MODE_HELP: Record<string, string> = {
  auto: "Workers install each new release by themselves, between jobs.",
  approve: "Workers show “Update available”; nothing installs until you approve it.",
  off: "Nothing installs by itself. Use the manual update on each worker.",
};

/** The first worker version that updates itself. */
const SELF_UPDATING = "0.8.0";

/** Update facts for the page. Read from files and Postgres only; never calls a worker or another service. */
async function updateFacts(): Promise<{ served: ServedRelease | null; settings: UpdateSettings; keyId: string | null; installSha: string; problem: string | null }> {
  const settings = await updateSettings();
  try {
    const [served, key, installSha] = await Promise.all([servedRelease(), publicSigningKey(), installFileSha256("install.sh")]);
    return { served, settings, keyId: key.keyId, installSha: installSha ?? "", problem: null };
  } catch (err) {
    return { served: null, settings, keyId: null, installSha: "", problem: err instanceof Error ? err.message : String(err) };
  }
}

function ManualUpdate({ message, sha }: { message: string; sha: string }) {
  return (
    <details className="rounded-lg border border-border px-3 text-xs">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-fg">Manual update (fallback)</summary>
      <div className="space-y-2 pb-3">
        <p className="text-muted">
          For a Muse VM, send this to that Muse account as your own message (app or WhatsApp). It is the same check as Add a worker:
          install.sh is compared with the sha256 below before it runs.
        </p>
        <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 font-mono [overflow-wrap:anywhere]">{message}</div>
        <CopyButton value={message} label="Copy message" />
        <p className="break-all text-muted">
          install.sh sha256: <code className="font-mono">{sha}</code>
        </p>
      </div>
    </details>
  );
}

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
        (SELECT string_agg(c.name, ', ') FROM channels c WHERE c.home_worker_id = w.id) AS channels,
        (SELECT count(*)::int FROM jobs j WHERE j.preferred_worker_id = w.id AND j.status = 'queued'
           AND j.created_at < now() - interval '10 minutes') AS waiting
      FROM workers w
      ORDER BY (w.status = 'revoked'), w.name`,
    sql`SELECT id, name FROM channels ORDER BY name`,
  ]);
  const isOwner = user.role === "owner";
  const APP_URL = portalUrl();
  const facts = await updateFacts();
  const latest = facts.served?.version ?? WORKER_VERSION;
  const mode = facts.settings.mode;
  const awaiting = workers.filter((w) => w.status !== "revoked" && w.update_offered_release && w.update_approved_release !== w.update_offered_release);

  return (
    <>
      <PageHeader
        title="Workers"
        description="Machines that render. Muse workers stay online about 55 minutes of every hour; a short “Sleeping” gap is normal."
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
                        {w.mode ? ` · ${MODE_HINT[w.mode] ?? w.mode}` : ""}
                        {w.version ? ` · v${w.version}` : ""} · seen {timeAgo(w.last_seen_at)}
                      </p>
                      <p className="text-xs text-muted">
                        Home channel: {w.channels ?? "none"} · {w.done24} done in 24 h
                      </p>
                      {w.status !== "revoked" && (
                        <WorkerUpdate
                          w={w}
                          latest={latest}
                          mode={mode}
                          keyId={facts.keyId}
                          isOwner={isOwner}
                          manual={facts.installSha ? manualUpdateMessage({ portalUrl: APP_URL, installSha256: facts.installSha, withRemotion: (w.capabilities as string[]).includes("remotion-2d"), host: String(w.host), mode: w.mode == null ? null : String(w.mode) }) : null}
                          installSha={facts.installSha}
                        />
                      )}
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
                  {needsAttention({ host: w.host, status: w.status }, p, w.waiting) && (
                    <div className="space-y-2 border-t border-border p-4">
                      <Alert tone="warn">
                        {p === "never"
                          ? "Needs attention: this worker never connected. Check the Muse setup chat for errors."
                          : w.waiting > 0
                            ? `Needs attention: ${w.waiting} job(s) are waiting for this worker.`
                            : "Needs attention: this worker missed its hourly runs. Its scheduled task may be paused."}{" "}
                        To run it now, send this message to that Muse account in the app or WhatsApp:
                      </Alert>
                      <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 text-xs">
                        {RUN_NOW_MESSAGE}
                      </pre>
                      <CopyButton value={RUN_NOW_MESSAGE} label="Copy message" />
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </div>

        <div className="space-y-6">
          {isOwner && (
            <Card className="h-fit">
              <CardHeader title="Add a worker" description="Creates a one-time code valid for 30 minutes." />
              <CardBody>
                <EnrollForm channels={channels.map((c) => ({ id: c.id, name: c.name }))} />
              </CardBody>
            </Card>
          )}
          <Card className="h-fit" data-testid="worker-updates">
            <CardHeader
              title="Worker updates"
              description="Workers 0.8.0+ install updates signed by this portal's key, between jobs, test them first and switch back if the new version fails."
            />
            <CardBody className="space-y-4">
              {facts.problem && <Alert tone="danger">Updates cannot be offered: {facts.problem}</Alert>}
              {isOwner ? (
                <form action={setUpdateMode} className="space-y-2">
                  <fieldset className="space-y-1">
                    <legend className="mb-1 text-sm font-medium">Update mode</legend>
                    {UPDATE_MODES.map((m) => (
                      <label key={m} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                        <input type="radio" name="mode" value={m} defaultChecked={m === mode} className="mt-1 size-4" id={`update-mode-${m}`} />
                        <span>
                          <span className="block text-sm">{UPDATE_MODE_LABEL[m]}</span>
                          <span className="block text-xs text-muted">{MODE_HELP[m]}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <SubmitButton className="w-full" pendingLabel="Saving…">
                    Save update mode
                  </SubmitButton>
                </form>
              ) : (
                <p className="text-sm">
                  Update mode: <span className="font-medium">{UPDATE_MODE_LABEL[mode]}</span>
                </p>
              )}
              <p className="text-sm" data-testid="update-mode-current">
                Now: <span className="font-medium">{UPDATE_MODE_LABEL[mode]}</span>. {MODE_HELP[mode]}
              </p>
              {isOwner && mode === "approve" && awaiting.length > 0 && (
                <form action={approveAllWorkerUpdates}>
                  <SubmitButton variant="primary" className="w-full">
                    Approve all ({awaiting.length})
                  </SubmitButton>
                </form>
              )}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted">Offers</dt>
                <dd className="break-all">{facts.served ? `v${facts.served.version} (${facts.served.release})` : "unknown"}</dd>
                <dt className="text-muted">Signing key</dt>
                <dd className="break-all font-mono">{facts.keyId ?? "not available"}</dd>
                <dt className="text-muted">Pinned</dt>
                <dd>{facts.settings.pinnedVersion ? `v${facts.settings.pinnedVersion}` : "none (downgrades are refused)"}</dd>
              </dl>
              {isOwner && facts.served && (
                <details className="rounded-lg border border-border px-3 text-xs">
                  <summary className="flex min-h-11 cursor-pointer items-center font-medium">Allow a downgrade</summary>
                  <div className="space-y-2 pb-3">
                    <p className="text-muted">
                      Workers refuse a version older than their own. Pin the version this portal offers to let them install it anyway, for
                      example after rolling the portal back. Remove the pin afterwards.
                    </p>
                    {facts.settings.pinnedVersion === facts.served.version ? (
                      <form action={setPinnedVersion.bind(null, null)}>
                        <SubmitButton>Remove pin v{facts.served.version}</SubmitButton>
                      </form>
                    ) : (
                      <form action={setPinnedVersion.bind(null, facts.served.version)}>
                        <SubmitButton>Pin v{facts.served.version}</SubmitButton>
                      </form>
                    )}
                  </div>
                </details>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

interface UpdateRow {
  id: string;
  version: string | null;
  update_offered_version: string | null;
  update_offered_release: string | null;
  update_approved_release: string | null;
  update_key_id: string | null;
  update_status: string | null;
  update_detail: string | null;
  update_result_version: string | null;
  update_result_at: Date | string | null;
}

/** Per worker: version, what it is offered, the last update result, and the manual fallback. */
function WorkerUpdate(props: {
  w: Record<string, unknown>;
  latest: string;
  mode: UpdateSettings["mode"];
  keyId: string | null;
  isOwner: boolean;
  manual: string | null;
  installSha: string;
}) {
  const w = props.w as unknown as UpdateRow;
  const behind = w.version !== props.latest;
  const selfUpdating = w.version ? compareVersions(w.version, SELF_UPDATING) >= 0 : false;
  const needsBootstrap = !selfUpdating || !w.update_key_id;
  const otherKey = Boolean(w.update_key_id && props.keyId && w.update_key_id !== props.keyId);
  const offered = w.update_offered_version;
  const approved = Boolean(w.update_offered_release && w.update_approved_release === w.update_offered_release);
  const result = describeUpdateResult(w.update_status, w.update_detail, w.update_result_version);
  const resultTone = w.update_status === "ok" ? "text-ok" : "text-warn";
  if (!behind && !offered && !result && !needsBootstrap && !otherKey) return null;
  return (
    <div className="space-y-2 pt-1 text-xs" data-testid="worker-update">
      {offered && (
        <p className="text-warn">
          Update to v{offered} available
          {props.mode === "off"
            ? " (updates are off; use the manual update)."
            : props.mode === "approve" && !approved
              ? ": waiting for your approval."
              : needsBootstrap
                ? ", but this worker needs the manual update once before it can install updates itself."
                : ": installs at its next check, between jobs."}
        </p>
      )}
      {!offered && behind && (
        <p className="text-warn">
          Running v{w.version ?? "unknown"}, latest is v{props.latest}. Newer job types, such as test renders, wait until it is updated.
        </p>
      )}
      {props.isOwner && props.mode === "approve" && offered && !approved && (
        <form action={approveWorkerUpdate.bind(null, w.id)}>
          <SubmitButton variant="primary">Approve v{offered}</SubmitButton>
        </form>
      )}
      {result && (
        <p className={resultTone}>
          Last update: {result} <span className="text-muted">({timeAgo(w.update_result_at)})</span>
        </p>
      )}
      {needsBootstrap && (
        <p className="text-muted">
          Automatic updates are not on for this worker yet: it needs the manual update below once (v{SELF_UPDATING}+ with this portal&apos;s
          key pinned). After that it updates itself.
        </p>
      )}
      {otherKey && (
        <p className="text-warn">
          This worker trusts another signing key ({w.update_key_id}), so it refuses this portal&apos;s updates. Run the manual update to pin
          this portal&apos;s key.
        </p>
      )}
      {props.manual && (behind || needsBootstrap || otherKey || w.update_status === "rolled_back" || w.update_status === "refused") && (
        <ManualUpdate message={props.manual} sha={props.installSha} />
      )}
    </div>
  );
}
