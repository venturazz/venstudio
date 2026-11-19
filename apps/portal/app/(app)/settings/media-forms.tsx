"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui.tsx";
import { SubmitButton } from "@/components/client.tsx";
import { testHermesImage, testKokoroVoice, type TestState } from "./actions.ts";

function Result({ state }: { state: TestState }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <Alert tone="danger">
        <p className="whitespace-pre-line break-words">{state.error}</p>
      </Alert>
    );
  }
  return (
    <Alert tone="ok">
      <ul className="space-y-0.5 break-words">
        {state.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {state.preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.preview} alt="Test image from Hermes" className="mt-2 max-h-48 max-w-full rounded-lg" />
      )}
    </Alert>
  );
}

export function TestVoiceForm() {
  const [state, action] = useActionState(testKokoroVoice, undefined);
  return (
    <form action={action} className="space-y-3">
      <SubmitButton className="min-h-11 text-sm" pendingLabel="Making a clip…">
        Test voice
      </SubmitButton>
      <Result state={state} />
    </form>
  );
}

export function TestImageForm() {
  const [state, action] = useActionState(testHermesImage, undefined);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted">
        Asks Hermes which image providers it has and makes one small test picture. Nothing is saved and no provider terms change.
        It can take a minute.
      </p>
      <SubmitButton className="min-h-11 text-sm" pendingLabel="Asking Hermes…">
        Test Hermes image
      </SubmitButton>
      <Result state={state} />
    </form>
  );
}
