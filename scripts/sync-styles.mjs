#!/usr/bin/env node
/**
 * Vendors the style packs from a local checkout of venturazz/venstudio-styles at one commit, validates them and
 * rewrites styles/lock.json deterministically. The portal reads only this vendored copy (no network, no GitHub token).
 *
 *   node scripts/sync-styles.mjs --from ../venstudio-styles [--commit <rev>]   copy, validate, write styles/lock.json
 *   node scripts/sync-styles.mjs --check                                         styles/ matches lock.json and validates
 *
 * Files come from the commit itself (git ls-tree / git show), never from the working tree, so uncommitted edits in
 * the checkout cannot slip in. Copied: packs/, skills/, tools/, schema/, FORMAT.md. styles/README.md is venstudio's own.
 * lock.json has no timestamps: the same commit always gives the same bytes.
 *
 * Zero dependencies; the validator is the one in the commit being vendored (tools/validate.mjs).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STYLES_DIR = path.join(ROOT, "styles");
export const LOCK_FORMAT = 1;
export const SOURCE_REPO = "venturazz/venstudio-styles";
/** What is vendored from the styles repo. Everything else in it (CI, runtime copy, docs) stays there. */
export const VENDORED = ["packs", "skills", "tools", "schema", "FORMAT.md"];
/** The skill folders (skills/README.md in the styles repo): skills/<status>/<id>/ and skills/kits/<id>/. */
export const SKILL_STATUSES = ["curated", "candidate"];
/** venstudio's own files inside styles/, never replaced by a sync. */
const OWN = ["README.md", "lock.json"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** Files of `dir` relative to it, sorted; dot files skipped. */
function walk(dir, prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...walk(p, rel));
    else out.push(rel);
  }
  return out;
}

/** Sorted-key object of file -> sha256 for the files under `dir` matching `filter`. */
function hashes(dir, files) {
  const out = {};
  for (const rel of [...files].sort()) out[rel] = sha256(readFileSync(path.join(dir, rel)));
  return out;
}

/**
 * The lock for a vendored tree: commit, the non-pack files' hashes, and per pack its version, status, engine,
 * file hashes and pack digest (tools/validate.mjs packDigest). Keys are written in a fixed order.
 */
export function buildLock(dir, commit, validator) {
  const all = walk(dir).filter((f) => !OWN.includes(f));
  const other = all.filter((f) => !f.startsWith("packs/") && !f.startsWith("skills/"));
  const ids = [...new Set(all.filter((f) => f.startsWith("packs/")).map((f) => f.split("/")[1]))].sort();
  const packs = ids.map((id) => {
    const base = path.join(dir, "packs", id);
    const files = hashes(base, walk(base));
    const style = JSON.parse(readFileSync(path.join(base, "style.json"), "utf8"));
    return {
      id,
      version: style.version,
      status: style.status,
      engine: style.renderer?.engine ?? null,
      composition: style.renderer?.composition ?? null,
      sha256: validator.packDigest(files),
      files,
    };
  });
  const lock = { format: LOCK_FORMAT, source: { repo: SOURCE_REPO, commit }, files: hashes(dir, other), packs };
  // Skills and their kits (styles repo skills/README.md): every file hashed, one digest per folder, as for packs.
  const folder = (rel) => {
    const base = path.join(dir, rel);
    const files = hashes(base, walk(base));
    return { files, sha256: validator.packDigest(files) };
  };
  const sub = (rel) => (existsSync(path.join(dir, rel)) ? readdirSync(path.join(dir, rel)).filter((n) => !n.startsWith(".") && statSync(path.join(dir, rel, n)).isDirectory()).sort() : []);
  if (existsSync(path.join(dir, "skills"))) {
    lock.kits = sub("skills/kits").map((id) => {
      const kit = JSON.parse(readFileSync(path.join(dir, "skills/kits", id, "kit.json"), "utf8"));
      return { id, version: kit.version, ...folder(`skills/kits/${id}`) };
    });
    lock.skills = SKILL_STATUSES.flatMap((status) =>
      sub(`skills/${status}`).map((id) => {
        const skill = JSON.parse(readFileSync(path.join(dir, "skills", status, id, "skill.json"), "utf8"));
        return { id, status, version: skill.version, kit: skill.kit ?? null, packs: skill.packs ?? [], ...folder(`skills/${status}/${id}`) };
      }),
    ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Keep the key order stable: files, sha256 last, as packs do.
    lock.kits = lock.kits.map(({ files, sha256, ...k }) => ({ ...k, sha256, files }));
    lock.skills = lock.skills.map(({ files, sha256, ...k }) => ({ ...k, sha256, files }));
  }
  return lock;
}

/** The skills validator of the vendored tree (tools/skills.mjs), or null when that commit has none. */
async function loadSkillsValidator(dir) {
  const file = path.join(dir, "tools", "skills.mjs");
  return existsSync(file) ? import(pathToFileURL(file).href) : null;
}

export const lockText = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

async function loadValidator(dir) {
  return import(pathToFileURL(path.join(dir, "tools", "validate.mjs")).href);
}

/** Copies the vendored paths of `commit` out of the repo at `from` into a fresh temp dir. Refuses symlinks and submodules. */
function extract(from, commit) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "vs-styles-sync-"));
  const listing = git(from, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...VENDORED]).toString("utf8");
  for (const entry of listing.split("\0").filter(Boolean)) {
    const [meta, rel] = entry.split("\t");
    const [mode, type] = meta.split(" ");
    if (type !== "blob" || mode === "120000") throw new Error(`${rel}: only plain files can be vendored (found ${type} ${mode})`);
    if (rel.split("/").some((s) => s === ".." || s === "")) throw new Error(`${rel}: unsafe path`);
    const dest = path.join(tmp, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, git(from, ["show", `${commit}:${rel}`]));
  }
  return tmp;
}

/** Replaces the vendored paths in `target` with those in `src`; venstudio's own files stay. */
function replaceVendored(src, target) {
  mkdirSync(target, { recursive: true });
  for (const name of VENDORED) rmSync(path.join(target, name), { recursive: true, force: true });
  for (const rel of walk(src)) {
    const dest = path.join(target, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(path.join(src, rel)));
  }
}

/**
 * Vendors `commit` of the styles repo at `from` into `target`. Throws, changing nothing, when the commit's packs do
 * not validate. Returns the lock.
 */
export async function syncStyles({ from, commit = "HEAD", target = STYLES_DIR }) {
  const full = git(from, ["rev-parse", "--verify", `${commit}^{commit}`]).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`could not resolve ${commit} in ${from}`);
  const tmp = extract(from, full);
  try {
    const validator = await loadValidator(tmp);
    const { issues } = validator.validateRepo(tmp);
    if (issues.length > 0) throw new Error(`the packs at ${full.slice(0, 12)} do not validate:\n- ${issues.join("\n- ")}`);
    const skills = await loadSkillsValidator(tmp);
    const skillIssues = skills ? skills.validateSkills(tmp).issues : [];
    if (skillIssues.length > 0) throw new Error(`the skills at ${full.slice(0, 12)} do not validate:\n- ${skillIssues.join("\n- ")}`);
    replaceVendored(tmp, target);
    const lock = buildLock(target, full, validator);
    writeFileSync(path.join(target, "lock.json"), lockText(lock));
    return lock;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Problems with the vendored copy: files that differ from lock.json, extra or missing files, invalid packs. */
export async function checkStyles(target = STYLES_DIR) {
  const issues = [];
  const lockFile = path.join(target, "lock.json");
  if (!existsSync(lockFile)) return ["styles/lock.json is missing"];
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  if (lock.format !== LOCK_FORMAT) issues.push(`styles/lock.json format ${lock.format} is not ${LOCK_FORMAT}`);
  const validator = await loadValidator(target);
  const again = buildLock(target, lock.source?.commit ?? "", validator);
  if (lockText(again) !== lockText(lock)) {
    const was = new Map(lock.packs.map((p) => [p.id, p]));
    for (const p of again.packs) if (was.get(p.id)?.sha256 !== p.sha256) issues.push(`styles/packs/${p.id} differs from lock.json (edited by hand? run the sync again)`);
    for (const id of was.keys()) if (!again.packs.some((p) => p.id === id)) issues.push(`styles/packs/${id} is in lock.json but missing`);
    if (JSON.stringify(again.files) !== JSON.stringify(lock.files)) issues.push("styles/tools, styles/schema or styles/FORMAT.md differ from lock.json");
    if (JSON.stringify(again.skills ?? null) !== JSON.stringify(lock.skills ?? null) || JSON.stringify(again.kits ?? null) !== JSON.stringify(lock.kits ?? null)) issues.push("styles/skills differs from lock.json (edited by hand? run the sync again)");
    if (issues.length === 0) issues.push("styles/lock.json is not in its canonical form; run the sync again");
  }
  const { issues: invalid } = validator.validateRepo(target);
  issues.push(...invalid);
  const skills = await loadSkillsValidator(target);
  if (skills) issues.push(...skills.validateSkills(target).issues);
  return issues;
}

/** Runtime files that differ between venstudio's apps/render-remotion and the styles repo's runtime/remotion copy. */
export function runtimeDrift(from) {
  const ours = path.join(ROOT, "apps", "render-remotion");
  const theirs = path.join(from, "runtime", "remotion");
  const out = [];
  if (existsSync(theirs)) {
    const files = ["package.json", "tsconfig.json", "scripts/probe.mjs", "src/index.ts", "src/Root.tsx", "src/compositions.ts", "src/props.ts"];
    out.push(...files.filter((f) => !existsSync(path.join(theirs, f)) || sha256(readFileSync(path.join(ours, f))) !== sha256(readFileSync(path.join(theirs, f)))).map((f) => `runtime/remotion/${f}`));
  }
  // The styles repo renders its html-capture fixtures with a copy of this worker (runtime/html-capture).
  const worker = path.join(from, "runtime", "html-capture", "venstudio-worker.ts");
  if (existsSync(path.join(from, "runtime")) && (!existsSync(worker) || sha256(readFileSync(worker)) !== sha256(readFileSync(path.join(ROOT, "apps", "worker", "venstudio-worker.ts"))))) {
    out.push("runtime/html-capture/venstudio-worker.ts");
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--check")) {
      const issues = await checkStyles();
      if (issues.length > 0) {
        for (const i of issues) console.error(`- ${i}`);
        process.exit(1);
      }
      const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8"));
      console.log(`styles/ matches lock.json (${SOURCE_REPO}@${lock.source.commit.slice(0, 12)}, ${lock.packs.length} packs) and validates`);
    } else {
      const from = path.resolve(arg("--from") ?? path.join(ROOT, "..", "venstudio-styles"));
      const lock = await syncStyles({ from, commit: arg("--commit") ?? "HEAD" });
      console.log(`vendored ${SOURCE_REPO}@${lock.source.commit} into styles/:`);
      for (const p of lock.packs) console.log(`  ${p.id}@${p.version} ${p.status} ${p.engine} ${p.sha256.slice(0, 12)}`);
      for (const k of lock.skills ?? []) console.log(`  skill /${k.id}@${k.version} ${k.status} ${k.sha256.slice(0, 12)}`);
      const drift = runtimeDrift(from);
      if (drift.length > 0) console.warn(`warning: the styles repo's runtime copy differs from apps/render-remotion and apps/worker in ${drift.join(", ")}; refresh it there`);
      console.log(`commit it as: bump styles to ${lock.source.commit.slice(0, 12)}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
