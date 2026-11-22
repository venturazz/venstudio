import "server-only";
import { db } from "./db.ts";
import { deleteAssetRow, finishAssetUpload } from "./assets.ts";
import { saveAsset } from "./storage.ts";
import { PLATE_EXECUTOR, PLATE_LICENCE, PLATE_TITLE, solidPng } from "../studio/plate.ts";

/**
 * The run's plain-colour plate (lib/studio/plate.ts): made once per run, reused by every render attempt. The render
 * contract needs a picture per shot; a scene-spec run generates none, so every shot points at this one file. Its
 * provenance is written here, by the code that drew it: source generated, executor portal-plate, no provider.
 */
export async function ensureRunPlate(run: { id: string; channelId: string | null }, size: { width: number; height: number }): Promise<string> {
  const sql = db();
  const [have] = await sql`
    SELECT id FROM assets
    WHERE metadata->>'runId' = ${run.id} AND metadata->>'executor' = ${PLATE_EXECUTOR} AND storage_path IS NOT NULL
    ORDER BY created_at LIMIT 1
  `;
  if (have) return String(have.id);
  const bytes = solidPng(size.width, size.height);
  const metadata = { executor: PLATE_EXECUTOR, provider: "venstudio-portal", via: "portal", runId: run.id, width: size.width, height: size.height };
  const [row] = await sql`
    INSERT INTO assets (title, kind, source, license, origin_url, tags, channel_id, metadata, created_by)
    VALUES (${PLATE_TITLE}, 'image', 'generated', ${PLATE_LICENCE}, '', '{}'::text[], ${run.channelId}, ${JSON.stringify(metadata)}::text::jsonb, ${null})
    RETURNING id
  `;
  const assetId = String(row.id);
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const saved = await saveAsset(assetId, "plate.png", body);
    await finishAssetUpload(assetId, { contentType: "image/png", bytes: saved.bytes, sha256: saved.sha256, storagePath: saved.storagePath });
    return assetId;
  } catch (err) {
    await deleteAssetRow(assetId).catch(() => {});
    throw err;
  }
}
