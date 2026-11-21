/**
 * The Remotion project, as one JSON file the portal serves at /install/render-remotion.json. Pure.
 *
 * Muse VMs cannot read the private GitHub repo, so the portal already serves the worker itself. The Remotion
 * renderer travels the same way: install.sh --with-remotion downloads this bundle, the worker's `unpack-bundle`
 * writes it out, and npm installs the dependencies from the registry. A signed update replaces it the same way.
 *
 * The project is the shared runtime (apps/render-remotion: package, root, shared props, probe) plus the render
 * project of every vendored remotion-2d style pack (styles/packs/<id>/render/), installed as src/packs/<id>/, and two
 * generated files: src/packs/index.ts, which Root.tsx registers, and src/packs/packs.json, which the probe and the
 * worker read. The runtime list is explicit, so nothing outside the project (and nothing like node_modules) can be
 * served; install-bundle.test.ts fails when a runtime file is missing from it.
 */

export const REMOTION_BUNDLE_NAME = "render-remotion.json";

/** The shared runtime: no look of its own; every composition comes from a pack. */
export const REMOTION_RUNTIME_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "scripts/probe.mjs",
  "src/index.ts",
  "src/Root.tsx",
  "src/compositions.ts",
  "src/props.ts",
];
/** Kept for callers that predate packs: the runtime files. */
export const REMOTION_PROJECT_FILES = REMOTION_RUNTIME_FILES;

/** Where the packs go inside the project, and the two generated files. */
export const PACKS_SRC_DIR = "src/packs";
export const PACK_INDEX_FILE = `${PACKS_SRC_DIR}/index.ts`;
export const PACK_LIST_FILE = `${PACKS_SRC_DIR}/packs.json`;

/** A remotion-2d pack's render project: its files relative to render/. */
export interface RemotionPackSource {
  id: string;
  version: string;
  composition: string;
  files: ReadonlyArray<{ path: string; content: string }>;
}

export interface ProjectBundle {
  name: string;
  version: string;
  files: Array<{ path: string; content: string }>;
}

const byId = <T extends { id: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** src/packs/index.ts: imports each pack's `composition`, in pack id order. Same text as the styles repo's assembler. */
export function packIndexSource(packs: ReadonlyArray<Pick<RemotionPackSource, "id">>): string {
  const sorted = byId(packs);
  const lines = [
    "// Generated from the installed style packs. Do not edit: the bundle builder writes it.",
    'import type { PackComposition } from "../compositions.ts";',
    ...sorted.map((p, i) => `import { composition as pack${i} } from "./${p.id}/index.tsx";`),
    "",
    `export const PACK_COMPOSITIONS: readonly PackComposition[] = [${sorted.map((_, i) => `pack${i}`).join(", ")}];`,
    "",
  ];
  return lines.join("\n");
}

/** src/packs/packs.json: what the probe renders and the worker maps templates with. */
export function packListJson(packs: ReadonlyArray<Pick<RemotionPackSource, "id" | "version" | "composition">>): string {
  return `${JSON.stringify(byId(packs).map((p) => ({ id: p.id, version: p.version, composition: p.composition })), null, 2)}\n`;
}

/** Builds the bundle from a reader of runtime files (relative path to text) and the packs' render projects. */
export function projectBundle(read: (relativePath: string) => string, packs: readonly RemotionPackSource[] = []): ProjectBundle {
  const pkg = JSON.parse(read("package.json")) as { name?: string; version?: string };
  const files: Array<{ path: string; content: string }> = REMOTION_RUNTIME_FILES.map((p) => ({ path: p, content: read(p) }));
  for (const pack of byId(packs)) {
    for (const f of [...pack.files].sort((a, b) => (a.path < b.path ? -1 : 1))) files.push({ path: `${PACKS_SRC_DIR}/${pack.id}/${f.path}`, content: f.content });
  }
  files.push({ path: PACK_INDEX_FILE, content: packIndexSource(packs) });
  files.push({ path: PACK_LIST_FILE, content: packListJson(packs) });
  return { name: pkg.name ?? "render-remotion", version: pkg.version ?? "0.0.0", files };
}
