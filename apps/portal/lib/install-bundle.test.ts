import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTION_PROJECT_FILES, projectBundle } from "./install-bundle.ts";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../render-remotion");

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
  assert.equal(b.files.length, REMOTION_PROJECT_FILES.length);
  const root = b.files.find((f) => f.path === "src/Root.tsx");
  assert.ok(root?.content.includes('id="flat-vector-explainer"'));
  for (const f of b.files) assert.ok(!f.path.includes("..") && !path.isAbsolute(f.path), f.path);
});
