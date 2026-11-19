import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  AlreadyRunningError,
  enroll,
  handlers,
  loop,
  normalizePortalUrl,
  parseArgs,
  NonRetryableError,
  parseLoudness,
  parseProbe,
  parseShowinfoTimes,
  summarizeAnalysis,
  wrapText,
} from "./venstudio-worker.ts";

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
    inputs: new Map<string, Buffer>(),
    heartbeats: 0,
    claims: [] as Array<{ capabilities: string[]; mode: string; waitSeconds?: number }>,
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
      const claim = JSON.parse((await body(req)).toString());
      state.claims.push(claim);
      // Long-poll like the real portal: wait up to waitSeconds for a job.
      const until = Date.now() + (claim.waitSeconds ?? 0) * 1000;
      while (state.queue.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
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
    const inputMatch = /^\/api\/worker\/jobs\/([^/]+)\/inputs\/([^/]+)$/.exec(url);
    if (inputMatch && req.method === "GET") {
      const [, jobId, assetId] = inputMatch;
      if (!state.running.has(jobId)) return json(res, 409, { error: "not running" });
      const data = state.inputs.get(assetId);
      if (!data) return json(res, 404, { error: "no such asset" });
      res.writeHead(200, { "content-type": "application/octet-stream", "x-sha256": createHash("sha256").update(data).digest("hex") });
      return res.end(data);
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
  await assert.rejects(loop({ home, mode: "tick", maxMinutes: 1, pollSeconds: 1 }), AlreadyRunningError);
  await writeFile(path.join(home, "worker.lock"), "999999"); // stale pid
  await loop({ home, mode: "tick", maxMinutes: 1, pollSeconds: 1 });
});

test("hold mode stays online, picks up a job queued mid-run within seconds, and exits at the budget", async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Hold worker" });

  let queuedAt = 0;
  setTimeout(() => {
    queuedAt = Date.now();
    portal.state.queue.push({ id: "job-late", type: "echo", payload: {} });
  }, 2500);
  const done = new Promise<number>((resolve) => {
    const iv = setInterval(() => {
      if (portal.state.completed.has("job-late")) {
        clearInterval(iv);
        resolve(Date.now());
      }
    }, 50);
  });

  const started = Date.now();
  // 0.1 min = 6 s budget, 2 s long-poll window.
  await loop({ home, mode: "hold", maxMinutes: 0.1, pollSeconds: 1, claimWaitSeconds: 2 });
  const elapsed = Date.now() - started;
  const finishedAt = await done;

  assert.ok(finishedAt - queuedAt < 1500, `job started ${finishedAt - queuedAt} ms after queueing`);
  assert.ok(elapsed >= 5500 && elapsed < 10_000, `exited after ${elapsed} ms`);
  assert.ok(portal.state.claims.every((c) => c.mode === "hold"));
  assert.ok(portal.state.claims.every((c) => (c.waitSeconds ?? 0) <= 2), "never waits past the cap");
  assert.ok(portal.state.claims.length <= 6, `long-poll keeps claim count low (${portal.state.claims.length})`);
});

test("analysis parsers: cut times, dedupe, loudness and probe", () => {
  const log = "n:0 pts_time:0.000\nn:1 pts_time:2.000\nn:2 pts_time:2.033\nn:3 pts_time:4.000\nn:4 pts_time:6.9999";
  assert.deepEqual(parseShowinfoTimes(log, 7), [2, 4]);
  assert.equal(parseLoudness("t: 1 M: -20.1 I: -22.0 LUFS\nSummary:\n  I:  -14.2 LUFS\n  LRA: 3 LU"), -14.2);
  assert.equal(parseLoudness("no audio here"), null);
  const probe = parseProbe({
    format: { duration: "7.000000" },
    streams: [{ codec_type: "video", r_frame_rate: "30000/1001", width: 1080, height: 1920 }, { codec_type: "audio" }],
  });
  assert.deepEqual(probe, { durationSec: 7, width: 1080, height: 1920, fps: 29.97, hasAudio: true });
  assert.throws(() => parseProbe({ format: { duration: "5" }, streams: [{ codec_type: "audio" }] }), NonRetryableError);
  const doc = summarizeAnalysis({ assetId: "a", probe, cuts: [2, 4], loudnessLufs: -14 });
  assert.equal(doc.shots.count, 3);
  assert.equal(doc.shots.avgSeconds, 2.33);
  assert.equal(doc.hook.firstCutSeconds, 2);
  assert.equal(doc.pacing.cutsPerMinute, 17.14);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test("analyze-video downloads a reference, finds its cuts and loudness, and uploads analysis.json", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Analysis worker" });

  // Three flat colour shots: cuts at 2 s and 4 s, plus a sine tone for loudness.
  const clip = path.join(home, "reference.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:d=3:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=7",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip,
  ]);
  const assetId = "11111111-2222-4333-8444-555555555555";
  const jobId = "22222222-3333-4444-8555-666666666666";
  portal.state.inputs.set(assetId, await readFile(clip));
  portal.state.queue.push({ id: jobId, type: "analyze-video", payload: { inputs: [assetId] } });

  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });

  const result = portal.state.completed.get(jobId) as Record<string, number | null>;
  assert.ok(result, "analysis job completed");
  assert.equal(result.cutCount, 2);
  assert.equal(result.firstCutSeconds, 2);
  assert.ok(Math.abs((result.avgShotSeconds as number) - 2.33) < 0.1, `avg shot ${result.avgShotSeconds}`);
  assert.equal(result.width, 320);
  assert.equal(typeof result.loudnessLufs, "number");
  assert.ok((portal.state.artifacts.get(`${jobId}/analysis.json`)?.bytes ?? 0) > 100, "analysis.json uploaded");
  await assert.rejects(stat(path.join(home, "work", jobId)), "work dir cleaned after completion");
});

test("analyze-video refuses a job without exactly one input asset", async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Guard worker" });
  portal.state.queue.push({ id: "33333333-3333-4444-8555-666666666666", type: "analyze-video", payload: { inputs: [] } });
  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });
  assert.equal(portal.state.failed.get("33333333-3333-4444-8555-666666666666")?.retryable, false);
});

test("wrapText keeps lines within the limit and drops nothing", () => {
  assert.equal(wrapText("a b c", 10), "a b c");
  const out = wrapText("The rise of the Roman roads across three continents and their lasting legacy", 20).split("\n");
  assert.ok(out.every((l) => l.length <= 20));
  assert.equal(out.join(" "), "The rise of the Roman roads across three continents and their lasting legacy");
});

test("render-preview renders placeholder cards and uploads preview.mp4", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Preview worker" });
  const jobId = "44444444-3333-4444-8555-666666666666";
  portal.state.queue.push({
    id: jobId,
    type: "render-preview",
    payload: { cards: ["Roman roads: a test card", "History · Educate"], durationSec: 5, width: 320, height: 568, fps: 15, fontAssetId: null, inputs: [] },
  });
  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });
  const result = portal.state.completed.get(jobId) as Record<string, unknown>;
  assert.ok(result, "render completed");
  assert.equal(result.cards, 2);
  assert.equal(result.textRendered, false);
  assert.equal(result.durationSec, 5);
  assert.ok((portal.state.artifacts.get(`${jobId}/preview.mp4`)?.bytes ?? 0) > 1000, "preview.mp4 uploaded");
});

const DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const hasDrawtext = hasFfmpeg && spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout.includes(" drawtext ");
test("render-preview draws the text when a font asset is supplied and ffmpeg has drawtext", { skip: !hasDrawtext || !existsSync(DEJAVU) ? "needs ffmpeg with drawtext and DejaVu Sans" : false }, async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "Font worker" });
  const fontId = "55555555-3333-4444-8555-666666666666";
  const jobId = "66666666-3333-4444-8555-666666666666";
  portal.state.inputs.set(fontId, readFileSync(DEJAVU));
  portal.state.queue.push({
    id: jobId,
    type: "render-preview",
    payload: { cards: ["Text on a card"], durationSec: 5, width: 320, height: 568, fps: 15, fontAssetId: fontId, inputs: [fontId] },
  });
  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });
  const result = portal.state.completed.get(jobId) as Record<string, unknown>;
  assert.equal(result?.textRendered, true);
});

test("render-preview says why text is missing when ffmpeg has no drawtext", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const portal = fakePortal();
  const base = await portal.start();
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-worker-"));
  t.after(async () => {
    await portal.stop();
    await rm(home, { recursive: true, force: true });
  });
  await enroll({ home, portal: base, code: "VS-GOOD-CODE-0001", name: "No-text worker" });
  const jobId = "77777777-3333-4444-8555-666666666666";
  portal.state.queue.push({ id: jobId, type: "render-preview", payload: { cards: ["Plain card"], durationSec: 5, width: 320, height: 568, fps: 15, fontAssetId: null, inputs: [] } });
  await loop({ home, mode: "tick", maxMinutes: 5, pollSeconds: 1 });
  const result = portal.state.completed.get(jobId) as Record<string, unknown>;
  assert.equal(result?.textRendered, false);
  assert.equal(result?.textNote, "no font in Assets");
});
