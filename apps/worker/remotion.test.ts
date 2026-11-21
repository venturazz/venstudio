/**
 * The remotion-2d path: props for the template, the CLI and mux arguments, the capability probe and the install
 * bundle. Everything here runs without Remotion; remotion-render.test.ts renders for real where it is installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NonRetryableError,
  REMOTION_COMPOSITIONS,
  buildMuxArgs,
  buildRemotionProps,
  buildRenderArgs,
  clearRemotionProbeCache,
  detectCapabilities,
  narrationFilter,
  parseRemotionProgress,
  parseRenderSpec,
  remotionCompositionFor,
  remotionConcurrency,
  remotionDir,
  remotionRenderArgs,
  remotionTimeoutMs,
  remotionUnavailableReason,
  transitionFor,
  writeProjectBundle,
  xfadeTimeline,
  planCrossFades,
} from "./venstudio-worker.ts";
import { SAMPLE_PROPS, barHeights, captionAt, formatCount, gaugeFraction, layerFrame, timelineFor, transitionFor as templateTransitionFor } from "../render-remotion/src/props.ts";
import { projectBundle, REMOTION_PROJECT_FILES } from "../portal/lib/install-bundle.ts";
import { fixtureWithUuids } from "./testdata/fixture.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../render-remotion");

test("buildRemotionProps hands the template the fixture's scenes, the shot pictures and the xfade timeline", () => {
  const spec = parseRenderSpec(fixtureWithUuids());
  const images = spec.shots.map((s) => `${s.assetId}.png`);
  const props = buildRemotionProps(spec, { images, font: null });
  assert.equal(props.template, "explainer-flat-vector");
  assert.equal(props.width, 1080);
  assert.equal(props.height, 1920);
  assert.equal(props.fps, 30);
  assert.equal(props.transitionSec, 0.5);
  assert.equal(props.durationSec, 24);
  assert.equal(props.narration, null, "the render is muted; the narration is added by ffmpeg afterwards");
  assert.deepEqual(props.shots.map((s) => s.image), images);
  assert.deepEqual(props.scenes.map((s) => s.shotRef), props.shots.map((s) => s.shotRef));
  assert.deepEqual(props.timeline, { fadeFrames: 15, startFrames: [0, 125, 270, 435, 580], frames: [140, 160, 180, 160, 140], totalFrames: 720 });
  const els = props.scenes.flatMap((s) => s.elements);
  assert.deepEqual(els.find((e) => e.kind === "bar")?.series, [0.2, 0.45, 0.7, 0.95]);
  assert.equal(els.find((e) => e.kind === "counter")?.value, 1400);
  for (const e of els.filter((x) => x.kind !== "bar" && x.kind !== "counter")) assert.ok(!("value" in e) && !("series" in e), `${e.kind} carries no invented data`);
  assert.equal(props.captions.length, 5);
  // Plain JSON: what goes to --props is exactly this.
  assert.deepEqual(JSON.parse(JSON.stringify(props)), props);
});

test("the template's timeline and transitions are the worker's", () => {
  const seconds = (fixtureWithUuids().shots as Array<{ seconds: number }>).map((s) => s.seconds);
  const plan = planCrossFades(seconds, 0.5);
  assert.ok(plan.ok);
  assert.deepEqual(timelineFor(seconds, 0.5, 30), xfadeTimeline(plan.starts, plan.totalSec, 0.5, 30));
  const cut = planCrossFades([2, 3.333, 1.7], 0);
  assert.ok(cut.ok);
  assert.deepEqual(timelineFor([2, 3.333, 1.7], 0, 25), xfadeTimeline(cut.starts, cut.totalSec, 0, 25));
  for (let i = 0; i < 14; i++) assert.equal(templateTransitionFor(i), transitionFor(i));
  // The sample props the probe renders are consistent with themselves.
  const s = timelineFor(SAMPLE_PROPS.shots.map((x) => x.seconds), SAMPLE_PROPS.transitionSec, SAMPLE_PROPS.fps);
  assert.equal(s.totalFrames, SAMPLE_PROPS.durationSec * SAMPLE_PROPS.fps);
  assert.equal(SAMPLE_PROPS.scenes.length, SAMPLE_PROPS.shots.length);
});

test("template helpers never invent data", () => {
  assert.deepEqual(barHeights(undefined), []);
  assert.deepEqual(barHeights([]), []);
  assert.deepEqual(barHeights([1, 2, 4]), [0.25, 0.5, 1]);
  assert.deepEqual(barHeights([-2, 4]), [0, 1]);
  assert.deepEqual(barHeights([0, 0]), [0, 0]);
  assert.equal(gaugeFraction(undefined), null);
  assert.equal(gaugeFraction([]), null);
  assert.equal(gaugeFraction([0.2, 0.7]), 0.7);
  assert.equal(gaugeFraction([20, 80]), 1);
  assert.equal(gaugeFraction([80, 20]), 0.25);
  assert.equal(formatCount(1400, 1400), "1,400");
  assert.equal(formatCount(700.4, 1400), "700");
  assert.equal(formatCount(1.25, 2.5), "1.3");
  assert.equal(formatCount(3.14159, 3.14159), "3.14");
  assert.equal(captionAt([{ start: 0, end: 2, text: "a" }, { start: 2, end: 4, text: "b" }], 2)?.text, "b");
  assert.equal(captionAt([{ start: 0, end: 2, text: "a" }], 5), null);
  assert.equal(layerFrame(17, 30, { id: "plate", frames: 1, fps: 1 }), 0);
  assert.equal(layerFrame(17, 30, { id: "prop-b", frames: 7, fps: 10 }), 15);
  assert.equal(layerFrame(17, 30, { id: "scene", frames: 120, fps: 30 }), 17);
  assert.equal(layerFrame(17, 30, undefined), 17);
});

test("remotionCompositionFor maps the template to its composition and refuses one it does not have", () => {
  const spec = parseRenderSpec(fixtureWithUuids());
  assert.equal(remotionCompositionFor(spec), "flat-vector-explainer");
  assert.deepEqual(Object.values(REMOTION_COMPOSITIONS), ["flat-vector-explainer"]);
  assert.ok(readFileSync(path.join(PROJECT, "src/Root.tsx"), "utf8").includes(`id="${REMOTION_COMPOSITIONS["explainer-flat-vector"]}"`));
  const other = { ...spec, scenePlan: spec.scenePlan ? { ...spec.scenePlan, template: "kinetic-facts" } : null };
  assert.throws(() => remotionCompositionFor(other), (e: Error) => e instanceof NonRetryableError && /Template "kinetic-facts" has no remotion-2d composition/.test(e.message) && /not drawn with another template/.test(e.message));
});

test("Remotion renders muted, bounded for a 2 vCPU machine, and ffmpeg adds the narration with the stills audio chain", () => {
  const args = remotionRenderArgs({ cli: "/r/node_modules/@remotion/cli/remotion-cli.js", projectDir: "/r", composition: "flat-vector-explainer", propsFile: "/w/p.json", publicDir: "/w/in", output: "/w/m.mp4", concurrency: 1 });
  assert.deepEqual(args.slice(0, 5), ["/r/node_modules/@remotion/cli/remotion-cli.js", "render", "/r/src/index.ts", "flat-vector-explainer", "/w/m.mp4"]);
  for (const a of ["--props=/w/p.json", "--public-dir=/w/in", "--concurrency=1", "--gl=swangle", "--muted", "--codec=h264"]) assert.ok(args.includes(a), a);
  assert.equal(remotionConcurrency({}, 2), 1);
  assert.equal(remotionConcurrency({}, 4), 2);
  assert.equal(remotionConcurrency({ VENSTUDIO_REMOTION_CONCURRENCY: "3" }, 2), 3);
  assert.equal(remotionConcurrency({ VENSTUDIO_REMOTION_CONCURRENCY: "99" }, 2), 1);
  assert.equal(remotionTimeoutMs(10), 10 * 60_000);
  assert.equal(remotionTimeoutMs(24), 960_000);
  assert.equal(remotionTimeoutMs(180), 7_200_000);
  const spec = parseRenderSpec(fixtureWithUuids());
  const mux = buildMuxArgs(spec, "/w/m.mp4", "in/n.wav", "video.part.mp4");
  const graph = mux[mux.indexOf("-filter_complex") + 1];
  assert.equal(graph, narrationFilter(spec, 1));
  assert.equal(graph, "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=24[a]");
  assert.ok(mux.join(" ").includes("-map 0:v:0 -map [a] -t 24 -c:v copy -c:a aac -b:a 160k -ar 48000 -movflags +faststart"));
  // The stills path ends its graph with the same chain, on its own input index.
  const stills = buildRenderArgs({ ...spec, engine: "ffmpeg-stills" }, { images: spec.shots.map((_, i) => `${i}.png`), narration: "n.wav", output: "o.mp4" }, { drawtext: false });
  assert.ok(stills.args[stills.args.indexOf("-filter_complex") + 1].endsWith(narrationFilter(spec, 5)));
});

test("parseRemotionProgress reads the CLI's frame counts", () => {
  assert.equal(parseRemotionProgress("Rendered 120/720, time remaining: 1m", 720), 120 / 720);
  assert.equal(parseRemotionProgress("Rendering frames 360/720", 720), 0.5);
  assert.equal(parseRemotionProgress("Encoded 720/720", 720), 1);
  assert.equal(parseRemotionProgress("Bundling 50%", 720), null);
  assert.equal(parseRemotionProgress("", 720), null);
});

async function fakeProject(probeOutput: { ok: boolean; reason?: string }, counter?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-fake-remotion-"));
  await mkdir(path.join(dir, "scripts"));
  const count = counter ? `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x");` : "";
  await writeFile(
    path.join(dir, "scripts", "probe.mjs"),
    `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); ${count}\nconsole.log(${JSON.stringify(JSON.stringify(probeOutput))}); process.exit(${probeOutput.ok ? 0 : 1});\n`,
  );
  return dir;
}

test("the probe decides remotion-2d: missing, failing and passing projects, cached per process", async (t) => {
  clearRemotionProbeCache();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vs-probe-"));
  const counter = path.join(tmp, "count");
  const ok = await fakeProject({ ok: true }, counter);
  const failing = await fakeProject({ ok: false, reason: "the templates changed since the last full probe; run the full probe again" });
  t.after(async () => {
    clearRemotionProbeCache();
    for (const d of [tmp, ok, failing]) await rm(d, { recursive: true, force: true });
  });
  assert.match((await remotionUnavailableReason(path.join(tmp, "nothing"))) as string, /not installed at/);
  assert.match((await remotionUnavailableReason(failing)) as string, /templates changed/);
  assert.equal(await remotionUnavailableReason(ok), null);
  assert.equal(await remotionUnavailableReason(ok), null);
  assert.equal(readFileSync(counter, "utf8"), "x", "the probe ran once for two asks");

  const prev = process.env.VENSTUDIO_REMOTION_DIR;
  process.env.VENSTUDIO_REMOTION_DIR = ok;
  t.after(() => {
    if (prev === undefined) delete process.env.VENSTUDIO_REMOTION_DIR;
    else process.env.VENSTUDIO_REMOTION_DIR = prev;
  });
  assert.equal(remotionDir("/home/x"), ok);
  const caps = await detectCapabilities();
  // remotion-2d also needs ffmpeg, which adds the narration.
  assert.equal(caps.includes("remotion-2d"), hasFfmpeg, caps.join(","));
  process.env.VENSTUDIO_REMOTION_DIR = failing;
  assert.ok(!(await detectCapabilities()).includes("remotion-2d"));
  delete process.env.VENSTUDIO_REMOTION_DIR;
  assert.equal(remotionDir("/home/x"), path.join("/home/x", "remotion"));
});

test("the portal's install bundle unpacks into a project the worker can probe, and bad bundles are refused", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = JSON.parse(JSON.stringify(projectBundle((p) => readFileSync(path.join(PROJECT, p), "utf8"))));
  // An earlier install: a dependency folder and a probe marker to keep, and a template file that is gone upstream.
  await mkdir(path.join(dir, "node_modules", "remotion"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "remotion", "package.json"), "{}");
  await writeFile(path.join(dir, ".venstudio-probe.json"), "{}");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "Old.tsx"), "old");
  assert.equal(await writeProjectBundle(bundle, dir), REMOTION_PROJECT_FILES.length);
  for (const p of REMOTION_PROJECT_FILES) assert.equal(await readFile(path.join(dir, p), "utf8"), readFileSync(path.join(PROJECT, p), "utf8"), p);
  assert.ok(!existsSync(path.join(dir, "src", "Old.tsx")), "src/ is replaced whole");
  assert.ok(existsSync(path.join(dir, "node_modules", "remotion", "package.json")), "dependencies are kept");
  assert.ok(existsSync(path.join(dir, ".venstudio-probe.json")));
  // Unpacked but not npm-installed: the probe says what is missing instead of claiming the capability.
  clearRemotionProbeCache();
  assert.match((await remotionUnavailableReason(dir)) as string, /not installed|reinstall/);
  clearRemotionProbeCache();

  for (const p of ["../escape.ts", "/etc/passwd", "src/../../x", "node_modules/remotion/index.js", ".venstudio-probe.json", "src//a.ts", "a b.ts"]) {
    await assert.rejects(writeProjectBundle({ files: [{ path: p, content: "x" }] }, dir), /project bundle/, p);
  }
  await assert.rejects(writeProjectBundle({ files: [] }, dir), /no files/);
  await assert.rejects(writeProjectBundle({ files: [{ path: "src/a.ts", content: 5 }] }, dir), /no content/);
  await assert.rejects(writeProjectBundle({ files: [{ path: "src/a.ts", content: "x".repeat(1024 * 1024 + 1) }] }, dir), /larger than/);
});
