import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, encrypt } from "./crypto/secretbox.ts";
import {
  MANIFEST_CONTEXT,
  MANIFEST_LIFETIME_SECONDS,
  buildManifest,
  canonicalJson,
  compareVersions,
  decideOffer,
  describeUpdateResult,
  newSigningKey,
  parseWorkerVersion,
  pendingFiles,
  releaseOf,
  signManifest,
  signingInput,
  signingKeyAad,
  updateKeyId,
  verifyManifestSignature,
  type ManifestFile,
  type ServedRelease,
} from "./update-manifest.ts";

const WORKER_SHA = "a".repeat(64);
const BUNDLE_SHA = "b".repeat(64);
const files: ManifestFile[] = [
  { name: "venstudio-worker.ts", sha256: WORKER_SHA, bytes: 1000 },
  { name: "render-remotion.json", sha256: BUNDLE_SHA, bytes: 2000 },
];
const served: ServedRelease = { version: "0.8.0", release: releaseOf("0.8.0", files), files };
const WORKER_ID = "11111111-2222-4333-8444-555555555555";

test("canonicalJson sorts keys at every depth, drops undefined members and has no whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: "x", c: null }], e: undefined, f: true }), '{"a":[{"c":null,"d":"x"}],"b":1,"f":true}');
  assert.equal(canonicalJson("é\n\u2028"), JSON.stringify("é\n\u2028"));
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  // Same value, different insertion order: same bytes.
  assert.equal(canonicalJson({ x: 1, y: { q: 2, p: 3 } }), canonicalJson({ y: { p: 3, q: 2 }, x: 1 }));
});

test("canonicalJson refuses values JSON cannot carry exactly", () => {
  assert.throws(() => canonicalJson(Number.NaN), /finite/);
  assert.throws(() => canonicalJson(Infinity), /finite/);
  assert.throws(() => canonicalJson([undefined]), /cannot encode/);
  assert.throws(() => canonicalJson({ f: () => 1 }), /cannot encode/);
});

test("a manifest signed with the portal key verifies, and any change to it does not", () => {
  const key = newSigningKey();
  assert.equal(key.keyId, updateKeyId(key.publicKey));
  assert.match(key.keyId, /^[0-9a-f]{16}$/);
  const m = signManifest(buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served, pinnedVersion: null, now: new Date() }), key.privateKey);
  assert.equal(verifyManifestSignature(m, key.publicKey), true);
  assert.equal(verifyManifestSignature({ ...m, version: "0.9.0" }, key.publicKey), false);
  assert.equal(verifyManifestSignature({ ...m, pin: true }, key.publicKey), false);
  assert.equal(verifyManifestSignature({ ...m, files: [{ ...files[0], sha256: "c".repeat(64) }, files[1]] }, key.publicKey), false);
  assert.equal(verifyManifestSignature({ ...m, workerId: "other" }, key.publicKey), false);
  // Another key's signature is not this key's.
  assert.equal(verifyManifestSignature(m, newSigningKey().publicKey), false);
  assert.equal(verifyManifestSignature({ ...m, signature: "not base64 !!" }, key.publicKey), false);
});

test("the signed bytes are the context line plus the canonical manifest without its signature", () => {
  const key = newSigningKey();
  const unsigned = buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served, pinnedVersion: null, now: new Date(0) });
  const signed = signManifest(unsigned, key.privateKey);
  assert.equal(signingInput(signed).toString("utf8"), MANIFEST_CONTEXT + canonicalJson(unsigned));
  assert.ok(!signingInput(signed).toString("utf8").includes("signature"));
});

test("manifests expire after the short lifetime and pin only the pinned version", () => {
  const now = new Date("2026-11-21T10:00:00.000Z");
  const m = buildManifest({ keyId: "k", workerId: WORKER_ID, served, pinnedVersion: null, now });
  assert.equal(m.issuedAt, "2026-11-21T10:00:00.000Z");
  assert.equal(Date.parse(m.expiresAt) - Date.parse(m.issuedAt), MANIFEST_LIFETIME_SECONDS * 1000);
  assert.ok(MANIFEST_LIFETIME_SECONDS <= 900);
  assert.equal(m.pin, false);
  assert.equal(buildManifest({ keyId: "k", workerId: WORKER_ID, served, pinnedVersion: "0.8.0", now }).pin, true);
  // A pin left over from an older portal does not pin what this portal serves.
  assert.equal(buildManifest({ keyId: "k", workerId: WORKER_ID, served, pinnedVersion: "0.7.0", now }).pin, false);
});

test("the private key survives encryption under ENCRYPTION_KEY only with its own AAD", () => {
  const key = newSigningKey();
  const box = Buffer.alloc(32, 7);
  const enc = encrypt(key.privateKey, box, signingKeyAad(key.keyId));
  assert.ok(enc.startsWith("v1."));
  assert.ok(!enc.includes(key.privateKey));
  assert.equal(decrypt(enc, box, signingKeyAad(key.keyId)), key.privateKey);
  assert.throws(() => decrypt(enc, box, signingKeyAad("other")));
  assert.throws(() => decrypt(enc, Buffer.alloc(32, 8), signingKeyAad(key.keyId)));
});

test("compareVersions orders dotted numbers and rejects anything else", () => {
  assert.equal(compareVersions("0.8.0", "0.7.0"), 1);
  assert.equal(compareVersions("0.7.99", "0.8.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.8", "0.8.0"), 0);
  assert.ok(Number.isNaN(compareVersions("0.8.0-beta", "0.8.0")));
  assert.ok(Number.isNaN(compareVersions("", "0.8.0")));
});

test("parseWorkerVersion reads the worker's VERSION line and releaseOf changes with any file", () => {
  assert.equal(parseWorkerVersion('import x from "y";\nexport const VERSION = "0.8.0";\n'), "0.8.0");
  assert.equal(parseWorkerVersion('const VERSION = "0.8.0";'), null);
  assert.match(served.release, /^0\.8\.0\+[0-9a-f]{8}$/);
  assert.notEqual(releaseOf("0.8.0", [files[0], { ...files[1], sha256: "c".repeat(64) }]), served.release);
});

test("pendingFiles: the worker file by hash, the Remotion bundle only where a project is installed", () => {
  assert.deepEqual(pendingFiles(served, { version: "0.8.0", files: { "venstudio-worker.ts": WORKER_SHA, "render-remotion.json": BUNDLE_SHA } }), []);
  assert.deepEqual(pendingFiles(served, { version: "0.7.0", files: { "venstudio-worker.ts": "c".repeat(64), "render-remotion.json": null } }), ["venstudio-worker.ts"]);
  assert.deepEqual(pendingFiles(served, { version: "0.8.0", files: { "venstudio-worker.ts": WORKER_SHA, "render-remotion.json": "unknown" } }), ["render-remotion.json"]);
  // No hashes reported: fall back to the version.
  assert.deepEqual(pendingFiles(served, { version: "0.8.0" }), []);
  assert.deepEqual(pendingFiles(served, { version: "0.7.0" }), ["venstudio-worker.ts"]);
});

test("decideOffer: Automatic offers, Approve waits for this exact release, Off never offers", () => {
  const behind = { version: "0.7.99", files: { "venstudio-worker.ts": "c".repeat(64), "render-remotion.json": null } };
  const current = { version: "0.8.0", files: { "venstudio-worker.ts": WORKER_SHA, "render-remotion.json": null } };
  assert.deepEqual(decideOffer({ mode: "auto", approvedRelease: null, served, worker: behind }), { pending: true, offer: true, reason: "auto" });
  assert.deepEqual(decideOffer({ mode: "auto", approvedRelease: null, served, worker: current }), { pending: false, offer: false, reason: "current" });
  assert.deepEqual(decideOffer({ mode: "approve", approvedRelease: null, served, worker: behind }), { pending: true, offer: false, reason: "awaiting-approval" });
  assert.deepEqual(decideOffer({ mode: "approve", approvedRelease: "0.8.0+00000000", served, worker: behind }), { pending: true, offer: false, reason: "awaiting-approval" });
  assert.deepEqual(decideOffer({ mode: "approve", approvedRelease: served.release, served, worker: behind }), { pending: true, offer: true, reason: "approved" });
  assert.deepEqual(decideOffer({ mode: "off", approvedRelease: served.release, served, worker: behind }), { pending: true, offer: false, reason: "off" });
});

test("describeUpdateResult gives the owner one plain line", () => {
  assert.equal(describeUpdateResult(null, null, null), null);
  assert.equal(describeUpdateResult("ok", null, "0.8.0"), "Updated to v0.8.0.");
  assert.equal(describeUpdateResult("rolled_back", "self-test failed", "0.9.0"), "Rolled back from v0.9.0: self-test failed");
  assert.equal(describeUpdateResult("refused", "checksum mismatch", "0.8.0"), "Refused v0.8.0: checksum mismatch");
});
