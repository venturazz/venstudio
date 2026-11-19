import { hermesStatus } from "@/lib/server/hermes.ts";
import { groupSkills } from "@/lib/hermes-skills.ts";
import { Alert, Badge } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { recheckHermes } from "@/app/(app)/gateway-actions.ts";

const FEATURE_LABELS: Record<string, string> = {
  run_submission: "Background runs",
  run_events_sse: "Live progress",
  run_stop: "Cancel runs",
  chat_completions: "Chat",
  responses_api: "Responses",
};

/** Async server component; wrap in <Suspense>. */
export async function HermesPanel({ detailed = false, canRecheck = false }: { detailed?: boolean; canRecheck?: boolean }) {
  const h = await hermesStatus();
  const recheck = canRecheck && h.configured && (
    <form action={recheckHermes}>
      <SubmitButton className="min-h-8 text-xs" pendingLabel="Checking…">
        Check again
      </SubmitButton>
    </form>
  );

  if (!h.configured) {
    return (
      <p className="text-sm text-muted">
        Not configured. Set <code className="font-mono text-xs">HERMES_BASE_URL</code> (e.g.{" "}
        <code className="font-mono text-xs">http://hermes-xxxx:8642</code>) and{" "}
        <code className="font-mono text-xs">HERMES_API_KEY</code>.
      </p>
    );
  }

  if (!h.ok) {
    return (
      <div className="space-y-3 text-sm">
        <Badge tone="danger" dot>
          Unreachable
        </Badge>
        <Alert tone="danger">
          <p className="font-medium">{h.error}</p>
          {h.hint && <p className="mt-1">{h.hint}</p>}
        </Alert>
        <p className="break-all text-xs text-muted">
          Tried: <code className="font-mono">{h.url}</code>
          {h.checkedAt && <> · checked {new Date(h.checkedAt).toLocaleTimeString()}</>}
        </p>
        {recheck}
      </div>
    );
  }

  const runsReady = h.features.run_submission !== false;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok" dot>
          Connected · {h.latencyMs} ms
        </Badge>
        <span className="text-muted">{h.skillsError ? "skills unavailable" : `${h.skills.length} skills`}</span>
      </div>
      {h.skillsSource === "chat" && (
        <p className="text-xs text-muted">
          Hermes&apos;s skills endpoint is broken in this version, so this list came from asking Hermes in a chat turn. It&apos;s
          refreshed at most once an hour.
        </p>
      )}
      {!runsReady && (
        <Alert tone="warn">This Hermes version doesn&apos;t support background runs. Update Hermes before using it in pipelines.</Alert>
      )}
      {h.skillsError && <Alert tone="warn">{h.skillsError}</Alert>}
      {detailed && (
        <>
          <div className="flex flex-wrap gap-1">
            {Object.entries(FEATURE_LABELS)
              .filter(([k]) => k in h.features)
              .map(([k, label]) => (
                <Badge key={k} tone={h.features[k] ? "accent" : "neutral"}>
                  {label}
                  {h.features[k] ? "" : " (no)"}
                </Badge>
              ))}
          </div>
          {h.skills.length > 0 && (
            <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-border">
              {groupSkills(h.skills).map(([category, skills]) => (
                <details key={category} className="group border-b border-border last:border-b-0">
                  <summary className="flex cursor-pointer items-center justify-between px-3 py-2 font-medium">
                    <span className="capitalize">{category}</span>
                    <span className="text-xs text-muted">{skills.length}</span>
                  </summary>
                  <ul className="space-y-2 px-3 pb-3">
                    {skills.map((s) => (
                      <li key={s.name}>
                        <code className="font-mono text-xs">{s.name}</code>
                        {s.description && <p className="text-xs text-muted">{s.description}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
        </>
      )}
      {recheck}
    </div>
  );
}

export function HermesPanelFallback() {
  return <p className="text-sm text-muted">Checking Hermes…</p>;
}
