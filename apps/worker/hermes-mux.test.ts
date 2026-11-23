/**
 * Worker 0.13.0: render-video engine hermes-mux lays a run's narration (and its mix) on Hermes's picture.
 *
 * The pure half runs anywhere: the length plan (the mirror of the portal's), the payload check and the ffmpeg
 * arguments. The ffmpeg half (skipped without ffmpeg) muxes a SILENT test clip with a WAV narration through the real
 * handler and measures the result with ebur128: the audio is near the target, the clip's own silence is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_MIX_FILTERS,
  HERMES_MUX_ENGINE,
  MUX_MAX_PAD_SEC,
  MUX_TAIL_SEC,
  NonRetryableError,
  buildHermesMuxArgs,
  buildMuxArgs,
  detectCapabilities,
  ffmpegHasFilter,
  handlers,
  hermesMuxInputsOf,
  hermesMuxPlan,
  makeWavPcm16,
  parseAudioPlan,
  parseHermesMuxSpec,
  parseLoudness,
  renderEngineOf,
  sniffVideoBytes,
  type JobContext,
} from "./venstudio-worker.ts";
import { hermesMuxPlan as portalMuxPlan } from "../portal/lib/studio/hermes-mux.ts";

const PIC = "dddddddd-1111-4111-8111-0000000000c1";
const NARR = "dddddddd-1111-4111-8111-0000000000ff";
const BED = "dddddddd-1111-4111-8111-0000000000be";

const payload = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: "dddddddd-2222-4222-8222-000000000001",
  engine: HERMES_MUX_ENGINE,
  format: "short",
  width: 320,
  height: 568,
  fps: 30,
  picture: { assetId: PIC },
  narrationAssetId: NARR,
  narrationSec: 5,
  targetLufs: -14,
  inputs: [PIC, NARR],
  ...extra,
});

test("the mux plan: a short picture holds its last frame, a little longer one pads the narration, a much longer one is cut", () => {
  assert.deepEqual(hermesMuxPlan({ clipSec: 12, narrationSec: 15.5, fps: 30 }), { mode: "freeze", durationSec: 15.5, clipSec: 12, narrationSec: 15.5, freezeSec: 3.5, padSec: 0, trimSec: 0 });
  assert.deepEqual(hermesMuxPlan({ clipSec: 17, narrationSec: 15.5, fps: 30 }), { mode: "pad", durationSec: 17, clipSec: 17, narrationSec: 15.5, freezeSec: 0, padSec: 1.5, trimSec: 0 });
  assert.deepEqual(hermesMuxPlan({ clipSec: 30, narrationSec: 15.5, fps: 30 }), { mode: "trim", durationSec: 16, clipSec: 30, narrationSec: 15.5, freezeSec: 0, padSec: 0, trimSec: 14 });
  // Within a frame either way is a match at the picture's length.
  assert.equal(hermesMuxPlan({ clipSec: 15.48, narrationSec: 15.5, fps: 30 }).mode, "match");
  assert.equal(hermesMuxPlan({ clipSec: 15.53, narrationSec: 15.5, fps: 30 }).mode, "match");
  assert.equal(hermesMuxPlan({ clipSec: 15.5 + MUX_MAX_PAD_SEC, narrationSec: 15.5, fps: 30 }).mode, "pad");
  assert.equal(hermesMuxPlan({ clipSec: 15.5 + MUX_MAX_PAD_SEC + 0.01, narrationSec: 15.5, fps: 30 }).durationSec, 15.5 + MUX_TAIL_SEC);
});

test("the worker's mux plan is the portal's, on every boundary", () => {
  for (const narrationSec of [4, 15.5, 59.97]) {
    for (const d of [-10, -1, -0.04, -0.02, 0, 0.02, 0.05, 1, 2.99, 3, 3.01, 20]) {
      for (const fps of [24, 30, 60]) {
        const i = { clipSec: Math.max(0.5, narrationSec + d), narrationSec, fps };
        assert.deepEqual(hermesMuxPlan(i), portalMuxPlan(i), JSON.stringify(i));
      }
    }
  }
});

test("a hermes-mux payload is checked strictly before any download", () => {
  const spec = parseHermesMuxSpec(payload({ narrationTempo: 1.05 }));
  assert.equal(spec.pictureAssetId, PIC);
  assert.equal(spec.narrationTempo, 1.05);
  assert.deepEqual(hermesMuxInputsOf(spec, null), [PIC, NARR]);
  assert.throws(() => parseHermesMuxSpec(payload({ inputs: [NARR] })), (e: unknown) => e instanceof NonRetryableError && /picture asset is not listed/.test(e.message));
  assert.throws(() => parseHermesMuxSpec(payload({ picture: null })), /no picture/);
  assert.throws(() => parseHermesMuxSpec(payload({ narrationAssetId: PIC })), /same asset/);
  assert.throws(() => parseHermesMuxSpec(payload({ narrationSec: 0 })), /narrationSec/);
  assert.throws(() => parseHermesMuxSpec(payload({ narrationTempo: 2 })), /narrationTempo/);
  assert.throws(() => parseHermesMuxSpec(payload({ engine: "ffmpeg-stills" })), /engine must be "hermes-mux"/);
  // The ordinary engine dispatch never takes it for stills either.
  assert.throws(() => renderEngineOf({ engine: HERMES_MUX_ENGINE }), /not one this worker/);
});

const bedPlan = {
  master: { targetLufs: -14, maxTruePeakDb: -1 },
  bed: { assetId: BED, sourceLufs: -20, gainDb: 3.5, duck: { threshold: 0.02, ratio: 4, attackMs: 15, releaseMs: 350, makeup: 1 }, cover: "loop" },
  ambient: { color: "brown", bandHz: [90, 3200], gainDb: -26 },
  sfx: [],
};

test("the mux arguments: the shared chain, Hermes's audio never mapped; copy unless the last frame is held or the codec is not H.264", () => {
  const spec = parseHermesMuxSpec(payload());
  const files = { picture: "in/pic.mp4", narration: "in/narr.wav", output: "video.part.mp4" };
  const at = (args: string[], k: string) => args[args.indexOf(k) + 1];
  // pad: the picture plays whole (copied), the narration is padded to its length.
  const pad = buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 6, narrationSec: 5, fps: 30 }), null, files, { pictureCodec: "h264" });
  assert.equal(at(pad, "-t"), "6");
  assert.equal(at(pad, "-c:v"), "copy");
  assert.deepEqual(pad.filter((a, i) => pad[i - 1] === "-map"), ["0:v:0", "[a]"]);
  assert.match(at(pad, "-filter_complex"), /^\[1:a\]loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=6\[a\]$/);
  // The same as the shared mux with no options, byte for byte: this is buildMuxArgs.
  assert.deepEqual(pad, buildMuxArgs({ targetLufs: -14, durationSec: 6 }, files.picture, files.narration, files.output, { sfx: [], picture: { freezeSec: 0, reencode: false } }));
  // freeze: tpad clones the last frame for the difference, and the picture is encoded again.
  const freeze = buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 3.5, narrationSec: 5, fps: 30 }), null, files, { pictureCodec: "h264" });
  assert.equal(at(freeze, "-t"), "5");
  assert.match(at(freeze, "-filter_complex"), /;\[0:v:0\]tpad=stop_mode=clone:stop_duration=1\.5,format=yuv420p\[v\]$/);
  assert.deepEqual(freeze.filter((a, i) => freeze[i - 1] === "-map"), ["[v]", "[a]"]);
  assert.equal(at(freeze, "-c:v"), "libx264");
  // trim: cut half a second after the narration, still copied.
  const trim = buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 20, narrationSec: 5, fps: 30 }), null, files, { pictureCodec: "h264" });
  assert.equal(at(trim, "-t"), "5.5");
  assert.equal(at(trim, "-c:v"), "copy");
  // A WebM (VP9) picture is encoded to H.264, without a tpad.
  const vp9 = buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 5, narrationSec: 5, fps: 30 }), null, files, { pictureCodec: "vp9" });
  assert.match(at(vp9, "-filter_complex"), /;\[0:v:0\]null,format=yuv420p\[v\]$/);
  assert.equal(at(vp9, "-c:v"), "libx264");
  // With the run's mix: the bed is input 2, ducked under the voice, mastered to the plan's target.
  const audio = parseAudioPlan(bedPlan, { durationSec: 6, targetLufs: -14, inputs: [PIC, NARR, BED] });
  const mixed = buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 6, narrationSec: 5, fps: 30 }), audio, { ...files, bed: "in/bed.wav" }, { pictureCodec: "h264" });
  assert.deepEqual(mixed.filter((a, i) => mixed[i - 1] === "-i"), ["in/pic.mp4", "in/narr.wav", "in/bed.wav"]);
  assert.match(at(mixed, "-filter_complex"), /sidechaincompress/);
  assert.match(at(mixed, "-filter_complex"), /anoisesrc=color=brown/);
  assert.match(at(mixed, "-filter_complex"), /loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo,atrim=duration=6\[a\]$/);
  assert.throws(() => buildHermesMuxArgs(spec, hermesMuxPlan({ clipSec: 6, narrationSec: 5, fps: 30 }), audio, files, { pictureCodec: "h264" }), /no bed file/);
});

test("Hermes's picture is recognised by its bytes", () => {
  const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftyp"), ...Buffer.from(brand), 0, 0, 0, 0]);
  assert.deepEqual(sniffVideoBytes(ftyp("isom")), { ext: "mp4" });
  assert.deepEqual(sniffVideoBytes(ftyp("qt  ")), { ext: "mov" });
  assert.deepEqual(sniffVideoBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), { ext: "webm" });
  assert.equal(sniffVideoBytes(Buffer.from("RIFF....WAVEfmt ")), null);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const canMux = hasFfmpeg && AUDIO_MIX_FILTERS.every((f) => ffmpegHasFilter(f)) && ffmpegHasFilter("tpad");

test("hermes-mux is reported only with ffmpeg, the whole mix chain and tpad", async (t) => {
  const prev = process.env.FFMPEG_PATH;
  t.after(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  });
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
  assert.ok(!(await detectCapabilities()).includes("hermes-mux"));
  if (prev === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = prev;
  if (hasFfmpeg) assert.equal((await detectCapabilities()).includes("hermes-mux"), canMux);
});

function wavOf(seconds: number, hz: number, amp: number, rate = 48000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767), true);
  return makeWavPcm16(rate, 1, pcm);
}

function ctxFor(workDir: string, p: Record<string, unknown>, files: Map<string, string>, kept: Map<string, string>): JobContext {
  return {
    job: { id: "dddddddd-3333-4333-8333-000000000001", type: "render-video", payload: p, capability: "hermes-mux", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home: workDir,
    signal: new AbortController().signal,
    progress: () => {},
    download: async (assetId, dest) => {
      const src = files.get(assetId);
      if (!src) throw new Error(`no such input ${assetId}`);
      await copyFile(src, dest);
      return { bytes: (await readFile(dest)).length, sha256: "" };
    },
    upload: async (name, file) => {
      const keep = path.join(path.dirname(workDir), `${path.basename(workDir)}-${name}`);
      await copyFile(file, keep);
      kept.set(name, keep);
      return { bytes: (await readFile(keep)).length, sha256: "" };
    },
  };
}

const probeOf = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" })) as { format: { duration: string }; streams: Array<{ codec_type: string }> };
const lufsOf = (file: string) => parseLoudness(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr);

test("a real mux: a SILENT Hermes clip and a WAV narration become one video whose audio is near the target", { skip: !canMux && "needs ffmpeg with the audio-mix filters and tpad", timeout: 180_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-hmux-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Hermes's clip: 3.5 s of picture with a silent audio track (what a render "without a voice" came back as).
  const clip = path.join(home, "clip.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=30:d=3.5", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
  const silentBefore = lufsOf(clip);
  assert.ok(silentBefore === null || silentBefore < -50, `the test clip is silent: ${String(silentBefore)} LUFS`);
  const narration = path.join(home, "narration.wav");
  await writeFile(narration, wavOf(5, 300, 0.4));
  const files = new Map([[PIC, clip], [NARR, narration]]);
  const kept = new Map<string, string>();
  // Narration alone at -16 LUFS: the clip is shorter, so its last frame is held for 1.5 s.
  const work = path.join(home, "freeze");
  await mkdir(work, { recursive: true });
  const r = await handlers["render-video"](ctxFor(work, payload({ targetLufs: -16 }), files, kept));
  const mux = r.mux as { mode: string; freezeSec: number; durationSec: number };
  assert.equal(mux.mode, "freeze");
  assert.equal(mux.freezeSec, 1.5);
  const out = kept.get("video.mp4") as string;
  const p = probeOf(out);
  assert.ok(Math.abs(Number(p.format.duration) - 5) < 0.15, `duration ${p.format.duration}`);
  assert.equal(p.streams.filter((s) => s.codec_type === "audio").length, 1, "one audio stream: the narration, not Hermes's");
  const loud = lufsOf(out);
  console.log(`hermes-mux freeze: ${loud} LUFS (target -16), reported ${String(r.integratedLufs)}`);
  assert.ok(loud !== null && Math.abs(loud - -16) <= 2, `integrated loudness ${String(loud)} LUFS, target -16`);
  assert.ok(typeof r.integratedLufs === "number" && Math.abs((r.integratedLufs as number) - -16) <= 2, `the job result reports the loudness: ${String(r.integratedLufs)}`);
  // With the run's mix (ambience, master -14) and a 6.5 s clip: the picture plays whole, the narration is padded.
  const longClip = path.join(home, "long.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=30:d=6.5", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", longClip]);
  files.set(PIC, longClip);
  const work2 = path.join(home, "pad");
  await mkdir(work2, { recursive: true });
  const r2 = await handlers["render-video"](ctxFor(work2, payload({ audio: { ...bedPlan, bed: null } }), files, kept));
  assert.equal((r2.mux as { mode: string }).mode, "pad");
  assert.deepEqual(r2.audioMix, { bed: null, ambient: true, sfx: 0, targetLufs: -14 });
  const out2 = kept.get("video.mp4") as string;
  assert.ok(Math.abs(Number(probeOf(out2).format.duration) - 6.5) < 0.15);
  const loud2 = lufsOf(out2);
  assert.ok(loud2 !== null && Math.abs(loud2 - -14) <= 2, `integrated loudness ${String(loud2)} LUFS, target -14`);
});
