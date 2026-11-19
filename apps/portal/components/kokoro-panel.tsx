import { kokoroHealth } from "@/lib/server/tts.ts";
import { env } from "@/lib/server/env.ts";
import { Alert, Badge } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { recheckKokoro } from "@/app/(app)/settings/actions.ts";
import { TestVoiceForm } from "@/app/(app)/settings/media-forms.tsx";

/** Async server component; wrap in <Suspense>. */
export async function KokoroPanel({ canRecheck = false }: { canRecheck?: boolean }) {
  const k = await kokoroHealth();
  const backup = env().TTS_BACKUP === "hermes-capcut" ? "CapCut through Hermes" : "off";
  const footer = (
    <p className="text-xs text-muted">
      Backup voice: {backup}. Used when Kokoro is not set up, fails, or does not cover the language.
    </p>
  );
  if (!k.configured) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Not configured. Set <code className="font-mono text-xs">KOKORO_BASE_URL</code> (for example{" "}
          <code className="break-all font-mono text-xs">http://kokoro:8880</code>) and, if your server needs one,{" "}
          <code className="font-mono text-xs">KOKORO_API_KEY</code>.
        </p>
        {footer}
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      {k.ok ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok" dot>
            Connected · {k.latencyMs} ms
          </Badge>
          <span className="text-muted">{k.voices.length} voices</span>
        </div>
      ) : (
        <>
          <Badge tone="danger" dot>
            Unreachable
          </Badge>
          <Alert tone="danger">
            <p className="break-words font-medium">{k.error}</p>
            {k.hint && <p className="mt-1 break-words">{k.hint}</p>}
          </Alert>
        </>
      )}
      {k.url && <p className="break-all text-xs text-muted">Checked {k.url}</p>}
      {canRecheck && (
        <form action={recheckKokoro}>
          <SubmitButton className="min-h-8 text-xs" pendingLabel="Checking…">
            Check again
          </SubmitButton>
        </form>
      )}
      {k.ok && <TestVoiceForm />}
      {footer}
    </div>
  );
}
