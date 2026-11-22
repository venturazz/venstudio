import "server-only";
import { createHash } from "node:crypto";
import { db } from "../db.ts";
import { deleteAssetRow, finishAssetUpload } from "../assets.ts";
import { saveAsset } from "../storage.ts";
import {
  buildProvenance,
  normalizeProvider,
  type CommercialOk,
  type ProvenanceExecutor,
  type ProviderKind,
  type ProviderTerms,
} from "../../studio/asset-plan.ts";
import type { AssetKind } from "../../studio/catalog.ts";

export interface GeneratedAssetInput {
  bytes: Uint8Array;
  /** Safe file name with the right extension, for example shot-01.png. */
  name: string;
  contentType: string;
  kind: AssetKind;
  executor: ProvenanceExecutor;
  title: string;
  /** Provider as reported by the executor. Normalised here. */
  provider: string;
  /** Hermes: the backend that really made the file. Named in the licence and kept in metadata. */
  backend?: string;
  /** Hermes: the plugin in front of the backend. Kept in metadata and named in the licence. */
  plugin?: string;
  model?: string;
  prompt?: string;
  originUrl?: string;
  /** Required for the CC0 library: the licence statement that was checked. */
  licence?: string;
  runId?: string | null;
  workOrderId?: string | null;
  shotRef?: string;
  channelId?: string | null;
  createdBy?: string | null;
  /** Hermes render of a research pack: the Hermes skill it was asked to render with (e.g. "/graph"). Kept in metadata. */
  hermesSkill?: string | null;
}

export interface SavedAsset {
  assetId: string;
  provider: string;
  providerKind: ProviderKind;
  sha256: string;
  bytes: number;
}

/** Makes a file name that passes storage's name check. */
export function safeFileName(base: string, ext: string): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/\.+/g, "-").slice(0, 60) || "asset";
  return `${stem}.${ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin"}`;
}

/** First time a provider is seen it is added as "unknown". An existing row is never changed here. */
export async function ensureProvider(name: string, kind: ProviderKind): Promise<void> {
  await db()`
    INSERT INTO asset_providers (name, kind) VALUES (${normalizeProvider(name)}, ${kind})
    ON CONFLICT (name, kind) DO NOTHING
  `;
}

export async function listProviderTerms(): Promise<ProviderTerms[]> {
  const rows = await db()`SELECT name, kind, commercial_ok, note FROM asset_providers ORDER BY kind, name`;
  return rows.map((r): ProviderTerms => ({
    name: String(r.name),
    kind: r.kind as ProviderKind,
    commercialOk: r.commercial_ok as CommercialOk,
    note: String(r.note ?? ""),
  }));
}

/**
 * The Hermes plugins each provider row was made through, read from the saved assets' metadata (`plugin`). For the
 * Settings list only. An unreadable table gives an empty map.
 */
export async function listProviderPlugins(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const rows = await db()`
      SELECT metadata->>'provider' AS provider, metadata->>'providerKind' AS kind, array_agg(DISTINCT metadata->>'plugin') AS plugins
      FROM assets
      WHERE metadata ? 'plugin' AND metadata ? 'provider'
      GROUP BY 1, 2
      LIMIT 500
    `;
    for (const r of rows) {
      const provider = typeof r.provider === "string" ? r.provider : "";
      const kind = typeof r.kind === "string" ? r.kind : "";
      const plugins = Array.isArray(r.plugins) ? (r.plugins as unknown[]).filter((p): p is string => typeof p === "string" && p !== "") : [];
      if (provider && kind && plugins.length > 0) out.set(`${kind}:${provider}`, plugins.slice(0, 5));
    }
  } catch (err) {
    console.error("could not read provider plugins", err);
  }
  return out;
}

/**
 * Stores an asset the studio made itself. The licence, source and origin come from buildProvenance (code that knows
 * which executor ran), never from text a model wrote. The provider is registered as "unknown" until the owner
 * confirms its terms in Settings.
 */
export async function saveGeneratedAsset(input: GeneratedAssetInput): Promise<SavedAsset> {
  const built = buildProvenance({
    executor: input.executor,
    title: input.title,
    kind: input.kind,
    provider: input.provider,
    backend: input.backend,
    plugin: input.plugin,
    model: input.model,
    prompt: input.prompt,
    originUrl: input.originUrl,
    licence: input.licence,
    shotRef: input.shotRef,
  });
  const promptSha256 = input.prompt ? createHash("sha256").update(input.prompt).digest("hex") : null;
  const metadata: Record<string, unknown> = {
    ...built.metadata,
    runId: input.runId ?? null,
    workOrderId: input.workOrderId ?? null,
    promptSha256,
    generatedAt: new Date().toISOString(),
    ...(input.hermesSkill ? { hermesSkill: input.hermesSkill.slice(0, 64) } : {}),
  };
  delete metadata.prompt;

  const [row] = await db()`
    INSERT INTO assets (title, kind, source, license, origin_url, tags, channel_id, metadata, created_by)
    VALUES (${built.record.title.slice(0, 200)}, ${built.record.kind}, ${built.record.source}, ${built.record.license},
            ${built.record.originUrl}, '{}'::text[], ${input.channelId ?? null},
            ${JSON.stringify(metadata)}::text::jsonb, ${input.createdBy ?? null})
    RETURNING id
  `;
  const assetId = String(row.id);
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input.bytes);
        controller.close();
      },
    });
    const saved = await saveAsset(assetId, input.name, body);
    await finishAssetUpload(assetId, { contentType: input.contentType, bytes: saved.bytes, sha256: saved.sha256, storagePath: saved.storagePath });
    await ensureProvider(built.provider, built.providerKind);
    return { assetId, provider: built.provider, providerKind: built.providerKind, sha256: saved.sha256, bytes: saved.bytes };
  } catch (err) {
    await deleteAssetRow(assetId).catch(() => {});
    throw err;
  }
}
