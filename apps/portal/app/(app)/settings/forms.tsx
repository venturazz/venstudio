"use client";

import { useActionState } from "react";
import { Alert, Field, Input, Select } from "@/components/ui.tsx";
import { CopyButton, SubmitButton } from "@/components/client.tsx";
import { addUser, changePassword, confirmTotp, disableTotp, startTotp } from "./actions.ts";

export function PasswordForm() {
  const [state, action] = useActionState(changePassword, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.ok && <Alert tone="ok">{state.ok}</Alert>}
      <Field label="Current password" htmlFor="current">
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New password" htmlFor="next">
          <Input id="next" name="next" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
        <Field label="Repeat new password" htmlFor="confirm">
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
      </div>
      <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
    </form>
  );
}

export function TotpSetup() {
  const [start, startAction] = useActionState(startTotp, undefined);
  const [confirm, confirmAction] = useActionState(confirmTotp, undefined);
  const setup = confirm?.secret ? confirm : start;

  if (confirm?.ok) return <Alert tone="ok">{confirm.ok}</Alert>;

  if (!setup?.secret) {
    return (
      <form action={startAction} className="space-y-3">
        {start?.error && <Alert tone="danger">{start.error}</Alert>}
        <p className="text-sm text-muted">
          Protect sign-in with a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy…).
        </p>
        <SubmitButton variant="primary" pendingLabel="Preparing…">
          Turn on two-factor
        </SubmitButton>
      </form>
    );
  }

  return (
    <form action={confirmAction} className="space-y-4">
      {confirm?.error && <Alert tone="danger">{confirm.error}</Alert>}
      <p className="text-sm">1. Scan this QR code with your authenticator app, or enter the key by hand.</p>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={setup.qr} alt="Two-factor QR code" width={180} height={180} className="rounded-lg bg-white p-1" />
        <div className="w-full min-w-0 space-y-2">
          <code className="block break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">{setup.secret}</code>
          <CopyButton value={setup.secret} label="Copy key" />
        </div>
      </div>
      <p className="text-sm">2. Enter the code the app shows.</p>
      <Field label="6-digit code" htmlFor="totp-code">
        <Input
          id="totp-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
          className="max-w-40 text-center font-mono tracking-[0.3em]"
        />
      </Field>
      <SubmitButton variant="primary" pendingLabel="Checking…">
        Confirm and turn on
      </SubmitButton>
    </form>
  );
}

export function TotpDisable() {
  const [state, action] = useActionState(disableTotp, undefined);
  if (state?.ok) return <Alert tone="ok">{state.ok}</Alert>;
  return (
    <form action={action} className="space-y-3">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      <p className="text-sm text-muted">Two-factor is on. Enter your password to turn it off.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input name="password" type="password" autoComplete="current-password" required aria-label="Password" />
        <SubmitButton variant="danger" className="shrink-0 whitespace-nowrap" pendingLabel="Turning off…">
          Turn off
        </SubmitButton>
      </div>
    </form>
  );
}

export function AddUserForm() {
  const [state, action] = useActionState(addUser, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.password && (
        <Alert tone="ok">
          <p>
            Created {state.email}. Temporary password (shown once):
          </p>
          <code className="mt-1 block break-all font-mono">{state.password}</code>
          <div className="mt-2">
            <CopyButton value={state.password} label="Copy password" />
          </div>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" htmlFor="u-name">
          <Input id="u-name" name="name" required maxLength={80} />
        </Field>
        <Field label="Email" htmlFor="u-email">
          <Input id="u-email" name="email" type="email" required />
        </Field>
        <Field label="Role" htmlFor="u-role">
          <Select id="u-role" name="role" defaultValue="editor">
            <option value="editor">Editor (can create and run)</option>
            <option value="viewer">Viewer (read only)</option>
          </Select>
        </Field>
      </div>
      <SubmitButton pendingLabel="Adding…">Add user</SubmitButton>
    </form>
  );
}
