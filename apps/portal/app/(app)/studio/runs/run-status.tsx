import { Badge } from "@/components/ui.tsx";

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const RUN_STATE: Record<string, { tone: Tone; label: string }> = {
  running: { tone: "info", label: "Hermes is working" },
  "waiting-human": { tone: "warn", label: "Waiting for you" },
  failed: { tone: "danger", label: "Failed" },
  done: { tone: "ok", label: "Done" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

const STAGE_STATE: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Pending" },
  running: { tone: "info", label: "Running" },
  passed: { tone: "ok", label: "Passed" },
  failed: { tone: "danger", label: "Failed" },
  "waiting-human": { tone: "warn", label: "Waiting for you" },
  skipped: { tone: "neutral", label: "Skipped" },
};

export function RunStateBadge({ state }: { state: string }) {
  const s = RUN_STATE[state] ?? { tone: "neutral" as const, label: state };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function StageStateBadge({ state }: { state: string }) {
  const s = STAGE_STATE[state] ?? { tone: "neutral" as const, label: state };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
