/**
 * Renders the golden fixture through the real remotion-2d path: the installed Remotion project, its browser, then
 * the narration mux and qc-video, exactly as a Muse worker would.
 *
 * Skipped unless VENSTUDIO_REMOTION_DIR points at an installed project whose probe passes, and ffmpeg is present.
 * CI sets that up (see .github/workflows/ci.yml); locally:
 *   (cd apps/render-remotion && npm install && npx remotion browser ensure && node scripts/probe.mjs --full)
 *   VENSTUDIO_REMOTION_DIR=$PWD/apps/render-remotion node --test apps/worker/remotion-render.test.ts
 * Set VENSTUDIO_REMOTION_OUT=<dir> to keep the video and a few frames to look at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { handlers, makeWavPcm16, parseLoudness, remotionUnavailableReason, type JobContext } from "./venstudio-worker.ts";
import { fixtureUuid, fixtureWithUuids } from "./testdata/fixture.ts";

const DIR = process.env.VENSTUDIO_REMOTION_DIR;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const why = !DIR ? "VENSTUDIO_REMOTION_DIR is not set" : !hasFfmpeg ? "ffmpeg is not installed" : await remotionUnavailableReason(path.resolve(DIR));
// CI sets this, so a broken install fails the build instead of skipping the one test that renders.
if (why && process.env.VENSTUDIO_REMOTION_REQUIRED === "1") throw new Error(`remotion-render: ${why}`);

function sine(seconds: number, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), true);
  return makeWavPcm16(rate, 1, pcm);
}

/** A 10 s music bed, as the fixture describes: a chord with a slow swell, so a loop is audible as a loop. */
function bedWav(seconds: number, rate = 48000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / seconds);
    const v = (Math.sin(2 * Math.PI * 261.63 * t) + Math.sin(2 * Math.PI * 329.63 * t) + Math.sin(2 * Math.PI * 392 * t)) * 0.12 * swell;
    dv.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return makeWavPcm16(rate, 1, pcm);
}

/** A real TrueType font from the system (CI's Playwright deps install DejaVu and Liberation). */
function systemFont(): string | null {
  const known = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  const hit = known.find((f) => existsSync(f));
  if (hit) return hit;
  const listed = spawnSync("fc-list", [":", "file"], { encoding: "utf8" });
  const ttf = (listed.stdout ?? "").split("\n").map((l) => l.replace(/:\s*$/, "").trim()).find((f) => f.endsWith(".ttf") && existsSync(f));
  return ttf ?? null;
}

function ctxFor(workDir: string, home: string, type: string, payload: Record<string, unknown>, files: Map<string, string>, kept: Map<string, string>): JobContext {
  return {
    job: { id: `cccccccc-4444-4444-8444-${type === "qc-video" ? "000000000002" : "000000000001"}`, type: type as JobContext["job"]["type"], payload, capability: "remotion-2d", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home,
    signal: new AbortController().signal,
    progress: (f, m) => {
      if (m && process.env.VENSTUDIO_REMOTION_VERBOSE) console.log(`${Math.round(f * 100)}% ${m}`);
    },
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

test("remotion-2d renders the golden fixture to a 1080x1920, 24 s H.264/AAC mp4 that qc-video reads", { skip: why ?? false, timeout: 20 * 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-remotion-render-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const payload = fixtureWithUuids() as Record<string, unknown> & { shots: Array<{ assetId: string }>; narrationAssetId: string };
  const files = new Map<string, string>();
  const colors = ["0x8ecae6", "0xffb703", "0x219ebc", "0xfb8500", "0x023047"];
  for (const [i, s] of payload.shots.entries()) {
    const f = path.join(home, `shot-${i}.png`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colors[i]}:s=540x960,drawgrid=w=60:h=60:t=3:c=white@0.5`, "-frames:v", "1", f]);
    files.set(s.assetId, f);
  }
  const narration = path.join(home, "narration.wav");
  await writeFile(narration, sine(24));
  files.set(payload.narrationAssetId, narration);
  // The fixture's inputs include its caption font and a 10 s bed that has to loop under 24 s of video.
  const font = systemFont();
  assert.ok(font, "no TrueType font on this machine for the fixture's asset-font");
  files.set(fixtureUuid("asset-font"), font);
  const bed = path.join(home, "bed.wav");
  await writeFile(bed, bedWav(10));
  files.set(fixtureUuid("asset-bed"), bed);

  const kept = new Map<string, string>();
  const work = path.join(home, "work", "render");
  await mkdir(work, { recursive: true });
  const started = Date.now();
  const result = await handlers["render-video"](ctxFor(work, home, "render-video", payload, files, kept));
  const seconds = (Date.now() - started) / 1000;
  console.log(`remotion render of 24 s took ${seconds.toFixed(1)} s: ${JSON.stringify(result)}`);
  assert.equal(result.engine, "remotion-2d");
  assert.equal(result.composition, "flat-vector-explainer");
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.fps, 30);
  assert.ok(Math.abs((result.durationSec as number) - 24) < 0.2, `duration ${String(result.durationSec)}`);
  const video = kept.get("video.mp4") as string;
  assert.ok(video, "video.mp4 was uploaded");
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", video], { encoding: "utf8" })) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
  };
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  assert.equal(v?.codec_name, "h264");
  assert.equal(`${v?.width}x${v?.height}`, "1080x1920");
  assert.equal(a?.codec_name, "aac", "the narration was muxed in");
  // 0.7.0: the soundtrack is the fixture's mix (bed looped under the narration, ambience, master at -14 LUFS), and the
  // captions were drawn with its captionStyle in the job's font.
  assert.deepEqual(result.audioMix, { bed: { assetId: fixtureUuid("asset-bed"), cover: "loop" }, ambient: true, sfx: 0, targetLufs: -14 });
  assert.equal(result.captionStyle, true);
  assert.equal(result.captionNote, null);
  const loud = parseLoudness(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr);
  assert.ok(loud !== null && Math.abs(loud - -14) <= 2, `integrated loudness ${String(loud)} LUFS, target -14`);

  // The portal's QC step runs on what the worker uploaded; it must read a Remotion render like a stills one.
  const qcFiles = new Map([["dddddddd-5555-4555-8555-000000000001", video]]);
  const qcWork = path.join(home, "work", "qc");
  await mkdir(qcWork, { recursive: true });
  const qc = await handlers["qc-video"](ctxFor(qcWork, home, "qc-video", { inputs: ["dddddddd-5555-4555-8555-000000000001"] }, qcFiles, kept));
  assert.equal(qc.width, 1080);
  assert.equal(qc.height, 1920);
  assert.equal(qc.hasAudio, true);
  assert.ok((qc.freezeRuns as unknown[]).length === 0 || process.env.VENSTUDIO_REMOTION_ALLOW_FREEZE, `frozen picture: ${JSON.stringify(qc.freezeRuns)}`);

  const out = process.env.VENSTUDIO_REMOTION_OUT;
  if (out) {
    await mkdir(out, { recursive: true });
    await copyFile(video, path.join(out, "explainer-fixture.mp4"));
    for (const at of [1, 4.4, 7, 9.2, 12, 14.7, 17, 21]) {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", "scale=540:-2", path.join(out, `frame-${String(at).replace(".", "_")}s.png`)]);
    }
  }
});
