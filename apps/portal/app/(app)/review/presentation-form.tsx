"use client";

import { useActionState } from "react";
import { Alert, Badge } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { PRESENTATION_RUBRIC, rubricField, type Rubric } from "@/lib/studio/presentation.ts";
import { scorePresentationAction } from "./actions.ts";

export interface PresentationView {
  score: number;
  passed: boolean;
  rubric: Rubric | null;
  byOwner: boolean;
}

export interface AdvisoryView {
  score: number;
  notes: string;
  frames: number;
}

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * The final video's presentation score on its Review card. The owner rates hook, pacing, legibility, visual polish and
 * audio from 1 to 5 stars (mapped to 0-100 on the server); a trial run needs it before its decision. Hermes's
 * advisory, when it came, is shown beside it and never decides.
 */
export function PresentationBlock({
  reviewId,
  isOwner,
  trial,
  presentation,
  advisory,
}: {
  reviewId: string;
  isOwner: boolean;
  trial: boolean;
  presentation: PresentationView | null;
  advisory: AdvisoryView | null;
}) {
  const [state, formAction] = useActionState(scorePresentationAction, undefined);
  return (
    <section className="space-y-3 rounded-lg border border-border p-3" data-testid="presentation-score">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Presentation score</h3>
        {presentation ? (
          <span data-testid="presentation-value">
            <Badge tone={presentation.passed ? "ok" : "danger"}>{`${presentation.score}/100${presentation.byOwner ? " by the owner" : ""}`}</Badge>
          </span>
        ) : (
          <span className="text-xs text-muted" data-testid="presentation-missing">
            {trial ? "Not scored yet. Required before you approve or reject this trial video." : "Not scored yet (optional for this run)."}
          </span>
        )}
      </div>
      {advisory && (
        <p className="break-words text-xs text-muted" data-testid="presentation-advisory">
          Hermes advisory (from {advisory.frames} stills, does not decide): {advisory.score}/100{advisory.notes ? `. ${advisory.notes}` : ""}
        </p>
      )}
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}
      {isOwner ? (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="reviewId" value={reviewId} />
          <p className="text-xs text-muted">Watch the whole video, then rate each line. 1 star is poor, 5 stars is ready to publish.</p>
          <p className="text-xs text-muted" data-testid="presentation-decides-not">
            Saving a score does not approve the video. It is recorded with your decision; approve or reject the video on this card.
          </p>
          {PRESENTATION_RUBRIC.map((r) => (
            <fieldset key={r.id} className="min-w-0 space-y-1" data-testid={`rubric-${r.id}`}>
              <legend className="text-sm font-medium">{r.label}</legend>
              <p className="text-xs text-muted">{r.hint}</p>
              <div className="flex flex-wrap gap-1.5">
                {STARS.map((n) => (
                  <label
                    key={n}
                    className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-lg border border-border px-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/12"
                  >
                    <input
                      type="radio"
                      name={rubricField(r.id)}
                      value={n}
                      required
                      defaultChecked={presentation?.rubric?.[r.id] === n}
                      aria-label={`${r.label}: ${n} of 5`}
                      className="size-4 accent-current"
                    />
                    <span aria-hidden>{n}★</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <SubmitButton variant="secondary" className="min-h-12 w-full sm:w-auto" pendingLabel="Saving…">
            {presentation ? "Update score" : "Save score"}
          </SubmitButton>
        </form>
      ) : (
        <p className="text-xs text-muted">The owner scores the final video.</p>
      )}
    </section>
  );
}
