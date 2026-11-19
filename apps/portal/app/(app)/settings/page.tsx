import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { Suspense } from "react";
import { GatewayPanel, GatewayPanelFallback } from "@/components/gateway-panel.tsx";
import { hasRole } from "@/lib/server/auth.ts";
import { serverHealth } from "@/lib/server/diagnostics.ts";
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, timeAgo } from "@/components/ui.tsx";
import { ConfirmButton, SubmitButton } from "@/components/client.tsx";
import { AddUserForm, PasswordForm, TotpDisable, TotpSetup } from "./forms.tsx";
import { removeUser, signOutOtherSessions } from "./actions.ts";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const user = await requireUser();
  const { welcome } = await searchParams;
  const sql = db();
  const isOwner = user.role === "owner";
  const [sessions, users] = await Promise.all([
    sql`SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions
        WHERE user_id = ${user.id} AND expires_at > now() AND mfa_pending = false ORDER BY last_seen_at DESC`,
    sql`SELECT id, name, email, role, totp_enabled, created_at FROM users WHERE ${isOwner}::boolean ORDER BY created_at`,
  ]);

  return (
    <>
      <PageHeader title="Settings" />
      {welcome && (
        <div className="mb-6">
          <Alert tone="ok">Owner account created. Next: turn on two-factor below, then remove SETUP_TOKEN from the server.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Two-factor sign-in" />
          <CardBody>{user.totpEnabled ? <TotpDisable /> : <TotpSetup />}</CardBody>
        </Card>

        <Card>
          <CardHeader title="Password" />
          <CardBody>
            <PasswordForm />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Signed-in devices"
            actions={
              sessions.length > 1 && (
                <form action={signOutOtherSessions}>
                  <SubmitButton className="min-h-8 text-xs">Sign out others</SubmitButton>
                </form>
              )
            }
          />
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id} className="px-4 py-2.5 text-sm sm:px-5">
                <p className="truncate">
                  {s.user_agent || "Unknown device"}{" "}
                  {s.id === user.sessionId && <Badge tone="accent">This device</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {s.ip} · active {timeAgo(s.last_seen_at)} · signed in {timeAgo(s.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title="AI gateway (9router)" description="Used for scripts, planning, images and TTS." />
          <CardBody>
            <Suspense fallback={<GatewayPanelFallback />}>
              <GatewayPanel showModels canRecheck={hasRole(user.role, "editor")} />
            </Suspense>
          </CardBody>
        </Card>

        {isOwner && (
          <Card>
            <CardHeader title="Server health" description="Helps tell a slow server from a slow app. Refresh to measure again." />
            <CardBody>
              <Suspense fallback={<p className="text-sm text-muted">Measuring…</p>}>
                <HealthPanel />
              </Suspense>
            </CardBody>
          </Card>
        )}

        {isOwner && (
          <Card className="lg:col-span-2">
            <CardHeader title="Team" description="People who can sign in to this portal." />
            <ul className="divide-y divide-border">
              {users.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {u.name} <span className="text-xs font-normal text-muted">{u.email}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {u.role} · {u.totp_enabled ? "2FA on" : "2FA off"}
                    </p>
                  </div>
                  {u.role !== "owner" && (
                    <form action={removeUser.bind(null, u.id)}>
                      <ConfirmButton variant="ghost" className="min-h-8 text-xs" message={`Remove ${u.email}?`}>
                        Remove
                      </ConfirmButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <CardBody className="border-t border-border">
              <AddUserForm />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

async function HealthPanel() {
  const h = await serverHealth();
  const rows: Array<[string, string]> = [
    ["Database round trip", `${h.dbRoundTripMs} ms`],
    ["Simple query", `${h.dbQueryMs} ms`],
    ["CPU load (1 min)", `${h.load1} on ${h.cpus} cores`],
    ["Free RAM", `${h.memFreeGb} of ${h.memTotalGb} GB`],
    ["Portal memory", `${h.processRssMb} MB`],
    ["Video storage free", h.artifactsFreeGb === null ? "unknown" : `${h.artifactsFreeGb} of ${h.artifactsTotalGb} GB`],
    ["Server uptime", `${h.uptimeHours} h`],
  ];
  return (
    <div className="space-y-3 text-sm">
      {h.verdict.map((v) => (
        <Alert key={v.text} tone={v.tone}>
          {v.text}
        </Alert>
      ))}
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
