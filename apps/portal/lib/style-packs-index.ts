/**
 * /install/style-packs.json: the index of the vendored style packs that workers install. Pure.
 *
 * It travels like the worker file and the Remotion bundle: listed with its sha256 in the signed update manifest
 * (update-manifest.ts), downloaded from /install/ and verified before it is used, and also fetched by install.sh.
 * A worker (0.9.0+) reports pack:<id>@<version> for each entry whose renderer probe passes on that machine. The
 * worker carries its own reader of this format (venstudio-worker.ts parsePacksIndex); tests keep the two in step.
 */

export const PACKS_FILE_NAME = "style-packs.json";
export const PACKS_INDEX_FORMAT = 1;

export interface PacksIndexEntry {
  id: string;
  version: string;
  status: string;
  engine: string;
  minWorkerVersion: string;
  composition: string | null;
  /** Pack digest from styles/lock.json. */
  sha256: string;
  /**
   * The environment the pack needs, `<id>@<version>` (worker 0.12.0+ reports the pack only once it is ready). Present
   * only for packs with an environment, so the bytes for every other pack stay what they were.
   */
  environment?: string;
}

export interface PacksIndex {
  format: typeof PACKS_INDEX_FORMAT;
  /** The venstudio-styles commit the packs were vendored from. */
  commit: string | null;
  packs: PacksIndexEntry[];
}

export function packsIndex(input: {
  commit: string | null;
  packs: ReadonlyArray<{ id: string; version: string; status: string; engine: string; minWorkerVersion: string; composition: string | null; sha256: string; environment?: { id: string; version: string } | null }>;
}): PacksIndex {
  return {
    format: PACKS_INDEX_FORMAT,
    commit: input.commit,
    packs: [...input.packs]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({
        id: p.id,
        version: p.version,
        status: p.status,
        engine: p.engine,
        minWorkerVersion: p.minWorkerVersion,
        composition: p.composition,
        sha256: p.sha256,
        ...(p.environment ? { environment: `${p.environment.id}@${p.environment.version}` } : {}),
      })),
  };
}

/** The served bytes: stable for the same packs, so the manifest hash only changes when a pack does. */
export function packsIndexText(index: PacksIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
