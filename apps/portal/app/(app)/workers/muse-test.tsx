import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { Alert, Badge, Card, CardBody, CardHeader } from "@/components/ui.tsx";
import { latestMuseTests, museFlagOn, museWorkerFacts, type MuseTestView } from "@/lib/server/muse-tasks.ts";
import {
  MUSE_HONEST_NOTE,
  MUSE_TEST_FRAME,
  MUSE_TEST_LABEL,
  MUSE_TEST_VARIANTS,
  durationText,
  museTaskWorkers,
  museTestDisabledReasons,
  type MuseWorkerFacts,
} from "@/lib/studio/muse-task.ts";
import { sendMuseTestTask } from "./actions.ts";

/** Owner only (the page renders it only for the owner; the action checks again). docs/muse-agent-tasks.md */
export async function MuseTestCard() {
  const [workers, latest] = await Promise.all([museWorkerFacts(), latestMuseTests()]);
  const flag = museFlagOn();
  const ready = museTaskWorkers(workers);
  const active = [...latest.values()].some((v) => v.status === "queued" || v.status === "running");
  return (
    <Card className="h-fit" data-testid="muse-agent-tasks">
      <AutoRefresh active={active} seconds={10} />
      <CardHeader title="Muse agent tasks" description="Send a small test through the Muse agent's inbox and see each step." />
      <CardBody className="space-y-4">
        <Alert tone="info">
          <span data-testid="muse-honest-note">{MUSE_HONEST_NOTE}</span>
        </Alert>
        {ready.length === 0 ? (
          <MuseWorkerRow worker={null} reasons={museTestDisabledReasons({ portalFlag: flag, anyWorker: false })} latest={null} />
        ) : (
          ready.map((w) => (
            <MuseWorkerRow key={w.id} worker={w} reasons={museTestDisabledReasons({ portalFlag: flag, worker: w, anyWorker: true })} latest={latest.get(w.id) ?? null} />
          ))
        )}
      </CardBody>
    </Card>
  );
}

function MuseWorkerRow({ worker, reasons, latest }: { worker: MuseWorkerFacts | null; reasons: string[]; latest: MuseTestView | null }) {
  const disabled = reasons.length > 0 || worker === null;
  const reasonId = `muse-reason-${worker?.id ?? "none"}`;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="muse-worker">
      {worker && <p className="break-words text-sm font-medium">{worker.name}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {MUSE_TEST_VARIANTS.map((v) => (
          <form key={v} action={worker ? sendMuseTestTask.bind(null, worker.id, v) : undefined}>
            <SubmitButton
              variant={v === "picture" ? "primary" : "secondary"}
              className="w-full sm:w-auto"
              disabled={disabled}
              aria-describedby={disabled ? reasonId : undefined}
              pendingLabel="Queuing…"
              data-testid={`muse-test-${v}`}
            >
              {MUSE_TEST_LABEL[v]}
            </SubmitButton>
          </form>
        ))}
      </div>
      {reasons.length > 0 && (
        <ul id={reasonId} className="space-y-1 text-xs text-warn" data-testid="muse-test-reason">
          {reasons.map((r) => (
            <li key={r} className="break-words">
              {r}
            </li>
          ))}
        </ul>
      )}
      {latest && <MuseTestResult view={latest} />}
    </div>
  );
}

const STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "danger"> = { queued: "neutral", running: "info", succeeded: "ok", failed: "danger", cancelled: "warn" };

function MuseTestResult({ view }: { view: MuseTestView }) {
  return (
    <div className="space-y-2 border-t border-border pt-3 text-xs" data-testid="muse-test-result">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Last test: {view.variant === "picture" ? "picture" : "JSON result"}</span>
        <Badge tone={STATUS_TONE[view.status] ?? "neutral"}>{view.status}</Badge>
        <Link href={`/jobs/${view.jobId}`} className="text-accent underline-offset-2 hover:underline">
          Job details
        </Link>
      </p>
      <ol className="space-y-1" data-testid="muse-timeline">
        {view.lines.map((l) => (
          <li key={l} className="break-words [overflow-wrap:anywhere]">
            {l}
          </li>
        ))}
      </ol>
      {view.wakeSec !== null && (
        <p className="font-medium" data-testid="muse-wake">
          Wake latency: {durationText(view.wakeSec)}
        </p>
      )}
      {view.image && (
        <figure className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- an owner-only artifact served by the portal */}
          <img src={`/api/artifacts/${view.image.artifactId}`} alt={`${view.image.name} from the Muse agent`} className="w-full max-w-[240px] rounded-lg border border-border" />
          <figcaption className={view.image.sizeOk === false ? "text-warn" : "text-muted"}>
            {view.image.name}
            {view.image.width !== null ? ` · ${view.image.width}×${view.image.height}` : ""}
            {view.image.sizeOk === false ? ` (asked for ${MUSE_TEST_FRAME.width}×${MUSE_TEST_FRAME.height})` : ""}
          </figcaption>
        </figure>
      )}
      {view.json && view.json.ok && (
        <div className="space-y-1" data-testid="muse-json-ok">
          <p className="text-ok">result.json passed the check.</p>
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-2 font-mono [overflow-wrap:anywhere]">{JSON.stringify(view.json.value, null, 2)}</pre>
        </div>
      )}
      {view.json && !view.json.ok && (
        <div className="space-y-1" data-testid="muse-json-issues">
          <p className="text-warn">result.json did not pass the check:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {view.json.issues.map((i) => (
              <li key={i} className="break-words">
                {i}
              </li>
            ))}
          </ul>
          {view.resultText && <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-2 font-mono [overflow-wrap:anywhere]">{view.resultText.slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  );
}
