// Environments and engine command on the portal side: the registry, the availability lines, the Template Lab wording,
// the env packs bundle (and the worker's reader of it) and the update manifest. node --test "apps/portal/lib/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ENGINES, STYLES } from "./studio/catalog.ts";
import {
  HANDOVER_REASON,
  availabilityOf,
  envCapability,
  environmentLine,
  labTrialOption,
  mergeRegistry,
  parsePack,
  parseWorkerEnvironments,
  workerEnvironmentLabel,
  type RegistryEntry,
  type StylePack,
} from "./studio/style-registry.ts";
import { HANDOVER_TEXT, rendererVerdict } from "./studio/lab-study.ts";
import { ENV_PACKS_FILE_NAME, ENV_PACKS_KIND, envPacksBundle, envPacksText } from "./env-packs.ts";
import { packsIndex, packsIndexText } from "./style-packs-index.ts";
import { UPDATE_FILE_NAMES, buildManifest, pendingFiles, releaseOf, type ManifestFile, type ServedRelease } from "./update-manifest.ts";
import { CAPABILITIES, WORKER_VERSION } from "../../../packages/protocol/src/index.ts";
import { UPDATE_ENV_PACKS_FILE, parseEnvPacksBundle, parsePacksIndex, packCapabilitiesFor, parseEnvironment } from "../../worker/venstudio-worker.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STYLES_DIR = path.join(ROOT, "styles");
const LOCK = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { source: { commit: string }; packs: Array<{ id: string; version: string; sha256: string; files: Record<string, string> }> };
const PROOF = "three-low-poly";
const lockOf = (id: string) => LOCK.packs.find((p) => p.id === id)!;
const proofRaw = () => JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", PROOF, "style.json"), "utf8")) as Record<string, any>;
const proofPack = (): StylePack => parsePack(proofRaw(), lockOf(PROOF).sha256)!;
const entryFor = (p: StylePack): RegistryEntry => mergeRegistry(STYLES, [p]).find((e) => e.id === p.id)!;
const ENV = "env:three-svg@1.0.0";

test("engine command is a catalogue engine, the worker's and the protocol's; the proof pack is in the vendored lock", () => {
  assert.equal(ENGINES.command.capability, "command");
  assert.ok(CAPABILITIES.includes("command"));
  assert.equal(WORKER_VERSION, "0.16.0");
  const lp = lockOf(PROOF);
  assert.ok(lp, "styles/lock.json lists the proof pack");
  assert.equal((lp as unknown as { engine: string }).engine, "command");
});

test("parsePack reads the environment; engine command without one is left out", () => {
  const p = proofPack();
  assert.equal(p.engine, "command");
  assert.deepEqual(p.environment && [p.environment.id, p.environment.version, p.environment.output, p.environment.captions], ["three-svg", "1.0.0", "png-frames", "worker"]);
  assert.deepEqual(p.environment?.licences.map((l) => `${l.tool} ${l.licence}`), ["three MIT", "resvg MPL-2.0"]);
  const { environment, ...bare } = proofRaw();
  void environment;
  assert.equal(parsePack(bare, "x".repeat(64)), null);
  const hermes = JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", "hermes-graph", "style.json"), "utf8"));
  assert.equal(parsePack({ ...hermes, environment: proofRaw().environment }, "x".repeat(64))?.environment, null, "a hermes pack never gets an environment");
});

test("the availability line: has, installing, failed with the reason, or none yet; ready wins", () => {
  const p = proofPack();
  const w = (name: string, capabilities: string[], environments: unknown) => ({ name, capabilities, environments: parseWorkerEnvironments(environments) });
  const installing = [{ id: "three-svg", version: "1.0.0", status: "installing", detail: "installing", packs: ["three-low-poly@0.1.0"], at: "2026-11-22T00:00:00Z" }];
  const failed = [{ id: "three-svg", version: "1.0.0", status: "failed", detail: "download https://github.com/x: sha256 mismatch", packs: [], at: "" }];
  assert.deepEqual(environmentLine(p, [w("Muse 01", ["ffmpeg", ENV], [])]), { state: "ready", text: `A worker has ${ENV}` });
  assert.deepEqual(environmentLine(p, [w("Muse 01", ["ffmpeg"], installing)]), { state: "installing", text: `${ENV}: installing… on Muse 01` });
  assert.deepEqual(environmentLine(p, [w("Muse 02", [], failed)]), { state: "failed", text: `${ENV}: failed on Muse 02: download https://github.com/x: sha256 mismatch` });
  assert.equal(environmentLine(p, [w("Muse 02", [], failed), w("Muse 01", [], installing)])?.state, "installing");
  assert.equal(environmentLine(p, [w("Muse 02", [], failed), w("Muse 03", [ENV], [])])?.state, "ready");
  assert.equal(environmentLine(p, [])?.text, `No worker has ${ENV} yet (workers 0.12.0+ install it after their next signed update)`);
  assert.equal(environmentLine({ environment: null }, []), null);
  assert.equal(environmentLine(p, [w("Old", [], [{ id: "three-svg", version: "0.9.0", status: "ready", detail: "", packs: [], at: "" }])])?.state, "none", "another version does not count");
  assert.deepEqual(parseWorkerEnvironments([{ id: "x", version: "1", status: "ready" }, { id: "../x", version: "1.0.0", status: "ready" }, "junk"]), []);
  assert.deepEqual(workerEnvironmentLabel(parseWorkerEnvironments(failed)[0]), { tone: "danger", text: `${ENV}: failed: download https://github.com/x: sha256 mismatch` });
  assert.equal(workerEnvironmentLabel(parseWorkerEnvironments(installing)[0]).text, `${ENV}: installing… (for three-low-poly@0.1.0)`);
});

test("a lab trial of the proof pack waits for the environment, then for the pack, then starts", () => {
  const e = entryFor(proofPack());
  const cap = `pack:${PROOF}@${proofPack().version}`;
  const no = labTrialOption(e, ["ffmpeg"]);
  assert.ok(!no.ok && no.reason === "No worker reports command", JSON.stringify(no));
  const noEnv = labTrialOption(e, ["ffmpeg", "command"]);
  assert.ok(!noEnv.ok && noEnv.reason === `No worker has ${ENV} yet`, JSON.stringify(noEnv));
  const noPack = labTrialOption(e, ["ffmpeg", "command", ENV]);
  assert.ok(!noPack.ok && noPack.reason === `No worker reports ${cap} yet`, JSON.stringify(noPack));
  assert.deepEqual(labTrialOption(e, ["ffmpeg", "command", ENV, cap]), { ok: true, via: "worker", capability: cap });
  assert.equal(availabilityOf(e, ["command", cap]).pack, true);
  assert.equal(envCapability({ id: "three-svg", version: "1.0.0" }), ENV);
});

test("Template Lab: a renderer no worker has reads as a handover from Hermes, never as something Kiro must build", () => {
  assert.equal(HANDOVER_REASON, "Needs an environment: hand it over from Hermes (docs/hermes-handover.md)");
  assert.ok(HANDOVER_TEXT.startsWith("needs an environment: hand it over from Hermes (docs/hermes-handover.md)"));
  for (const engine of ["manim", "godot-2d", "godot-3d", "blender-cycles", "remotion-3d", "sprite-rig"]) {
    const v = rendererVerdict(engine, []);
    assert.ok(v.text.startsWith(HANDOVER_TEXT) && !/Kiro|plugin first|Phase 4/.test(v.text), `${engine}: ${v.text}`);
    const p = { ...proofPack(), id: "probe-line-graph", engine, environment: null, status: "draft" as const };
    const o = labTrialOption(entryFor(p), []);
    assert.ok(!o.ok && o.reason === HANDOVER_REASON && !/Kiro/.test(o.fix), `${engine}: ${JSON.stringify(o)}`);
  }
});

test("the env packs bundle carries every file of each pack with an environment, and the worker reads it", () => {
  const files = new Map<string, string>();
  for (const rel of Object.keys(lockOf(PROOF).files)) files.set(rel, readFileSync(path.join(STYLES_DIR, "packs", PROOF, rel), "utf8"));
  const bundle = envPacksBundle({ commit: LOCK.source.commit, packs: [{ id: PROOF, version: proofPack().version, sha256: lockOf(PROOF).sha256, files }] });
  assert.equal(ENV_PACKS_FILE_NAME, UPDATE_ENV_PACKS_FILE);
  assert.equal(bundle.kind, ENV_PACKS_KIND);
  const text = envPacksText(bundle);
  const parsed = parseEnvPacksBundle(JSON.parse(text));
  assert.deepEqual(parsed.packs.map((p) => `${p.id}@${p.version}`), [`${PROOF}@${proofPack().version}`]);
  assert.ok(parsed.packs[0].files.some((f) => f.path === "env/package-lock.json") && parsed.packs[0].files.some((f) => f.path === "render/render.mjs"));
  // The worker's digest check is the lock's: a changed file is refused.
  const tampered = JSON.parse(text);
  tampered.packs[0].files.find((f: { path: string }) => f.path === "render/render.mjs").text += "\n// changed";
  assert.throws(() => parseEnvPacksBundle(tampered), /do not match its digest/);
  assert.equal(createHash("sha256").update(text).digest("hex"), createHash("sha256").update(envPacksText(envPacksBundle({ commit: LOCK.source.commit, packs: [{ id: PROOF, version: proofPack().version, sha256: lockOf(PROOF).sha256, files: new Map([...files].reverse()) }] }))).digest("hex"), "stable bytes");
  assert.equal(parseEnvironment(proofRaw().environment).id, "three-svg");
});

test("the packs index names the environment; the worker reports the pack only once it is ready", () => {
  const p = proofPack();
  const idx = packsIndex({ commit: null, packs: [p] });
  assert.equal(idx.packs[0].environment, "three-svg@1.0.0");
  const stills = packsIndex({ commit: null, packs: [{ id: "a-b", version: "1.0.0", status: "trial", engine: "ffmpeg-stills", minWorkerVersion: "0.9.0", composition: null, sha256: "a".repeat(64) }] });
  assert.equal("environment" in stills.packs[0], false, "packs without an environment keep their index bytes");
  const parsed = parsePacksIndex(JSON.parse(packsIndexText(idx)));
  const key = `${p.id}@${p.version}`;
  assert.deepEqual(packCapabilitiesFor(parsed, ["ffmpeg", "command"], [], "0.12.0", [], []), []);
  assert.deepEqual(packCapabilitiesFor(parsed, ["ffmpeg", "command"], [], "0.12.0", [], [key]), [`pack:${key}`]);
  assert.deepEqual(packCapabilitiesFor(parsed, ["ffmpeg", "command"], [], "0.11.0", [], [key]), [], "an older worker never reports it");
});

test("env-packs.json travels in the signed manifest only for workers that report it", () => {
  assert.deepEqual([...UPDATE_FILE_NAMES], ["venstudio-worker.ts", "render-remotion.json", "style-packs.json", "env-packs.json"]);
  const sha = (c: string) => c.repeat(64);
  const files: ManifestFile[] = UPDATE_FILE_NAMES.map((name, i) => ({ name, sha256: sha("abcd"[i]), bytes: 100 }));
  const s: ServedRelease = { version: "0.12.0", release: releaseOf("0.12.0", files), files };
  const v11 = { version: "0.11.0", files: { "venstudio-worker.ts": sha("f"), "render-remotion.json": null, "style-packs.json": sha("c") } };
  assert.deepEqual(pendingFiles(s, v11), ["venstudio-worker.ts"]);
  const forOld = buildManifest({ keyId: "k", workerId: "w", served: s, pinnedVersion: null, now: new Date(0), worker: v11 });
  assert.deepEqual(forOld.files.map((f) => f.name), ["venstudio-worker.ts", "render-remotion.json", "style-packs.json"], "0.11.0 refuses a manifest naming a file it does not know");
  const v12 = { version: "0.12.0", files: { ...v11.files, "venstudio-worker.ts": sha("a"), "env-packs.json": null } };
  assert.deepEqual(pendingFiles(s, v12), ["env-packs.json"]);
  assert.deepEqual(pendingFiles(s, { ...v12, files: { ...v12.files, "env-packs.json": sha("d") } }), []);
  const forNew = buildManifest({ keyId: "k", workerId: "w", served: s, pinnedVersion: null, now: new Date(0), worker: v12 });
  assert.deepEqual(forNew.files.map((f) => f.name), [...UPDATE_FILE_NAMES]);
});

test("worker environments stored as a JSON string (early 0.12.0 claims) read the same as an array", () => {
  const list = [{ id: "three-svg", version: "1.0.0", status: "ready", detail: "probe passed", packs: ["three-low-poly@0.1.0"], at: "2026-11-22T19:14:46.705Z" }];
  assert.deepEqual(parseWorkerEnvironments(JSON.stringify(list)), parseWorkerEnvironments(list));
  assert.equal(parseWorkerEnvironments(list).length, 1);
  assert.deepEqual(parseWorkerEnvironments("not json"), []);
});
