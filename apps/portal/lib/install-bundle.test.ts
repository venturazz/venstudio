import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  HTML_PACK_LIST_FILE,
  PACK_INDEX_FILE,
  PACK_LIST_FILE,
  REMOTION_PROJECT_FILES,
  REMOTION_RUNTIME_FILES,
  htmlPackListJson,
  packIndexSource,
  packListJson,
  projectBundle,
  renderDigest,
  type ProjectBundle,
} from "./install-bundle.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

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
  // The runtime alone, plus the generated pack files (no packs: empty lists), html/packs.json among them.
  assert.equal(b.files.length, REMOTION_PROJECT_FILES.length + 3);
  assert.equal(b.files.find((f) => f.path === HTML_PACK_LIST_FILE)?.content, "[]\n");
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

test("html-capture packs travel in the same bundle as html/<id>/ with html/packs.json, and the worker accepts them", async (t) => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/remotion-project.mjs");
  const { remotionBundle } = (await import(pathToFileURL(script).href)) as { remotionBundle: () => ProjectBundle };
  const b = remotionBundle();
  const pageFiles = readdirSync(path.join(STYLES, "packs/probe-line-graph/render")).sort();
  for (const rel of pageFiles) {
    assert.equal(b.files.find((f) => f.path === `html/probe-line-graph/${rel}`)?.content, readFileSync(path.join(STYLES, "packs/probe-line-graph/render", rel), "utf8"), rel);
  }
  const list = JSON.parse(b.files.find((f) => f.path === HTML_PACK_LIST_FILE)!.content) as Array<{ id: string; version: string; drawsCaptions: boolean; sha256: string }>;
  assert.deepEqual(list.map((p) => p.id), ["probe-line-graph"]);
  assert.equal(list[0].drawsCaptions, false);
  // The digest is the styles validator's renderDigest over the lock's hashes, so a worker can check what it installed.
  const lock = JSON.parse(readFileSync(path.join(STYLES, "lock.json"), "utf8")) as { packs: Array<{ id: string; version: string; files: Record<string, string> }> };
  const lp = lock.packs.find((p) => p.id === "probe-line-graph")!;
  const validator = (await import(pathToFileURL(path.join(STYLES, "tools/validate.mjs")).href)) as { renderDigest: (f: Record<string, string>) => string };
  assert.equal(list[0].sha256, validator.renderDigest(lp.files));
  assert.equal(list[0].version, lp.version);
  // Unpacked by the worker's own code, the pack is installed and usable.
  const worker = (await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../worker/venstudio-worker.ts")).href)) as {
    writeProjectBundle: (raw: unknown, dir: string) => Promise<number>;
    installedHtmlPacks: (dir: string) => Promise<{ packs: Array<{ id: string; version: string }>; problems: string[] }>;
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-bundle-html-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await worker.writeProjectBundle(JSON.parse(JSON.stringify(b)), dir);
  const got = await worker.installedHtmlPacks(dir);
  assert.deepEqual(got.problems, []);
  assert.deepEqual(got.packs.map((p) => `${p.id}@${p.version}`), [`probe-line-graph@${lp.version}`]);
});

test("the portal's html list and digest are the styles assembler's, byte for byte", async () => {
  const styles = (await import(pathToFileURL(path.join(STYLES, "tools/assemble-remotion.mjs")).href)) as { htmlPackListJson: (p: unknown[]) => string };
  const validator = (await import(pathToFileURL(path.join(STYLES, "tools/validate.mjs")).href)) as { renderDigest: (f: Record<string, string>) => string };
  const files = [
    { path: "index.html", content: "<!doctype html>" },
    { path: "vendor/x/LICENSE", content: "MIT" },
    { path: "graph.js", content: "window.VENSTUDIO = {};" },
  ];
  const hashes = Object.fromEntries(files.map((f) => [`render/${f.path}`, createHash("sha256").update(f.content).digest("hex")]));
  assert.equal(renderDigest(files), validator.renderDigest({ ...hashes, "style.json": "0".repeat(64) }));
  const packs = [
    { id: "zz-page", version: "1.2.3", drawsCaptions: true, sha256: "a".repeat(64) },
    { id: "probe-line-graph", version: "0.1.0", drawsCaptions: false, sha256: "b".repeat(64) },
  ];
  assert.equal(htmlPackListJson(packs), styles.htmlPackListJson(packs));
  assert.equal(htmlPackListJson([]), styles.htmlPackListJson([]));
});
