"use client";

import { useActionState } from "react";
import { Alert, Field, Input, Select, Textarea } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { FORMATS } from "@/lib/formats.ts";
import type { FormState } from "@/lib/form.ts";

export interface ChannelValues {
  name: string;
  handle: string;
  niche: string;
  format: string;
  language: string;
  googleAccount: string;
  status: string;
  videosPerDay: number;
  homeWorkerId: string;
  notes: string;
}

export function ChannelForm({
  action,
  values,
  workers,
  submitLabel,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  values?: Partial<ChannelValues>;
  workers: Array<{ id: string; name: string }>;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  const v = values ?? {};
  return (
    <form action={formAction} className="space-y-5">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel name" htmlFor="name">
          <Input id="name" name="name" defaultValue={v.name} required maxLength={80} />
        </Field>
        <Field label="YouTube handle" htmlFor="handle" hint="Optional, e.g. @mythstories">
          <Input id="handle" name="handle" defaultValue={v.handle} placeholder="@handle" maxLength={40} />
        </Field>
        <Field label="Niche" htmlFor="niche" hint="What the channel is about, in a few words.">
          <Input id="niche" name="niche" defaultValue={v.niche} maxLength={120} placeholder="e.g. forgotten history" />
        </Field>
        <Field label="Format" htmlFor="format">
          <Select id="format" name="format" defaultValue={v.format ?? "other"}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Google account" htmlFor="googleAccount" hint="Which of your 5 emails owns this channel.">
          <Input id="googleAccount" name="googleAccount" defaultValue={v.googleAccount} maxLength={120} />
        </Field>
        <Field label="Language" htmlFor="language">
          <Input id="language" name="language" defaultValue={v.language ?? "en"} maxLength={10} />
        </Field>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={v.status ?? "planning"}>
            <option value="planning">Planning</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
        </Field>
        <Field label="Videos per day" htmlFor="videosPerDay">
          <Input id="videosPerDay" name="videosPerDay" type="number" min={0} max={24} defaultValue={v.videosPerDay ?? 2} />
        </Field>
        <Field
          label="Home worker"
          htmlFor="homeWorkerId"
          hint="This channel's jobs go to this worker first. Others take over if it misses its wake."
        >
          <Select id="homeWorkerId" name="homeWorkerId" defaultValue={v.homeWorkerId ?? ""}>
            <option value="">Any worker</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Notes" htmlFor="notes">
        <Textarea id="notes" name="notes" defaultValue={v.notes} maxLength={4000} rows={4} />
      </Field>
      <div className="flex justify-end">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
