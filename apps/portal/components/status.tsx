import { Badge } from "./ui.tsx";
import type { Presence } from "@/lib/server/workers.ts";

const JOB: Record<string, { tone: "neutral" | "ok" | "warn" | "danger" | "info" | "accent"; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  succeeded: { tone: "ok", label: "Done" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "warn", label: "Cancelled" },
};

export function JobStatus({ status }: { status: string }) {
  const s = JOB[status] ?? { tone: "neutral" as const, label: status };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

const PRESENCE: Record<Presence, { tone: "neutral" | "ok" | "warn" | "danger" | "info"; label: string }> = {
  working: { tone: "info", label: "Working" },
  online: { tone: "ok", label: "Online" },
  sleeping: { tone: "neutral", label: "Sleeping" },
  offline: { tone: "danger", label: "Offline" },
  never: { tone: "warn", label: "Never seen" },
};

export function WorkerPresence({ presence, status }: { presence: Presence; status: string }) {
  if (status === "revoked") return <Badge tone="neutral">Revoked</Badge>;
  const p = PRESENCE[presence];
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={p.tone} dot>
        {p.label}
      </Badge>
      {status === "draining" && <Badge tone="warn">Draining</Badge>}
    </span>
  );
}

const CHANNEL: Record<string, { tone: "neutral" | "ok" | "warn"; label: string }> = {
  planning: { tone: "neutral", label: "Planning" },
  active: { tone: "ok", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
};

export function ChannelStatus({ status }: { status: string }) {
  const s = CHANNEL[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
