/**
 * Render engine dispatch: the worker reads `engine` from the render-video payload and picks a render path, and the
 * stills path stays byte-identical to what it was before engines existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NonRetryableError,
  RENDER_ENGINES,
  VERSION,
  XFADE_PAD_FRAMES,
  buildRenderArgs,
  detectCapabilities,
  engineUnavailable,
  ffmpegHasFilter,
  handlers,
  makeWavPcm16,
  parseRenderSpec,
  parseScenePlan,
  planCrossFades,
  renderEngineOf,
  transitionFor,
  xfadeTimeline,
  xfadeTimelineFor,
  type JobContext,
} from "./venstudio-worker.ts";
import { planCrossFades as portalPlanCrossFades, transitionFor as portalTransitionFor } from "../portal/lib/studio/render-engine.ts";
import { fixture, fixtureWithUuids } from "./testdata/fixture.ts";

const golden = JSON.parse(readFileSync(new URL("./testdata/stills-args.golden.json", import.meta.url), "utf8")) as {
  payload: Record<string, unknown>;
  withFont: unknown;
  noDrawtext: unknown;
};

const PATHS = { images: ["in/a.png", "in/b.png", "in/c.jpg"], narration: "in/n.wav", output: "video.part.mp4", font: "in/f.ttf" };

test("ffmpeg-stills args are byte-identical to the worker before engines (0.4.0), with and without the new fields", () => {
  // testdata/stills-args.golden.json was captured from buildRenderArgs before any of this change.
  const variants: Array<[string, Record<string, unknown>]> = [
    ["an old portal's payload (no engine, no transitionSec)", golden.payload],
    ["engine ffmpeg-stills, transitionSec 0", { ...golden.payload, engine: "ffmpeg-stills", transitionSec: 0 }],
    ["engine ffmpeg-stills with a stray scenePlan", { ...golden.payload, engine: "ffmpeg-stills", transitionSec: 0, scenePlan: { version: 1 } }],
  ];
  for (const [label, payload] of variants) {
    const spec = parseRenderSpec(payload);
    assert.equal(spec.engine, "ffmpeg-stills", label);
    assert.equal(spec.transitionSec, 0, label);
    assert.equal(spec.scenePlan, null, label);
    assert.deepEqual(buildRenderArgs(spec, PATHS, { drawtext: true }), golden.withFont, label);
    assert.deepEqual(buildRenderArgs(spec, PATHS, { drawtext: false }), golden.noDrawtext, label);
  }
});

test("renderEngineOf: a missing engine means stills, a known one is kept, anything else is refused by name", () => {
  assert.equal(renderEngineOf({}), "ffmpeg-stills");
  assert.equal(renderEngineOf({ engine: null }), "ffmpeg-stills");
  assert.equal(renderEngineOf({ engine: "ffmpeg-stills" }), "ffmpeg-stills");
  assert.equal(renderEngineOf({ engine: "remotion-2d" }), "remotion-2d");
  for (const e of ["manim", "blender-cycles", "provider-video", "sprite-rig", "remotion-3d", "godot-2d"]) {
    assert.throws(() => renderEngineOf({ engine: e }), (err: Error) => err instanceof NonRetryableError && err.message.includes(`"${e}"`) && /not rendered as stills/.test(err.message), e);
  }
  assert.throws(() => renderEngineOf({ engine: 42 }), NonRetryableError);
  assert.throws(() => renderEngineOf({ engine: "  " }), NonRetryableError);
  assert.deepEqual(Object.keys(RENDER_ENGINES).sort(), ["ffmpeg-stills", "remotion-2d"]);
});

test("engineUnavailable names the engine, the capability and the way forward", () => {
  assert.equal(engineUnavailable("ffmpeg-stills", ["echo", "ffmpeg"]), null);
  assert.equal(engineUnavailable("remotion-2d", ["ffmpeg", "remotion-2d"]), null);
  const m = engineUnavailable("remotion-2d", ["echo", "ffmpeg"], "the Remotion project is not installed") as string;
  assert.match(m, /Engine "remotion-2d" needs capability "remotion-2d"/);
  assert.match(m, new RegExp(`worker \\(${VERSION.replaceAll(".", "\\.")}\\)`));
  assert.match(m, /not installed/);
  assert.match(m, /Retry/);
});

/** A JobContext whose download fails the test, to prove dispatch fails before any input is fetched. */
function noDownloadCtx(workDir: string, payload: Record<string, unknown>): { ctx: JobContext; downloads: string[] } {
  const downloads: string[] = [];
  const ctx: JobContext = {
    job: { id: "bbbbbbbb-1111-4111-8111-0000000000e1", type: "render-video", payload, capability: "ffmpeg", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home: workDir,
    signal: new AbortController().signal,
    progress: () => {},
    upload: async () => {
      throw new Error("no uploads in this test");
    },
    download: async (assetId) => {
      downloads.push(assetId);
      throw new Error("no downloads in this test");
    },
  };
  return { ctx, downloads };
}

test("render-video refuses an engine it has no path for before downloading anything, and never renders stills", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-engine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const engine of ["manim", "provider-video", "blender-cycles"]) {
    const { ctx, downloads } = noDownloadCtx(dir, { ...golden.payload, engine });
    await assert.rejects(handlers["render-video"](ctx), (err: Error) => err instanceof NonRetryableError && err.message.includes(`"${engine}"`));
    assert.deepEqual(downloads, [], engine);
  }
});

test("render-video with remotion-2d fails naming the engine when this machine has no Remotion renderer", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-engine-"));
  const prev = process.env.VENSTUDIO_REMOTION_DIR;
  process.env.VENSTUDIO_REMOTION_DIR = path.join(dir, "no-remotion-here");
  t.after(async () => {
    if (prev === undefined) delete process.env.VENSTUDIO_REMOTION_DIR;
    else process.env.VENSTUDIO_REMOTION_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const { ctx, downloads } = noDownloadCtx(dir, fixtureWithUuids());
  await assert.rejects(handlers["render-video"](ctx), (err: Error) => {
    assert.ok(err instanceof NonRetryableError, "not retried: retrying cannot install Remotion");
    assert.match(err.message, /Engine "remotion-2d" needs capability "remotion-2d"/);
    return true;
  });
  assert.deepEqual(downloads, []);
});

test("parseScenePlan reads the golden fixture: scenes line up with shot-01..shot-05, bar has series, counter has value", () => {
  const p = fixture as { scenePlan: unknown; shots: Array<{ shotRef: string }> };
  const plan = parseScenePlan(p.scenePlan, { engine: "remotion-2d", width: 1080, height: 1920, fps: 30, shotRefs: p.shots.map((s) => s.shotRef) });
  assert.deepEqual(plan.scenes.map((s) => s.shotRef), ["shot-01", "shot-02", "shot-03", "shot-04", "shot-05"]);
  assert.equal(plan.template, "explainer-flat-vector");
  assert.equal(plan.transitionSec, 0.5);
  const all = plan.scenes.flatMap((s) => s.elements);
  assert.deepEqual(all.find((e) => e.kind === "bar")?.series, [0.2, 0.45, 0.7, 0.95]);
  assert.equal(all.find((e) => e.kind === "counter")?.value, 1400);
  // A heading has neither; the parser must not invent them.
  const heading = all.find((e) => e.kind === "heading");
  assert.ok(heading && !("value" in heading) && !("series" in heading));
});

test("parseScenePlan refuses a plan that does not line up with the shots or would render a still", () => {
  const p = fixture as { scenePlan: Record<string, unknown> & { scenes: Array<Record<string, unknown>> }; shots: Array<{ shotRef: string }> };
  const ctx = { engine: "remotion-2d", width: 1080, height: 1920, fps: 30, shotRefs: p.shots.map((s) => s.shotRef) };
  assert.throws(() => parseScenePlan(undefined, ctx), /has none/);
  assert.throws(() => parseScenePlan({ ...p.scenePlan, version: 2 }, ctx), /version 2/);
  assert.throws(() => parseScenePlan(p.scenePlan, { ...ctx, engine: "ffmpeg-stills" }), /for engine "remotion-2d"/);
  assert.throws(() => parseScenePlan(p.scenePlan, { ...ctx, width: 1920, height: 1080 }), /1080x1920/);
  assert.throws(() => parseScenePlan(p.scenePlan, { ...ctx, shotRefs: ctx.shotRefs.slice(0, 4) }), /5 scenes for 4 shots/);
  const swapped = { ...p.scenePlan, scenes: [p.scenePlan.scenes[1], p.scenePlan.scenes[0], ...p.scenePlan.scenes.slice(2)] };
  assert.throws(() => parseScenePlan(swapped, ctx), /line up/);
  const still = { ...p.scenePlan, scenes: p.scenePlan.scenes.map((s, i) => (i === 1 ? { ...s, tokens: ["not-a-token"], camera: false } : s)) };
  assert.throws(() => parseScenePlan(still, ctx), /scene 2 \(shot-02\) has neither a motion token nor a camera move/);
  // Garbage values are dropped, not passed to the template.
  const messy = {
    ...p.scenePlan,
    scenes: p.scenePlan.scenes.map((s, i) => (i === 0 ? { ...s, elements: [{ kind: "counter", value: "1400" }, { kind: "bar", series: ["x", 3, null] }, { kind: "<script>" }] } : s)),
  };
  const parsed = parseScenePlan(messy, ctx);
  assert.deepEqual(parsed.scenes[0].elements, [{ kind: "counter" }, { kind: "bar", series: [3] }]);
});

// ---------------------------------------------------------------------------
// Cross-fades

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("the worker's cross-fade arithmetic is the portal's, on the golden fixture and on awkward lengths", () => {
  const seconds = (fixture.shots as Array<{ seconds: number }>).map((s) => s.seconds);
  const plan = planCrossFades(seconds, 0.5);
  assert.deepEqual(plan, portalPlanCrossFades(seconds, 0.5));
  assert.ok(plan.ok);
  assert.deepEqual(plan.offsets, [4.167, 9, 14.5, 19.333]);
  assert.equal(plan.totalSec, 24);
  assert.equal(plan.totalSec, fixture.durationSec);
  const cases: Array<[number[], number]> = [
    [[3], 0.5],
    [[2, 2, 2], 0.5],
    [[1.1, 0.9, 4.333], 0.25],
    [[0.7, 0.7], 0.15],
    [[0.7, 0.7], 0.1],
    [[0.5, 3], 0.5],
    [[2, 0, 2], 0.5],
    [[2, 2], -1],
    [[], 0.5],
  ];
  for (const [s, d] of cases) assert.deepEqual(planCrossFades(s, d), portalPlanCrossFades(s, d), `${s.join("+")} @ ${d}`);
  for (let i = -1; i < 20; i++) assert.equal(transitionFor(i), portalTransitionFor(i), `transition ${i}`);
});

test("xfadeTimeline snaps the fixture's boundaries to frames without drift", () => {
  const seconds = (fixture.shots as Array<{ seconds: number }>).map((s) => s.seconds);
  const plan = planCrossFades(seconds, 0.5);
  assert.ok(plan.ok);
  const t = xfadeTimeline(plan.starts, plan.totalSec, 0.5, 30);
  assert.equal(t.fadeFrames, 15);
  assert.deepEqual(t.startFrames, [0, 125, 270, 435, 580]);
  assert.deepEqual(t.frames, [140, 160, 180, 160, 140]);
  assert.equal(t.totalFrames, 720);
  // Every shot ends exactly where the next one's fade ends; the last ends the video.
  t.frames.forEach((f, i) => assert.equal(t.startFrames[i] + f, i < 4 ? t.startFrames[i + 1] + t.fadeFrames : t.totalFrames));
  // 60 equal shots whose length is not a whole number of frames: the end stays within half a frame of the plan.
  const many = planCrossFades(Array.from({ length: 60 }, () => 2.011), 0.5);
  assert.ok(many.ok);
  const tm = xfadeTimeline(many.starts, many.totalSec, 0.5, 30);
  assert.ok(Math.abs(tm.totalFrames / 30 - many.totalSec) <= 0.5 / 30);
});

test("parseRenderSpec accepts the golden fixture: 26 s of shots with 0.5 s fades is a 24 s video for 24 s of narration", () => {
  const spec = parseRenderSpec(fixtureWithUuids());
  assert.equal(spec.engine, "remotion-2d");
  assert.equal(spec.transitionSec, 0.5);
  assert.equal(spec.durationSec, 24);
  assert.equal(Math.round(spec.shots.reduce((n, s) => n + s.seconds, 0) * 1000) / 1000, 26);
  assert.deepEqual(spec.scenePlan?.scenes.map((s) => s.shotRef), ["shot-01", "shot-02", "shot-03", "shot-04", "shot-05"]);
});

test("with fades the check is on the timeline after the overlaps; with hard cuts it is exactly the old one", () => {
  const stills = { ...fixtureWithUuids(), engine: "ffmpeg-stills" };
  assert.equal(parseRenderSpec(stills).durationSec, 24);
  // Shots that add up to the narration are too short once they overlap.
  const p = stills as unknown as Record<string, unknown> & { shots: Array<Record<string, unknown>> };
  const short = { ...p, shots: p.shots.map((s, i) => ({ ...s, seconds: [4, 5, 6, 5, 4][i] })), durationSec: 22 };
  assert.throws(() => parseRenderSpec(short), /with 0\.5 s cross-fades the shots \(24 s together\) fill 22 s, but the narration is 24 s/);
  // durationSec has to be what the shots and fades make.
  assert.throws(() => parseRenderSpec({ ...p, durationSec: 26 }), /durationSec is 26 s, but 5 shots of 26 s with 0\.5 s cross-fades last 24 s/);
  // A fade that eats a shot is refused with the portal's reason.
  assert.throws(() => parseRenderSpec({ ...p, transitionSec: 2.5 }), /leaves shot 2 only 0\.333 s of its own/);
  // Hard cuts: the old message, word for word.
  assert.throws(() => parseRenderSpec({ ...p, transitionSec: 0 }), /render-video payload: the shots add up to 26 s but the narration is 24 s/);
  // One shot has nothing to fade into, so it is checked as hard cuts.
  const one = { ...p, shots: [{ ...p.shots[0], seconds: 24 }], transitionSec: 0.5 };
  assert.equal(parseRenderSpec(one).transitionSec, 0);
});

test("buildRenderArgs chains xfades at frame-exact offsets, with the transition fixed by position", () => {
  const spec = parseRenderSpec({ ...fixtureWithUuids(), engine: "ffmpeg-stills" });
  const images = ["a", "b", "c", "d", "e"].map((x) => `in/${x}.png`);
  const plan = buildRenderArgs(spec, { images, narration: "in/n.wav", output: "o.mp4" }, { drawtext: false });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.ok(!graph.includes("concat="), "no hard concat when fading");
  const xf = graph.split(";").filter((c) => c.includes("xfade="));
  assert.deepEqual(xf, [
    "[v0][v1]xfade=transition=fade:duration=0.5:offset=4.166667[x1]",
    "[x1][v2]xfade=transition=slideup:duration=0.5:offset=9[x2]",
    "[x2][v3]xfade=transition=fade:duration=0.5:offset=14.5[x3]",
    "[x3][v4]xfade=transition=wipeleft:duration=0.5:offset=19.333333[v]",
  ]);
  // Motion runs over the shot's visible frames; every shot but the last carries the padding xfade discards.
  for (const [i, frames] of [140, 160, 180, 160, 140].entries()) {
    const d = i < 4 ? frames + XFADE_PAD_FRAMES : frames;
    assert.ok(graph.includes(`/${frames}':`) || graph.includes(`/${frames})`), `shot ${i + 1} moves over ${frames} frames`);
    assert.ok(graph.includes(`:d=${d}:s=1080x1920:fps=30,format=yuv420p[v${i}]`), `shot ${i + 1} is ${d} frames long`);
  }
  assert.equal(plan.args[plan.args.indexOf("-t") + 1], "24");
  assert.ok(graph.includes("apad=whole_dur=24[a]"));
  // Captions go on after the last fade.
  const withFont = buildRenderArgs(spec, { images, narration: "in/n.wav", output: "o.mp4", font: "in/f.ttf" }, { drawtext: true });
  const g2 = withFont.args[withFont.args.indexOf("-filter_complex") + 1];
  assert.ok(g2.includes("offset=19.333333[vc];[vc]drawtext="));
  assert.equal(withFont.captionsBurned, true);
});

test("xfadeTimelineFor refuses fades that do not fit, instead of building a broken graph", () => {
  const base = parseRenderSpec({ ...fixtureWithUuids(), engine: "ffmpeg-stills" });
  assert.throws(() => xfadeTimelineFor({ ...base, transitionSec: 3 }), NonRetryableError);
  assert.throws(() => xfadeTimelineFor({ ...base, fps: 1, transitionSec: 0.2 }), /shorter than one frame/);
});

async function makeStill(file: string, color: string, size = "320x568") {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${size}`, "-frames:v", "1", file]);
}

function sine(seconds: number, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 0.3 * 32767), true);
  return makeWavPcm16(rate, 1, pcm);
}

function probeFrames(file: string): { frames: number; videoSec: number; formatSec: number } {
  const out = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,duration:format=duration", "-of", "json", file], { encoding: "utf8" }),
  ) as { streams: Array<{ nb_read_frames: string; duration: string }>; format: { duration: string } };
  return { frames: Number(out.streams[0].nb_read_frames), videoSec: Number(out.streams[0].duration), formatSec: Number(out.format.duration) };
}

test("3 shots of 2 s with 0.5 s fades render 5 s of video: the sum less 2 x 0.5", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-xfade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "in"));
  const ids = ["aaaaaaaa-2222-4222-8222-000000000001", "aaaaaaaa-2222-4222-8222-000000000002", "aaaaaaaa-2222-4222-8222-000000000003"];
  const NARRATION = "aaaaaaaa-2222-4222-8222-0000000000ff";
  for (const [i, c] of ["red", "green", "blue"].entries()) await makeStill(path.join(dir, "in", `${i}.png`), c);
  await writeFile(path.join(dir, "in", "n.wav"), sine(5));
  const spec = parseRenderSpec({
    format: "short", width: 320, height: 568, fps: 30, engine: "ffmpeg-stills", transitionSec: 0.5,
    shots: ids.map((assetId, i) => ({ shotRef: `shot-0${i + 1}`, assetId, seconds: 2, motion: "zoom-in" })),
    narrationAssetId: NARRATION, narrationSec: 5, durationSec: 5, captions: [], targetLufs: -16, fontAssetId: null,
    inputs: [...ids, NARRATION],
  });
  assert.equal(spec.durationSec, 5);
  const plan = buildRenderArgs(spec, { images: ["in/0.png", "in/1.png", "in/2.png"], narration: "in/n.wav", output: "out.mp4" }, { drawtext: false });
  execFileSync("ffmpeg", plan.args.filter((a, i, all) => !(a === "-progress" || all[i - 1] === "-progress")), { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  const p = probeFrames(path.join(dir, "out.mp4"));
  assert.equal(p.frames, 150, "6 s of shots less two 0.5 s overlaps is 5 s, 150 frames at 30 fps");
  assert.ok(Math.abs(p.videoSec - 5) < 0.05, `video stream ${p.videoSec} s`);
  assert.ok(Math.abs(p.formatSec - 5) < 0.1, `file ${p.formatSec} s`);
  // The same shots with hard cuts are 6 s, so the difference is the fades and nothing else.
  const cutSpec = { ...spec, transitionSec: 0, durationSec: 6 };
  const cut = buildRenderArgs(cutSpec, { images: ["in/0.png", "in/1.png", "in/2.png"], narration: "in/n.wav", output: "cut.mp4" }, { drawtext: false });
  execFileSync("ffmpeg", cut.args.filter((a, i, all) => !(a === "-progress" || all[i - 1] === "-progress")), { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  assert.equal(probeFrames(path.join(dir, "cut.mp4")).frames - p.frames, 30, "exactly 2 x 0.5 s shorter");
});

test("render-video renders a faded stills job end to end and reports the fade", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-xfade-job-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = ["aaaaaaaa-3333-4333-8333-000000000001", "aaaaaaaa-3333-4333-8333-000000000002", "aaaaaaaa-3333-4333-8333-000000000003"];
  const NARRATION = "aaaaaaaa-3333-4333-8333-0000000000ff";
  const files = new Map<string, string>();
  for (const [i, c] of ["orange", "purple", "teal"].entries()) {
    const f = path.join(dir, `src-${i}.png`);
    await makeStill(f, c);
    files.set(ids[i], f);
  }
  await writeFile(path.join(dir, "src-n.wav"), sine(5));
  files.set(NARRATION, path.join(dir, "src-n.wav"));
  const work = path.join(dir, "work");
  await mkdir(work);
  const uploads: string[] = [];
  const ctx: JobContext = {
    job: {
      id: "bbbbbbbb-3333-4333-8333-000000000001", type: "render-video", capability: "xfade", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30,
      payload: {
        format: "short", width: 320, height: 568, fps: 30, engine: "ffmpeg-stills", transitionSec: 0.5,
        shots: ids.map((assetId, i) => ({ shotRef: `shot-0${i + 1}`, assetId, seconds: 2, motion: "pan-left" })),
        narrationAssetId: NARRATION, narrationSec: 5, durationSec: 5, captions: [], targetLufs: -16, fontAssetId: null, inputs: [...ids, NARRATION],
      },
    },
    workDir: work,
    signal: new AbortController().signal,
    progress: () => {},
    download: async (assetId, dest) => {
      const buf = readFileSync(files.get(assetId) as string);
      await writeFile(dest, buf);
      return { bytes: buf.length, sha256: "" };
    },
    upload: async (name, file) => {
      uploads.push(name);
      return { bytes: readFileSync(file).length, sha256: "" };
    },
  };
  const result = await handlers["render-video"](ctx);
  assert.deepEqual(uploads, ["video.mp4"]);
  assert.equal(result.engine, "ffmpeg-stills");
  assert.equal(result.transitionSec, 0.5);
  assert.ok(Math.abs((result.durationSec as number) - 5) < 0.1, `duration ${String(result.durationSec)}`);
});

test("xfade is reported only with an ffmpeg that has the filter", async (t) => {
  const prev = process.env.FFMPEG_PATH;
  t.after(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  });
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
  const none = await detectCapabilities();
  assert.ok(!none.includes("ffmpeg") && !none.includes("xfade"), none.join(","));
  if (prev === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = prev;
  if (hasFfmpeg) {
    const caps = await detectCapabilities();
    assert.equal(caps.includes("xfade"), ffmpegHasFilter("xfade"));
  }
});

test("sceneStartsOf records where shots change, fades included", async () => {
  const { sceneStartsOf } = await import("./venstudio-worker.ts");
  assert.deepEqual(sceneStartsOf(parseRenderSpec(fixtureWithUuids())), [0, 4.167, 9, 14.5, 19.333]);
  assert.deepEqual(sceneStartsOf(parseRenderSpec(golden.payload)), [0, 3.4, 7.5]);
});
