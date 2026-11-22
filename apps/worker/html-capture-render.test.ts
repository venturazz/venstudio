/**
 * html-capture for real (CI): the probe, every vendored html-capture pack rendered through the real render-video path (the
 * installed html/ pack, the Remotion project's Chrome Headless Shell, the shared caption burn and mux, then qc-video
 * with sampled frames), and pages that try the network, which must fail.
 *
 * Skipped unless VENSTUDIO_REMOTION_DIR points at a project assembled by scripts/remotion-project.mjs (it carries
 * html/<id>/ and html/packs.json) whose browser is installed, and ffmpeg is present. CI sets
 * VENSTUDIO_REMOTION_REQUIRED=1, so a broken install fails instead of skipping. Locally:
 *   node scripts/remotion-project.mjs /tmp/vs-remotion
 *   (cd /tmp/vs-remotion && npm install && npx remotion browser ensure)
 *   VENSTUDIO_REMOTION_DIR=/tmp/vs-remotion node --test apps/worker/html-capture-render.test.ts
 * VENSTUDIO_REMOTION_OUT=<dir> keeps the video.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RENDERERS,
  parseRenderSpec,
  captureHtml,
  clearHtmlCaptureCache,
  findChromium,
  handlers,
  htmlCaptureUnavailableReason,
  installedHtmlPacks,
  makeWavPcm16,
  placeholderUuid,
  withPlaceholderUuids,
  type JobContext,
} from "./venstudio-worker.ts";

const DIR = process.env.VENSTUDIO_REMOTION_DIR ? path.resolve(process.env.VENSTUDIO_REMOTION_DIR) : null;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const why = !DIR ? "VENSTUDIO_REMOTION_DIR is not set" : !hasFfmpeg ? "ffmpeg is not installed" : await htmlCaptureUnavailableReason(DIR);
if (why && process.env.VENSTUDIO_REMOTION_REQUIRED === "1") throw new Error(`html-capture-render: ${why}`);

function sine(seconds: number, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), true);
  return makeWavPcm16(rate, 1, pcm);
}

function systemFont(): string | null {
  const known = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  return known.find((f) => existsSync(f)) ?? null;
}

function ctxFor(workDir: string, home: string, type: string, payload: Record<string, unknown>, files: Map<string, string>, kept: Map<string, string>, capability: string): JobContext {
  return {
    job: { id: `eeeeeeee-4444-4444-8444-${type === "qc-video" ? "000000000002" : "000000000001"}`, type: type as JobContext["job"]["type"], payload, capability: capability as JobContext["job"]["capability"], attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home,
    signal: new AbortController().signal,
    progress: () => {},
    download: async (assetId, dest) => {
      const src = files.get(assetId);
      if (!src) throw new Error(`no such input ${assetId}`);
      await copyFile(src, dest);
      return { bytes: (await readFile(dest)).length, sha256: "" };
    },
    upload: async (name, file) => {
      const keep = path.join(home, `uploaded-${name}`);
      await copyFile(file, keep);
      kept.set(name, keep);
      return { bytes: (await readFile(keep)).length, sha256: "" };
    },
  };
}

function probeVideo(file: string) {
  const out = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt,nb_read_frames:format=duration", "-of", "json", file], { encoding: "utf8" }),
  ) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; nb_read_frames?: string }>; format: { duration: string } };
  return { video: out.streams.find((s) => s.codec_type === "video"), audio: out.streams.find((s) => s.codec_type === "audio"), duration: Number(out.format.duration) };
}

test("the html-capture probe passed on this machine (1 s page rendered, its network request blocked)", { skip: why ?? false }, () => {
  assert.equal(why, null);
});

/** Every html-capture pack in the vendored lock, with what its fixture must measure (fixtures/expect.json). */
const STYLES = new URL("../../styles/", import.meta.url);
const HTML_PACKS = (JSON.parse(readFileSync(new URL("lock.json", STYLES), "utf8")) as { packs: Array<{ id: string; version: string; engine: string }> }).packs.filter((p) => p.engine === "html-capture");

for (const lockPack of HTML_PACKS) {
  const PACK = new URL(`packs/${lockPack.id}/`, STYLES);
  const expect = JSON.parse(readFileSync(new URL("fixtures/expect.json", PACK), "utf8")) as { width: number; height: number; fps: number; durationSec: number };
  const drawsCaptions = (JSON.parse(readFileSync(new URL("style.json", PACK), "utf8")) as { renderer: { drawsCaptions?: boolean } }).renderer.drawsCaptions === true;
  const frames = Math.round(expect.durationSec * expect.fps);
  test(`${lockPack.id} renders through render-video: ${expect.width}x${expect.height}, ${expect.fps} fps, ${expect.durationSec} s, ${frames} frames, H.264 yuv420p with the narration; qc-video samples 6 frames`, { skip: why ?? false, timeout: 15 * 60_000 }, async (t) => {
    const installed = await installedHtmlPacks(DIR as string);
    assert.deepEqual(installed.problems, []);
    assert.ok(installed.packs.some((p) => p.id === lockPack.id), `the assembled project carries html/${lockPack.id}`);

    const home = await mkdtemp(path.join(os.tmpdir(), "vs-html-render-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const raw = JSON.parse(readFileSync(new URL("fixtures/payload.json", PACK), "utf8")) as Record<string, unknown>;
    const payload = withPlaceholderUuids(raw) as Record<string, unknown> & { shots: Array<{ assetId: string }>; narrationAssetId: string; durationSec: number };
    const files = new Map<string, string>();
    for (const [i, s] of payload.shots.entries()) {
      const f = path.join(home, `shot-${i}.png`);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${["1d3557", "2a9d8f", "6d597a"][i % 3]}:s=540x960`, "-frames:v", "1", f]);
      files.set(s.assetId, f);
    }
    const narration = path.join(home, "narration.wav");
    await writeFile(narration, sine(payload.durationSec));
    files.set(payload.narrationAssetId, narration);
    const font = systemFont();
    assert.ok(font, "no TrueType font on this machine for the fixture's asset-font");
    files.set(placeholderUuid("asset-font"), font);

    const kept = new Map<string, string>();
    const work = path.join(home, "work", "render");
    await mkdir(work, { recursive: true });
    const started = Date.now();
    const result = await handlers["render-video"](ctxFor(work, home, "render-video", payload, files, kept, `pack:${lockPack.id}@${lockPack.version}`));
    console.log(`html-capture render of ${lockPack.id} (${payload.durationSec} s) took ${((Date.now() - started) / 1000).toFixed(1)} s: ${JSON.stringify(result)}`);
    assert.equal(result.engine, "html-capture");
    assert.equal(result.renderer, "html-capture");
    assert.deepEqual(result.htmlPack, { id: lockPack.id, version: installed.packs.find((p) => p.id === lockPack.id)?.version });
    assert.equal(result.frames, frames);
    // captionsBurned means "the captions are in the video", as on the Remotion path: drawn by the page when the pack
    // declares drawsCaptions, burned by ffmpeg otherwise. Which one did it is the renderer's caption mode.
    assert.equal(result.captionsBurned, true, "the captions are in the video");
    assert.equal(RENDERERS["html-capture"].captions(parseRenderSpec(payload), { drawsCaptions } as never), drawsCaptions ? "renderer" : "shared-burn", "the page draws them only when the pack says so; otherwise the shared burn does, never both");
    const video = kept.get("video.mp4") as string;
    const p = probeVideo(video);
    assert.equal(p.video?.codec_name, "h264");
    assert.equal(p.video?.pix_fmt, "yuv420p");
    assert.equal(`${p.video?.width}x${p.video?.height}`, `${expect.width}x${expect.height}`);
    assert.equal(Number(p.video?.nb_read_frames), frames);
    assert.ok(Math.abs(p.duration - expect.durationSec) < 0.15, `duration ${p.duration}`);
    assert.equal(p.audio?.codec_name, "aac", "the shared mux added the narration");

    const qcFiles = new Map([["dddddddd-5555-4555-8555-000000000009", video]]);
    const qcWork = path.join(home, "work", "qc");
    await mkdir(qcWork, { recursive: true });
    const qc = await handlers["qc-video"](ctxFor(qcWork, home, "qc-video", { inputs: ["dddddddd-5555-4555-8555-000000000009"], sampleFrames: 6 }, qcFiles, kept, `pack:${lockPack.id}@${lockPack.version}`));
    assert.equal(qc.width, expect.width);
    assert.equal(qc.hasAudio, true);
    assert.equal((qc.sampledFrames as unknown[]).length, 6);
    assert.ok(kept.has("frame-06.jpg"));

    const out = process.env.VENSTUDIO_REMOTION_OUT;
    if (out) {
      await mkdir(out, { recursive: true });
      await copyFile(video, path.join(out, `${lockPack.id}.mp4`));
    }
  });
}

/** A one-file page that does `body` in init (or at load when `atLoad`), then renders a plain frame. */
async function networkPage(dir: string, body: string, atLoad = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const page = `<!doctype html><html><body>${atLoad ? body : ""}<script>
window.VENSTUDIO = {
  async init(p) { ${atLoad ? "" : body} return { totalFrames: p.totalFrames, fps: p.fps, width: p.width, height: p.height }; },
  renderFrame(f) { document.body.style.background = f % 2 ? "#000" : "#fff"; }
};</script></body></html>`;
  await writeFile(path.join(dir, "index.html"), page);
  return dir;
}

test("a page that tries the network fails the job by name: fetch, an image from another host, a WebSocket", { skip: why ?? false, timeout: 5 * 60_000 }, async (t) => {
  clearHtmlCaptureCache();
  const chrome = await findChromium(DIR as string);
  assert.ok(chrome);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vs-html-net-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cases: Array<[string, string, boolean]> = [
    ["fetch", `await fetch("https://example.com/data.json").catch(() => null);`, false],
    ["img", `<img src="http://198.51.100.7/pic.png">`, true],
    ["websocket", `try { new WebSocket("wss://example.com/live"); } catch (e) {}`, false],
  ];
  for (const [name, body, atLoad] of cases) {
    const root = await networkPage(path.join(tmp, name), body, atLoad);
    const size = { width: 64, height: 36, fps: 10, totalFrames: 5 };
    await assert.rejects(
      captureHtml({ chrome: chrome as string, root, inDir: null, props: size, ...size, output: path.join(tmp, `${name}.mp4`), cwd: tmp, burn: null, timeoutMs: 120_000, signal: AbortSignal.timeout(150_000) }),
      /tried to use the network/,
      name,
    );
    assert.equal(existsSync(path.join(tmp, `${name}.mp4`)) && readFileSync(path.join(tmp, `${name}.mp4`)).length > 0, false, `${name}: no video was written`);
  }
});
