"use client";

import { useActionState, useEffect, useState, useTransition, type FormEvent } from "react";
import { Alert, Badge, Button, Field, Select, Textarea } from "@/components/ui.tsx";
import {
  FAMILY_LABELS,
  LANGUAGES,
  LANGUAGE_BY_CODE,
  PURPOSES,
  STYLES,
  THEMES,
  VIDEO_FORMATS,
  WORKFLOWS,
  type Family,
  type Format,
  type Workflow,
} from "@/lib/studio/catalog.ts";
import type { ProductionPlan } from "@/lib/studio/planner.ts";
import { studioAction } from "./actions.ts";

const EXECUTOR: Record<string, string> = { hermes: "Hermes", "9router": "9router", worker: "Muse worker", human: "You", provider: "AI provider" };
const MUSE: Record<string, { tone: "ok" | "warn" | "danger" | "neutral"; label: string }> = {
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

export function StudioForm({
  channels,
  references,
}: {
  channels: Array<{ id: string; label: string }>;
  references: Array<{ id: string; title: string }>;
}) {
  const [state, dispatch] = useActionState(studioAction, undefined);
  const [isPending, startTransition] = useTransition();
  const v = state?.values ?? {};
  const [format, setFormat] = useState<Format>(v.format === "long" ? "long" : "short");
  const [styleId, setStyleId] = useState(v.styleId ?? "");
  const [themeId, setThemeId] = useState(v.themeId ?? "");
  const [language, setLanguage] = useState(v.language ?? "en");
  const [workflow, setWorkflow] = useState<Workflow>(v.workflow === "copycat-structure" ? "copycat-structure" : "original");

  // A suggestion action detects the theme from the brief; select it so the next preview uses it.
  useEffect(() => {
    if (state?.detectedThemeId) setThemeId(state.detectedThemeId);
  }, [state]);

  // Submit through a handler, not a form action. A form action makes React reset the form after it runs, which
  // clears the native selects and loses what the user chose. Here the controlled fields keep their values.
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.name) fd.set(submitter.name, submitter.value);
    startTransition(() => dispatch(fd));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.saved && <Alert tone="ok">Saved as a planned production. Its stages run once their workers are connected.</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel" htmlFor="channelId" hint="Shows each channel's category. Nothing is chosen for you.">
          <Select id="channelId" name="channelId" defaultValue={v.channelId ?? ""}>
            <option value="">No channel yet</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Format" htmlFor="format-group" hint={VIDEO_FORMATS[format].label}>
          <div id="format-group" className="grid grid-cols-2 gap-2">
            {(["short", "long"] as const).map((f) => (
              <Button key={f} type="button" variant={format === f ? "primary" : "secondary"} aria-pressed={format === f} onClick={() => setFormat(f)}>
                {f === "short" ? "Short" : "Long"}
              </Button>
            ))}
          </div>
          <input type="hidden" name="format" value={format} />
        </Field>
      </div>

      <Field label="Describe the video or type keywords" htmlFor="brief" hint="For example: the rise and fall of the Roman roads, told as a documentary.">
        <Textarea id="brief" name="brief" rows={3} maxLength={4000} defaultValue={v.brief ?? ""} required />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Theme or genre" htmlFor="themeId">
          <Select id="themeId" name="themeId" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
            <option value="">Any theme</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Workflow" htmlFor="workflow">
          <Select id="workflow" name="workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
            {(Object.keys(WORKFLOWS) as Workflow[]).map((w) => (
              <option key={w} value={w}>
                {WORKFLOWS[w].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Purpose</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PURPOSES.map((p) => (
            <label key={p.id} className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-sm">
              <input type="checkbox" name="purposes" value={p.id} defaultChecked={(v.purposes ?? "").includes(p.id)} className="mt-1 size-4 accent-[var(--vs-accent)]" />
              <span>
                <span className="font-medium">{p.label}</span>
                <span className="block text-xs text-muted">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Narration language"
          htmlFor="language"
          hint={LANGUAGE_BY_CODE[language]?.ttsNote}
        >
          <Select id="language" name="language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Subtitles in</legend>
          <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border border-border p-2 text-sm">
            {LANGUAGES.filter((l) => l.code !== language).map((l) => (
              <label key={l.code} className="flex items-center gap-2">
                <input type="checkbox" name="subtitles" value={l.code} defaultChecked={(v.subtitles ?? "").includes(l.code)} className="size-4 accent-[var(--vs-accent)]" />
                {l.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {workflow === "copycat-structure" && (
        <Field label="Reference video" htmlFor="referenceAssetId" hint="Upload a video in Assets and analyze it first. Only its structure is learned, never its content.">
          <Select id="referenceAssetId" name="referenceAssetId" defaultValue={v.referenceAssetId ?? ""}>
            <option value="">Choose a reference…</option>
            {references.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {workflow === "copycat-structure" && !references.length && <Alert tone="info">No videos in Assets yet. Upload one there, then come back.</Alert>}

      <Field label="Style" htmlFor="styleId" hint={styleId ? STYLES.find((s) => s.id === styleId)?.description : "Or press Suggest styles to rank them from your brief."}>
        <Select id="styleId" name="styleId" value={styleId} onChange={(e) => setStyleId(e.target.value)}>
          <option value="">Choose a style…</option>
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

      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="intent" value="suggest" disabled={isPending}>
          Suggest styles
        </Button>
        <Button type="submit" name="intent" value="preview" disabled={isPending}>
          Preview plan
        </Button>
        <Button type="submit" name="intent" value="save" variant="primary" disabled={isPending}>
          {isPending ? "Working…" : "Save production"}
        </Button>
      </div>

      {state?.suggestions && state.suggestions.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Suggested styles</p>
          <div className="flex flex-wrap gap-2">
            {state.suggestions.map((s) => (
              <Button key={s.styleId} type="button" variant="secondary" onClick={() => setStyleId(s.styleId)} className="h-auto py-2">
                <span className="text-left">
                  {s.label}
                  <span className="block text-xs text-muted">matched: {s.matched.slice(0, 4).join(", ")}</span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {state?.plan && (
        <div className="space-y-3 border-t border-border pt-5">
          <p className="text-sm font-semibold">Plan</p>
          <PlanView plan={state.plan} />
        </div>
      )}
    </form>
  );
}
