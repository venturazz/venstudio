import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { enroll, handlers, loop, normalizePortalUrl, parseArgs, NonRetryableError } from "./venstudio-worker.ts";

/** In-memory fake of the portal's worker API. */
function fakePortal() {
  const state = {
    token: "tok_abcdefghijklmnopqrstuvwxyz0123456789",
    enrolled: false,
    queue: [] as Array<{ id: string; type: string; payload: Record<string, unknown> }>,
    running: new Map<string, { cancel: boolean; lost: boolean }>(),
    completed: new Map<string, Record<string, unknown>>(),
    failed: new Map<string, { error: string; retryable: boolean }>(),
    artifacts: new Map<string, { bytes: number; sha256: string }>(),
    heartbeats: 0,
    claims: [] as Array<{ capabilities: string[]; mode: string }>,
  };

  async function body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  function json(res: ServerResponse, status: number, data?: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(data === undefined ? "" : JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/api/worker/enroll") {
      const b = JSON.parse((await body(req)).toString());
      if (b.code !== "VS-GOOD-CODE-0001") return json(res, 403, { error: "bad code" });
      state.enrolled = true;
      return json(res, 200, { workerId: "00000000-0000-0000-0000-000000000001", token: state.token });
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) return json(res, 401, { error: "unauthorized" });

    if (url === "/api/worker/claim") {
      state.claims.push(JSON.parse((await body(req)).toString()));
      const job = state.queue.shift();
      if (!job) {
        res.writeHead(204);
        return res.end();
      }
      state.running.set(job.id, { cancel: false, lost: false });
      return json(res, 200, {
        job: {
          ...job,
          capability: "echo",
          attempt: 1,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          heartbeatIntervalSeconds: 5,
        },
      });
    }
    const m = /^\/api\/worker\/jobs\/([^/]+)\/(heartbeat|complete|fail|artifacts\/(.+))$/.exec(url);
    if (!m) return json(res, 404, { error: "not found" });
    const [, id, action] = m;
    const run = state.running.get(id);
    if (!run || run.lost) {
      await body(req);
      return json(res, 409, { error: "not running" });
    }
    if (action === "heartbeat") {
      await body(req);
      state.heartbeats++;
      return json(res, 200, { leaseExpiresAt: new Date().toISOString(), cancel: run.cancel });
    }
    if (action === "complete") {
      state.completed.set(id, JSON.parse((await body(req)).toString()).result);
      state.running.delete(id);
      return json(res, 200, { ok: true });
    }
    if (action === "fail") {
      state.failed.set(id, JSON.parse((await body(req)).toString()));
      state.running.delete(id);
      return json(res, 200, { ok: true });
    }
    const buf = await body(req);
    const info = { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    state.artifacts.set(`${id}/${decodeURIComponent(m[3])}`, info);
    return json(res, 200, { name: m[3], ...info });
  });

  return {
    state,
    async start() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      return `http://127.0.0.1:${addr.port}`;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("normalizePortalUrl requires https except on localhost", () => {
  assert.equal(normalizePortalUrl("https://studio.example.com/path"), "https://studio.example.com");
  assert.equal(normalizePortalUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizePortalUrl("http://studio.example.com"));
});

test("parseArgs reads flags", () => {
  assert.deepEqual(parseArgs(["enroll", "--portal", "https://x", "--code", "VS-1", "--quiet"]), {
    command: "enroll",
    flags: { portal: "https://x", code: "VS-1", quiet: "true" },
  });
});

test("enroll, then tick runs every queued job and exits when the queue is empty", async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });

  await assert.rejects(enroll({ home, portal: base, code: "VS-WRONG", name: "Test" }), /403/);
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Test worker" });
  const cfg = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.token, portal.state.token);
  assert.equal((await stat(path.join(home, "config.json"))).mode & 0o777, 0o600);

  // A handler that writes and uploads a file, to exercise the artifact path without ffmpeg.
  handlers["test-upload"] = async (ctx) => {
    const file = path.join(ctx.workDir, "out.bin");
    await writeFile(file, Buffer.alloc(300_000, 7));
    ctx.progress(0.5, "wrote file");
    const up = await ctx.upload("out.bin", file, "application/octet-stream");
    return { bytes: up.bytes };
  };
  handlers["test-bad-input"] = async () => {
    throw new NonRetryableError("bad input");
  };

  portal.state.queue.push(
    { id: "job-echo", type: "echo", payload: { hello: "world" } },
    { id: "job-upload", type: "test-upload", payload: {} },
    { id: "job-bad", type: "test-bad-input", payload: {} },
    { id: "job-unknown", type: "does-not-exist", payload: {} },
  );

  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });

  const echo = portal.state.completed.get("job-echo")!;
  assert.ok(echo, "echo completed");
  assert.equal(typeof echo.cpus, "number");
  assert.deepEqual(echo.payload, { hello: "world" });

  assert.deepEqual(portal.state.completed.get("job-upload"), { bytes: 300_000 });
  assert.equal(portal.state.artifacts.get("job-upload/out.bin")?.bytes, 300_000);

  assert.deepEqual(portal.state.failed.get("job-bad"), { error: "bad input", retryable: false });
  assert.equal(portal.state.failed.get("job-unknown")?.retryable, false);

  assert.equal(portal.state.claims.at(-1)?.mode, "tick");
  assert.ok(portal.state.claims.at(-1)?.capabilities.includes("echo"));
  // Work dirs are cleaned after completion; lock released.
  await assert.rejects(stat(path.join(home, "work", "job-echo")));
  await assert.rejects(stat(path.join(home, "worker.lock")));
});

test("a job cancelled in the portal stops at the next heartbeat", async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Test worker" });

  handlers["test-slow"] = (ctx) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ finished: true }), 20_000);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
      // Simulate the user pressing Cancel shortly after start.
      setTimeout(() => {
        const run = portal.state.running.get("job-slow");
        if (run) run.cancel = true;
      }, 500);
    });
  portal.state.queue.push({ id: "job-slow", type: "test-slow", payload: {} });

  const started = Date.now();
  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });
  assert.ok(Date.now() - started < 15_000, "stopped well before the handler would finish");
  assert.equal(portal.state.completed.has("job-slow"), false);
  assert.deepEqual(portal.state.failed.get("job-slow"), { error: "Cancelled", retryable: false });
});

test("a second worker process can't run while the lock is held", async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Test worker" });
  await writeFile(path.join(home, "worker.lock"), String(process.pid)); // our own live pid
  await assert.rejects(loop({ home, mode: "tick", maxMinutes: 1, pollSeconds: 1 }), /Another worker is running/);
  await writeFile(path.join(home, "worker.lock"), "999999"); // stale pid
  await loop({ home, mode: "tick", maxMinutes: 1, pollSeconds: 1 });
});
