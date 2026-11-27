import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser, hasRole } from "@/lib/server/auth.ts";
import { reapStuckStages } from "@/lib/server/director.ts";
import { getRun, type RunDetail } from "@/lib/server/runs.ts";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { Alert, Badge, Card, CardBody, CardHeader, LinkButton, PageHeader, timeAgo } from "@/components/ui.tsx";
import { stageLabel } from "@/lib/studio/review.ts";
import { isModelStage, isProductionStage, isRunStage, stageSummary } from "@/lib/studio/engine.ts";
import { RECIPES, runRecipeOf, runStagesOf } from "@/lib/studio/recipes.ts";
import { productionSummary } from "@/lib/studio/production.ts";
import { isRenderingWait, stageWaitText, waitingText } from "@/lib/studio/pacing.ts";
import { isTrialRun, parseRunConfig, runSettings } from "@/lib/studio/run-config.ts";
import { HERMES_RENDER_LABEL, HTML_DESIGN_BADGE, LAB_TRIAL_BADGE, TRIAL_BADGE, isResearchEngine } from "@/lib/studio/style-registry.ts";
import { cancelRunAction } from "../actions.ts";
import { RunStateBadge, StageStateBadge } from "../run-status.tsx";

export const metadata = { title: "Hermes run" };
export const dynamic = "force-dynamic";

function outputText(stage: string, output: Record<string, unknown>): string {
  if (!isRunStage(stage)) return "";
  const result = output.result;
  if (result === undefined || result === null) return "";
  let text = "";
  try {
    text = JSON.stringify(result, null, 2);
  } catch {
    text = "";
  }
  return text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text;
}

/**
 * What this render was drawn from: the payload's hash (twelve hex) and the pack that drew it. Composed parts live inside
 * the payload, so the same line covers a story the kit never had — and a re-render can be compared against it.
 */
function frozenText(output: Record<string, unknown>): string {
  const frozen = output.frozen;
  if (!frozen || typeof frozen !== "object") return "";
  const f = frozen as { short?: unknown; pack?: unknown };
  if (typeof f.short !== "string" || f.short.length === 0) return "";
  const pack = typeof f.pack === "string" && f.pack.length > 0 ? ` from ${f.pack}` : "";
  return `Frozen payload ${f.short}${pack}: the same run renders the same video.`;
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("run page: reaper failed", err);
  }
  let detail: RunDetail | null = null;
  try {
    detail = await getRun(id);
  } catch (err) {
    console.error("run page: could not load", err);
  }
  if (!detail) notFound();
  const { run, stages, workOrders, reviews, attempts, gates } = detail;
  const canEdit = hasRole(user.role, "editor");
  const open = reviews.find((r) => r.state === "open");
  const finished = run.state === "cancelled" || run.state === "failed" || run.state === "done";
  const board = stages.find((s) => s.stage === "storyboard" && s.state === "passed");
  // A stage that waits for a rate-limited or slow Hermes is pending with a not-before time. It is busy, not idle or failed.
  const waiting = run.state === "running" ? stages.find((s) => s.state === "pending" && s.notBefore) : undefined;
  const now = Date.now();
  const waitLine = waiting?.notBefore ? stageWaitText(waiting.output.hermesWait, waiting.notBefore.getTime(), now) : "";
  const assetsPending = stages.some((s) => s.stage === "assets" && s.state === "pending" && !s.notBefore);
  const storyboardReady = Boolean(board) && assetsPending && run.state === "running";
  // A storyboard that is ready but not yet approved has nothing running, so there is nothing to poll for.
  const live = run.state === "running" && !storyboardReady;
  // The run's own stage list, fixed when it started (a run from before workflows has the original list).
  const runConfig = parseRunConfig(run.config);
  const flowStages = runStagesOf(runConfig);
  const recipe = RECIPES[runRecipeOf(runConfig)];
  const stateOf = new Map(stages.map((s) => [s.stage, s.state] as const));
  const makesPictures = flowStages.includes("assets");

  return (
    <>
      <AutoRefresh active={live} seconds={4} />
      <PageHeader
        title={run.topic || "Waiting for an idea"}
        description={`${run.channelName || "No channel"} · ${run.templateId} · started ${timeAgo(run.createdAt)}`}
        actions={
          <>
            <LinkButton href="/studio" variant="secondary">
              All runs
            </LinkButton>
            {open && (
              <LinkButton href="/review" variant="primary">
                Open in Review
              </LinkButton>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {storyboardReady ? <Badge tone="ok">Storyboard ready</Badge> : <RunStateBadge state={run.state} />}
        {isTrialRun(parseRunConfig(run.config)) && (
          <span data-testid="trial-badge" title="Research only, not for publishing">
            <Badge tone="warn">{TRIAL_BADGE}: research only, not for publishing</Badge>
          </span>
        )}
        {isResearchEngine(parseRunConfig(run.config).stylePack?.engine) && (
          <span data-testid="hermes-render-badge" title="Hermes renders this video with its own tools; it is never published">
            <Badge tone="warn">{HERMES_RENDER_LABEL}</Badge>
          </span>
        )}
        {runRecipeOf(parseRunConfig(run.config)) === "html-design" && (
          <span data-testid="html-design-badge" title="Hermes wrote the page this video is drawn from; research only, never published">
            <Badge tone="warn">{HTML_DESIGN_BADGE}</Badge>
          </span>
        )}
        {parseRunConfig(run.config).stylePack?.lab && (
          <span data-testid="lab-trial-badge" title="A Draft or Lab pack, run for testing: never published, not counted toward promotion">
            <Badge tone="warn">{LAB_TRIAL_BADGE}</Badge>
          </span>
        )}
        <span className="text-xs text-muted" data-testid="run-attempts">
          {attempts} stage attempt{attempts === 1 ? "" : "s"}
        </span>
      </div>
      {storyboardReady && (
        <div className="mb-4">
          <Alert tone="ok">Storyboard ready. Approve it in Review to start sourcing assets.</Alert>
        </div>
      )}
      {waiting && (
        // A render Hermes is working on says so itself (it is not a busy or slow Hermes): "the studio checks for the
        // finished file; nothing is restarted".
        <div className="mb-4" data-testid={isRenderingWait(waiting.output.hermesWait) ? "hermes-rendering" : "hermes-wait"}>
          <Alert tone="info">
            {stageLabel(waiting.stage)}: {waitLine}
            {isRenderingWait(waiting.output.hermesWait) ? "" : ". Nothing failed; the step continues on its own."}
          </Alert>
        </div>
      )}
      <details className="mb-4 rounded-lg border border-border px-3 py-2 text-sm" data-testid="run-settings">
        <summary className="flex min-h-11 cursor-pointer items-center font-medium">Video settings</summary>
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
          {runSettings(parseRunConfig(run.config)).map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted">{r.label}</dt>
              <dd className="break-words">{r.value}</dd>
            </div>
          ))}
        </dl>
      </details>
      {run.state === "waiting-human" && !open && (
        <div className="mb-4">
          <Alert tone="warn">This run is waiting for you, but no open item was found. Open Review to check.</Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title="Stages" description="The newest attempt of each stage." />
          <div className="space-y-1 border-b border-border px-4 pb-3 text-xs sm:px-5" data-testid="run-workflow" data-recipe={recipe.id}>
            <p className="text-muted">
              Workflow: {runConfig.workflow ? recipe.label : `${recipe.label} (started before workflows)`}
            </p>
            <ol className="flex flex-wrap items-center gap-1">
              {flowStages.map((k, i) => (
                <li key={k} className="flex items-center gap-1" data-testid={`workflow-step-${k}`} data-state={stateOf.get(k) ?? "not-started"}>
                  {i > 0 && <span aria-hidden="true" className="text-muted">→</span>}
                  <Badge tone={stateOf.get(k) === "passed" ? "ok" : stateOf.get(k) === "failed" ? "danger" : stateOf.get(k) ? "info" : "neutral"}>{stageLabel(k)}</Badge>
                </li>
              ))}
            </ol>
          </div>
          <ul className="divide-y divide-border">
            {stages.map((s) => {
              const text = outputText(s.stage, s.output);
              const done = s.state === "passed" || s.state === "waiting-human";
              const summary = !done
                ? ""
                : isProductionStage(s.stage)
                  ? productionSummary(s.stage, s.output.result)
                  : isModelStage(s.stage)
                    ? stageSummary(s.stage, s.output.result)
                    : "";
              const jobId = typeof s.output.jobId === "string" ? s.output.jobId : "";
              return (
                <li key={s.id} className="space-y-2 px-4 py-3 sm:px-5" data-testid={`stage-${s.stage}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{stageLabel(s.stage)}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-muted">attempt {s.attempt}</span>
                      <StageStateBadge state={s.state} />
                    </span>
                  </div>
                  {summary && <p className="break-words text-xs text-muted">{summary}</p>}
                  {typeof s.output.renderNote === "string" && (
                    <p className="break-words text-xs text-muted" data-testid={`stage-${s.stage}-note`}>
                      {s.output.renderNote}
                    </p>
                  )}
                  {frozenText(s.output) && (
                    <p className="break-words text-xs text-muted" data-testid={`stage-${s.stage}-frozen`}>
                      {frozenText(s.output)}
                    </p>
                  )}
                  {typeof s.output.previewWorkerNote === "string" && (
                    <p className="break-words text-xs text-muted" data-testid={`stage-${s.stage}-note`}>
                      {s.output.previewWorkerNote}
                    </p>
                  )}
                  {s.state === "pending" && s.notBefore && run.state === "running" && (
                    <p className="break-words text-xs text-muted">{stageWaitText(s.output.hermesWait, s.notBefore.getTime(), now)}</p>
                  )}
                  {s.stage === "render" && jobId && (
                    <p className="text-xs">
                      <Link href={`/jobs/${jobId}`} className="inline-flex min-h-11 items-center text-accent underline-offset-2 hover:underline">
                        Open the render job
                      </Link>
                    </p>
                  )}
                  {s.error && <p className="break-words text-xs text-danger">{s.error}</p>}
                  {text && (
                    <details>
                      <summary className="min-h-8 cursor-pointer text-xs font-medium text-accent">Show output</summary>
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs">{text}</pre>
                    </details>
                  )}
                </li>
              );
            })}
            {stages.length === 0 && <li className="px-4 py-6 text-sm text-muted">No stages yet.</li>}
          </ul>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Work orders" />
            <CardBody className="space-y-2 text-sm">
              {makesPictures || workOrders.length > 0 ? (
                <p>
                  {workOrders.length} work order{workOrders.length === 1 ? "" : "s"} from the storyboard.
                </p>
              ) : (
                <p data-testid="no-work-orders">This workflow makes no pictures, so it has no work orders.</p>
              )}
            </CardBody>
            {workOrders.length > 0 && (
              <ul className="divide-y divide-border border-t border-border" data-testid="work-orders">
                {workOrders.map((w) => (
                  <li key={w.id} className="space-y-1 px-4 py-3 text-xs sm:px-5" data-testid="work-order" data-state={w.state}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{w.shotRef || w.stage}</span>
                      <Badge tone={w.state === "done" ? "ok" : w.state === "failed" ? "danger" : "info"}>{w.state}</Badge>
                    </div>
                    <p className="break-words text-muted">
                      {w.provider ? `Provider ${w.provider}. ` : ""}
                      {w.attempts} attempt{w.attempts === 1 ? "" : "s"}
                    </p>
                    {w.error && <p className="break-words text-danger">{w.error}</p>}
                    {w.state === "pending" && w.notBefore && run.state === "running" && (
                      <p className="break-words text-muted" data-testid="work-order-wait">
                        {waitingText(w.notBefore.getTime(), now)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {gates.length > 0 && (
            <Card>
              <CardHeader title="Checks" />
              <ul className="divide-y divide-border">
                {gates.map((g) => (
                  <li key={g.gate} className="px-4 py-3 text-xs sm:px-5">
                    <span className="font-medium">{g.gate}</span>: {g.passed ? "passed" : "needs attention"}
                    {!g.passed && g.issues.length > 0 && <span className="block break-words text-muted">{g.issues.join(" ")}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {canEdit && !finished && (
            <form action={cancelRunAction.bind(null, run.id)}>
              <SubmitButton variant="danger" className="min-h-12 w-full" pendingLabel="Cancelling…">
                Cancel run
              </SubmitButton>
            </form>
          )}
          <p className="text-xs text-muted">
            <Link href="/review" className="text-accent underline-offset-2 hover:underline">
              Go to the Review inbox
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
