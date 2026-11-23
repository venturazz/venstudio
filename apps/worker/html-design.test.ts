/**
 * html-design and preview-frames (worker 0.11.0), the parts that need no browser: the page bundle check, what the
 * capture server serves and with which headers, the page guard, the preview payload, the page/pack agreement and the
 * job type. The real captures (stills of a pack page and of an uploaded page, the CSP, pages that try the network or
 * throw) run in CI in html-capture-render.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HTML_PAGE_CSP,
  HTML_PAGE_GUARD_SOURCE,
  HTML_PAGE_LIMITS,
  PAGE_BUNDLE_KIND,
  PREVIEW_LIMITS,
  PREVIEW_NO_NARRATION,
  VERSION,
  advertisedJobTypes,
  claimJobTypes,
  captureFileFor,
  captureHeaders,
  chromiumArgs,
  htmlPageModeFor,
  parseHtmlPacks,
  parsePageBundle,
  parsePreviewPayload,
  parseRenderSpec,
  renderInputsOf,
  stillFile,
  writePageBundle,
  type InstalledHtmlPack,
} from "./venstudio-worker.ts";

const PAGE = "aaaaaaaa-1111-4111-8111-0000000000aa";
const PLATE = "bbbbbbbb-2222-4222-8222-0000000000bb";
const FONT = "cccccccc-3333-4333-8333-0000000000cc";
const NARRATION = "dddddddd-4444-4444-8444-0000000000dd";

const bundle = (files: Record<string, unknown>) => ({ format: 1, kind: PAGE_BUNDLE_KIND, files });
const INDEX = "<!doctype html><script>window.VENSTUDIO={init(p){return p},renderFrame(){}}</script>";

test("worker 0.11.0+ runs preview-frames, and names the job type in a claim only once its still probe passed", () => {
  assert.equal(VERSION, "0.15.0");
  assert.ok(advertisedJobTypes({}).includes("preview-frames"));
  assert.ok(!claimJobTypes(advertisedJobTypes({}), ["ffmpeg", "html-capture", "pack:probe-line-graph@0.1.1"]).includes("preview-frames"));
  assert.ok(claimJobTypes(advertisedJobTypes({}), ["ffmpeg", "html-capture", "preview-frames"]).includes("preview-frames"));
  assert.ok(claimJobTypes(advertisedJobTypes({}), []).includes("render-video"), "nothing else changes");
});

test("a page bundle is checked again on the worker: index.html, text files with plain names, 20 files and 300 KB at most", () => {
  assert.deepEqual(parsePageBundle(bundle({ "index.html": INDEX, "scene.js": "1", "art/logo.svg": "<svg/>" })).map((f) => f.path), ["art/logo.svg", "index.html", "scene.js"]);
  const refused: Array<[unknown, RegExp]> = [
    [{ files: { "index.html": INDEX } }, /not a VenStudio page bundle/],
    [bundle({}), /0 files/],
    [bundle({ "scene.js": "1" }), /no index\.html/],
    [bundle({ "index.html": INDEX, "other.html": "x" }), /"other\.html" is not allowed/],
    [bundle({ "index.html": INDEX, "../escape.js": "x" }), /is not allowed/],
    [bundle({ "index.html": INDEX, ".hidden.js": "x" }), /is not allowed/],
    [bundle({ "index.html": INDEX, "a/b/c/d.js": "x" }), /is not allowed/],
    [bundle({ "index.html": INDEX, "font.woff2": "x" }), /is not allowed/],
    [bundle({ "index.html": INDEX, "x.js": 5 }), /x\.js is not text/],
    [bundle({ "index.html": INDEX, "x.js": "a\0b" }), /x\.js is not text/],
    [bundle(Object.fromEntries([["index.html", INDEX], ...Array.from({ length: 20 }, (_, i) => [`f${i}.js`, "1"])])), /21 files/],
    [bundle({ "index.html": "x".repeat(HTML_PAGE_LIMITS.totalBytes + 1) }), /holds 307201 bytes; the limit is 307200/],
  ];
  for (const [raw, re] of refused) assert.throws(() => parsePageBundle(raw), re);
});

test("writePageBundle writes the page into its own folder only", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writePageBundle(parsePageBundle(bundle({ "index.html": INDEX, "js/scene.js": "1" })), path.join(dir, "page"));
  assert.equal(await readFile(path.join(dir, "page", "index.html"), "utf8"), INDEX);
  assert.equal(await readFile(path.join(dir, "page", "js", "scene.js"), "utf8"), "1");
});

test("the capture server: page/ only when a page was uploaded, pack/ and in/ beside it, nothing else; the CSP on every response of a page capture", () => {
  const roots = { pack: "/w/pack", in: "/w/job/in", page: "/w/job/page" };
  assert.equal(captureFileFor("/tok/page/index.html", "tok", roots), "/w/job/page/index.html");
  assert.equal(captureFileFor("/tok/pack/fonts/fonts.css", "tok", roots), "/w/pack/fonts/fonts.css");
  assert.equal(captureFileFor("/tok/in/plate.png", "tok", roots), "/w/job/in/plate.png");
  assert.equal(captureFileFor("/tok/page/index.html", "tok", { pack: "/w/pack", in: null }), null, "no page folder without an uploaded page");
  // Never the job folder itself (the page bundle, the work files), never outside a root.
  for (const u of ["/tok/page.json", "/tok/job/page.json", "/tok/page/../page.json", "/tok/page/%2e%2e/page.json", "/tok/in/../page.json", "/other/page/index.html", "/tok/page/.secret"]) {
    assert.equal(captureFileFor(u, "tok", roots), null, u);
  }
  const page = captureHeaders("/w/job/page/index.html", 10, true);
  assert.equal(page["content-security-policy"], HTML_PAGE_CSP);
  // The owner's policy, plus explicit refusals for what script-src 'self' would otherwise let through (workers fall back to it).
  assert.ok(HTML_PAGE_CSP.startsWith("default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; "));
  for (const d of ["worker-src 'none'", "child-src 'none'", "frame-src 'none'", "object-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(HTML_PAGE_CSP.includes(d), d);
  assert.equal(page["x-content-type-options"], "nosniff");
  assert.equal(page["content-type"], "text/html; charset=utf-8");
  assert.equal(captureHeaders("/w/pack/index.html", 10, false)["content-security-policy"], undefined, "a signed pack's page keeps the 0.10.0 headers");
});

test("the page guard refuses fetch, XHR, workers, window.open and frames, and reports CSP violations", () => {
  for (const what of ["g.fetch", "g.XMLHttpRequest", "g.Worker", "g.SharedWorker", "g.open", "sendBeacon", '"iframe"', '"object"', '"embed"', "securitypolicyviolation"]) {
    assert.ok(HTML_PAGE_GUARD_SOURCE.includes(what), what);
  }
  // A fresh profile, no extensions, and the dead proxy and resolver from 0.10.0.
  const args = chromiumArgs({ width: 10, height: 10, userDataDir: "/tmp/fresh" });
  for (const a of ["--user-data-dir=/tmp/fresh", "--disable-extensions", "--proxy-server=http://127.0.0.1:9", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]) assert.ok(args.includes(a), a);
  // Chromium's own sandbox stays on for an uploaded page wherever the machine supports it; signed packs keep 0.10.0's flags.
  assert.ok(args.includes("--no-sandbox"));
  assert.ok(!chromiumArgs({ width: 10, height: 10, userDataDir: "/tmp/fresh", sandbox: true }).includes("--no-sandbox"));
  for (const what of ["serviceWorker", 'g.addEventListener("securitypolicyviolation"']) assert.ok(HTML_PAGE_GUARD_SOURCE.includes(what), what);
});

test("an html-design pack renders only a page uploaded with the job, and an uploaded page only with such a pack", () => {
  const designed = { id: "hermes-designed-explainer", version: "0.1.0", drawsCaptions: false, designed: true, sha256: "0".repeat(64), dir: "/x" } as InstalledHtmlPack;
  const plain = { id: "probe-line-graph", version: "0.1.1", drawsCaptions: false, sha256: "0".repeat(64), dir: "/y" } as InstalledHtmlPack;
  assert.equal(htmlPageModeFor({ page: { assetId: PAGE } }, designed), designed);
  assert.equal(htmlPageModeFor({}, plain), plain);
  assert.throws(() => htmlPageModeFor({}, designed), /draws a page Hermes writes for each run, and this job carries none/);
  assert.throws(() => htmlPageModeFor({ page: { assetId: PAGE } }, plain), /not an html-design pack/);
  assert.deepEqual(parseHtmlPacks([{ id: "hermes-designed-explainer", version: "0.1.0", drawsCaptions: false, designed: true, sha256: "a".repeat(64) }])[0].designed, true);
  assert.equal(parseHtmlPacks([{ id: "probe-line-graph", version: "0.1.1", drawsCaptions: false, sha256: "a".repeat(64) }])[0].designed, undefined);
});

const scenePlan = (template: string) => ({
  version: 1,
  engine: "html-capture",
  template,
  family: "explainer",
  width: 1080,
  height: 1920,
  fps: 30,
  transitionSec: 0,
  scenes: [1, 2, 3].map((i) => ({ shotRef: `shot-0${i}`, seconds: 2, beatRole: "body", elements: [{ kind: "heading", text: `Scene ${i}` }], tokens: ["pop"], camera: false, layers: [{ id: "scene", frames: 60, fps: 30 }] })),
});

function previewPayload(extra: Record<string, unknown> = {}) {
  return {
    format: "short",
    width: 1080,
    height: 1920,
    fps: 30,
    engine: "html-capture",
    transitionSec: 0,
    shots: [1, 2, 3].map((i) => ({ shotRef: `shot-0${i}`, assetId: PLATE, seconds: 2, motion: "zoom-in" })),
    durationSec: 6,
    captions: [{ start: 0, end: 2, text: "Hello" }],
    targetLufs: -14,
    fontAssetId: FONT,
    inputs: [PLATE, FONT, PAGE],
    scenePlan: scenePlan("hermes-designed-explainer"),
    runId: "eeeeeeee-5555-4555-8555-0000000000ee",
    preview: { times: [1, 3, 5, 5.01], page: PAGE },
    ...extra,
  };
}

test("a preview payload is a render payload without narration: same spec, the asked stills as frames, the page by id", () => {
  const plan = parsePreviewPayload(previewPayload());
  assert.equal(plan.pageAssetId, PAGE);
  assert.deepEqual(plan.stills, [{ atSec: 1, frame: 30 }, { atSec: 3, frame: 90 }, { atSec: 5, frame: 150 }], "5 s and 5.01 s are one frame");
  assert.equal(plan.spec.narrationAssetId, PREVIEW_NO_NARRATION);
  assert.equal(plan.spec.durationSec, 6);
  assert.equal(plan.spec.page, undefined, "the page is not part of the render spec of a preview");
  assert.ok(!renderInputsOf(plan.spec).includes(PAGE));
  // A pack's own page (scene-spec): no page.
  const { preview, ...rest } = previewPayload();
  assert.equal(parsePreviewPayload({ ...rest, preview: { times: [0] } }).pageAssetId, null);
  assert.ok(preview);
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ preview: undefined }, /no preview block/],
    [{ preview: { times: [] } }, /1 to 12 times/],
    [{ preview: { times: Array.from({ length: PREVIEW_LIMITS.maxStills + 1 }, (_, i) => i / 10) } }, /1 to 12 times/],
    [{ preview: { times: [7] } }, /preview time 1 must be from 0 to 6 s/],
    [{ preview: { times: [1], page: "not-a-uuid" } }, /preview.page must be the page asset id/],
    [{ preview: { times: [1], page: NARRATION } }, /the page asset is not listed in inputs/],
    [{ narrationAssetId: NARRATION }, /a preview has no narration/],
    [{ engine: "remotion-2d", scenePlan: { ...scenePlan("x"), engine: "remotion-2d" } }, /previews are for html-capture pages/],
    [{ durationSec: 0 }, /durationSec must be above 0/],
  ];
  for (const [extra, re] of refused) assert.throws(() => parsePreviewPayload(previewPayload(extra)), re, String(re));
  assert.equal(stillFile(0), "still-01.jpg");
});

test("render-video reads payload.page only for html-capture, listed in inputs; the page is never downloaded as a picture", () => {
  const { preview, ...p } = previewPayload();
  assert.ok(preview);
  const render = { ...p, inputs: [PLATE, FONT, PAGE, NARRATION], narrationAssetId: NARRATION, narrationSec: 6, page: { assetId: PAGE } };
  const spec = parseRenderSpec(render);
  assert.deepEqual(spec.page, { assetId: PAGE });
  assert.ok(!renderInputsOf(spec).includes(PAGE), "the page bundle is fetched by the renderer into page/, not into in/");
  assert.throws(() => parseRenderSpec({ ...render, page: { assetId: "x" } }), /page must name the page asset/);
  assert.throws(() => parseRenderSpec({ ...render, inputs: [PLATE, FONT, NARRATION] }), /the page asset is not listed in inputs/);
  assert.equal(parseRenderSpec({ ...render, page: undefined }).page, undefined, "a payload without a page parses as before");
});
