"use client";

import { useActionState } from "react";
import { Alert, Field, Input, Select } from "@/components/ui.tsx";
import { CopyButton, SubmitButton } from "@/components/client.tsx";
import { createEnrollment } from "./actions.ts";

export function EnrollForm({ channels }: { channels: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(createEnrollment, undefined);

  if (state?.code) {
    return (
      <div className="space-y-4">
        <Alert tone="ok">
          Code created. It works once and expires at {new Date(state.expiresAt!).toLocaleTimeString()}.
        </Alert>
        <div className="rounded-lg border border-border bg-surface-2 p-3 text-center font-mono text-lg tracking-wider">
          {state.code}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">For a Muse account</p>
          <p className="text-xs text-muted">Open the Muse account (browser profile or app) and send this message to the agent:</p>
          <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 text-xs">{state.prompt}</pre>
          <CopyButton value={state.prompt!} label="Copy message" />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">For a VPS or your own PC</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-2 p-3 text-xs">{state.command}</pre>
          <CopyButton value={state.command!} label="Copy command" />
        </div>
        <a href="/workers" className="block text-center text-sm text-accent">
          Done
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Worker name" htmlFor="label">
        <Input id="label" name="label" placeholder="Muse 01" required maxLength={80} />
      </Field>
      <Field label="Runs on" htmlFor="host">
        <Select id="host" name="host" defaultValue="muse">
          <option value="muse">Muse VM (hourly wake)</option>
          <option value="vps">VPS / GPU server</option>
          <option value="local">My own computer</option>
        </Select>
      </Field>
      <Field label="Home channel" htmlFor="channelId" hint="Optional. The channel this worker serves first.">
        <Select id="channelId" name="channelId" defaultValue="">
          <option value="">None</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton variant="primary" className="w-full" pendingLabel="Creating…">
        Create enrollment code
      </SubmitButton>
    </form>
  );
}
