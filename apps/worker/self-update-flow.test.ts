/**
 * The whole self-update path with the real worker process: a worker of an older version, a small fake portal that signs
 * manifests with the portal's own code (apps/portal/lib/update-manifest.ts), and `tick` runs. scripts/e2e.sh does the
 * same against the real portal and Postgres in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, updatePaths } from "./venstudio-worker.ts";
import { buildManifest, newSigningKey, releaseOf, signManifest, type ManifestFile } from "../portal/lib/update-manifest.ts";

const SOURCE = readFileSync(fileURLToPath(new URL("./venstudio-worker.ts", import.meta.url)), "utf8");
const WORKER_ID = "11111111-2222-4333-8444-555555555555";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const withVersion = (v: string, inject = "") => {
  const out = SOURCE.replace(/^export const VERSION = ".*";$/m, `export const VERSION = "${v}";${inject ? `\n${inject}` : ""}`);
  assert.notEqual(out, SOURCE);
  return out;
};

interface Portal {
  url: string;
  served: { worker: string; bundle: string };
  mode: "pass" | "tamper" | "bad-signature" | "expired";
  pinnedVersion: string | null;
  reports: Array<{ status: string; version: string; detail: string }>;
  claims: string[];
  close: () => Promise<void>;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

async function fakePortal(): Promise<Portal> {
  const key = newSigningKey();
  const portal = {
    served: { worker: SOURCE, bundle: '{"name":"r","version":"0","files":[]}' },
    mode: "pass",
    pinnedVersion: null,
    reports: [],
    claims: [],
  } as unknown as Portal;
  const release = () => {
    const files: ManifestFile[] = [
      { name: "venstudio-worker.ts", sha256: sha(portal.served.worker), bytes: Buffer.byteLength(portal.served.worker) },
      { name: "render-remotion.json", sha256: sha(portal.served.bundle), bytes: Buffer.byteLength(portal.served.bundle) },
    ];
    const version = /^export const VERSION = "(.*)";$/m.exec(portal.served.worker)![1];
    return { version, release: releaseOf(version, files), files };
  };
  const server = createServer(async (req, res) => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const url = req.url ?? "";
    if (url === "/api/health") return json(200, { ok: true });
    if (url.startsWith("/api/worker/") && req.headers.authorization !== `Bearer ${"t".repeat(32)}`) return json(401, { error: "bad token" });
    if (url === "/api/worker/update" && req.method === "GET") return json(200, { keyId: key.keyId, mode: "auto" });
    if (url === "/api/worker/update" && req.method === "POST") {
      const b = (await body(req)) as { files?: Record<string, string | null> };
      const served = release();
      if (b.files?.["venstudio-worker.ts"] === served.files[0].sha256) return json(200, { manifest: null, reason: "current" });
      const now = portal.mode === "expired" ? new Date(Date.now() - 2 * 3600_000) : new Date();
      const m = signManifest(buildManifest({ keyId: key.keyId, workerId: WORKER_ID, served, pinnedVersion: portal.pinnedVersion, now }), key.privateKey);
      if (portal.mode === "bad-signature") m.signature = Buffer.from(Buffer.from(m.signature, "base64").map((x, i) => (i === 5 ? x ^ 0xff : x))).toString("base64");
      return json(200, { manifest: m, reason: "auto" });
    }
    if (url === "/api/worker/update/report") {
      portal.reports.push((await body(req)) as Portal["reports"][number]);
      return json(200, { ok: true });
    }
    if (url === "/api/worker/claim") {
      portal.claims.push(String((await body(req)).version));
      res.writeHead(204);
      return res.end();
    }
    if (url === "/install/venstudio-worker.ts") {
      // Tampering keeps the length, so only the checksum can catch it.
      let text = portal.served.worker;
      if (portal.mode === "tamper") text = text.replace("Self-update", "Self-updatE");
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(text);
    }
    if (url === "/install/render-remotion.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(portal.served.bundle);
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  portal.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  portal.close = () => new Promise<void>((r) => server.close(() => r()));
  (portal as Portal & { publicKey: string }).publicKey = key.publicKey;
  return portal;
}

async function workerHome(portal: Portal): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-flow-"));
  await mkdir(path.join(home, "app"), { recursive: true });
  const cfg = { portalUrl: portal.url, token: "t".repeat(32), workerId: WORKER_ID, name: "Flow", updateKey: (portal as Portal & { publicKey: string }).publicKey };
  await writeFile(path.join(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
  return home;
}

function tick(home: string): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, VENSTUDIO_HOME: home, VENSTUDIO_UPDATE_CHECK_SECONDS: "600" };
  delete env.VENSTUDIO_REMOTION_DIR;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.VENSTUDIO_AUTO_UPDATE;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--no-warnings", updatePaths(home).live, "tick"], { env, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

const OLD = "0.7.99";

test("self-update end to end: install, refuse tampering, bad signatures, expiry and downgrades, roll back broken versions", { timeout: 300_000 }, async (t) => {
  const portal = await fakePortal();
  const home = await workerHome(portal);
  t.after(async () => {
    await portal.close();
    await rm(home, { recursive: true, force: true });
  });
  const p = updatePaths(home);
  const live = () => readFile(p.live, "utf8");
  const lastReport = () => portal.reports.at(-1);

  await t.test("an older worker verifies, self-tests, swaps and restarts as the new version", async () => {
    await writeFile(p.live, withVersion(OLD));
    const r = await tick(home);
    assert.equal(r.code, 0, r.out);
    assert.equal(await live(), SOURCE);
    assert.equal(await readFile(p.prev, "utf8"), withVersion(OLD));
    assert.deepEqual(portal.claims, [VERSION], "only the new version claimed");
    assert.deepEqual(lastReport(), { status: "ok", version: VERSION, detail: `updated from v${OLD}` });
    assert.equal(existsSync(p.pending), false);
    assert.match(r.out, /signature and checksum verified/);
    // Current now: the next tick installs nothing and reports nothing.
    const n = portal.reports.length;
    assert.equal((await tick(home)).code, 0);
    assert.equal(portal.reports.length, n);
  });

  for (const [mode, re] of [
    ["tamper", /checksum mismatch/],
    ["bad-signature", /bad signature/],
    ["expired", /expired/],
  ] as const) {
    await t.test(`${mode}: refused, reported, nothing staged or run`, async () => {
      portal.mode = mode;
      await writeFile(p.live, withVersion(OLD));
      const r = await tick(home);
      portal.mode = "pass";
      assert.equal(r.code, 0, r.out);
      assert.equal(await live(), withVersion(OLD));
      assert.equal(existsSync(p.next), false);
      assert.equal(lastReport()?.status, "refused");
      assert.match(lastReport()?.detail ?? "", re);
      assert.equal(portal.claims.at(-1), OLD, "the old version kept working");
    });
  }

  await t.test("a downgrade is refused unless the owner pins that version", async () => {
    await writeFile(p.live, SOURCE);
    portal.served.worker = withVersion("0.7.50");
    let r = await tick(home);
    assert.equal(r.code, 0, r.out);
    assert.equal(await live(), SOURCE);
    assert.equal(lastReport()?.status, "refused");
    assert.match(lastReport()?.detail ?? "", /older than this worker/);
    portal.pinnedVersion = "0.7.50";
    r = await tick(home);
    assert.equal(r.code, 0, r.out);
    assert.equal(await live(), withVersion("0.7.50"));
    assert.deepEqual(lastReport(), { status: "ok", version: "0.7.50", detail: `updated from v${VERSION}` });
    portal.pinnedVersion = null;
    portal.served.worker = SOURCE;
    r = await tick(home);
    assert.equal(await live(), SOURCE, r.out);
  });

  await t.test("a version whose self-test fails is never swapped in, and is not tried again", async () => {
    portal.served.worker = withVersion("9.9.0", 'if (process.argv[2] === "selftest") { console.log(JSON.stringify({ ok: false, reason: "injected failure" })); process.exit(3); }');
    const r = await tick(home);
    assert.equal(r.code, 0, r.out);
    assert.equal(await live(), SOURCE);
    assert.equal(lastReport()?.status, "rolled_back");
    assert.match(lastReport()?.detail ?? "", /self-test failed.*injected failure/);
    assert.equal(existsSync(p.nextDir), false);
    const n = portal.reports.length;
    const again = await tick(home);
    assert.match(again.out, /failed here before/);
    assert.equal(portal.reports.length, n, "no new report for a release that already failed here");
  });

  await t.test("a version that exits with an error twice before its first claim is rolled back by the old process", async () => {
    portal.served.worker = withVersion("9.9.1", 'if (process.argv[2] === "tick") process.exit(4);');
    const claims = portal.claims.length;
    const r = await tick(home);
    assert.equal(r.code, 0, r.out);
    assert.equal(await live(), SOURCE);
    assert.equal(lastReport()?.status, "rolled_back");
    assert.match(lastReport()?.detail ?? "", /v9\.9\.1 exited with an error 2 times before its first claim/);
    assert.match(r.out, /starting it once more/);
    assert.deepEqual(portal.claims.slice(claims), [VERSION], "the previous version carried on");
    assert.equal(existsSync(p.pending), false);
    portal.served.worker = SOURCE;
  });
});
