/**
 * The vendored style pack validator (styles/tools/validate.mjs, copied from venturazz/venstudio-styles by
 * scripts/sync-styles.mjs) run against the vendored packs. The styles repo has the same tests on its side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../styles");
interface Validator {
  validateStyle: (s: unknown, o?: { dirName?: string }) => string[];
  validateRepo: (root: string) => { packs: Array<{ id: string }>; issues: string[] };
  findDuplicates: (e: Array<{ id: string; composition?: string | null }>) => string[];
  OPTIONAL_TOP_KEYS: string[];
}
const V = (await import(pathToFileURL(path.join(STYLES, "tools/validate.mjs")).href)) as Validator;
const load = (id: string) => JSON.parse(readFileSync(path.join(STYLES, "packs", id, "style.json"), "utf8")) as Record<string, any>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const has = (issues: string[], re: RegExp) => issues.some((i) => re.test(i));

test("the vendored packs are valid", () => {
  const { packs, issues } = V.validateRepo(STYLES);
  assert.deepEqual(issues, []);
  // 13 packs (the html-design pack and the first engine command pack among them), plus one Hermes research pack per
  // claude-animation-skills skill (ten; zach-3d-films is an alias).
  assert.equal(packs.length, 23);
  assert.equal(packs.filter((p: { id: string }) => p.id.startsWith("hermes-") && !["hermes-research-explainer", "hermes-designed-explainer"].includes(p.id)).length, 10);
});

test("every required field is required", () => {
  const good = load("explainer-flat-vector");
  assert.deepEqual(V.validateStyle(good, { dirName: "explainer-flat-vector" }), []);
  for (const k of Object.keys(good).filter((k) => !V.OPTIONAL_TOP_KEYS.includes(k))) {
    const s = clone(good);
    delete s[k];
    assert.ok(V.validateStyle(s).length > 0, `missing ${k} accepted`);
  }
});

test("a bad status is refused", () => {
  assert.ok(has(V.validateStyle({ ...load("horror-story"), status: "published" }), /status must be one of draft, lab, trial, proven, listed, retired/));
  assert.ok(has(V.validateStyle({ ...load("horror-story"), status: "listed" }), /owner-approved PR/), "listed needs the owner's approval");
});

test("a bad renderer is refused", () => {
  const s = load("documentary-stills");
  assert.ok(has(V.validateStyle({ ...s, renderer: { ...s.renderer, engine: "premiere" } }), /renderer.engine must be one of/));
  assert.ok(has(V.validateStyle({ ...s, renderer: { ...s.renderer, engine: "remotion-2d" } }), /renderer.composition must name/));
  assert.ok(has(V.validateStyle({ ...s, renderer: { ...s.renderer, engine: "godot-2d" } }), /no worker can run godot-2d yet/));
});

test("provenance without a licence is refused", () => {
  const s = clone(load("ambient-loop"));
  delete s.provenance[0].licence;
  assert.ok(has(V.validateStyle(s), /provenance\[0\]\.licence must record/));
  assert.ok(has(V.validateStyle({ ...load("ambient-loop"), provenance: [] }), /provenance must list/));
});

test("duplicate ids are refused", (t) => {
  assert.deepEqual(V.findDuplicates([{ id: "a" }, { id: "a" }]), ['duplicate pack id "a"']);
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-validator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(STYLES, "packs", "travel-documentary"), path.join(dir, "packs", "travel-documentary"), { recursive: true });
  cpSync(path.join(STYLES, "packs", "travel-documentary"), path.join(dir, "packs", "travel-copy"), { recursive: true });
  const { issues } = V.validateRepo(dir);
  assert.ok(has(issues, /duplicate pack id "travel-documentary"/), issues.join("\n"));
  assert.ok(has(issues, /must equal the pack directory name "travel-copy"/));
  writeFileSync(path.join(dir, "packs", "travel-copy", "style.json"), "{ not json");
  assert.ok(has(V.validateRepo(dir).issues, /style.json is not JSON/));
});
