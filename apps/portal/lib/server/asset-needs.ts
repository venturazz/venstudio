import "server-only";
import { db } from "./db.ts";
import type { AssetNeed } from "../studio/asset-needs.ts";

/**
 * Records what a run wanted and did not get, and lists what is still open.
 *
 * Deliberately non-fatal: bookkeeping must never break a render. A run that cannot record its need still produces its
 * video; the library just learns a little later.
 */
export async function recordNeeds(needs: readonly AssetNeed[]): Promise<void> {
  for (const n of needs) {
    await db()`
      INSERT INTO asset_needs (asset_class, tag, note)
      VALUES (${n.assetClass}, ${n.tag.toLowerCase()}, ${n.reason})
      ON CONFLICT (asset_class, tag) DO UPDATE
        SET videos = asset_needs.videos + 1,
            last_seen = now(),
            note = EXCLUDED.note,
            resolved_at = NULL
    `.catch(() => undefined);
  }
}

export interface OpenNeed {
  assetClass: "music" | "sfx" | "ambience";
  tag: string;
  videos: number;
  note: string;
  lastSeen: string;
}

/** Open needs, most blocking first: the finder's work order. */
export async function listOpenNeeds(limit = 50): Promise<OpenNeed[]> {
  const rows = await db()`
    SELECT asset_class, tag, videos, note, last_seen
    FROM asset_needs
    WHERE resolved_at IS NULL
    ORDER BY videos DESC, last_seen DESC
    LIMIT ${limit}
  `.catch(() => [] as Array<Record<string, unknown>>);
  return rows.map((r) => ({
    assetClass: r.asset_class as OpenNeed["assetClass"],
    tag: String(r.tag),
    videos: Number(r.videos),
    note: String(r.note ?? ""),
    lastSeen: String(r.last_seen),
  }));
}

/** Called by the finder once an asset with that class and tag is in the library. */
export async function resolveNeed(assetClass: string, tag: string, assetId: string | null): Promise<void> {
  await db()`
    UPDATE asset_needs SET resolved_at = now(), resolved_asset_id = ${assetId}
    WHERE asset_class = ${assetClass} AND tag = ${tag.toLowerCase()} AND resolved_at IS NULL
  `.catch(() => undefined);
}
