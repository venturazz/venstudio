/**
 * The Remotion project, as one JSON file the portal serves at /install/render-remotion.json. Pure.
 *
 * Muse VMs cannot read the private GitHub repo, so the portal already serves the worker itself. The Remotion
 * templates travel the same way: install.sh --with-remotion downloads this bundle, the worker's `unpack-bundle`
 * writes it out, and npm installs the dependencies from the registry. The list is explicit, so nothing outside the
 * project (and nothing like node_modules) can be served; install-bundle.test.ts fails when a project file is missing
 * from it.
 */

export const REMOTION_BUNDLE_NAME = "render-remotion.json";

export const REMOTION_PROJECT_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "scripts/probe.mjs",
  "src/index.ts",
  "src/Root.tsx",
  "src/FlatVectorExplainer.tsx",
  "src/elements.tsx",
  "src/props.ts",
  "src/theme.ts",
];

export interface ProjectBundle {
  name: string;
  version: string;
  files: Array<{ path: string; content: string }>;
}

/** Builds the bundle from a reader of project files (relative path to text). */
export function projectBundle(read: (relativePath: string) => string): ProjectBundle {
  const pkg = JSON.parse(read("package.json")) as { name?: string; version?: string };
  return {
    name: pkg.name ?? "render-remotion",
    version: pkg.version ?? "0.0.0",
    files: REMOTION_PROJECT_FILES.map((p) => ({ path: p, content: read(p) })),
  };
}
