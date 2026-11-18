"use client";

import { useActionState, useState } from "react";
import { Alert, Field, Input, Select } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { createJobAction } from "./actions.ts";

export function JobForm({
  types,
  channels,
}: {
  types: Array<{ id: string; label: string; description: string }>;
  channels: Array<{ id: string; name: string }>;
}) {
  const [state, action] = useActionState(createJobAction, undefined);
  const [type, setType] = useState(types[0]?.id ?? "echo");
  const current = types.find((t) => t.id === type);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Job type" htmlFor="type" hint={current?.description}>
        <Select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      {type === "smoke-test" && (
        <Field label="Clip length (seconds)" htmlFor="seconds">
          <Input id="seconds" name="seconds" type="number" min={1} max={60} defaultValue={5} />
        </Field>
      )}
      <Field label="Channel" htmlFor="channelId" hint="Routes the job to the channel's home worker first.">
        <Select id="channelId" name="channelId" defaultValue="">
          <option value="">Any worker</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <SubmitButton variant="primary" className="w-full" pendingLabel="Queuing…">
        Queue job
      </SubmitButton>
    </form>
  );
}
