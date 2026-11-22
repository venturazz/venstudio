/**
 * Renderer plugins (0.10.0) and the pure parts of html-capture: dispatch, refusal by name, what each plugin declares,
 * the request filter, the capture server's path mapping, the Chromium and ffmpeg arguments, the virtual clock (run in
 * a node:vm context standing in for the page), the props, the installed HTML packs and the pack capabilities.
 * The real browser render is html-capture-render.test.ts (CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  HTML_PROBE_BLOCKED_URL,
  NonRetryableError,
  RENDER_ENGINES,
  RENDERERS,
  VERSION,
  VIRTUAL_CLOCK_SOURCE,
  buildHtmlCaptureProps,
  buildRemotionProps,
  buildRenderArgs,
  captureContentType,
  captureFileFor,
  captureUrlAllowed,
  chromiumArgs,
  clearHtmlCaptureCache,
  findChromium,
  handlers,
  htmlCaptureFfmpegArgs,
  htmlInitIssue,
  htmlPackFor,
  installedHtmlPacks,
  packCapabilitiesFor,
  parseHtmlPacks,
  parseRenderSpec,
  placeholderUuid,
  renderDigestOf,
  rendererFor,
  sampleFrameArgs,
  sampleFrameTimes,
  sharedCaptionBurn,
  withPlaceholderUuids,
  type JobContext,
  type PacksIndex,
} from "./venstudio-worker.ts";
import { fixtureWithUuids } from "./testdata/fixture.ts";

const golden = JSON.parse(readFileSync(new URL("./testdata/stills-args.golden.json", import.meta.url), "utf8")) as { payload: Record<string, unknown> };

/** The golden fixture as an html-capture job for a pack named probe-line-graph. */
function htmlSpec() {
  const p = fixtureWithUuids() as Record<string, unknown> & { scenePlan: Record<string, unknown> };
  return parseRenderSpec({ ...p, engine: "html-capture", scenePlan: { ...p.scenePlan, engine: "html-capture", template: "probe-line-graph" } });
}

test("every engine has exactly one plugin, with the capability jobs are routed by", () => {
  assert.deepEqual(Object.keys(RENDERERS).sort(), Object.keys(RENDER_ENGINES).sort());
  for (const [id, r] of Object.entries(RENDERERS)) {
    assert.equal(r.id, id);
    assert.equal(r.capability, RENDER_ENGINES[id], id);
  }
  // The names workers reported before plugins are unchanged, so routing of jobs without a pack does not move.
  assert.equal(RENDERERS["ffmpeg-stills"].capability, "ffmpeg");
  assert.equal(RENDERERS["remotion-2d"].capability, "remotion-2d");
  assert.equal(RENDERERS["html-capture"].capability, "html-capture");
});

test("plugins declare what runs after them: the shared mux for muted pictures, the shared burn only for html templates that do not draw captions", () => {
  const stills = RENDERERS["ffmpeg-stills"];
  const remotion = RENDERERS["remotion-2d"];
  const html = RENDERERS["html-capture"];
  const spec = htmlSpec();
  assert.equal(stills.audio, "own-graph");
  assert.equal(stills.captions(spec, null), "renderer");
  assert.equal(remotion.audio, "shared-mux");
  // The file name the 0.5.0 path muxed from, so the mux arguments stay the golden ones.
  assert.equal(remotion.mutedFile, "remotion.part.mp4");
  assert.equal(remotion.captions(spec, "flat-vector-explainer"), "renderer");
  assert.equal(html.audio, "shared-mux");
  assert.equal(html.mutedFile, "html.part.mp4");
  assert.equal(html.captions(spec, { drawsCaptions: false }), "shared-burn");
  assert.equal(html.captions(spec, { drawsCaptions: true }), "renderer");
});

test("rendererFor refuses an engine without a plugin by name, including the portal-only hermes renderer", () => {
  for (const e of ["manim", "hermes", "godot-2d", "remotion-3d"]) {
    assert.throws(() => rendererFor(e), (err: Error) => err instanceof NonRetryableError && err.message.includes(`"${e}"`) && /not rendered as stills/.test(err.message), e);
  }
  assert.equal(rendererFor("html-capture").id, "html-capture");
  // hermes is the portal's research renderer: a worker says so instead of listing what it runs.
  assert.throws(() => rendererFor("hermes"), /rendered by the portal through Hermes/);
});

test("the shared caption burn is the stills graph's drawtext chain, byte for byte", () => {
  const spec = parseRenderSpec(golden.payload);
  const args = buildRenderArgs(spec, { images: spec.shots.map((_, i) => `in/${i}.png`), narration: "in/n.wav", output: "video.part.mp4", font: "in/f.ttf" }, { drawtext: true });
  const graph = args.args[args.args.indexOf("-filter_complex") + 1];
  const burn = sharedCaptionBurn(spec, "in/f.ttf", { drawtext: true });
  assert.ok(burn.filter && graph.includes(`[vc]${burn.filter}[v]`), "the same filters");
  assert.deepEqual(burn.files, args.captionFiles);
  assert.equal(burn.captionsBurned, true);
  const none = sharedCaptionBurn(spec, undefined, { drawtext: true });
  assert.deepEqual([none.filter, none.captionsBurned, none.captionNote], [null, false, "no font in Assets"]);
  assert.equal(sharedCaptionBurn(spec, "in/f.ttf", { drawtext: false }).captionNote, "this ffmpeg build has no drawtext filter");
});

/** A JobContext whose download fails the test, to prove dispatch fails before any input is fetched. */
function noDownloadCtx(workDir: string, payload: Record<string, unknown>): { ctx: JobContext; downloads: string[] } {
  const downloads: string[] = [];
  const ctx: JobContext = {
    job: { id: "bbbbbbbb-1111-4111-8111-0000000000e2", type: "render-video", payload, capability: "html-capture", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
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

test("render-video with html-capture fails naming the engine when this machine has no Chromium, before any download", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-html-engine-"));
  const prev = process.env.VENSTUDIO_REMOTION_DIR;
  const prevChrome = process.env.VENSTUDIO_CHROMIUM_PATH;
  process.env.VENSTUDIO_REMOTION_DIR = path.join(dir, "no-remotion-here");
  delete process.env.VENSTUDIO_CHROMIUM_PATH;
  clearHtmlCaptureCache();
  t.after(async () => {
    if (prev === undefined) delete process.env.VENSTUDIO_REMOTION_DIR;
    else process.env.VENSTUDIO_REMOTION_DIR = prev;
    if (prevChrome !== undefined) process.env.VENSTUDIO_CHROMIUM_PATH = prevChrome;
    clearHtmlCaptureCache();
    await rm(dir, { recursive: true, force: true });
  });
  const p = fixtureWithUuids() as Record<string, unknown> & { scenePlan: Record<string, unknown> };
  const { ctx, downloads } = noDownloadCtx(dir, { ...p, engine: "html-capture", scenePlan: { ...p.scenePlan, engine: "html-capture", template: "probe-line-graph" } });
  await assert.rejects(handlers["render-video"](ctx), (err: Error) => {
    assert.ok(err instanceof NonRetryableError);
    assert.match(err.message, /Engine "html-capture" needs capability "html-capture"/);
    assert.match(err.message, /no headless Chromium/);
    assert.match(err.message, /html-capture\.md/);
    return true;
  });
  assert.deepEqual(downloads, []);
});

test("htmlPackFor names the template it has nothing for, and never draws another", () => {
  const spec = htmlSpec();
  const pack = { id: "probe-line-graph", version: "0.1.0", drawsCaptions: false, sha256: "a".repeat(64), dir: "/x" };
  assert.equal(htmlPackFor(spec, [pack]).id, "probe-line-graph");
  assert.throws(
    () => htmlPackFor(spec, [{ ...pack, id: "other-pack" }]),
    (err: Error) => err instanceof NonRetryableError && /Template "probe-line-graph" has no html-capture pack/.test(err.message) && /other-pack@0\.1\.0/.test(err.message),
  );
});

test("only the capture server's own origin and data:/blob:/about: URLs may load", () => {
  const origin = "http://127.0.0.1:45123";
  assert.equal(captureUrlAllowed(`${origin}/tok/pack/index.html`, origin), true);
  assert.equal(captureUrlAllowed(`${origin}/favicon.ico`, origin), true);
  assert.equal(captureUrlAllowed("data:image/png;base64,AAAA", origin), true);
  assert.equal(captureUrlAllowed("blob:http://127.0.0.1:45123/x", origin), true);
  for (const u of ["https://cdn.jsdelivr.net/npm/gsap", "http://127.0.0.1:45124/x", "http://localhost:45123/x", "ws://127.0.0.1:45123/", HTML_PROBE_BLOCKED_URL, "file:///etc/passwd", "not a url"]) {
    assert.equal(captureUrlAllowed(u, origin), false, u);
  }
});

test("the capture server maps only /<token>/pack/ and /<token>/in/ inside their roots", () => {
  const roots = { pack: "/srv/pack", in: "/srv/job/in" };
  assert.equal(captureFileFor("/t0k/pack/index.html", "t0k", roots), path.resolve("/srv/pack/index.html"));
  assert.equal(captureFileFor("/t0k/pack/vendor/lib.js?v=1", "t0k", roots), path.resolve("/srv/pack/vendor/lib.js"));
  assert.equal(captureFileFor("/t0k/in/abc.png", "t0k", roots), path.resolve("/srv/job/in/abc.png"));
  for (const bad of ["/other/pack/index.html", "/t0k/pack/../in/abc.png", "/t0k/pack/%2e%2e/x", "/t0k/pack/.hidden", "/t0k/pack/", "/t0k/etc/passwd", "/t0k/pack/a%00b", "/t0k/pack/%E0%A4%A"]) {
    assert.equal(captureFileFor(bad, "t0k", roots), null, bad);
  }
  assert.equal(captureFileFor("/t0k/in/abc.png", "t0k", { pack: "/srv/pack", in: null }), null, "no inputs folder for the probe");
  assert.equal(captureContentType("index.html"), "text/html; charset=utf-8");
  assert.equal(captureContentType("three.module.js"), "text/javascript; charset=utf-8");
  assert.equal(captureContentType("x.unknown"), "application/octet-stream");
});

test("Chromium runs headless over a pipe at device scale 1, with a dead proxy and a resolver that resolves nothing", () => {
  const a = chromiumArgs({ width: 1080, height: 1920, userDataDir: "/tmp/u" });
  for (const flag of ["--remote-debugging-pipe", "--window-size=1080,1920", "--force-device-scale-factor=1", "--user-data-dir=/tmp/u", "--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--mute-audio"]) {
    assert.ok(a.includes(flag), flag);
  }
  assert.ok(!a.some((f) => f.startsWith("--remote-debugging-port")), "no debugging port");
});

test("frames are encoded to muted H.264 yuv420p with faststart; a shared burn runs before the pixel format", () => {
  const plain = htmlCaptureFfmpegArgs({ fps: 30, frames: 720, output: "html.part.mp4", burn: null });
  assert.deepEqual(plain.slice(plain.indexOf("-f"), plain.indexOf("-i") + 2), ["-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "pipe:0"]);
  assert.equal(plain[plain.indexOf("-frames:v") + 1], "720");
  assert.equal(plain[plain.indexOf("-vf") + 1], "format=yuv420p");
  for (const f of ["libx264", "yuv420p", "+faststart", "-an"]) assert.ok(plain.includes(f), f);
  assert.equal(plain.at(-1), "html.part.mp4");
  const burned = htmlCaptureFfmpegArgs({ fps: 30, frames: 720, output: "html.part.mp4", burn: "drawtext=a,drawtext=b" });
  assert.equal(burned[burned.indexOf("-vf") + 1], "drawtext=a,drawtext=b,format=yuv420p");
});

test("init's reply must match the job; one frame of rounding is allowed", () => {
  const want = { width: 1080, height: 1920, fps: 30, totalFrames: 720 };
  assert.equal(htmlInitIssue({ ...want }, want), null);
  assert.equal(htmlInitIssue({ ...want, totalFrames: 721 }, want), null);
  assert.match(htmlInitIssue({ ...want, totalFrames: 700 }, want) as string, /700 frames, the job 720/);
  assert.match(htmlInitIssue({ ...want, width: 1920, height: 1080 }, want) as string, /1920x1080/);
  assert.match(htmlInitIssue({ ...want, fps: 25 }, want) as string, /25 fps/);
  assert.match(htmlInitIssue(null, want) as string, /returned nothing/);
});

/** A context that stands in for the page: the globals the clock replaces, plus a document with animations. */
function pageContext(o: { realTimers?: boolean } = {}) {
  const anims: Array<{ currentTime: number | null; paused: boolean; pause(): void }> = [];
  const calls: string[] = [];
  const sandbox: Record<string, unknown> = {
    Date,
    Math: Object.create(Math),
    performance: { now: () => 123456, timeOrigin: 1 },
    navigator: { sendBeacon: () => true, serviceWorker: { register: () => Promise.resolve() } },
    document: { getAnimations: () => anims, fonts: { status: "loaded" } },
    __venstudioBlocked: (what: string) => calls.push(what),
    setTimeout: o.realTimers ? (fn: () => void, ms: number) => setTimeout(fn, ms) : () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  // Math must keep its functions; Object.create gives the clock a Math whose random it can replace.
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.Math = Object.assign(Object.create(Object.getPrototypeOf(Math)), Math, { random: Math.random });", ctx);
  vm.runInContext(VIRTUAL_CLOCK_SOURCE, ctx);
  const run = (code: string) => vm.runInContext(code, ctx) as unknown;
  // Values from the page's realm, as plain JSON (arrays from another realm are not deepEqual to this one's).
  const value = (code: string) => JSON.parse(run(`JSON.stringify(${code})`) as string) as unknown;
  return { ctx, anims, calls, run, value };
}

test("the virtual clock: time moves only between frames, by exactly one frame, and timers and frame callbacks follow it", async () => {
  const { run, value } = pageContext();
  assert.equal(run("Date.now()"), 1767225600000, "a fixed epoch");
  assert.equal(run("performance.now()"), 0);
  assert.equal(run("new Date().toISOString()"), "2026-01-01T00:00:00.000Z");
  assert.equal(run("new Date(0).toISOString()"), "1970-01-01T00:00:00.000Z", "explicit dates are untouched");
  run(`
    globalThis.log = [];
    setTimeout(() => log.push("t50@" + performance.now()), 50);
    setTimeout(() => log.push("t0@" + performance.now()), 0);
    const iv = setInterval(() => { log.push("iv@" + performance.now()); if (performance.now() >= 80) clearInterval(iv); }, 40);
    requestAnimationFrame((t) => log.push("raf@" + t));
    globalThis.frames = [];
    globalThis.VENSTUDIO = { async init(p) { return { totalFrames: 3, fps: 25, width: p.width, height: 2 }; }, renderFrame(f) { frames.push(f + ":" + performance.now() + ":" + Date.now()); } };
  `);
  assert.deepEqual(value("log"), [], "nothing runs before the first frame");
  assert.deepEqual(JSON.parse(JSON.stringify(await (run("__venstudio.init({ width: 4 })") as Promise<unknown>))), { totalFrames: 3, fps: 25, width: 4, height: 2 });
  await (run("__venstudio.frame(0, 25)") as Promise<unknown>);
  assert.deepEqual(value("log"), ["t0@0", "raf@0"]);
  await (run("__venstudio.frame(1, 25)") as Promise<unknown>);
  await (run("__venstudio.frame(2, 25)") as Promise<unknown>);
  assert.deepEqual(value("log"), ["t0@0", "raf@0", "iv@40", "t50@50", "iv@80"], "timers fire in due order at their own times, the interval stops");
  assert.deepEqual(value("frames"), ["0:0:1767225600000", "1:40:1767225600040", "2:80:1767225600080"]);
});

test("the virtual clock: during init a page may wait for the next tick and the next frame; time stays at 0", async () => {
  const { run, value } = pageContext({ realTimers: true });
  run(`
    globalThis.seen = [];
    globalThis.VENSTUDIO = {
      async init(p) {
        await new Promise((r) => setTimeout(r, 0));
        seen.push("tick@" + performance.now());
        await new Promise((r) => requestAnimationFrame(r));
        seen.push("frame@" + performance.now());
        setTimeout(() => seen.push("later@" + performance.now()), 100);
        return { totalFrames: 10, fps: 10, width: p.width, height: 1 };
      },
      renderFrame() {},
    };
  `);
  await (run("__venstudio.init({ width: 2 })") as Promise<unknown>);
  assert.deepEqual(value("seen"), ["tick@0", "frame@0"]);
  // A timer set for later still waits for the virtual clock, not for real time.
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(value("seen"), ["tick@0", "frame@0"]);
  await (run("__venstudio.frame(1, 10)") as Promise<unknown>);
  assert.deepEqual(value("seen"), ["tick@0", "frame@0", "later@100"]);
});

test("the virtual clock: Math.random is the same sequence on every render", () => {
  const a = pageContext().value("[Math.random(), Math.random(), Math.random()]") as number[];
  const b = pageContext().value("[Math.random(), Math.random(), Math.random()]") as number[];
  assert.deepEqual(a, b);
  assert.ok(a.every((x) => x >= 0 && x < 1) && new Set(a).size === 3);
});

test("the virtual clock: network APIs throw and report the attempt; a page without VENSTUDIO fails init by name", async () => {
  const { run, calls } = pageContext();
  assert.throws(() => run('new WebSocket("wss://example.com/x")'), /Network access is not available/);
  assert.throws(() => run('navigator.sendBeacon("https://example.com/b")'), /Network access is not available/);
  assert.throws(() => run('new EventSource("https://example.com/e")'), /Network access is not available/);
  assert.deepEqual(calls, ["wss://example.com/x", "https://example.com/b", "https://example.com/e"]);
  await assert.rejects(run("__venstudio.init({})") as Promise<unknown>, /does not define window\.VENSTUDIO/);
});

test("the virtual clock: CSS and Web Animations are paused and set to the clock from the frame they appear on", async () => {
  const { run, anims } = pageContext();
  run("globalThis.VENSTUDIO = { init: async () => ({}), renderFrame() {} };");
  const anim = () => ({ currentTime: null as number | null, paused: false, pause() { this.paused = true; } });
  const first = anim();
  anims.push(first);
  await (run("__venstudio.frame(0, 10)") as Promise<unknown>);
  await (run("__venstudio.frame(5, 10)") as Promise<unknown>);
  const late = anim();
  anims.push(late);
  await (run("__venstudio.frame(6, 10)") as Promise<unknown>);
  assert.equal(first.paused, true);
  assert.equal(first.currentTime, 600);
  assert.equal(late.currentTime, 0, "starts at its own first frame");
  await (run("__venstudio.frame(8, 10)") as Promise<unknown>);
  assert.equal(late.currentTime, 200);
});

test("buildHtmlCaptureProps: the same timeline Remotion gets, relative URLs, and captions only for a template that draws them", () => {
  const spec = htmlSpec();
  const images = spec.shots.map((s) => `../in/${s.assetId}.png`);
  const props = buildHtmlCaptureProps(spec, { images, font: "../in/f.ttf", drawsCaptions: false });
  const remotion = buildRemotionProps({ ...spec, engine: "remotion-2d" }, { images, font: "f.ttf" });
  assert.deepEqual(props.timeline, remotion.timeline);
  assert.equal(props.totalFrames, remotion.timeline?.totalFrames);
  assert.equal(props.template, "probe-line-graph");
  assert.deepEqual(props.scenes, remotion.scenes);
  assert.deepEqual(props.shots.map((s) => s.image), images);
  assert.deepEqual(props.captions, [], "ffmpeg burns them");
  assert.equal(props.drawsCaptions, false);
  assert.deepEqual(props.captionStyle, spec.captionStyle);
  const drawing = buildHtmlCaptureProps(spec, { images, font: null, drawsCaptions: true });
  assert.deepEqual(drawing.captions, spec.captions);
  assert.throws(() => buildHtmlCaptureProps(spec, { images: images.slice(1), font: null, drawsCaptions: false }), NonRetryableError);
});

test("installed HTML packs: only entries whose files match their digest, cached per directory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-html-packs-"));
  t.after(async () => {
    clearHtmlCaptureCache();
    await rm(dir, { recursive: true, force: true });
  });
  const files = { "index.html": "<!doctype html><title>x</title>", "vendor/lib.js": "export const x = 1;\n", "vendor/LICENSE.txt": "MIT\n" };
  const hashes: Record<string, string> = {};
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, "html", "good-pack", rel)), { recursive: true });
    await writeFile(path.join(dir, "html", "good-pack", rel), text);
    await mkdir(path.dirname(path.join(dir, "html", "edited-pack", rel)), { recursive: true });
    await writeFile(path.join(dir, "html", "edited-pack", rel), rel === "index.html" ? `${text} edited` : text);
    hashes[rel] = createHash("sha256").update(text).digest("hex");
  }
  const digest = renderDigestOf(hashes);
  await writeFile(
    path.join(dir, "html", "packs.json"),
    JSON.stringify([
      { id: "good-pack", version: "0.1.0", drawsCaptions: true, sha256: digest },
      { id: "edited-pack", version: "0.1.0", drawsCaptions: false, sha256: digest },
      { id: "missing-pack", version: "0.1.0", drawsCaptions: false, sha256: digest },
      { id: "Bad Id", version: "x", sha256: "no" },
    ]),
  );
  clearHtmlCaptureCache();
  const got = await installedHtmlPacks(dir);
  assert.deepEqual(got.packs.map((p) => [p.id, p.version, p.drawsCaptions, p.dir]), [["good-pack", "0.1.0", true, path.join(dir, "html", "good-pack")]]);
  assert.equal(got.problems.length, 2);
  assert.match(got.problems.join("\n"), /edited-pack@0\.1\.0: its files differ/);
  assert.match(got.problems.join("\n"), /missing-pack@0\.1\.0: index\.html is missing/);
  assert.equal(await installedHtmlPacks(dir), await installedHtmlPacks(dir), "cached");
  assert.deepEqual(parseHtmlPacks({}), []);
  assert.deepEqual(await installedHtmlPacks(path.join(dir, "nothing-here")), { packs: [], problems: [] });
});

test("pack:<id>@<version> for an html-capture pack needs html-capture and that exact version installed", () => {
  const idx: PacksIndex = {
    format: 1,
    commit: null,
    packs: [{ id: "probe-line-graph", version: "0.1.0", status: "lab", engine: "html-capture", minWorkerVersion: "0.10.0", composition: null, sha256: "b".repeat(64) }],
  };
  const installed = [{ id: "probe-line-graph", version: "0.1.0", drawsCaptions: false, sha256: "c".repeat(64) }];
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "html-capture"], [], VERSION, installed), ["pack:probe-line-graph@0.1.0"]);
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg"], [], VERSION, installed), [], "the probe did not pass");
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "html-capture"], [], VERSION, []), [], "not installed");
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "html-capture"], [], VERSION, [{ ...installed[0], version: "0.0.9" }]), [], "another version");
  assert.deepEqual(packCapabilitiesFor(idx, ["ffmpeg", "html-capture"], [], "0.9.0", installed), [], "0.9.0 cannot run it");
  const hermes: PacksIndex = { ...idx, packs: [{ ...idx.packs[0], id: "hermes-research", engine: "hermes" }] };
  assert.deepEqual(packCapabilitiesFor(hermes, ["ffmpeg", "html-capture", "remotion-2d"], [], VERSION, installed), [], "the portal renders hermes packs, never a worker");
});

test("findChromium finds Remotion's Chrome Headless Shell and nothing that is not executable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-chromium-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(await findChromium(dir, env), null);
  const bin = path.join(dir, "node_modules", ".remotion", "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "chrome-headless-shell"), "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(await findChromium(dir, env), null, "not executable");
  await chmod(path.join(bin, "chrome-headless-shell"), 0o755);
  assert.equal(await findChromium(dir, env), path.join(bin, "chrome-headless-shell"));
  assert.equal(await findChromium(dir, { VENSTUDIO_CHROMIUM_PATH: path.join(dir, "nope") } as NodeJS.ProcessEnv), null, "an override that does not exist is not silently replaced");
});

test("qc-video samples evenly spaced stills only when asked, at most 12", () => {
  assert.deepEqual(sampleFrameTimes(undefined, 24), []);
  assert.deepEqual(sampleFrameTimes(0, 24), []);
  assert.deepEqual(sampleFrameTimes(6, 0), []);
  assert.deepEqual(sampleFrameTimes(6, 24), [2, 6, 10, 14, 18, 22]);
  assert.equal(sampleFrameTimes(50, 24).length, 12);
  assert.deepEqual(sampleFrameArgs("input.bin", 2, "frame-01.jpg"), ["-y", "-hide_banner", "-loglevel", "error", "-ss", "2", "-i", "input.bin", "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "4", "frame-01.jpg"]);
});

test("capture-html turns a fixture's readable asset ids into stable UUIDs the worker accepts", () => {
  const u = placeholderUuid("asset-shot-01");
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(u, placeholderUuid("asset-shot-01"));
  const p = withPlaceholderUuids({ inputs: ["asset-shot-01", "asset-voice"], shots: [{ assetId: "asset-shot-01" }], narrationAssetId: "asset-voice", text: "asset-shot-01 stays in prose" });
  assert.deepEqual(p, { inputs: [u, placeholderUuid("asset-voice")], shots: [{ assetId: u }], narrationAssetId: placeholderUuid("asset-voice"), text: "asset-shot-01 stays in prose" });
});
