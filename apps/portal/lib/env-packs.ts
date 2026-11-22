/**
 * /install/env-packs.json: the packs with an environment (engine command and any pack that declares one), with all
 * their files, for worker 0.12.0+. Pure.
 *
 * It travels like the style packs index: listed with its sha256 in the signed update manifest (only for a worker that
 * reports the file, so 0.11.0 and older never see a name they would refuse), downloaded from /install/ and verified
 * before it is used. The worker checks every pack's files against its digest (the sha256 in styles/lock.json, the
 * styles validator's packDigest over every file) before it writes them to <home>/packs/<id>@<version>/. Nothing in
 * it runs on arrival: the worker installs each environment later, between jobs, and reports it only after its probe.
 * The worker's reader is venstudio-worker.ts parseEnvPacksBundle; tests keep the two in step.
 */

export const ENV_PACKS_FILE_NAME = "env-packs.json";
export const ENV_PACKS_KIND = "venstudio-env-packs";
export const ENV_PACKS_FORMAT = 1;

export interface EnvPacksBundle {
  format: typeof ENV_PACKS_FORMAT;
  kind: typeof ENV_PACKS_KIND;
  commit: string | null;
  packs: Array<{ id: string; version: string; sha256: string; files: Array<{ path: string; text: string }> }>;
}

export function envPacksBundle(input: {
  commit: string | null;
  packs: ReadonlyArray<{ id: string; version: string; sha256: string; files: ReadonlyMap<string, string> }>;
}): EnvPacksBundle {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    format: ENV_PACKS_FORMAT,
    kind: ENV_PACKS_KIND,
    commit: input.commit,
    packs: [...input.packs]
      .sort((a, b) => byName(a.id, b.id))
      .map((p) => ({
        id: p.id,
        version: p.version,
        sha256: p.sha256,
        files: [...p.files.keys()].sort(byName).map((path) => ({ path, text: p.files.get(path) as string })),
      })),
  };
}

/** The served bytes: stable for the same packs. */
export function envPacksText(bundle: EnvPacksBundle): string {
  return `${JSON.stringify(bundle)}\n`;
}
