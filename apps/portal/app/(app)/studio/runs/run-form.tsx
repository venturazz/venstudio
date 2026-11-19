"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { LANGUAGES } from "@/lib/studio/catalog.ts";
import { startRunAction, testHermesAction, type HermesTestState } from "./actions.ts";

export interface RunFormOptions {
  channels: Array<{ id: string; label: string }>;
  templates: Array<{ id: string; label: string }>;
}

export function RunForm({ channels, templates }: RunFormOptions) {
  const [state, formAction] = useActionState(startRunAction, undefined);
  const v = state?.values ?? {};
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}
      <Field label="Channel" htmlFor="channelId">
        <Select id="channelId" name="channelId" defaultValue={v.channelId ?? ""} required>
          <option value="" disabled>
            Choose a channel
          </option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Template" htmlFor="templateId" hint="Retired templates are not listed.">
        <Select id="templateId" name="templateId" defaultValue={v.templateId ?? ""} required>
          <option value="" disabled>
            Choose a template
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Format" htmlFor="format">
          <Select id="format" name="format" defaultValue={v.format ?? "short"}>
            <option value="short">Short</option>
            <option value="long">Long</option>
          </Select>
        </Field>
        <Field label="Language" htmlFor="language">
          <Select id="language" name="language" defaultValue={v.language ?? "en"}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Topic hint (optional)" htmlFor="topic" hint="Hermes proposes ideas that fit this hint and the channel plan.">
        <Input id="topic" name="topic" defaultValue={v.topic ?? ""} maxLength={300} placeholder="e.g. a lesser known myth" />
      </Field>
      <SubmitButton variant="primary" className="min-h-12 w-full sm:w-auto" pendingLabel="Starting…">
        Ask Hermes for ideas
      </SubmitButton>
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
