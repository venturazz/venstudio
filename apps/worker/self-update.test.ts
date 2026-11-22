import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUNDLE_MARKER,
  MANIFEST_CONTEXT,
  UpdateRefused,
  VERSION,
  canonicalJson,
  checkManifest,
  compareVersions,
  confirmUpdateStarted,
  installedBundleSha,
  noteStartFailure,
  parseUpdateKey,
  planUpdate,
  readUpdateState,
  reconcileUpdateOnStart,
  restartArgv,
  runSelftest,
  selfUpdateDisabledReason,
  stageRemotionBundle,
  stageWorkerFile,
  swapInWorker,
  swapRemotionInstall,
  updateCheckSeconds,
  updateKeyId,
  updatePaths,
  verifyUpdateBytes,
} from "./venstudio-worker.ts";
import {
  MANIFEST_CONTEXT as PORTAL_CONTEXT,
  buildManifest,
  canonicalJson as portalCanonicalJson,
  compareVersions as portalCompareVersions,
  newSigningKey,
  releaseOf,
  signManifest,
  updateKeyId as portalUpdateKeyId,
  type ManifestFile,
  type UnsignedManifest,
} from "../portal/lib/update-manifest.ts";

const WORKER_ID = "11111111-2222-4333-8444-555555555555";
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const newer = (() => {
  const [a, b, c] = VERSION.split(".").map(Number);
  return `${a}.${b}.${c + 1}`;
})();

function served(version: string, workerBody = "new worker", bundleBody = '{"files":[]}'): { version: string; release: string; files: ManifestFile[] } {
  const files: ManifestFile[] = [
    { name: "venstudio-worker.ts", sha256: sha(workerBody), bytes: Buffer.byteLength(workerBody) },
    { name: "render-remotion.json", sha256: sha(bundleBody), bytes: Buffer.byteLength(bundleBody) },
  ];
  return { version, release: releaseOf(version, files), files };
}

const key = newSigningKey();
const sign = (m: UnsignedManifest, k = key) => signManifest(m, k.privateKey);
const manifest = (over: Partial<UnsignedManifest> = {}, now = new Date()) =>
  sign({ ...buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: served(newer), pinnedVersion: null, now }), ...over });
const ctx = (over: Partial<Parameters<typeof checkManifest>[1]> = {}) => ({ publicKey: key.publicKey, workerId: WORKER_ID, now: Date.now(), lastIssuedAt: null, ...over });

test("the worker's canonical JSON, key id, context and version order match the portal's", () => {
  const values: unknown[] = [
    null,
    true,
    0,
    -1.5,
    1e21,
    "ü\u2028\"\\",
    [],
    {},
    { b: [1, { z: null, a: "x" }], a: { y: false, x: undefined } },
    buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: served("0.8.0"), pinnedVersion: "0.8.0", now: new Date(0) }),
  ];
  for (const v of values) assert.equal(canonicalJson(v), portalCanonicalJson(v));
  assert.equal(MANIFEST_CONTEXT, PORTAL_CONTEXT);
  assert.equal(updateKeyId(key.publicKey), portalUpdateKeyId(key.publicKey));
  for (const [a, b] of [["0.8.0", "0.7.0"], ["0.7.99", "0.8.0"], ["1.0", "1.0.0"], ["0.10.0", "0.9.0"], ["x", "0.8.0"]]) {
    const w = compareVersions(a, b);
    const p = portalCompareVersions(a, b);
    assert.ok(Object.is(w, p), `${a} vs ${b}`);
  }
  assert.throws(() => canonicalJson(Number.NaN));
});

test("parseUpdateKey accepts only an Ed25519 public key", () => {
  assert.equal(parseUpdateKey(key.publicKey).asymmetricKeyType, "ed25519");
  assert.throws(() => parseUpdateKey("{{UPDATE_PUBLIC_KEY}}"), /base64/);
  assert.throws(() => parseUpdateKey(Buffer.alloc(44, 1).toString("base64")));
});

test("checkManifest accepts a manifest signed by the pinned key for this worker", () => {
  const r = checkManifest(manifest(), ctx());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.manifest.version, newer);
});

test("checkManifest refuses a bad signature and any change made after signing", () => {
  const m = manifest();
  const flipped = { ...m, signature: Buffer.from(Buffer.from(m.signature, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
  for (const bad of [flipped, { ...m, version: "9.9.9" }, { ...m, pin: true }, { ...m, files: [{ ...m.files[0], sha256: "c".repeat(64) }, m.files[1]] }, { ...m, extra: 1 }]) {
    const r = checkManifest(bad, ctx());
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /bad signature/);
  }
});

test("checkManifest refuses another key, another worker, expired, future and replayed manifests", () => {
  const other = newSigningKey();
  const byOther = sign(buildManifest({ keyId: other.keyId, workerId: WORKER_ID, served: served(newer), pinnedVersion: null, now: new Date() }), other);
  const r1 = checkManifest(byOther, ctx());
  assert.ok(!r1.ok && /trusts key/.test(r1.reason));
  // Signed by the other key but claiming the pinned key's id: still a bad signature.
  const forged = sign({ ...buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: served(newer), pinnedVersion: null, now: new Date() }) }, other);
  const r2 = checkManifest(forged, ctx());
  assert.ok(!r2.ok && /bad signature/.test(r2.reason));
  const r3 = checkManifest(manifest({ workerId: "99999999-2222-4333-8444-555555555555" }), ctx());
  assert.ok(!r3.ok && /not this one/.test(r3.reason));
  const old = manifest({}, new Date(Date.now() - 2 * 3600_000));
  const r4 = checkManifest(old, ctx());
  assert.ok(!r4.ok && /expired/.test(r4.reason));
  const future = manifest({}, new Date(Date.now() + 3600_000));
  const r5 = checkManifest(future, ctx());
  assert.ok(!r5.ok && /future/.test(r5.reason));
  const m = manifest();
  const r6 = checkManifest(m, ctx({ lastIssuedAt: m.issuedAt }));
  assert.ok(!r6.ok && /replayed/.test(r6.reason));
  // A few minutes of clock difference is tolerated.
  assert.equal(checkManifest(manifest({}, new Date(Date.now() - 12 * 60_000)), ctx()).ok, true);
  const long = sign({ ...buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served: served(newer), pinnedVersion: null, now: new Date() }), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
  const r7 = checkManifest(long, ctx());
  assert.ok(!r7.ok && /too long/.test(r7.reason));
});

test("checkManifest refuses malformed manifests before looking at the signature", () => {
  const m = manifest();
  const cases: Array<[unknown, RegExp]> = [
    [null, /not an object/],
    [{ ...m, format: 2 }, /format/],
    [{ ...m, files: [] }, /no valid files/],
    [{ ...m, files: [{ ...m.files[0], name: "../run.sh" }] }, /unknown or repeated/],
    [{ ...m, files: [m.files[0], m.files[0]] }, /unknown or repeated/],
    [{ ...m, files: [{ ...m.files[0], sha256: "XYZ" }] }, /sha256/],
    [{ ...m, files: [{ ...m.files[0], bytes: 0 }] }, /size/],
    [{ ...m, pin: "yes" }, /pin/],
  ];
  for (const [raw, re] of cases) {
    const r = checkManifest(raw, ctx());
    assert.ok(!r.ok && re.test(r.reason), `${JSON.stringify(raw)?.slice(0, 60)} -> ${r.ok ? "ok" : r.reason}`);
  }
});

test("planUpdate installs only newer workers, a pinned version, and bundles where a project is installed", () => {
  const s = served("0.9.0", "W", "B");
  const local = { version: "0.8.0", workerSha: sha("old"), bundleSha: null as string | null, failed: {} as Record<string, string> };
  const base = { version: "0.9.0", pin: false, files: s.files };
  assert.equal(planUpdate(base, local).worker?.name, "venstudio-worker.ts");
  assert.equal(planUpdate(base, local).bundle, null, "the bundle waits for the new worker");
  // Downgrade: refused, nothing installed, unless pinned.
  const down = { ...base, version: "0.7.0" };
  const p1 = planUpdate(down, local);
  assert.equal(p1.worker, null);
  assert.match(p1.refused ?? "", /older than this worker/);
  assert.equal(planUpdate({ ...down, pin: true }, local).worker?.name, "venstudio-worker.ts");
  // Same version, same file: nothing. Different file: refused, but a bundle may still update.
  const same = { ...base, version: "0.8.0" };
  assert.deepEqual(planUpdate(same, { ...local, workerSha: sha("W") }), { worker: null, bundle: null, refused: null, notice: null });
  const p2 = planUpdate(same, { ...local, bundleSha: "unknown" });
  assert.match(p2.refused ?? "", /same version/);
  assert.equal(p2.bundle?.name, "render-remotion.json");
  // Bundle only when installed here and different.
  assert.equal(planUpdate(same, { ...local, workerSha: sha("W"), bundleSha: null }).bundle, null);
  assert.equal(planUpdate(same, { ...local, workerSha: sha("W"), bundleSha: sha("B") }).bundle, null);
  assert.equal(planUpdate(same, { ...local, workerSha: sha("W"), bundleSha: "unknown" }).bundle?.name, "render-remotion.json");
  // A release that failed here is skipped quietly.
  const p3 = planUpdate(base, { ...local, failed: { [sha("W")]: "self-test failed" } });
  assert.equal(p3.worker, null);
  assert.match(p3.notice ?? "", /failed here before/);
  assert.equal(p3.refused, null);
});

test("restartArgv keeps the command and passes what is left of the budget", () => {
  const now = 1_000_000;
  assert.deepEqual(restartArgv(["hold", "--max-minutes", "55"], now + 30 * 60_000, now), ["hold", "--max-minutes", "30"]);
  assert.deepEqual(restartArgv(["tick"], now + 50 * 60_000, now), ["tick", "--max-minutes", "50"]);
  assert.deepEqual(restartArgv(["hold", "--home", "/x", "--max-minutes", "0.4"], now + 6_000, now), ["hold", "--home", "/x", "--max-minutes", "0.1"]);
  assert.deepEqual(restartArgv(["daemon", "--poll", "30"], Infinity, now), ["daemon", "--poll", "30"]);
});

test("self-update is off without a pinned key, outside the installed path, or when switched off", () => {
  const home = "/home/hatch/venstudio";
  const live = path.join(home, "app", "venstudio-worker.ts");
  assert.equal(selfUpdateDisabledReason({ updateKey: key.publicKey }, home, live, {}), null);
  assert.match(selfUpdateDisabledReason({}, home, live, {}) ?? "", /no update key/);
  assert.match(selfUpdateDisabledReason({ updateKey: key.publicKey }, home, "/repo/apps/worker/venstudio-worker.ts", {}) ?? "", /not the installed worker/);
  assert.match(selfUpdateDisabledReason({ updateKey: key.publicKey }, home, live, { VENSTUDIO_AUTO_UPDATE: "0" }) ?? "", /AUTO_UPDATE/);
  assert.equal(updateCheckSeconds({}), 600);
  assert.equal(updateCheckSeconds({ VENSTUDIO_UPDATE_CHECK_SECONDS: "30" }), 30);
  assert.equal(updateCheckSeconds({ VENSTUDIO_UPDATE_CHECK_SECONDS: "1" }), 600);
});

test("verifyUpdateBytes refuses a different size or hash", () => {
  const body = Buffer.from("payload");
  const f = { name: "venstudio-worker.ts" as const, sha256: sha(body), bytes: body.length };
  verifyUpdateBytes(f, body);
  assert.throws(() => verifyUpdateBytes(f, Buffer.from("payloaD")), (e: unknown) => e instanceof UpdateRefused && /checksum mismatch/.test((e as Error).message));
  assert.throws(() => verifyUpdateBytes(f, Buffer.from("payload!")), (e: unknown) => e instanceof UpdateRefused && /bytes/.test((e as Error).message));
});

test("staging, swap, start failures and rollback keep the previous worker and record why", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const p = updatePaths(home);
  await mkdir(p.app, { recursive: true });
  await writeFile(p.live, "OLD");
  const body = Buffer.from("NEW");
  const file = { name: "venstudio-worker.ts" as const, sha256: sha(body), bytes: body.length };

  // A tampered download writes nothing.
  await assert.rejects(stageWorkerFile(home, file, Buffer.from("BAD")), UpdateRefused);
  assert.equal(existsSync(p.next), false);

  await stageWorkerFile(home, file, body);
  assert.equal(await readFile(p.next, "utf8"), "NEW");
  assert.equal(await readFile(p.live, "utf8"), "OLD", "staging never touches the live file");

  await swapInWorker(home, { version: "9.0.0", sha256: file.sha256 });
  assert.equal(await readFile(p.live, "utf8"), "NEW");
  assert.equal(await readFile(p.prev, "utf8"), "OLD");
  assert.equal((await readFile(p.pending, "utf8")).trim(), "0");
  assert.equal(existsSync(p.nextDir), false);
  assert.equal((await readUpdateState(home)).pending?.version, "9.0.0");

  // The new version starting sees itself pending.
  assert.equal((await reconcileUpdateOnStart(home, sha("NEW"))).kind, "starting");
  // It exits with an error twice before its first claim: once retried, then rolled back.
  assert.equal(await noteStartFailure(home), "retry");
  assert.equal((await readFile(p.pending, "utf8")).trim(), "1");
  assert.equal(await noteStartFailure(home), "rolled-back");
  assert.equal(await readFile(p.live, "utf8"), "OLD");
  assert.equal(existsSync(p.pending), false);
  // The old version starts, sees the rollback, records the release as failed.
  const r = await reconcileUpdateOnStart(home, sha("OLD"));
  assert.equal(r.kind, "rolled-back");
  if (r.kind === "rolled-back") assert.equal(r.version, "9.0.0");
  const state = await readUpdateState(home);
  assert.equal(state.pending, undefined);
  assert.match(state.failed?.[file.sha256] ?? "", /before its first claim/);
  assert.equal(await noteStartFailure(home), "none", "no update pending: a failure is just a failure");
});

test("a confirmed start clears the pending update and keeps the backup", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const p = updatePaths(home);
  await mkdir(p.app, { recursive: true });
  await writeFile(p.live, "OLD");
  const body = Buffer.from("NEW");
  await stageWorkerFile(home, { name: "venstudio-worker.ts", sha256: sha(body), bytes: 3 }, body);
  await swapInWorker(home, { version: "9.0.0", sha256: sha(body) });
  await confirmUpdateStarted(home);
  assert.equal(existsSync(p.pending), false);
  assert.equal((await readUpdateState(home)).pending, undefined);
  assert.equal(await readFile(p.prev, "utf8"), "OLD");
  assert.equal((await reconcileUpdateOnStart(home, sha("NEW"))).kind, "none");
});

test("runSelftest passes only on exit 0 with ok:true, and names the reason otherwise", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-selftest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, "good.mjs");
  const bad = path.join(dir, "bad.mjs");
  const silent = path.join(dir, "silent.mjs");
  await writeFile(good, 'console.log("noise"); console.log(JSON.stringify({ ok: true, version: "9.0.0" }));');
  await writeFile(bad, 'console.log(JSON.stringify({ ok: false, version: "9.0.0", reason: "portal unreachable" })); process.exit(1);');
  await writeFile(silent, "process.exit(0);");
  assert.deepEqual(await runSelftest(good, dir), { ok: true, version: "9.0.0", reason: "" });
  const b = await runSelftest(bad, dir);
  assert.equal(b.ok, false);
  assert.match(b.reason, /exited with 1: portal unreachable/);
  assert.equal((await runSelftest(silent, dir)).ok, false, "exit 0 without ok:true is a failure");
});

test("a Remotion bundle is built beside the live project and swapped in only after its probe", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-remotion-update-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const live = path.join(home, "remotion");
  await mkdir(path.join(live, "scripts"), { recursive: true });
  await mkdir(path.join(live, "node_modules", "remotion"), { recursive: true });
  await writeFile(path.join(live, "package.json"), JSON.stringify({ name: "r", version: "0.1.0", dependencies: { remotion: "4.0.543" } }));
  await writeFile(path.join(live, "scripts", "probe.mjs"), "// live");
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(await installedBundleSha(home, env), "unknown");
  assert.equal(await installedBundleSha(home, { VENSTUDIO_REMOTION_DIR: live }), null, "a hand-managed project is never replaced");

  const bundle = (deps: Record<string, string>) =>
    Buffer.from(JSON.stringify({ files: [{ path: "package.json", content: JSON.stringify({ name: "r", version: "0.2.0", dependencies: deps }) }, { path: "scripts/probe.mjs", content: "// new" }, { path: "src/index.ts", content: "export {};" }] }));
  const calls: string[][] = [];
  const fakeRun = async (cmd: string, args: string[]) => {
    calls.push([path.basename(cmd), ...args.map((a) => path.basename(a))]);
    if (path.basename(cmd) === "cp") await mkdir(args[2], { recursive: true });
  };
  const same = bundle({ remotion: "4.0.543" });
  await stageRemotionBundle(home, same, sha(same), new AbortController().signal, fakeRun as never);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [["cp", "-al", "node_modules"], [path.basename(process.execPath), "probe.mjs", "--full"], [path.basename(process.execPath), "probe.mjs"]]);
  assert.equal(await readFile(path.join(live, "scripts", "probe.mjs"), "utf8"), "// live", "the live project is untouched while staging");
  await swapRemotionInstall(home);
  assert.equal(await readFile(path.join(live, "scripts", "probe.mjs"), "utf8"), "// new");
  assert.equal(await readFile(path.join(home, "remotion.prev", "scripts", "probe.mjs"), "utf8"), "// live");
  assert.equal(await installedBundleSha(home, env), sha(same));
  assert.equal(existsSync(path.join(live, BUNDLE_MARKER)), true);

  // Changed dependencies are installed fresh, never into hard links.
  calls.length = 0;
  const changed = bundle({ remotion: "4.0.600" });
  await stageRemotionBundle(home, changed, sha(changed), new AbortController().signal, fakeRun as never);
  assert.equal(calls[0][1], "install");
  assert.deepEqual(calls[1].slice(0, 3), ["remotion", "browser", "ensure"]);
  // A failing probe leaves the live project in place.
  const failing = async (cmd: string, args: string[]) => {
    if (args.includes("--full")) throw new Error("probe failed");
    if (path.basename(cmd) === "cp") await mkdir(args[2], { recursive: true });
  };
  await assert.rejects(stageRemotionBundle(home, same, sha(same), new AbortController().signal, failing as never), /probe failed/);
  assert.equal(await installedBundleSha(home, env), sha(same));
});
