/**
 * The block names the installed map knows, for the shape check.
 *
 * Server only, and deliberately not in `lib/studio/voxel.ts`: that module is imported by the run and review cards, and a
 * `node:fs` import there breaks the browser bundle ("the chunking context does not support external modules").
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const CACHE = new Map<string, Set<string> | undefined>();

/** The pack's blockmap as a set, or undefined when the pack ships none (shape checks still run, materials are not checked). */
export function knownMaterials(packId: string): Set<string> | undefined {
  if (CACHE.has(packId)) return CACHE.get(packId);
  let set: Set<string> | undefined;
  try {
    const file = path.resolve(import.meta.dirname, "../../../styles/packs", packId, "render/assets/vendor/blockmap.json");
    set = new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>));
  } catch {
    set = undefined;
  }
  CACHE.set(packId, set);
  return set;
}
