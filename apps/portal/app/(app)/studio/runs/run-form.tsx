"use client";

import Link from "next/link";
import { useActionState, useState, useTransition, type FormEvent } from "react";
import { Alert, Badge, Button, Field, Select, Textarea } from "@/components/ui.tsx";
import { LANGUAGES, LANGUAGE_BY_CODE, PURPOSES, THEMES, VIDEO_FORMATS, type Format } from "@/lib/studio/catalog.ts";
import { suggestStyles } from "@/lib/studio/planner.ts";
import { defaultThemeFor, engineView, MAX_BRIEF_CHARS, NO_THEME, type RunFormPrefill } from "@/lib/studio/run-config.ts";
import { HERMES_RENDER_LABEL, TRIAL_BADGE, TRIAL_LABEL } from "@/lib/studio/style-registry.ts";
import { MUSE } from "../studio-form.tsx";
import { startRunAction, testHermesAction, type HermesTestState } from "./actions.ts";

export interface RunFormChannel {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  plan: string;
  autonomy: string;
}
export interface RunFormTemplate {
  id: string;
  label: string;
  styleId: string;
  formats: Format[];
  /** A Trial style pack: research only, not for publishing. */
  trial?: boolean;
  /** The style pack version. */
  version?: string;
  /** Rendered by Hermes with its own tools: research only, never published (always a trial). */
  research?: boolean;
}
export interface RunFormOptions {
  channels: RunFormChannel[];
  /** Listed style packs a worker reports. */
  templates: RunFormTemplate[];
  /** Trial style packs a worker reports, offered in their own research-only section. */
  trialTemplates?: RunFormTemplate[];
  /** Listed or Trial styles no worker reports yet, as plain labels. */
  waiting?: string[];
  /** Capabilities enrolled workers report, from the stored rows. */
  capabilities: string[];
  prefill: RunFormPrefill;
}

/** A Hermes-rendered style always reads "Hermes render (research only)" first, whatever its pack is named. */
function researchLabel(t: RunFormTemplate): string {
  if (!t.research) return t.label;
  return t.label === HERMES_RENDER_LABEL ? HERMES_RENDER_LABEL : `${HERMES_RENDER_LABEL}: ${t.label}`;
}

const KOKORO: Record<string, { tone: "ok" | "warn"; label: string }> = {
  kokoro: { tone: "ok", label: "Kokoro voice" },
  verify: { tone: "warn", label: "Kokoro: check first" },
  other: { tone: "warn", label: "Not in Kokoro" },
};

function themeFor(channel: RunFormChannel | undefined): string {
  return defaultThemeFor(channel?.category) || NO_THEME;
}

/**
 * The New video form. Every field is controlled and the form submits through onSubmit and a transition, not a form
 * action: React 19 resets a form after its action runs, which would clear the native selects.
 */
export function RunForm({ channels, templates: listed, trialTemplates = [], waiting = [], capabilities, prefill }: RunFormOptions) {
  const templates = [...listed, ...trialTemplates];
  const [state, dispatch] = useActionState(startRunAction, undefined);
  const [isPending, startTransition] = useTransition();
  const known = (id: string) => channels.some((c) => c.id === id);
  const [channelId, setChannelId] = useState(known(prefill.channelId) ? prefill.channelId : "");
  const channel = channels.find((c) => c.id === channelId);
  const [themeId, setThemeId] = useState(prefill.themeId || themeFor(channel));
  // Once the owner picks a theme, changing the channel no longer replaces it.
  const [themeTouched, setThemeTouched] = useState(Boolean(prefill.themeId));
  const [templateId, setTemplateId] = useState(templates.some((t) => t.id === prefill.templateId) ? prefill.templateId : "");
  const [format, setFormat] = useState<Format>(prefill.format);
  const [language, setLanguage] = useState(prefill.language);
  const [purposes, setPurposes] = useState<string[]>(prefill.purposes);
  const [subtitles, setSubtitles] = useState<string[]>(prefill.subtitles);
  const [brief, setBrief] = useState(prefill.brief);
  const [suggested, setSuggested] = useState<Array<{ templateId: string; label: string; matched: string[] }> | null>(null);

  const template = templates.find((t) => t.id === templateId);
  const engine = template ? engineView(template.styleId, capabilities) : null;
  const muse = engine ? (MUSE[engine.muse] ?? MUSE.external) : null;
  const lang = LANGUAGE_BY_CODE[language];
  const kokoro = lang ? KOKORO[lang.tts] : undefined;

  function pickChannel(id: string) {
    setChannelId(id);
    if (!themeTouched) setThemeId(themeFor(channels.find((c) => c.id === id)));
  }
  function toggle(list: string[], set: (v: string[]) => void, value: string, on: boolean) {
    set(on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value));
  }
  function suggest() {
    const theme = themeId && themeId !== NO_THEME ? themeId : undefined;
    const byStyle = new Map(templates.filter((t) => t.formats.includes(format)).map((t) => [t.styleId, t]));
    setSuggested(
      suggestStyles(brief, format, theme, 10)
        .filter((s) => byStyle.has(s.style.id))
        .slice(0, 5)
        .map((s) => ({ templateId: byStyle.get(s.style.id)!.id, label: s.style.label, matched: s.matched })),
    );
  }
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" data-testid="run-form">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && (
        <Alert tone="ok">
          <span className="break-words">{state.ok} </span>
          {state.runId && (
            <Link href={`/studio/runs/${state.runId}`} className="font-medium underline underline-offset-2" data-testid="run-started-link">
              Open the run
            </Link>
          )}
        </Alert>
      )}
      <input type="hidden" name="productionId" value={prefill.productionId} />
      <input type="hidden" name="labStudyId" value={prefill.labStudyId ?? ""} />

      <Field label="Channel" htmlFor="channelId">
        <Select id="channelId" name="channelId" value={channelId} onChange={(e) => pickChannel(e.target.value)} required>
          <option value="" disabled>
            Choose a channel
          </option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {channel && (
        <div className="space-y-1.5 rounded-lg border border-border p-3 text-sm" data-testid="channel-context">
          <p>
            <span className="text-muted">Category: </span>
            {channel.categoryLabel || "not set"}
          </p>
          <p>
            <span className="text-muted">Autonomy: </span>
            {channel.autonomy}
          </p>
          <p className="break-words">
            <span className="text-muted">Plan: </span>
            {channel.plan || "No plan written yet. Hermes then works from the niche only."}
          </p>
          <p className="text-xs text-muted">
            Set on the{" "}
            <Link href={`/channels/${channel.id}`} className="text-accent underline-offset-2 hover:underline">
              channel page
            </Link>
            . Nothing here changes the channel.
          </p>
        </div>
      )}

      <Field label="What is the video about? (optional)" htmlFor="brief" hint="Leave it empty and Hermes picks ideas from the channel plan.">
        <Textarea id="brief" name="brief" rows={3} maxLength={MAX_BRIEF_CHARS} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. a lesser known myth, told as a mystery" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Format" htmlFor="format" hint={VIDEO_FORMATS[format].label}>
          <Select id="format" name="format" value={format} onChange={(e) => setFormat(e.target.value === "long" ? "long" : "short")}>
            <option value="short">Short</option>
            <option value="long">Long</option>
          </Select>
        </Field>
        <Field label="Theme" htmlFor="themeId" hint="Starts as the channel category. A change here is for this video only.">
          <Select
            id="themeId"
            name="themeId"
            value={themeId}
            onChange={(e) => {
              setThemeId(e.target.value);
              setThemeTouched(true);
            }}
          >
            <option value={NO_THEME}>No theme</option>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {channel && t.id === channel.category ? " (channel)" : ""}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="space-y-2">
        <Field label="Style" htmlFor="templateId" hint="Listed styles a worker can render, then Trial styles. Planned styles are on the Styles page.">
          <Select id="templateId" name="templateId" value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
            <option value="" disabled>
              {templates.length === 0 ? "No style is available yet" : "Choose a style"}
            </option>
            {listed.length > 0 && (
              <optgroup label="Listed styles">
                {listed.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                    {t.formats.includes(format) ? "" : " (not for this format)"}
                  </option>
                ))}
              </optgroup>
            )}
            {trialTemplates.length > 0 && (
              <optgroup label={TRIAL_LABEL}>
                {trialTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {researchLabel(t)} (trial)
                    {t.formats.includes(format) ? "" : " (not for this format)"}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        {prefill.labStudyId && (
          <p className="text-xs text-muted" data-testid="lab-study-link">
            Linked to a Template Lab study: this run is a trial whatever the style&apos;s status, and its result shows on the{" "}
            <Link href={`/studio/lab/${prefill.labStudyId}`} className="text-accent underline-offset-2 hover:underline">
              study page
            </Link>
            .
          </p>
        )}
        {(template?.trial || (prefill.labStudyId && template)) && (
          <Alert tone="warn">
            <span data-testid="trial-style-note">
              {TRIAL_BADGE}: research only, not for publishing. The run is marked as a trial and its result is recorded for the style&apos;s curation.
            </span>
          </Alert>
        )}
        {listed.length === 0 && (
          <p className="text-xs text-muted" data-testid="no-listed-styles">
            No style is Listed yet. Styles become Listed in the styles repository after their trials pass and the owner approves them.
          </p>
        )}
        <section className="space-y-2 rounded-lg border border-dashed border-warn/60 p-3" data-testid="trial-styles" aria-labelledby="trial-styles-title">
          <h3 id="trial-styles-title" className="text-sm font-medium">
            {TRIAL_LABEL}
          </h3>
          {trialTemplates.length === 0 ? (
            <p className="text-xs text-muted">No Trial style can be rendered by a worker right now.</p>
          ) : (
            <ul className="space-y-1.5">
              {trialTemplates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`trial-style-${t.styleId}`}>
                  <Badge tone="warn">{TRIAL_BADGE}</Badge>
                  {t.research && (
                    <Badge tone="warn">
                      <span data-testid="hermes-render-label">{HERMES_RENDER_LABEL}</span>
                    </Badge>
                  )}
                  <span className="min-w-0 break-words">
                    {t.label}
                    {t.version ? <span className="text-xs text-muted"> v{t.version}</span> : null}
                  </span>
                  <Button type="button" variant={t.id === templateId ? "primary" : "secondary"} onClick={() => setTemplateId(t.id)} className="min-h-11" aria-label={`Use the trial style ${researchLabel(t)}`}>
                    {t.id === templateId ? "Chosen" : "Use for research"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {waiting.length > 0 && (
            <p className="text-xs text-muted" data-testid="waiting-styles">
              Waiting for a worker that reports the pack (or for Hermes): {waiting.join("; ")}. Workers 0.9.0 and later install packs with their signed updates.
            </p>
          )}
        </section>
        <Button type="button" onClick={suggest} disabled={!brief.trim()} className="min-h-11">
          Suggest from brief
        </Button>
        {suggested && suggested.length === 0 && <p className="text-xs text-muted">No style matches that brief for this format. Add detail or pick one from the list.</p>}
        {suggested && suggested.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="style-suggestions">
            {suggested.map((s) => (
              <Button key={s.templateId} type="button" variant={s.templateId === templateId ? "primary" : "secondary"} onClick={() => setTemplateId(s.templateId)} className="h-auto py-2">
                <span className="text-left">
                  {s.label}
                  <span className="block text-xs opacity-80">matched: {s.matched.slice(0, 4).join(", ")}</span>
                </span>
              </Button>
            ))}
          </div>
        )}
        {engine && muse && (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="engine-info">
            <span className="text-muted">Engine: {engine.label}</span>
            <Badge tone={muse.tone}>{muse.label}</Badge>
            {engine.worker === "yes" && <Badge tone="ok">A worker reports {engine.capability}</Badge>}
            {engine.worker === "no" && <Badge tone="warn">No worker reports {engine.capability} yet</Badge>}
            {engine.worker === "external" && <Badge>Not run by a worker</Badge>}
          </div>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Purpose (optional)</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {PURPOSES.map((p) => (
            <label key={p.id} className="flex min-h-11 items-start gap-2 rounded-lg border border-border p-2.5 text-sm">
              <input
                type="checkbox"
                name="purposes"
                value={p.id}
                checked={purposes.includes(p.id)}
                onChange={(e) => toggle(purposes, setPurposes, p.id, e.target.checked)}
                className="mt-1 size-4 shrink-0 accent-[var(--vs-accent)]"
              />
              <span className="min-w-0">
                <span className="font-medium">{p.label}</span>
                <span className="block text-xs text-muted">{p.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Narration language" htmlFor="language" hint={lang?.ttsNote}>
          <Select
            id="language"
            name="language"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              setSubtitles((s) => s.filter((c) => c !== e.target.value));
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
          {kokoro && (
            <span className="mt-1.5 inline-block" data-testid="kokoro-flag">
              <Badge tone={kokoro.tone}>{kokoro.label}</Badge>
            </span>
          )}
        </Field>
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">Subtitles in (optional)</legend>
          <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border border-border p-2 text-sm">
            {LANGUAGES.filter((l) => l.code !== language).map((l) => (
              <label key={l.code} className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  name="subtitles"
                  value={l.code}
                  checked={subtitles.includes(l.code)}
                  onChange={(e) => toggle(subtitles, setSubtitles, l.code, e.target.checked)}
                  className="size-4 shrink-0 accent-[var(--vs-accent)]"
                />
                <span className="truncate">{l.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <Button type="submit" variant="primary" className="min-h-12 w-full sm:w-auto" disabled={isPending} aria-busy={isPending}>
        {isPending ? "Starting…" : "Ask Hermes for ideas"}
      </Button>
    </form>
  );
}

export function HermesTest() {
  const [result, setResult] = useState<HermesTestState>(undefined);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3">
      <Button
        type="button"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(await testHermesAction());
          })
        }
      >
        {pending ? "Testing…" : "Test Hermes JSON"}
      </Button>
      {result && (
        <Alert tone={result.ok ? "ok" : "danger"}>
          <span data-testid="hermes-test-result" className="break-words">
            {result.ok ? "Pass. " : "Fail. "}
            {result.detail}
          </span>
        </Alert>
      )}
    </div>
  );
}
