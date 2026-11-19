import { routerImageOverview } from "@/lib/server/executors/router-image.ts";
import { listEndpointHealth } from "@/lib/server/endpoint-health.ts";
import { findHealth, proofOf, proofText } from "@/lib/studio/endpoint-health.ts";
import { timeAgo } from "@/components/ui.tsx";

/**
 * Async server component; wrap in <Suspense>. Reads the stored capability scan and endpoint health only, so it never
 * waits on 9router or Hermes. A 9router image model is used only after a real call proved it.
 */
export async function RouterImageNote() {
  const { models, health, proven } = await routerImageOverview();
  const now = Date.now();
  const hermesRows = (await listEndpointHealth("image")).filter((h) => h.endpoint === "hermes").slice(0, 8);
  return (
    <div className="mb-3 space-y-2 text-sm text-muted">
      <p>
        {models.length === 0
          ? "9router lists no image models in the last scan, so after Hermes the studio goes to the public-domain library."
          : proven
            ? `If Hermes cannot make a picture, the studio asks 9router next with ${proven.id}, the model a real call proved.`
            : "9router lists image models, but none is proven by a real call yet, so the studio does not use them. Press Test 9router image to try them."}
      </p>
      {models.length > 0 && (
        <ul className="space-y-1" data-testid="router-image-health">
          {models.slice(0, 8).map((m) => {
            const h = findHealth(health, "9router", m.id, "image");
            const proof = proofOf(h, now);
            return (
              <li key={m.id} className="break-words text-xs" data-proof={proof}>
                <span className="font-medium text-fg">{m.id}</span>: {proofText(proof)}
                {proof === "quarantined" && h?.lastError ? ` (${h.lastError})` : ""}
                {proof === "proven" && h?.lastSuccessAt ? `, last worked ${timeAgo(new Date(h.lastSuccessAt))}` : ""}
              </li>
            );
          })}
        </ul>
      )}
      {hermesRows.length > 0 && (
        <p className="break-words text-xs">
          Hermes providers seen in real calls (Hermes&apos;s own report):{" "}
          {hermesRows
            .map((h) => `${h.model} ${h.lastSuccessAt !== null && (h.lastFailureAt === null || h.lastSuccessAt >= h.lastFailureAt) ? "worked" : "failed"}`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}
