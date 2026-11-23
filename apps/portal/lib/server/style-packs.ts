import "server-only";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { STYLES } from "../studio/catalog.ts";
import { isResearchRecipe } from "../studio/recipes.ts";
import { mergeRegistry, packSeedTemplate, parsePack, type OwnerDecision, type RegistryEntry, type StylePack, type TrialGate, type TrialOutcome } from "../studio/style-registry.ts";
import { packsIndex, type PacksIndex } from "../style-packs-index.ts";
import { envPacksBundle, type EnvPacksBundle } from "../env-packs.ts";
import { readAdvisory, readRubric } from "../studio/presentation.ts";
import type { HtmlPackSource, RemotionPackSource } from "../install-bundle.ts";
import type { Template } from "../studio/templates.ts";

/**
 * The vendored style packs (styles/ and styles/lock.json, written by scripts/sync-styles.mjs), read from disk once
 * per process: at start, never from the network. Every file is checked against its sha256 in lock.json; a pack whose
 * files differ is left out and logged, so a hand-edited copy is never served or offered.
 *
 * Where styles/ is: next to the worker files the portal already serves. In the repo WORKER_DIR is apps/worker and the
 * packs are at the repo root (../../styles); in the image WORKER_DIR is /app/worker and the Dockerfile copies them to
 * /app/styles (../styles). The first of the two with a lock.json wins.
 */

interface LockPack {
  id: string;
  version: string;
  status: string;
  engine: string | null;
  composition: string | null;
  sha256: string;
  files: Record<string, string>;
}
interface Lock {
  format: number;
  source: { repo: string; commit: string };
  packs: LockPack[];
}

export interface VendoredStyles {
  dir: string | null;
  commit: string | null;
  packs: StylePack[];
  /** Pack files by pack id, verified against lock.json (relative path to text). */
  files: Map<string, Map<string, string>>;
  problems: string[];
}

export function stylesDir(): string | null {
  const workerDir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().WORKER_DIR);
  for (const rel of ["../styles", "../../styles"]) {
    const dir = path.resolve(/*turbopackIgnore: true*/ workerDir, rel);
    if (existsSync(path.join(/*turbopackIgnore: true*/ dir, "lock.json"))) return dir;
  }
  return null;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function load(): Promise<VendoredStyles> {
  const dir = stylesDir();
  const out: VendoredStyles = { dir, commit: null, packs: [], files: new Map(), problems: [] };
  if (!dir) {
    out.problems.push("styles/lock.json was not found next to the worker files; no style packs are available");
    return out;
  }
  let lock: Lock;
  try {
    lock = JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ dir, "lock.json"), "utf8")) as Lock;
  } catch (err) {
    out.problems.push(`styles/lock.json could not be read: ${(err as Error).message}`);
    return out;
  }
  if (lock.format !== 1 || !Array.isArray(lock.packs)) {
    out.problems.push(`styles/lock.json has format ${String(lock.format)}; this portal reads format 1`);
    return out;
  }
  out.commit = typeof lock.source?.commit === "string" ? lock.source.commit : null;
  for (const lp of lock.packs) {
    const base = path.join(/*turbopackIgnore: true*/ dir, "packs", lp.id);
    const texts = new Map<string, string>();
    let bad = "";
    for (const [rel, want] of Object.entries(lp.files ?? {})) {
      if (rel.split("/").some((s) => s === ".." || s === "")) {
        bad = `${rel} has an unsafe path`;
        break;
      }
      const body = await readFile(path.join(/*turbopackIgnore: true*/ base, rel)).catch(() => null);
      if (!body || sha(body) !== want) {
        bad = `${rel} ${body ? "differs from" : "is missing, listed in"} lock.json`;
        break;
      }
      texts.set(rel, body.toString("utf8"));
    }
    const pack = bad ? null : parsePack(JSON.parse(texts.get("style.json") ?? "null") as unknown, lp.sha256);
    if (!pack || pack.version !== lp.version) {
      out.problems.push(`style pack ${lp.id} left out: ${bad || "its style.json is not usable by this portal"}`);
      continue;
    }
    out.packs.push(pack);
    out.files.set(pack.id, texts);
  }
  for (const p of out.problems) console.error(p);
  return out;
}

let cached: Promise<VendoredStyles> | undefined;

/** The vendored packs, loaded once per process. A load that found no styles/ is not kept, so it is tried again. */
export function vendoredStyles(): Promise<VendoredStyles> {
  const p = (cached ??= load());
  void p.then((v) => {
    if (v.dir === null && cached === p) cached = undefined;
  });
  return p;
}

/** The registry: catalogue merged with the vendored packs. */
export async function styleRegistry(): Promise<RegistryEntry[]> {
  return mergeRegistry(STYLES, (await vendoredStyles()).packs);
}

export async function registryEntry(styleId: string): Promise<RegistryEntry | undefined> {
  return (await styleRegistry()).find((e) => e.id === styleId);
}

/**
 * Seed templates for the vendored packs the catalogue does not know (tpl-<id>, from the pack's contract), so every
 * pack can be offered and started like a catalogue style. Retired packs get none.
 */
export async function packSeedTemplates(): Promise<Template[]> {
  return (await styleRegistry()).flatMap((e) => (e.pack && !e.catalogued && e.pack.status !== "retired" ? [packSeedTemplate(e.pack)] : []));
}

/** A vendored pack's contract (style.json contract: pacing, on-screen elements, captions, audio, assets), or null. */
export async function packContract(id: string): Promise<Record<string, unknown> | null> {
  const v = await vendoredStyles();
  const text = v.files.get(id)?.get("style.json");
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as { contract?: unknown };
    return typeof raw.contract === "object" && raw.contract !== null ? (raw.contract as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** /install/style-packs.json: what workers install and report pack capabilities from. */
export async function servedPacksIndex(): Promise<PacksIndex> {
  const v = await vendoredStyles();
  return packsIndex({ commit: v.commit, packs: v.packs });
}

/** /install/env-packs.json: every pack with an environment, with all its files (worker 0.12.0+). */
export async function servedEnvPacks(): Promise<EnvPacksBundle> {
  const v = await vendoredStyles();
  return envPacksBundle({
    commit: v.commit,
    packs: v.packs.filter((p) => p.environment).map((p) => ({ id: p.id, version: p.version, sha256: p.sha256, files: v.files.get(p.id) ?? new Map<string, string>() })),
  });
}

/** The render projects of the remotion-2d packs, for the Remotion bundle. */
export async function remotionPackSources(): Promise<RemotionPackSource[]> {
  const v = await vendoredStyles();
  return v.packs
    .filter((p) => p.engine === "remotion-2d" && p.composition)
    .map((p) => ({
      id: p.id,
      version: p.version,
      composition: p.composition as string,
      files: [...(v.files.get(p.id) ?? new Map<string, string>()).entries()]
        .filter(([rel]) => rel.startsWith("render/"))
        .map(([rel, content]) => ({ path: rel.slice("render/".length), content })),
    }));
}

/** The pages of the html-capture packs, for the same bundle (installed as html/<id>/, worker 0.10.0+). */
export async function htmlPackSources(): Promise<HtmlPackSource[]> {
  const v = await vendoredStyles();
  return v.packs
    .filter((p) => p.engine === "html-capture")
    .map((p) => ({
      id: p.id,
      version: p.version,
      drawsCaptions: p.drawsCaptions === true,
      // An html-design pack (worker 0.11.0+): runs render the page Hermes wrote, never this pack's reference page.
      ...(isResearchRecipe(p.workflow?.recipe) ? { designed: true } : {}),
      files: [...(v.files.get(p.id) ?? new Map<string, string>()).entries()]
        .filter(([rel]) => rel.startsWith("render/"))
        .map(([rel, content]) => ({ path: rel.slice("render/".length), content })),
    }));
}

/**
 * The files of an html-design pack a page Hermes writes may load as ../pack/<path>: its render/ files without the
 * reference page (index.html). Empty for an unknown pack.
 */
export async function packVendoredFiles(id: string): Promise<string[]> {
  const v = await vendoredStyles();
  return [...(v.files.get(id)?.keys() ?? [])]
    .filter((rel) => rel.startsWith("render/") && rel !== "render/index.html")
    .map((rel) => rel.slice("render/".length))
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------
// Trial outcomes

type Q = ReturnType<typeof db>;

const DECISIONS: readonly OwnerDecision[] = ["approved", "rejected", "revised", "auto-approved"];

function rowToOutcome(r: Record<string, unknown>): TrialOutcome {
  const gates = Array.isArray(r.qc_gates) ? (r.qc_gates as TrialGate[]) : [];
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  const decision = DECISIONS.find((d) => d === r.owner_decision) ?? null;
  return {
    runId: String(r.run_id),
    packId: String(r.pack_id),
    packVersion: String(r.pack_version),
    qcPassed: typeof r.qc_passed === "boolean" ? r.qc_passed : null,
    gates,
    presentationScore: r.presentation_score == null ? null : Number(r.presentation_score),
    ownerDecision: decision,
    videoAssetId: r.video_asset_id == null ? null : String(r.video_asset_id),
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at) ?? "",
    ownerRubric: readRubric(r.owner_rubric),
    hermesAdvisory: readAdvisory(r.hermes_advisory),
    renderer: typeof r.renderer === "string" ? r.renderer : null,
    labTrial: r.lab_trial === true,
    qcWaived: r.qc_waived === true,
    waivedIssues: Array.isArray(r.waived_issues) ? r.waived_issues.filter((i): i is string => typeof i === "string") : [],
  };
}

/** Every recorded trial outcome, newest first. */
export async function listTrialOutcomes(sql: Q = db()): Promise<TrialOutcome[]> {
  const rows = await sql`
    SELECT run_id, pack_id, pack_version, qc_passed, qc_gates, presentation_score, owner_decision, video_asset_id, decided_at, created_at,
           owner_rubric, hermes_advisory, renderer, lab_trial, qc_waived, waived_issues
    FROM style_trial_outcomes ORDER BY created_at DESC LIMIT 2000
  `;
  return rows.map((r) => rowToOutcome(r as Record<string, unknown>));
}
