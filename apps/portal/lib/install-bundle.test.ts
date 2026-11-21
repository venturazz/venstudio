import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { PACK_INDEX_FILE, PACK_LIST_FILE, REMOTION_PROJECT_FILES, REMOTION_RUNTIME_FILES, packIndexSource, packListJson, projectBundle, type ProjectBundle } from "./install-bundle.ts";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../render-remotion");
const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../styles");

/** Every file in the project that a worker needs: not dependencies, not local probe results. */
function projectFiles(dir = PROJECT, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".") || name === "out") continue;
    const p = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...projectFiles(p, rel));
    else out.push(rel);
  }
  return out;
}

test("the served Remotion bundle lists exactly the project's files", () => {
  assert.deepEqual([...REMOTION_PROJECT_FILES].sort(), projectFiles().sort(), "add new files in apps/render-remotion to REMOTION_PROJECT_FILES");
});

test("projectBundle carries each file's text and the package name", () => {
  const b = projectBundle((p) => readFileSync(path.join(PROJECT, p), "utf8"));
  assert.equal(b.name, "@venstudio/render-remotion");
  // The runtime alone, plus the two generated pack files (no packs: an empty list).
  assert.equal(b.files.length, REMOTION_PROJECT_FILES.length + 2);
  const root = b.files.find((f) => f.path === "src/Root.tsx");
  assert.ok(root?.content.includes("PACK_COMPOSITIONS"), "Root.tsx registers the packs' compositions");
  assert.equal(b.files.find((f) => f.path === PACK_LIST_FILE)?.content, "[]\n");
  for (const f of b.files) assert.ok(!f.path.includes("..") && !path.isAbsolute(f.path), f.path);
});

test("the served bundle loads the flat-vector-explainer composition from the vendored pack", async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/remotion-project.mjs");
  const { remotionBundle } = (await import(pathToFileURL(script).href)) as { remotionBundle: () => ProjectBundle };
  const b = remotionBundle();
  const paths = b.files.map((f) => f.path);
  for (const rel of REMOTION_RUNTIME_FILES) assert.ok(paths.includes(rel), rel);
  for (const rel of ["FlatVectorExplainer.tsx", "elements.tsx", "theme.ts", "index.tsx"]) {
    const served = b.files.find((f) => f.path === `src/packs/explainer-flat-vector/${rel}`);
    assert.equal(served?.content, readFileSync(path.join(STYLES, "packs/explainer-flat-vector/render", rel), "utf8"), rel);
  }
  assert.ok(!paths.includes("src/FlatVectorExplainer.tsx"), "the composition no longer lives in the runtime");
  assert.deepEqual(JSON.parse(b.files.find((f) => f.path === PACK_LIST_FILE)!.content), [{ id: "explainer-flat-vector", version: "1.0.0", composition: "flat-vector-explainer" }]);
  const index = b.files.find((f) => f.path === PACK_INDEX_FILE)!.content;
  assert.match(index, /import \{ composition as pack0 \} from "\.\/explainer-flat-vector\/index\.tsx";/);
  assert.match(b.files.find((f) => f.path === "src/packs/explainer-flat-vector/index.tsx")!.content, /id: "flat-vector-explainer"/);
});

test("the portal's bundle builder and the styles repo's assembler write the same generated files", async () => {
  const styles = (await import(pathToFileURL(path.join(STYLES, "tools/assemble-remotion.mjs")).href)) as {
    packIndexSource: (p: unknown[]) => string;
    packListJson: (p: unknown[]) => string;
    RUNTIME_FILES: string[];
  };
  const packs = [
    { id: "zeta-pack", version: "2.1.0", composition: "zeta" },
    { id: "explainer-flat-vector", version: "1.0.0", composition: "flat-vector-explainer" },
  ];
  assert.equal(packIndexSource(packs), styles.packIndexSource(packs));
  assert.equal(packListJson(packs), styles.packListJson(packs));
  assert.equal(packIndexSource([]), styles.packIndexSource([]));
  assert.deepEqual(styles.RUNTIME_FILES, [...REMOTION_RUNTIME_FILES]);
});
