/** Worker 0.9.0: the style packs index, its signed delivery, and the pack capabilities it reports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  UPDATE_PACKS_FILE,
  VERSION,
  checkManifest,
  detectCapabilities,
  installPacksIndex,
  installedPacksSha,
  packCapabilitiesFor,
  parsePacksIndex,
  planUpdate,
  probedPacksOf,
  readInstalledPacks,
  stylePacksPath,
  type PacksIndex,
} from "./venstudio-worker.ts";
import { buildManifest, newSigningKey, releaseOf, signManifest, type ManifestFile } from "../portal/lib/update-manifest.ts";
import { PACKS_FILE_NAME, packsIndex, packsIndexText } from "../portal/lib/style-packs-index.ts";
import { mergeRegistry, newVideoStyles, parsePack } from "../portal/lib/studio/style-registry.ts";
import { STYLES } from "../portal/lib/studio/catalog.ts";

const STYLES_DIR = new URL("../../styles/", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("lock.json", STYLES_DIR), "utf8")) as { source: { commit: string }; packs: Array<{ id: string; sha256: string }> };
const packs = lock.packs.map((p) => parsePack(JSON.parse(readFileSync(new URL(`packs/${p.id}/style.json`, STYLES_DIR), "utf8")), p.sha256)!);
/** The bytes the portal serves at /install/style-packs.json for the vendored packs. */
const served = packsIndexText(packsIndex({ commit: lock.source.commit, packs }));
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const WORKER_ID = "11111111-2222-4333-8444-555555555555";

test("the worker reads the index the portal serves, and the names agree", () => {
  assert.equal(UPDATE_PACKS_FILE, PACKS_FILE_NAME);
  const idx = parsePacksIndex(JSON.parse(served));
  assert.equal(idx.commit, lock.source.commit);
  assert.deepEqual(idx.packs.map((p) => p.id), [...lock.packs.map((p) => p.id)].sort());
  assert.deepEqual(idx.packs.find((p) => p.id === "explainer-flat-vector"), {
    id: "explainer-flat-vector",
    version: "1.0.1",
    status: "trial",
    engine: "remotion-2d",
    minWorkerVersion: "0.9.0",
    composition: "flat-vector-explainer",
    sha256: lock.packs.find((p) => p.id === "explainer-flat-vector")!.sha256,
  });
  assert.equal(packsIndexText(packsIndex({ commit: lock.source.commit, packs: [...packs].reverse() })), served, "stable bytes, whatever the order");
});

test("parsePacksIndex refuses anything but format 1 with well-formed entries", () => {
  const good = JSON.parse(served) as PacksIndex;
  const bad = (edit: (x: any) => void, re: RegExp) => {
    const x = JSON.parse(served);
    edit(x);
    assert.throws(() => parsePacksIndex(x), re);
  };
  assert.ok(parsePacksIndex(good));
  bad((x) => (x.format = 2), /unknown format 2/);
  bad((x) => (x.packs[0].id = "../x"), /no valid or a repeated id/);
  bad((x) => x.packs.push({ ...x.packs[0] }), /repeated id/);
  bad((x) => (x.packs[0].version = "1.0"), /no valid version/);
  bad((x) => (x.packs[0].sha256 = "zz"), /no valid sha256/);
  bad((x) => (x.packs[0].composition = "Bad Name"), /no valid composition/);
  bad((x) => (x.packs[0].minWorkerVersion = "soon"), /minWorkerVersion/);
  assert.throws(() => parsePacksIndex([]), /not an object/);
});

test("pack capabilities: reported only for packs whose probe passes here, at their exact version", () => {
  const idx = parsePacksIndex(JSON.parse(served));
  const stills = ["ambient-loop", "documentary-stills", "horror-story", "mystery-narration", "story-read-aloud", "travel-documentary"].map((id) => `pack:${id}@1.0.1`);
  const probed = [{ id: "explainer-flat-vector", version: "1.0.1", composition: "flat-vector-explainer" }];
  assert.deepEqual(packCapabilitiesFor(idx, ["echo", "ffmpeg", "xfade"], []), stills, "stills need ffmpeg with xfade");
  assert.deepEqual(packCapabilitiesFor(idx, ["echo", "ffmpeg"], []), [], "no xfade, no stills pack");
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "xfade", "remotion-2d"], probed).sort(), ["pack:explainer-flat-vector@1.0.1", ...stills].sort());
  assert.ok(!packCapabilitiesFor(idx, ["ffmpeg", "xfade", "remotion-2d"], []).includes("pack:explainer-flat-vector@1.0.1"), "remotion-2d alone is not the pack: its probe must have rendered it");
  assert.ok(!packCapabilitiesFor(idx, ["ffmpeg", "xfade", "remotion-2d"], [{ ...probed[0], version: "0.9.9" }]).includes("pack:explainer-flat-vector@1.0.1"), "another version was probed");
  assert.ok(!packCapabilitiesFor(idx, ["ffmpeg", "xfade"], probed).includes("pack:explainer-flat-vector@1.0.1"), "the probe passed earlier, but remotion-2d is not reported now");
  // A pack for a newer worker, or an engine this worker does not run, is not reported.
  const future: PacksIndex = { ...idx, packs: [{ ...idx.packs[1], id: "future-look", minWorkerVersion: "9.0.0" }, { ...idx.packs[1], id: "manim-look", engine: "manim" }] };
  assert.deepEqual(packCapabilitiesFor(future, ["ffmpeg", "xfade"], []), []);
  assert.deepEqual(packCapabilitiesFor(null, ["ffmpeg", "xfade"], []), []);
  // The vendored packs need exactly this worker version.
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "xfade"], [], "0.8.0"), [], "0.8.0 is older than the packs' minWorkerVersion");
});

test("what the worker reports is what the portal's New Video counts as available", () => {
  const idx = parsePacksIndex(JSON.parse(served));
  const caps = ["echo", "ffmpeg", "xfade", "remotion-2d", ...packCapabilitiesFor(idx, ["ffmpeg", "xfade", "remotion-2d"], [{ id: "explainer-flat-vector", version: "1.0.1", composition: "flat-vector-explainer" }])];
  const offer = newVideoStyles(mergeRegistry(STYLES, packs), caps);
  assert.equal(offer.trial.length, 7);
  // The Hermes research packs (the generic one and one per claude-animation-skills skill) are never reported by a
  // worker: they wait for Hermes, and are offered once Hermes is set up. The two html-capture adaptations (Trial) wait
  // for a worker with html-capture.
  const hermesIds = packs.filter((p) => p.engine === "hermes").map((p) => p.id);
  assert.equal(hermesIds.length, 11);
  assert.deepEqual(offer.waiting.map((e) => e.id).sort(), [...hermesIds, "animated-line-graph", "minimal-line-art"].sort());
  assert.equal(newVideoStyles(mergeRegistry(STYLES, packs), caps, { hermes: true }).trial.length, 7 + 11);
  // The html-capture probe is reported once installed and probed, but it is Lab: never offered.
  const html = packCapabilitiesFor(idx, ["ffmpeg", "xfade", "html-capture"], [], "0.10.0", [{ id: "probe-line-graph", version: "0.1.1", drawsCaptions: false, sha256: "0".repeat(64) }]);
  assert.ok(html.includes("pack:probe-line-graph@0.1.1"));
  assert.ok(!html.some((c) => c.startsWith("pack:hermes-research-explainer")), "no worker reports the hermes pack");
  const withProbe = newVideoStyles(mergeRegistry(STYLES, packs), [...caps, ...html]);
  assert.ok(![...withProbe.listed, ...withProbe.trial, ...withProbe.waiting].some((e) => e.id === "probe-line-graph"));
});

test("probedPacksOf keeps only well-formed entries of the probe's output", () => {
  assert.deepEqual(probedPacksOf({ ok: true, packs: [{ id: "a", version: "1.0.0", composition: "c" }, { id: 1 }, null] }), [{ id: "a", version: "1.0.0", composition: "c" }]);
  assert.deepEqual(probedPacksOf({ ok: true, compositions: ["flat-vector-explainer"] }), [], "a probe from before packs names none");
});

test("installPacksIndex writes the index atomically, and nothing when it does not parse", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-packs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await installedPacksSha(home), null);
  assert.equal(await readInstalledPacks(home), null);
  await assert.rejects(installPacksIndex(home, Buffer.from('{"format":2,"packs":[]}')), /unknown format/);
  assert.equal(await installedPacksSha(home), null, "a refused index is not written");
  const idx = await installPacksIndex(home, Buffer.from(served));
  assert.equal(idx.packs.length, 21);
  assert.equal(await readFile(stylePacksPath(home), "utf8"), served);
  assert.equal(await installedPacksSha(home), sha(served));
  assert.equal((await readInstalledPacks(home))?.packs.length, 21);
  await writeFile(stylePacksPath(home), "not json");
  assert.equal(await readInstalledPacks(home), null, "a damaged file reports no packs");
});

test("signed delivery: a manifest may name the packs index; planUpdate installs it once the worker file is current", () => {
  const key = newSigningKey();
  const body = { worker: "worker body", bundle: '{"files":[]}', packs: served };
  const files: ManifestFile[] = [
    { name: "venstudio-worker.ts", sha256: sha(body.worker), bytes: Buffer.byteLength(body.worker) },
    { name: "render-remotion.json", sha256: sha(body.bundle), bytes: Buffer.byteLength(body.bundle) },
    { name: "style-packs.json", sha256: sha(body.packs), bytes: Buffer.byteLength(body.packs) },
  ];
  const s = { version: VERSION, release: releaseOf(VERSION, files), files };
  const m = signManifest(buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: s, pinnedVersion: null, now: new Date() }), key.privateKey);
  const ok = checkManifest(m, { publicKey: key.publicKey, workerId: WORKER_ID, now: Date.now(), lastIssuedAt: null });
  assert.ok(ok.ok, ok.ok ? "" : ok.reason);
  // An unknown fourth file is still refused.
  const extra = signManifest({ ...buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: s, pinnedVersion: null, now: new Date() }), files: [...files, { name: "x.sh" as never, sha256: "a".repeat(64), bytes: 1 }] }, key.privateKey);
  assert.ok(!checkManifest(extra, { publicKey: key.publicKey, workerId: WORKER_ID, now: Date.now(), lastIssuedAt: null }).ok);

  const local = { version: VERSION, workerSha: sha(body.worker), bundleSha: null, packsSha: null as string | null, failed: {} as Record<string, string> };
  const base = { version: VERSION, pin: false, files };
  assert.equal(planUpdate(base, local).packs?.name, "style-packs.json", "nothing installed yet: install it");
  assert.equal(planUpdate(base, { ...local, packsSha: sha(body.packs) }).packs, null, "current: nothing");
  assert.equal(planUpdate(base, { ...local, packsSha: "e".repeat(64) }).packs?.name, "style-packs.json", "different: install it, no worker version bump");
  const newerWorker = { ...base, version: "99.0.0" };
  const p = planUpdate(newerWorker, { ...local, workerSha: sha("old") });
  assert.equal(p.worker?.name, "venstudio-worker.ts");
  assert.equal(p.packs, null, "the packs wait for the new worker (it may read a newer index)");
  // A portal older than this worker: the worker file is refused, the packs index is still taken.
  const older = planUpdate({ ...base, version: "0.1.0" }, local);
  assert.match(older.refused ?? "", /older than this worker/);
  assert.equal(older.worker, null);
  assert.equal(older.packs?.name, "style-packs.json");
  const failed = planUpdate(base, { ...local, failed: { [sha(body.packs)]: "style packs index: unknown format" } });
  assert.equal(failed.packs, null);
  assert.match(failed.notice ?? "", /style packs .* failed here before/);
});

test("detectCapabilities reports the installed stills packs on a machine with ffmpeg", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-packs-caps-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = await detectCapabilities(home);
  assert.ok(!before.some((c) => c.startsWith("pack:")), "no index, no pack capability");
  await installPacksIndex(home, Buffer.from(served));
  const caps = await detectCapabilities(home);
  if (caps.includes("xfade")) assert.ok(caps.includes("pack:documentary-stills@1.0.1" as never), caps.join(","));
  assert.ok(!caps.includes("pack:explainer-flat-vector@1.0.1" as never) || caps.includes("remotion-2d"), "the Remotion pack only with its renderer");
});
