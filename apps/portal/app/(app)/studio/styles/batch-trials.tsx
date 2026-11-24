"use client";

/**
 * Batch trials belong to the Style library, not to New Video: choosing one style is one decision, and a grid of
 * checkboxes under that choice was a second picker in the same form. Here it is what it is — a research action that
 * starts one trial run per ticked style, from one brief.
 *
 * The action is the same one New Video used (startBatchTrialAction), so nothing about the runs changed, only where the
 * owner starts them from.
 */

import { useActionState, useState } from "react";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui.tsx";
import { MAX_BATCH_TRIALS, MIN_BATCH_TRIALS, TRY_THESE_STYLES } from "@/lib/studio/trial-batch.ts";
import { MAX_BRIEF_CHARS } from "@/lib/studio/run-config.ts";
import { startBatchTrialAction } from "../runs/actions.ts";

export interface BatchStyle {
  id: string;
  label: string;
}

export function BatchTrials({ channels, styles, defaultDurationSec }: { channels: Array<{ id: string; name: string }>; styles: BatchStyle[]; defaultDurationSec: number }) {
  const [state, dispatch] = useActionState(startBatchTrialAction, undefined);
  const [batch, setBatch] = useState<string[]>([]);

  if (styles.length < MIN_BATCH_TRIALS) return null;

  return (
    <details className="rounded-lg border border-dashed border-warn/60 p-3" data-testid="batch-trial">
      <summary className="cursor-pointer text-sm font-medium">{TRY_THESE_STYLES}</summary>
      <form action={dispatch} className="space-y-3 pt-3">
        <p className="text-xs text-muted">
          One brief, one trial run per style you tick, at most {MAX_BATCH_TRIALS}. They run as ordinary trials: research only, never
          published. Hermes works through them one ask at a time, and the queue above shows where each run is.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Channel" htmlFor="batchChannelId">
            <Select id="batchChannelId" name="channelId" required defaultValue={channels[0]?.id ?? ""}>
              {channels.length === 0 && (
                <option value="" disabled>
                  No channel yet
                </option>
              )}
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Length" htmlFor="batchDurationSec" hint="A trial is about the look, not the runtime.">
            <Select id="batchDurationSec" name="durationSec" defaultValue={String(defaultDurationSec)}>
              {[15, 30, 45, 60].map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Brief" htmlFor="batchBrief" hint={`${MAX_BRIEF_CHARS} characters at most. Every run in the batch uses it.`}>
          <Textarea id="batchBrief" name="brief" rows={3} maxLength={MAX_BRIEF_CHARS} required />
        </Field>
        <input type="hidden" name="format" value="short" />
        <input type="hidden" name="language" value="en" />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Styles</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {styles.map((t) => (
              <label key={t.id} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <input
                  type="checkbox"
                  name="batchTemplateIds"
                  value={t.id}
                  checked={batch.includes(t.id)}
                  onChange={(e) => setBatch((b) => (e.target.checked ? [...b.filter((x) => x !== t.id), t.id] : b.filter((x) => x !== t.id)))}
                  className="size-4 shrink-0 accent-[var(--vs-accent)]"
                  aria-label={`Try ${t.label}`}
                />
                <span className="min-w-0 break-words">{t.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={batch.length < MIN_BATCH_TRIALS} className="min-h-11">
          {batch.length < MIN_BATCH_TRIALS ? `Tick at least ${MIN_BATCH_TRIALS} styles` : `Start ${batch.length} trials`}
        </Button>
        {state?.error && <Alert tone="danger">{state.error}</Alert>}
        {state?.ok && (
          <Alert tone="ok">
            <span className="break-words" data-testid="batch-started">
              {state.ok}
            </span>
          </Alert>
        )}
        {state?.runs && state.runs.length > 0 && (
          <ol className="space-y-1 text-sm" data-testid="batch-runs">
            {state.runs.map((r) => (
              <li key={r.runId} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{r.position}</span>
                <a href={`/studio/runs/${r.runId}`} className="break-words text-accent underline-offset-2 hover:underline" data-testid="batch-run-link">
                  {r.label}
                </a>
              </li>
            ))}
          </ol>
        )}
      </form>
    </details>
  );
}