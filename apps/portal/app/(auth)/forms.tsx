"use client";

import { useActionState } from "react";
import { Alert, Field, Input } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { login, setupOwner, verifyMfa } from "./actions.ts";

export function LoginForm() {
  const [state, action] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus defaultValue={state?.values?.email} />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton variant="primary" className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}

export function VerifyForm() {
  const [state, action] = useActionState(verifyMfa, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="6-digit code" htmlFor="code">
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
          className="text-center font-mono text-lg tracking-[0.4em]"
        />
      </Field>
      <SubmitButton variant="primary" className="w-full" pendingLabel="Checking…">
        Verify
      </SubmitButton>
    </form>
  );
}

export function SetupForm() {
  const [state, action] = useActionState(setupOwner, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <Field label="Setup token" htmlFor="token" hint="The SETUP_TOKEN value from the server's .env file.">
        <Input id="token" name="token" type="password" autoComplete="off" required />
      </Field>
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required defaultValue={state?.values?.name} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state?.values?.email} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters. A passphrase works well.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <SubmitButton variant="primary" className="w-full" pendingLabel="Creating…">
        Create owner account
      </SubmitButton>
    </form>
  );
}
