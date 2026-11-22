import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { deleteAssetRow, finishAssetUpload } from "./assets.ts";
import { saveAsset } from "./storage.ts";
import { PAGE_EXECUTOR, PAGE_LICENCE, pageBundle, type HtmlDesign } from "../studio/html-design.ts";

/**
 * The page Hermes wrote for an html-design run, stored as the run's html-page asset (migration 0020): the page bundle
 * the worker downloads for the preview and the render. One asset per run and page (keyed by the bundle's sha256), so a
 * retried preview or render reuses it and a revised page gets its own. Stored as application/json, never as text/html:
 * the portal serves assets inline from its own origin, so the page is never a document there. Its provenance is
 * written here: source hermes, executor hermes-html-design, research only, the backend and plugin Hermes named.
 */
export async function ensureRunPage(run: { id: string; channelId: string | null; topic: string }, design: HtmlDesign, from: { stageId: string; attempt: number }): Promise<string> {
  const sql = db();
  const text = pageBundle(design);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const [have] = await sql`
    SELECT id FROM assets
    WHERE kind = 'html-page' AND metadata->>'runId' = ${run.id} AND metadata->>'pageSha256' = ${sha256} AND storage_path IS NOT NULL
    ORDER BY created_at LIMIT 1
  `;
  if (have) return String(have.id);
  const metadata = {
    executor: PAGE_EXECUTOR,
    provider: "hermes",
    backend: design.backend ?? "hermes-agent",
    ...(design.plugin ? { plugin: design.plugin } : {}),
    via: "hermes-gate",
    runId: run.id,
    stageId: from.stageId,
    stageAttempt: from.attempt,
    pageSha256: sha256,
    files: design.files.map((f) => f.path),
    researchOnly: true,
    generatedAt: new Date().toISOString(),
  };
  const title = `${run.topic || "Video"} (page Hermes designed, research only)`.slice(0, 200);
  const [row] = await sql`
    INSERT INTO assets (title, kind, source, license, origin_url, tags, channel_id, metadata, created_by)
    VALUES (${title}, 'html-page', 'hermes', ${PAGE_LICENCE}, '', '{}'::text[], ${run.channelId}, ${JSON.stringify(metadata)}::text::jsonb, ${null})
    RETURNING id
  `;
  const assetId = String(row.id);
  try {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const saved = await saveAsset(assetId, "page.json", body);
    await finishAssetUpload(assetId, { contentType: "application/json", bytes: saved.bytes, sha256: saved.sha256, storagePath: saved.storagePath });
    return assetId;
  } catch (err) {
    await deleteAssetRow(assetId).catch(() => {});
    throw err;
  }
}
