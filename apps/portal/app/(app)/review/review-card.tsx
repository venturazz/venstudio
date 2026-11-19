"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Badge, Card, CardBody, Textarea } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { reviewTitle, stageLabel, type ReviewKind, type ReviewPayload } from "@/lib/studio/review.ts";
import { decideReviewAction } from "./actions.ts";

export interface ReviewCardView {
  id: string;
  runId: string;
  stage: string;
  kind: ReviewKind;
  payload: ReviewPayload;
  topic: string;
  channelName: string;
  /** Plain-language gate lines, computed on the server. */
  gateLines: string[];
  /** Relative time text, computed on the server. */
  age: string;
}

const BTN = "min-h-12 w-full sm:w-auto";

function MediaBlock({ stage, payload }: { stage: string; payload: ReviewPayload }) {
  const media = payload.media;
  const checks = payload.checks ?? [];
  const images = media?.images ?? [];
  const termsLine = [...(payload.issues ?? []), ...checks].some((l) => /commercial-use terms|provider terms/i.test(l));
  if (!media && checks.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="review-media">
      {stage === "assets" && images.length > 0 && (
        <ul className="grid grid-cols-2 gap-2" data-testid="asset-grid">
          {images.map((img) => (
            <li key={img.assetId} className="min-w-0 space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/assets/${img.assetId}`} alt={`Shot ${img.shotRef}`} loading="lazy" className="aspect-[9/16] w-full rounded-lg border border-border bg-surface-2 object-cover" />
              <p className="break-words text-xs text-muted">
                {img.shotRef} · {img.provider || "unknown provider"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {(stage === "assets" || stage === "voice") && termsLine && (
        <p className="break-words text-sm" data-testid="provider-terms-notice">
          Some of this was made by a provider whose commercial-use terms are not confirmed.{" "}
          <Link href="/settings" className="inline-flex min-h-11 items-center text-accent underline-offset-2 hover:underline">
            Confirm the terms in Settings
          </Link>
        </p>
      )}
      {stage === "voice" && media?.audioAssetId && (
        <div className="space-y-1">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="none" src={`/api/assets/${media.audioAssetId}`} className="w-full" data-testid="voice-audio" />
          {media.voiceProvider && <p className="text-xs text-muted">Voice: {media.voiceProvider}</p>}
        </div>
      )}
      {(stage === "render" || stage === "qc") && media?.videoAssetId && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video controls playsInline preload="metadata" src={`/api/assets/${media.videoAssetId}`} className="aspect-[9/16] max-h-[70vh] w-full rounded-lg bg-black" data-testid="render-video" />
      )}
      {checks.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted" data-testid="review-checks">
          {checks.map((line, i) => (
            <li key={`${i}-${line}`} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {(stage === "render" || stage === "qc") && (
        <p className="text-xs text-muted">The presentation check is manual in Phase 4. Watch the video before you approve.</p>
      )}
    </div>
  );
}

export function ReviewCard({ item }: { item: ReviewCardView }) {
  const [state, formAction] = useActionState(decideReviewAction, undefined);
  const p = item.payload;
  const issues = p.issues && p.issues.length > 0 ? p.issues : item.gateLines;
  const ideas = p.ideas ?? [];
  return (
    <Card data-testid="review-card" data-kind={item.kind}>
      <CardBody className="space-y-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.kind === "stage-error" || item.kind === "gate-failure" ? "danger" : item.kind === "idea" ? "accent" : "info"}>
              {stageLabel(item.stage)}
            </Badge>
            {item.channelName && <span className="text-xs text-muted">{item.channelName}</span>}
            <span className="text-xs text-muted">{item.age}</span>
          </div>
          <h2 className="break-words text-base font-semibold">{reviewTitle(item.kind, item.stage)}</h2>
          <p className="break-words text-sm text-muted">
            {item.topic ? `Topic: ${item.topic}` : "No topic yet"} ·{" "}
            <Link href={`/studio/runs/${item.runId}`} className="text-accent underline-offset-2 hover:underline">
              Open run
            </Link>
          </p>
        </div>

        {state?.error && <Alert tone="danger">{state.error}</Alert>}
        {state?.ok && <Alert tone="ok">{state.ok}</Alert>}

        {item.kind === "idea" && (
          <ul className="space-y-3">
            {ideas.length === 0 && <li className="text-sm text-muted">Hermes sent no usable ideas. Send a revision to ask again.</li>}
            {ideas.map((idea, i) => (
              <li key={`${i}-${idea.title}`} className="rounded-lg border border-border p-3">
                <p className="break-words font-medium">{idea.title}</p>
                <p className="mt-1 break-words text-sm">{idea.hook}</p>
                <p className="mt-1 break-words text-xs text-muted">
                  {idea.angle} · score {Math.round(idea.score)}
                </p>
                <form action={formAction} className="mt-3">
                  <input type="hidden" name="reviewId" value={item.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <input type="hidden" name="ideaIndex" value={i} />
                  <input type="hidden" name="note" value="" />
                  <SubmitButton variant="primary" className={BTN} pendingLabel="Saving…">
                    Approve this idea
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        )}

        {item.kind === "approval" && (
          <>
            {p.summary && <p className="whitespace-pre-wrap break-words text-sm">{p.summary}</p>}
            {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
            <MediaBlock stage={item.stage} payload={p} />
            <form action={formAction}>
              <input type="hidden" name="reviewId" value={item.id} />
              <input type="hidden" name="decision" value="approve" />
              <input type="hidden" name="ideaIndex" value="" />
              <input type="hidden" name="note" value="" />
              <SubmitButton variant="primary" className={BTN} pendingLabel="Saving…">
                Approve
              </SubmitButton>
            </form>
          </>
        )}

        {item.kind === "gate-failure" && (
          <>
            {p.summary && <p className="break-words text-sm">{p.summary}</p>}
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {issues.map((line, i) => (
                <li key={`${i}-${line}`} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
            <MediaBlock stage={item.stage} payload={p} />
          </>
        )}

        {item.kind === "stage-error" && (
          <Alert tone="danger">
            <span className="break-words">{p.error || p.summary || "The stage stopped."}</span>
          </Alert>
        )}

        {(item.kind === "gate-failure" || item.kind === "stage-error") && (
          <form action={formAction}>
            <input type="hidden" name="reviewId" value={item.id} />
            <input type="hidden" name="decision" value="retry" />
            <input type="hidden" name="ideaIndex" value="" />
            <input type="hidden" name="note" value="" />
            <SubmitButton variant="primary" className={BTN} pendingLabel="Saving…">
              Retry
            </SubmitButton>
          </form>
        )}

        <form action={formAction} className="space-y-3 border-t border-border pt-4">
          <input type="hidden" name="reviewId" value={item.id} />
          <input type="hidden" name="ideaIndex" value="" />
          <label htmlFor={`note-${item.id}`} className="block text-sm font-medium">
            What should change?
          </label>
          <Textarea id={`note-${item.id}`} name="note" rows={3} maxLength={1000} placeholder="Write a note for Hermes" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton name="decision" value="revise" className={BTN} pendingLabel="Saving…">
              Send revision
            </SubmitButton>
            <SubmitButton name="decision" value="reject" variant="danger" className={BTN} pendingLabel="Saving…">
              Reject
            </SubmitButton>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
