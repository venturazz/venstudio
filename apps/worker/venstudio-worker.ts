#!/usr/bin/env node
/**
 * VenStudio render worker.
 *
 * Single file, no npm dependencies. Runs on Node.js >= 22.18 (TypeScript type stripping is on by default).
 * Talks to the portal only through outbound HTTPS, so it works on Muse VMs (no public IP, egress proxy).
 *
 *   node venstudio-worker.ts enroll --portal https://studio.example.com --code VS-XXXX-XXXX-XXXX --name "Muse 01"
 *   node venstudio-worker.ts tick     # claim and run jobs until the queue is empty, then exit
 *   node venstudio-worker.ts hold     # stay online ~55 min, starting jobs within seconds (Muse hourly task)
 *   node venstudio-worker.ts daemon   # poll forever (VPS / GPU box)
 *   node venstudio-worker.ts status   # show config and check the portal is reachable
 *
 * State lives in $VENSTUDIO_HOME (default /home/hatch/venstudio on Muse, else ./.venstudio):
 *   config.json   portal URL + worker token (chmod 600)
 *   work/<jobId>/ job scratch space; kept until the job finishes so a restarted VM can resume
 *   worker.lock   prevents two workers running at once
 */

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import type {
  Capability,
  ClaimedJob,
  ClaimResponse,
  EnrollResponse,
  HeartbeatResponse,
  WorkerMode,
} from "../../packages/protocol/src/index.ts";

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Config

export interface WorkerConfig {
  portalUrl: string;
  token: string;
  workerId: string;
  name: string;
}

export function defaultHome(): string {
  if (process.env.VENSTUDIO_HOME) return path.resolve(process.env.VENSTUDIO_HOME);
  if (existsSync("/home/hatch")) return "/home/hatch/venstudio";
  return path.resolve(".venstudio");
}

export async function loadConfig(home: string): Promise<WorkerConfig> {
  const file = path.join(home, "config.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`No config at ${file}. Run "enroll" first.`);
  }
  const cfg = JSON.parse(raw) as WorkerConfig;
  if (!cfg.portalUrl || !cfg.token) throw new Error(`Config at ${file} is incomplete. Enroll again.`);
  return cfg;
}

async function saveConfig(home: string, cfg: WorkerConfig) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.json");
  await writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

// ---------------------------------------------------------------------------
// Logging

let quiet = false;
export function log(msg: string) {
  if (!quiet) console.log(`${new Date().toISOString()} ${msg}`);
}

// ---------------------------------------------------------------------------
// HTTP

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function normalizePortalUrl(url: string): string {
  const u = new URL(url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("Portal URL must use https:// (http:// is only allowed for localhost)");
  }
  return u.origin;
}

export class PortalClient {
  base: string;
  token: string | undefined;
  constructor(base: string, token?: string) {
    this.base = normalizePortalUrl(base);
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "user-agent": `venstudio-worker/${VERSION}`,
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /** JSON request with retries on network errors and 5xx. Returns null for 204. */
  async json<T>(method: string, pathname: string, body?: unknown, attempts = 4): Promise<T | null> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(this.base + pathname, {
          method,
          headers: this.headers({ "content-type": "application/json" }),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 204) return null;
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : null) as T;
        let message = text.slice(0, 300);
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message;
        } catch {}
        const err = new HttpError(res.status, `${method} ${pathname} -> ${res.status}: ${message}`);
        if (res.status < 500) throw err; // client errors are final
        lastErr = err;
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) throw err;
        lastErr = err;
      }
      if (i < attempts - 1) await sleep(Math.min(30_000, 1000 * 2 ** i));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Downloads one input asset of this job and verifies its SHA-256 before the file is used. */
  async download(jobId: string, assetId: string, dest: string): Promise<{ bytes: number; sha256: string }> {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${this.base}/api/worker/jobs/${jobId}/inputs/${assetId}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          const err = new HttpError(res.status, `download ${assetId} -> ${res.status}: ${text.slice(0, 200)}`);
          if (res.status < 500) throw err;
          lastErr = err;
        } else {
          const expected = res.headers.get("x-sha256") ?? "";
          const tmp = `${dest}.part`;
          const hash = createHash("sha256");
          let bytes = 0;
          const meter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              hash.update(chunk);
              bytes += chunk.length;
              cb(null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>), meter, createWriteStream(tmp));
          const sha256 = hash.digest("hex");
          if (expected && sha256 !== expected) {
            await rm(tmp, { force: true });
            throw new Error(`download ${assetId}: checksum mismatch`);
          }
          await rename(tmp, dest);
          return { bytes, sha256 };
        }
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) throw err;
        lastErr = err;
      }
      await sleep(2000 * (i + 1));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async upload(jobId: string, name: string, file: string, contentType: string) {
    const info = await stat(file);
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${this.base}/api/worker/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: this.headers({ "content-type": contentType, "content-length": String(info.size) }),
          body: Readable.toWeb(createReadStream(file)) as ReadableStream,
          // Required by Node's fetch for streaming request bodies.
          duplex: "half",
          signal: AbortSignal.timeout(30 * 60_000),
        } as RequestInit);
        const text = await res.text();
        if (res.ok) return JSON.parse(text) as { name: string; bytes: number; sha256: string };
        const err = new HttpError(res.status, `upload ${name} -> ${res.status}: ${text.slice(0, 300)}`);
        if (res.status < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof HttpError && err.status < 500) throw err;
        lastErr = err;
      }
      await sleep(2000 * (i + 1));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

// ---------------------------------------------------------------------------
// Capabilities

function hasCommand(cmd: string, args: string[] = ["-version"]): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<Capability[]> {
  const caps: Capability[] = ["echo"];
  if (hasCommand(process.env.FFMPEG_PATH ?? "ffmpeg")) caps.push("ffmpeg");
  const kokoro = process.env.KOKORO_URL;
  if (kokoro) {
    try {
      const res = await fetch(`${kokoro.replace(/\/+$/, "")}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) caps.push("tts-kokoro");
    } catch {}
  }
  const extra = (process.env.VENSTUDIO_EXTRA_CAPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of extra) if (!caps.includes(c as Capability)) caps.push(c as Capability);
  return caps;
}

// ---------------------------------------------------------------------------
// Job handlers

export interface JobContext {
  job: ClaimedJob;
  workDir: string;
  signal: AbortSignal;
  progress: (fraction: number, message?: string) => void;
  upload: (name: string, file: string, contentType: string) => Promise<{ bytes: number; sha256: string }>;
  /** Fetches an input asset of this job (only assets listed in the job payload are allowed). */
  download: (assetId: string, dest: string) => Promise<{ bytes: number; sha256: string }>;
}

export class NonRetryableError extends Error {}

type Handler = (ctx: JobContext) => Promise<Record<string, unknown>>;

async function freeDiskGb(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Reference analysis (study only: cuts, pacing, hook timing, loudness)

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

export function ffprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) return path.join(path.dirname(process.env.FFMPEG_PATH), "ffprobe");
  return "ffprobe";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/** Reads ffprobe's JSON. Throws a non-retryable error when the file has no video or no duration. */
export function parseProbe(json: unknown): ProbeResult {
  const j = json as { format?: { duration?: unknown }; streams?: Array<Record<string, unknown>> };
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) throw new NonRetryableError("The file has no video stream");
  const [num, den] = String(video.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = den > 0 ? round2(num / den) : 0;
  const durationSec = Number(j.format?.duration ?? video.duration ?? 0);
  if (!(durationSec > 0)) throw new NonRetryableError("Could not read the video duration");
  return {
    durationSec: round2(durationSec),
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    fps,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

/** Cut times from ffmpeg's showinfo log. Detections within 0.2 s of each other are one cut. */
export function parseShowinfoTimes(stderr: string, durationSec: number): number[] {
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (t > 0.05 && t < durationSec - 0.05) times.push(t);
  }
  const out: number[] = [];
  for (const t of times.sort((a, b) => a - b)) {
    if (out.length === 0 || t - out[out.length - 1] > 0.2) out.push(t);
  }
  return out;
}

/** Integrated loudness (LUFS) from ffmpeg's ebur128 summary: the last "I:" value. */
export function parseLoudness(stderr: string): number | null {
  const matches = [...stderr.matchAll(/\bI:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)];
  if (matches.length === 0) return null;
  const v = Number(matches[matches.length - 1][1]);
  return Number.isFinite(v) ? v : null;
}

export interface AnalysisDoc {
  schemaVersion: 1;
  source: { assetId: string };
  video: ProbeResult;
  cuts: number[];
  shots: { count: number; avgSeconds: number; medianSeconds: number; shortestSeconds: number; longestSeconds: number };
  hook: { firstCutSeconds: number | null };
  pacing: { cutsPerMinute: number };
  loudnessLufs: number | null;
}

export function summarizeAnalysis(args: { assetId: string; probe: ProbeResult; cuts: number[]; loudnessLufs: number | null }): AnalysisDoc {
  const d = args.probe.durationSec;
  const bounds = [0, ...args.cuts, d];
  const shots = bounds.slice(1).map((t, i) => t - bounds[i]).filter((s) => s > 0);
  const sorted = [...shots].sort((a, b) => a - b);
  const avg = shots.length ? shots.reduce((a, b) => a + b, 0) / shots.length : d;
  return {
    schemaVersion: 1,
    source: { assetId: args.assetId },
    video: args.probe,
    cuts: args.cuts.map(round2),
    shots: {
      count: shots.length,
      avgSeconds: round2(avg),
      medianSeconds: round2(sorted[Math.floor(sorted.length / 2)] ?? d),
      shortestSeconds: round2(sorted[0] ?? d),
      longestSeconds: round2(sorted[sorted.length - 1] ?? d),
    },
    hook: { firstCutSeconds: args.cuts.length ? round2(args.cuts[0]) : null },
    pacing: { cutsPerMinute: round2(args.cuts.length / (d / 60)) },
    loudnessLufs: args.loudnessLufs === null ? null : round2(args.loudnessLufs),
  };
}

/** Runs a command and returns its output. Rejects on a non-zero exit or when aborted. */
export function runCapture(cmd: string, args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new Error("Aborted"));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
}

export const handlers: Record<string, Handler> = {
  async echo(ctx) {
    ctx.progress(0.5, "Collecting environment");
    return {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      freeDiskGb: await freeDiskGb(ctx.workDir),
      behindProxy: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy),
      ffmpeg: hasCommand(process.env.FFMPEG_PATH ?? "ffmpeg"),
      payload: ctx.job.payload,
    };
  },

  async "analyze-video"(ctx) {
    const inputs = Array.isArray(ctx.job.payload.inputs) ? ctx.job.payload.inputs.filter((v): v is string => typeof v === "string") : [];
    const assetId = inputs[0];
    if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) throw new NonRetryableError("analyze-video needs exactly one input asset");
    const input = path.join(ctx.workDir, "input.bin");
    if (!(await stat(input).catch(() => null))) {
      ctx.progress(0.05, "Downloading reference");
      await ctx.download(assetId, input);
    }
    ctx.progress(0.2, "Reading stream info");
    const probe = parseProbe(
      JSON.parse(
        (await runCapture(ffprobePath(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input], ctx.signal)).stdout,
      ),
    );
    ctx.progress(0.3, "Detecting cuts");
    const scenes = await runCapture(
      ffmpegPath(),
      ["-hide_banner", "-nostats", "-i", input, "-an", "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"],
      ctx.signal,
    );
    const cuts = parseShowinfoTimes(scenes.stderr, probe.durationSec);
    ctx.progress(0.8, "Measuring loudness");
    const loudnessLufs = probe.hasAudio
      ? parseLoudness((await runCapture(ffmpegPath(), ["-hide_banner", "-nostats", "-i", input, "-af", "ebur128=peak=true", "-f", "null", "-"], ctx.signal)).stderr)
      : null;
    const doc = summarizeAnalysis({ assetId, probe, cuts, loudnessLufs });
    const out = path.join(ctx.workDir, "analysis.json");
    await writeFile(out, JSON.stringify(doc, null, 2));
    await ctx.upload("analysis.json", out, "application/json");
    return {
      schemaVersion: 1,
      durationSec: probe.durationSec,
      cutCount: cuts.length,
      avgShotSeconds: doc.shots.avgSeconds,
      firstCutSeconds: doc.hook.firstCutSeconds,
      cutsPerMinute: doc.pacing.cutsPerMinute,
      loudnessLufs: doc.loudnessLufs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
    };
  },

  async "smoke-test"(ctx) {
    const p = ctx.job.payload as { seconds?: number; width?: number; height?: number; fps?: number };
    const seconds = clampInt(p.seconds, 1, 60, 5);
    const width = clampInt(p.width, 16, 3840, 1080);
    const height = clampInt(p.height, 16, 3840, 1920);
    const fps = clampInt(p.fps, 1, 60, 30);
    const out = path.join(ctx.workDir, "smoke-test.mp4");

    let renderSeconds: number | null = null;
    // Resume: if a previous attempt (VM recycled mid-job) already rendered the file, only upload it.
    const existing = await stat(out).catch(() => null);
    if (existing && existing.size > 0) {
      ctx.progress(0.8, "Found finished render from a previous attempt; uploading");
    } else {
      const started = Date.now();
      await runFfmpeg(
        [
          "-y", "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}`,
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
          "-t", String(seconds),
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          "-progress", "pipe:1", "-nostats",
          `${out}.part.mp4`,
        ],
        seconds,
        (f) => ctx.progress(f * 0.8, `Rendering ${Math.round(f * 100)}%`),
        ctx.signal,
      );
      await rename(`${out}.part.mp4`, out);
      renderSeconds = (Date.now() - started) / 1000;
      ctx.progress(0.8, `Rendered in ${renderSeconds.toFixed(1)} s; uploading`);
    }
    const up = await ctx.upload("smoke-test.mp4", out, "video/mp4");
    return {
      seconds,
      resolution: `${width}x${height}`,
      fps,
      renderSeconds,
      realtimeFactor: renderSeconds ? Math.round((seconds / renderSeconds) * 100) / 100 : null,
      bytes: up.bytes,
      sha256: up.sha256,
      cpus: os.cpus().length,
    };
  },
};

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Runs ffmpeg with `-progress pipe:1` and reports progress as a fraction of `durationSeconds`. */
export function runFfmpeg(
  args: string[],
  durationSeconds: number,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let lastReport = 0;
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const m = /out_time_(?:us|ms)=(\d+)/.exec(chunk);
      if (m && Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSeconds));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new Error("Aborted"));
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(-1000)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Running a job

export async function runJob(client: PortalClient, job: ClaimedJob, home: string): Promise<void> {
  const workDir = path.join(home, "work", job.id);
  await mkdir(workDir, { recursive: true });
  const controller = new AbortController();
  let lastProgress: number | undefined;
  let lastMessage: string | undefined;
  let leaseLost = false;
  let cancelled = false;

  const beat = async () => {
    try {
      const res = await client.json<HeartbeatResponse>("POST", `/api/worker/jobs/${job.id}/heartbeat`, {
        progress: lastProgress,
        message: lastMessage,
      });
      lastMessage = undefined;
      if (res?.cancel) {
        cancelled = true;
        controller.abort();
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        leaseLost = true;
        controller.abort();
      } else {
        log(`heartbeat failed: ${(err as Error).message}`);
      }
    }
  };
  const timer = setInterval(beat, Math.max(5, job.heartbeatIntervalSeconds) * 1000);

  const handler = handlers[job.type];
  log(`job ${job.id} (${job.type}) attempt ${job.attempt} started`);
  try {
    if (!handler) throw new NonRetryableError(`This worker version (${VERSION}) has no handler for "${job.type}"`);
    const result = await handler({
      job,
      workDir,
      signal: controller.signal,
      progress: (f, msg) => {
        lastProgress = f;
        if (msg) lastMessage = msg;
      },
      download: (assetId, dest) => client.download(job.id, assetId, dest),
      upload: async (name, file, type) => {
        await beat(); // refresh the lease before a long upload
        const r = await client.upload(job.id, name, file, type);
        return { bytes: r.bytes, sha256: r.sha256 };
      },
    });
    clearInterval(timer);
    await client.json("POST", `/api/worker/jobs/${job.id}/complete`, { result, message: "Completed" });
    log(`job ${job.id} completed`);
    await rm(workDir, { recursive: true, force: true });
  } catch (err) {
    clearInterval(timer);
    const message = err instanceof Error ? err.message : String(err);
    if (leaseLost) {
      log(`job ${job.id} lease lost; dropping it (another worker may retry)`);
      return;
    }
    if (cancelled) {
      log(`job ${job.id} cancelled by portal`);
      await client.json("POST", `/api/worker/jobs/${job.id}/fail`, { error: "Cancelled", retryable: false }).catch(() => {});
      await rm(workDir, { recursive: true, force: true });
      return;
    }
    log(`job ${job.id} failed: ${message}`);
    const retryable = !(err instanceof NonRetryableError);
    await client.json("POST", `/api/worker/jobs/${job.id}/fail`, { error: message, retryable }).catch((e) => {
      log(`could not report failure: ${(e as Error).message}`);
    });
    if (!retryable) await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Loop

async function acquireLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "worker.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await open(file, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      let alive = false;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {}
      }
      if (alive) throw new AlreadyRunningError(`Another worker is running (pid ${pid}).`);
      await rm(file, { force: true }); // stale lock from a recycled VM
    }
  }
  throw new Error("Could not acquire worker lock");
}

export class AlreadyRunningError extends Error {}

/** Long-poll window: the portal holds a claim request open this long waiting for a job. */
export const CLAIM_WAIT_SECONDS = 25;

/**
 * Main loop.
 *   tick   - run until the queue is empty, then exit.
 *   hold   - stay online until the time budget is used, picking up jobs within seconds (Muse hourly task).
 *   daemon - run forever.
 * A job that starts before the budget ends always runs to completion.
 */
export async function loop(opts: {
  home: string;
  mode: WorkerMode;
  maxMinutes: number;
  pollSeconds: number;
  claimWaitSeconds?: number;
}) {
  const cfg = await loadConfig(opts.home);
  const client = new PortalClient(cfg.portalUrl, cfg.token);
  const release = await acquireLock(opts.home);
  const deadline = Date.now() + opts.maxMinutes * 60_000;
  const timeLeft = () => deadline - Date.now();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    const capabilities = await detectCapabilities();
    const budget = opts.mode === "daemon" ? "" : `, budget ${opts.maxMinutes} min`;
    log(`${cfg.name} v${VERSION} ${opts.mode} mode${budget}, capabilities: ${capabilities.join(", ")}`);
    let ran = 0;
    let idleBackoff = opts.pollSeconds;
    while (!stopping) {
      if (opts.mode !== "daemon" && timeLeft() <= 0) {
        log(`time budget used after ${ran} job(s); exiting until next wake`);
        break;
      }
      // Never hold a claim open past the budget.
      const maxWait = opts.claimWaitSeconds ?? CLAIM_WAIT_SECONDS;
      const waitSeconds =
        opts.mode === "tick" ? 0 : Math.max(0, Math.min(maxWait, Math.floor(opts.mode === "hold" ? timeLeft() / 1000 : maxWait)));
      let res: ClaimResponse | null;
      try {
        res = await client.json<ClaimResponse>("POST", "/api/worker/claim", {
          capabilities,
          mode: opts.mode,
          version: VERSION,
          waitSeconds,
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) throw new Error("Portal rejected the worker token (revoked?). Enroll again.");
        log(`claim failed: ${(err as Error).message}`);
        if (opts.mode === "tick") break;
        const pause = Math.min(idleBackoff * 1000, opts.mode === "hold" ? Math.max(0, timeLeft()) : 300_000);
        await sleep(pause);
        idleBackoff = Math.min(300, idleBackoff * 2);
        continue;
      }
      idleBackoff = opts.pollSeconds;
      if (!res) {
        if (opts.mode === "tick") {
          log(ran === 0 ? "queue empty" : `queue empty after ${ran} job(s)`);
          break;
        }
        // Long-poll already waited; only pause if the portal answered instantly (old portal or drained worker).
        if (waitSeconds === 0) await sleep(Math.min(opts.pollSeconds * 1000, Math.max(0, timeLeft())));
        continue;
      }
      await runJob(client, res.job, opts.home);
      ran++;
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await release();
  }
}

// ---------------------------------------------------------------------------
// Commands

export async function enroll(opts: { home: string; portal: string; code: string; name: string }) {
  const client = new PortalClient(opts.portal);
  const capabilities = await detectCapabilities();
  const res = await client.json<EnrollResponse>("POST", "/api/worker/enroll", {
    code: opts.code,
    name: opts.name,
    capabilities,
    version: VERSION,
  });
  if (!res) throw new Error("Empty enrollment response");
  await saveConfig(opts.home, { portalUrl: client.base, token: res.token, workerId: res.workerId, name: opts.name });
  log(`enrolled as ${opts.name} (${res.workerId}); config saved to ${path.join(opts.home, "config.json")}`);
}

async function status(home: string) {
  const cfg = await loadConfig(home);
  console.log(JSON.stringify({ name: cfg.name, workerId: cfg.workerId, portalUrl: cfg.portalUrl, version: VERSION, home }, null, 2));
  const res = await fetch(`${cfg.portalUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  console.log(`portal health: HTTP ${res.status}`);
  console.log(`capabilities: ${(await detectCapabilities()).join(", ")}`);
}

export function parseArgs(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = "true";
    }
  }
  return { command, flags };
}

const HELP = `venstudio-worker ${VERSION}
Usage:
  node venstudio-worker.ts enroll --portal <url> --code <code> [--name <name>]
  node venstudio-worker.ts tick   [--max-minutes 50]   run until the queue is empty
  node venstudio-worker.ts hold   [--max-minutes 55]   stay online for the budget (Muse hourly task)
  node venstudio-worker.ts daemon [--poll 30]
  node venstudio-worker.ts status
Env: VENSTUDIO_HOME, FFMPEG_PATH, KOKORO_URL, VENSTUDIO_EXTRA_CAPS, HTTPS_PROXY`;

/**
 * Node's fetch only uses HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 is set at startup.
 * Muse VMs route egress through a proxy, so re-run ourselves with it set.
 */
function ensureProxyEnv(): boolean {
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return false;
  const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(child.status ?? 1);
}

export async function main(argv: string[]) {
  const { command, flags } = parseArgs(argv);
  const home = flags.home ? path.resolve(flags.home) : defaultHome();
  quiet = flags.quiet === "true";
  switch (command) {
    case "enroll":
      if (!flags.portal || !flags.code) throw new Error("enroll needs --portal and --code");
      return enroll({ home, portal: flags.portal, code: flags.code, name: flags.name ?? os.hostname() });
    case "tick":
      return loop({ home, mode: "tick", maxMinutes: Number(flags["max-minutes"] ?? 50), pollSeconds: 30 });
    case "hold":
      return loop({ home, mode: "hold", maxMinutes: Number(flags["max-minutes"] ?? 55), pollSeconds: 20 });
    case "daemon":
      return loop({ home, mode: "daemon", maxMinutes: Infinity, pollSeconds: Number(flags.poll ?? 30) });
    case "status":
      return status(home);
    default:
      console.log(HELP);
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  ensureProxyEnv();
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof AlreadyRunningError) {
      // The previous scheduled run is still working (e.g. a long render). Not an error.
      console.log(`${new Date().toISOString()} already running: ${err.message} Nothing to do.`);
      process.exit(0);
    }
    console.error(`${new Date().toISOString()} fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
