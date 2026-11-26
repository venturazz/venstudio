import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PROVISION_MAX_ATTEMPTS, PROVISION_RETRY_MS, provisionDue, runProvisioner } from "./venstudio-worker.ts";

/**
 * Provisioning: a worker with no Remotion project installs one from the portal by running the portal's own installer as
 * its own account. These tests pin the two things that make that safe — the hash the portal names, and the attempt
 * bound that stops a box where Remotion cannot run from retrying every hour.
 */

const INSTALLER = "#!/usr/bin/env bash\necho '[venstudio] pretend install'\n";
const SHA = createHash("sha256").update(INSTALLER).digest("hex");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-provision-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "app"), { recursive: true });
  return dir;
}

async function serve(body: string) {
  const server = createServer((req, res) => {
    if (req.url !== "/install/install.sh") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("provisionDue: at most three attempts, six hours apart", () => {
  const now = Date.parse("2026-11-26T00:00:00Z");
  assert.equal(provisionDue({ attempts: 0, lastAt: null, lastError: null }, now), true);
  assert.equal(provisionDue({ attempts: 1, lastAt: new Date(now - 60_000).toISOString(), lastError: null }, now), false);
  assert.equal(provisionDue({ attempts: 1, lastAt: new Date(now - PROVISION_RETRY_MS).toISOString(), lastError: null }, now), true);
  assert.equal(provisionDue({ attempts: PROVISION_MAX_ATTEMPTS, lastAt: new Date(now - 99 * 3600_000).toISOString(), lastError: "x" }, now), false);
  // A malformed timestamp retries rather than wedging the worker forever.
  assert.equal(provisionDue({ attempts: 1, lastAt: "not a date", lastError: null }, now), true);
});

test("runProvisioner: runs the installer as this account, with --with-remotion and its own home", async () => {
  const box = await serve(INSTALLER);
  try {
    const dir = home();
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const r = await runProvisioner({
      home: dir,
      portalUrl: box.url,
      mode: "hold",
      expectedSha256: SHA,
      run: async (file, args, cwd) => {
        calls.push({ file, args, cwd });
        return { code: 0 };
      },
    });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, dir);
    assert.match(calls[0].args.join(" "), /--home .*--with-remotion$/);
    assert.match(calls[0].args.join(" "), /--mode hold/);
    // The fetched installer is kept so the log and the owner can see exactly what ran.
    const kept = path.join(dir, "app", "install-provision.sh");
    assert.equal(readFileSync(kept, "utf8"), INSTALLER);
    assert.equal(statSync(kept).mode & 0o777, 0o700);
  } finally {
    box.close();
  }
});

test("runProvisioner: refuses an installer that is not the one the portal named", async () => {
  const box = await serve(INSTALLER.replace("pretend", "something else"));
  try {
    const dir = home();
    let ran = 0;
    const r = await runProvisioner({
      home: dir,
      portalUrl: box.url,
      mode: "tick",
      expectedSha256: SHA,
      run: async () => {
        ran += 1;
        return { code: 0 };
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /changed while fetching/);
    assert.equal(ran, 0, "nothing may run when the hash does not match");
    assert.equal(existsSync(path.join(dir, "app", "install-provision.sh")), false);
  } finally {
    box.close();
  }
});

test("runProvisioner: a failing installer reports its last lines", async () => {
  const box = await serve(INSTALLER);
  try {
    const r = await runProvisioner({
      home: home(),
      portalUrl: box.url,
      mode: "hold",
      expectedSha256: SHA,
      run: async () => ({ code: 1, reason: "chromium: libnss3.so missing" }),
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /libnss3/);
  } finally {
    box.close();
  }
});