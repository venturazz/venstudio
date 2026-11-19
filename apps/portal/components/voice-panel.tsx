import { describeVoicePath, kokoroHealth } from "@/lib/server/tts.ts";
import { env } from "@/lib/server/env.ts";
import { Alert, Badge } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { recheckKokoro } from "@/app/(app)/settings/actions.ts";
import { TestVoiceForm } from "@/app/(app)/settings/media-forms.tsx";

/** Async server component; wrap in <Suspense>. Reads the stored scan and the environment only, so it never waits on 9router or Hermes. */
export async function VoicePanel({ canTest = false }: { canTest?: boolean }) {
  const info = await describeVoicePath();
  const override = env().KOKORO_BASE_URL ? await kokoroHealth() : null;
  return (
    <div className="space-y-3 text-sm">
      {info.paths.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted">The voice stage tries these in order:</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {info.paths.map((p) => (
              <li key={p} className="break-words">
                {p}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <Alert tone="warn">
          <p className="break-words">No voice path is available yet.</p>
        </Alert>
      )}
      {info.skipped.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted">
          {info.skipped.map((s) => (
            <li key={s} className="break-words">
              Not used: {s}
            </li>
          ))}
        </ul>
      )}
      {override && (
        <div className="space-y-1">
          {override.ok ? (
            <Badge tone="ok" dot>
              Kokoro override connected · {override.latencyMs} ms · {override.voices.length} voices
            </Badge>
          ) : (
            <>
              <Badge tone="danger" dot>
                Kokoro override unreachable
              </Badge>
              <Alert tone="danger">
                <p className="break-words font-medium">{override.error}</p>
                {override.hint && <p className="mt-1 break-words">{override.hint}</p>}
              </Alert>
            </>
          )}
          {canTest && (
            <form action={recheckKokoro}>
              <SubmitButton className="min-h-8 text-xs" pendingLabel="Checking…">
                Check override again
              </SubmitButton>
            </form>
          )}
        </div>
      )}
      {canTest && <TestVoiceForm />}
      <p className="text-xs text-muted">
        Backup voice: {info.backup}. The studio finds these voices through 9router and Hermes by itself. Nothing to set here. The provider that
        made each voice is listed under Asset providers for you to confirm.
      </p>
    </div>
  );
}
