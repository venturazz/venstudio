import { gatewayStatus } from "@/lib/server/ai-gateway.ts";
import { Alert, Badge } from "./ui.tsx";
import { SubmitButton } from "./client.tsx";
import { recheckGateway } from "@/app/(app)/gateway-actions.ts";

/** Async server component; wrap in <Suspense> so pages render without waiting for 9router. */
export async function GatewayPanel({ showModels = false, canRecheck = false }: { showModels?: boolean; canRecheck?: boolean }) {
  const g = await gatewayStatus();
  const recheck = canRecheck && g.configured && (
    <form action={recheckGateway}>
      <SubmitButton className="min-h-8 text-xs" pendingLabel="Checking…">
        Check again
      </SubmitButton>
    </form>
  );

  if (!g.configured) {
    return (
      <p className="text-sm text-muted">
        Not configured. Set <code className="font-mono text-xs">NINEROUTER_BASE_URL</code> and{" "}
        <code className="font-mono text-xs">NINEROUTER_API_KEY</code>.
      </p>
    );
  }
  if (g.ok) {
    return (
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="ok" dot>
            Connected · {g.latencyMs} ms
          </Badge>
          <span className="text-muted">{g.models.length} models</span>
        </div>
        {showModels && (
          <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
            {g.models.map((m) => (
              <Badge key={m}>{m}</Badge>
            ))}
          </div>
        )}
        {recheck}
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <Badge tone="danger" dot>
        Unreachable
      </Badge>
      <Alert tone="danger">
        <p className="font-medium">{g.error}</p>
        {g.hint && <p className="mt-1">{g.hint}</p>}
      </Alert>
      <p className="break-all text-xs text-muted">
        Tried: <code className="font-mono">{g.url}</code>
        {g.checkedAt && <> · checked {new Date(g.checkedAt).toLocaleTimeString()}</>}
      </p>
      {recheck}
    </div>
  );
}

export function GatewayPanelFallback() {
  return <p className="text-sm text-muted">Checking 9router…</p>;
}
