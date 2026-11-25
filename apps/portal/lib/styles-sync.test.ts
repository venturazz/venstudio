/** scripts/sync-styles.mjs: vendoring a styles commit is deterministic, checked, and refuses invalid packs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STYLES = path.join(ROOT, "styles");
interface Lock {
  format: number;
  source: { repo: string; commit: string };
  files: Record<string, string>;
  packs: Array<{ id: string; version: string; status: string; engine: string; sha256: string; files: Record<string, string> }>;
}
const S = (await import(pathToFileURL(path.join(ROOT, "scripts/sync-styles.mjs")).href)) as {
  syncStyles: (o: { from: string; commit?: string; target: string }) => Promise<Lock>;
  checkStyles: (target?: string) => Promise<string[]>;
  VENDORED: string[];
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  }).trim();

/** A scratch styles repo holding the vendored packs, tools, schema and FORMAT.md as one commit. */
function scratchRepo(t: { after: (f: () => void) => void }): { repo: string; commit: string } {
  const repo = mkdtempSync(path.join(os.tmpdir(), "vs-styles-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const name of S.VENDORED) cpSync(path.join(STYLES, name), path.join(repo, name), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "scratch\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "packs");
  return { repo, commit: git(repo, "rev-parse", "HEAD") };
}

test("the committed styles/ matches styles/lock.json and validates", async () => {
  assert.deepEqual(await S.checkStyles(STYLES), []);
  const lock = JSON.parse(readFileSync(path.join(STYLES, "lock.json"), "utf8")) as Lock;
  assert.equal(lock.source.repo, "venturazz/venstudio-styles");
  assert.match(lock.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(lock.packs.map((p) => p.id), [...lock.packs.map((p) => p.id)].sort(), "packs in id order");
});

test("syncing the same commit twice gives the same lock.json bytes, and the packs' hashes match the committed lock", async (t) => {
  const { repo, commit } = scratchRepo(t);
  const target = mkdtempSync(path.join(os.tmpdir(), "vs-styles-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(path.join(target, "README.md"), "venstudio's own note\n");
  await S.syncStyles({ from: repo, commit, target });
  const first = readFileSync(path.join(target, "lock.json"), "utf8");
  await S.syncStyles({ from: repo, commit: "main", target });
  assert.equal(readFileSync(path.join(target, "lock.json"), "utf8"), first);
  const lock = JSON.parse(first) as Lock;
  assert.equal(lock.source.commit, commit);
  const committed = JSON.parse(readFileSync(path.join(STYLES, "lock.json"), "utf8")) as Lock;
  assert.deepEqual(lock.packs, committed.packs, "same files, same pack hashes, whatever commit they came from");
  assert.deepEqual(lock.files, committed.files);
  assert.equal(readFileSync(path.join(target, "README.md"), "utf8"), "venstudio's own note\n", "styles/README.md is venstudio's own");
  assert.deepEqual(await S.checkStyles(target), []);
});

test("the sync copies the commit, not the working tree, and --check catches a hand edit", async (t) => {
  const { repo, commit } = scratchRepo(t);
  const target = mkdtempSync(path.join(os.tmpdir(), "vs-styles-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const readme = path.join(repo, "packs", "horror-narration", "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8") + "\nuncommitted\n");
  await S.syncStyles({ from: repo, commit, target });
  assert.ok(!readFileSync(path.join(target, "packs", "horror-narration", "README.md"), "utf8").includes("uncommitted"));
  writeFileSync(path.join(target, "packs", "horror-narration", "README.md"), "edited by hand ".repeat(30) + "\n## Provenance\n## Status\n");
  const issues = await S.checkStyles(target);
  assert.ok(issues.some((i) => /styles\/packs\/horror-narration differs from lock.json/.test(i)), issues.join("\n"));
});

test("a commit whose packs do not validate is refused and changes nothing", async (t) => {
  const { repo } = scratchRepo(t);
  const file = path.join(repo, "packs", "ambient-loop", "style.json");
  const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...s, status: "listed" }, null, 2));
  git(repo, "commit", "-qam", "list it without the owner");
  const target = mkdtempSync(path.join(os.tmpdir(), "vs-styles-target-"));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(path.join(target, "keep.txt"), "x");
  await assert.rejects(S.syncStyles({ from: repo, target }), /do not validate[\s\S]*owner-approved PR/);
  assert.deepEqual(execFileSync("ls", [target], { encoding: "utf8" }).trim().split("\n"), ["keep.txt"]);
});
