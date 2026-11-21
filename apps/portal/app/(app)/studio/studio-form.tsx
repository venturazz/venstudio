"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import { Alert, Badge, Button, Field, Input, Select } from "@/components/ui.tsx";
import { FAMILY_LABELS, STYLES, VIDEO_FORMATS, type Family, type Format } from "@/lib/studio/catalog.ts";
import type { ProductionPlan } from "@/lib/studio/planner.ts";
import { testRenderAction } from "./actions.ts";

const EXECUTOR: Record<string, string> = { hermes: "Hermes", "9router": "9router", worker: "Muse worker", human: "You", provider: "AI provider" };
export const MUSE: Record<string, { tone: "ok" | "warn" | "danger" | "neutral"; label: string }> = {
  "muse-ok": { tone: "ok", label: "Muse: runs well" },
  "muse-slow": { tone: "warn", label: "Muse: slow, CPU only" },
  "muse-test": { tone: "warn", label: "Muse: verify first" },
  "gpu-preferred": { tone: "danger", label: "Needs a GPU worker" },
  external: { tone: "neutral", label: "AI provider" },
};

function groupedStyles() {
  const groups = new Map<Family, typeof STYLES>();
  for (const s of STYLES) groups.set(s.family, [...(groups.get(s.family) ?? []), s]);
  return [...groups.entries()];
}

export function PlanView({ plan }: { plan: ProductionPlan }) {
  const muse = MUSE[plan.muse] ?? MUSE.external;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{plan.styleLabel}</Badge>
        <Badge>{plan.formatLabel}</Badge>
        {plan.themeLabel && <Badge>{plan.themeLabel}</Badge>}
        {plan.purposes.map((p) => (
          <Badge key={p.id}>{p.label}</Badge>
        ))}
        <Badge>Narration: {plan.language.label}</Badge>
        {plan.subtitles.map((s) => (
          <Badge key={s.code}>Subs: {s.label}</Badge>
        ))}
        <Badge tone={muse.tone}>{muse.label}</Badge>
      </div>
      <p className="text-sm text-muted">
        {plan.durationSec[0]}–{plan.durationSec[1]} s · about {plan.targetShots} shots · engine: {plan.engineLabel} ({plan.engineTier})
      </p>
      {plan.warnings.length > 0 && (
        <Alert tone="warn">
          <ul className="list-disc space-y-1 pl-4">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      <ol className="space-y-2">
        {plan.stages.map((s, i) => (
          <li key={s.id} className="flex gap-3 rounded-lg border border-border p-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-medium">{i + 1}</span>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{s.label}</p>
                <Badge tone={s.runnable ? "ok" : "neutral"}>{s.runnable ? "Runs now" : "Planned"}</Badge>
                <Badge>{EXECUTOR[s.executor] ?? s.executor}</Badge>
              </div>
              <p className="text-xs text-muted">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {plan.cautions.length > 0 && (
        <div>
          <p className="text-sm font-medium">Cautions for this style</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
            {plan.cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A test render checks the path plan -> job -> worker -> video with placeholder cards. It does not ask Hermes and
 * does not make a real video. Submits through onSubmit so the selects keep their values after an error.
 */
export function TestRenderForm() {
  const [state, dispatch] = useActionState(testRenderAction, undefined);
  const [isPending, startTransition] = useTransition();
  const [format, setFormat] = useState<Format>("short");
  const [styleId, setStyleId] = useState("");
  const [note, setNote] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="test-render-form">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Style" htmlFor="test-style">
          <Select id="test-style" name="styleId" value={styleId} onChange={(e) => setStyleId(e.target.value)} required>
            <option value="" disabled>
              Choose a style
            </option>
            {groupedStyles().map(([family, styles]) => (
              <optgroup key={family} label={FAMILY_LABELS[family]}>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.formats.includes(format) ? "" : " (not for this format)"}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Format" htmlFor="test-format" hint={VIDEO_FORMATS[format].label}>
          <Select id="test-format" name="format" value={format} onChange={(e) => setFormat(e.target.value === "long" ? "long" : "short")}>
            <option value="short">Short</option>
            <option value="long">Long</option>
          </Select>
        </Field>
      </div>
      <Field label="Card text (optional)" htmlFor="test-note" hint="Shown on the first card.">
        <Input id="test-note" name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} />
      </Field>
      <Button type="submit" variant="primary" className="min-h-12 w-full sm:w-auto" disabled={isPending} aria-busy={isPending}>
        {isPending ? "Queuing…" : "Queue test render"}
      </Button>
    </form>
  );
}
