/**
 * Render engine dispatch: the worker reads `engine` from the render-video payload and picks a render path, and the
 * stills path stays byte-identical to what it was before engines existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NonRetryableError,
  RENDER_ENGINES,
  VERSION,
  buildRenderArgs,
  engineUnavailable,
  handlers,
  parseRenderSpec,
  parseScenePlan,
  renderEngineOf,
  type JobContext,
} from "./venstudio-worker.ts";

const golden = JSON.parse(readFileSync(new URL("./testdata/stills-args.golden.json", import.meta.url), "utf8")) as {
  payload: Record<string, unknown>;
  withFont: unknown;
  noDrawtext: unknown;
};
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/render/explainer-payload.json", import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * The golden payload as a worker receives it. The fixture uses readable placeholder ids ("asset-shot-01"); the worker
 * only accepts UUID asset ids, because they become URL paths and file names. Everything else is the fixture's bytes.
 */
export function fixtureWithUuids(): Record<string, unknown> {
  const ids = new Map<string, string>();
  const uuid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `f1f70000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id) as string;
  };
  const p = structuredClone(fixture) as Record<string, unknown> & { shots: Array<Record<string, unknown>>; inputs: string[] };
  p.shots = p.shots.map((s) => ({ ...s, assetId: uuid(String(s.assetId)) }));
  p.narrationAssetId = uuid(String(p.narrationAssetId));
  p.inputs = p.inputs.map(uuid);
  return p;
}

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
