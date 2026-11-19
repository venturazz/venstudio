import { ensureFreshInBackground, getCapabilities } from "@/lib/server/capabilities.ts";
import {
  buildCapabilities,
  CAPABILITY_STAGES,
  capabilitiesFor,
  missingCapabilityMessage,
  routerCombos,
  scanStateOf,
  stageStatus,
  STAGE_INFO,
  type Capability,
  type SourceStatus,
  type StageStatus,
} from "@/lib/studio/capabilities.ts";
import { Alert, Badge, timeAgo } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { scanCapabilitiesNow } from "@/app/(app)/settings/actions.ts";

const MAX_CHIPS = 8;

const BADGE: Record<StageStatus, { tone: "ok" | "info" | "warn" | "neutral"; text: string }> = {
  ready: { tone: "ok", text: "Ready" },
  found: { tone: "info", text: "Found, not used yet" },
  missing: { tone: "warn", text: "Missing" },
  later: { tone: "neutral", text: "Later" },
};

/** Async server component; wrap in <Suspense>. Reads only the stored scan, so it never waits on Hermes or 9router. */
export async function CapabilitiesPanel({ canScan = false }: { canScan?: boolean }) {
  const snap = await getCapabilities();
  ensureFreshInBackground(snap);
  const caps = buildCapabilities(snap);
  const state = scanStateOf(snap);

  return (
    <div className="space-y-4 px-4 py-3 text-sm sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted">{snap ? `Scanned ${timeAgo(snap.scannedAt)}` : "Not scanned yet. The first scan starts by itself and takes up to two minutes."}</p>
        {canScan && (
          <form action={scanCapabilitiesNow}>
            <SubmitButton className="min-h-8 text-xs" pendingLabel="Scanning…">
              Scan now
            </SubmitButton>
          </form>
        )}
      </div>

      {snap && (
        <div className="space-y-2">
          <SourceLine name="Hermes" status={snap.hermes?.status} detail={snap.hermes ? `${snap.hermes.skills.length} skills listed` : ""} />
          <SourceLine
            name="9router"
            status={snap.router?.status}
            detail={snap.router ? `${snap.router.lists.chat.length} models, ${routerCombos(snap.router.lists).length} combos` : ""}
          />
          {snap.error && <Alert tone="warn">{snap.error}</Alert>}
        </div>
      )}

      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        {CAPABILITY_STAGES.map((stage) => {
          const info = STAGE_INFO[stage];
          const status = stageStatus(stage, snap);
          const badge = BADGE[status];
          const found = capabilitiesFor(stage, caps);
          const chips = uniqueChips(found);
          return (
            <li key={stage} className="min-w-0 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{info.label}</h3>
                <Badge tone={badge.tone} dot>
                  {badge.text}
                </Badge>
              </div>
              <p className="mt-1 break-words text-xs text-muted">{info.today}</p>
              {chips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {chips.slice(0, MAX_CHIPS).map((c) => (
                    <span key={`${c.via}:${c.id}`} className="max-w-full break-all rounded-md bg-surface-2 px-2 py-0.5 text-xs">
                      {c.label}{" "}
                      <span className="text-muted">via {c.via === "hermes" ? "Hermes" : "9router"}
                        {!c.verified && ", not verified"}
                      </span>
                    </span>
                  ))}
                  {chips.length > MAX_CHIPS && <span className="px-1 py-0.5 text-xs text-muted">+{chips.length - MAX_CHIPS} more</span>}
                </div>
              )}
              {status === "found" && !info.used && <p className="mt-2 break-words text-xs text-muted">Listed only. No stage has called it, so it is not proven to work.</p>}
              {chips.some((c) => !c.verified) && (
                <p className="mt-2 break-words text-xs text-muted">Not verified means Hermes named it in its own answer and /v1/skills did not list it.</p>
              )}
              {status === "missing" && <p className="mt-2 break-words text-xs text-warn">{missingCapabilityMessage(stage, state)}</p>}
            </li>
          );
        })}
      </ul>

      {snap?.hermes?.notes && <p className="break-words text-xs text-muted">Hermes note: {snap.hermes.notes}</p>}
    </div>
  );
}

function uniqueChips(caps: Capability[]): Capability[] {
  const seen = new Set<string>();
  return caps.filter((c) => {
    const key = `${c.via}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function SourceLine({ name, status, detail }: { name: string; status: SourceStatus | undefined; detail: string }) {
  if (!status) return <p className="text-xs text-muted">{name}: not scanned</p>;
  if (!status.configured) {
    return (
      <Alert tone="warn">
        <p className="font-medium">{name} is not configured</p>
        {status.hint && <p className="mt-1 break-words">{status.hint}</p>}
      </Alert>
    );
  }
  if (!status.ok) {
    return (
      <Alert tone="danger">
        <p className="break-words font-medium">
          {name}: {status.error}
        </p>
        {status.hint && <p className="mt-1 break-words">{status.hint}</p>}
      </Alert>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="ok" dot>
        {name} scanned
      </Badge>
      <span className="text-xs text-muted">{detail}</span>
    </div>
  );
}
