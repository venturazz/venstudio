// html-design (research only, owner decision): the page validator, the reply's shape, the gate, the shots and the page
// bundle; the still-frame preview's pure parts; the research-only rules. docs/style-packs.md, "html-design".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HTML_DESIGN_BADGE,
  PAGE_BUNDLE_KIND,
  PAGE_LIMITS,
  htmlDesignGate,
  htmlDesignLines,
  htmlDesignPrompt,
  htmlDesignShots,
  pageBundle,
  pageIssues,
  readHtmlDesign,
  validateHtmlDesign,
  type DesignBrief,
  type PageFile,
} from "./html-design.ts";
import {
  HTML_DESIGN_NEEDS_PREVIEW,
  NO_PREVIEW_CONTINUE,
  PREVIEW_NARRATION_PLACEHOLDER,
  parsePreviewResult,
  previewNote,
  previewPayload,
  previewTimes,
  previewWorkers,
  sceneStartsOf,
} from "./frame-preview.ts";
import { buildRenderPayload } from "./render.ts";
import { OWNER_ONLY_STAGES, alwaysReviewed, workflowForPack } from "./recipes.ts";
import { guardFinalDecision, isDesignedPack, newVideoStyles, mergeRegistry, parsePack, parseRunStylePack, publishRefusal, runStylePack, type StylePack } from "./style-registry.ts";
import { parseRunConfig } from "./run-config.ts";
import { STYLES } from "./catalog.ts";
import { decisionHint, decisionLabel, keptWord, tightenLabel } from "./review.ts";
import { productionStageAction, productionSummary } from "./production.ts";
import { planReview, parsePlanPayload, HTML_DESIGN_NOTE } from "./plan-review.ts";
import { seedTemplates } from "./templates.ts";
import type { DirectorContext } from "./director.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; version: string; sha256: string; files: Record<string, string> }> };
const lockPack = (id: string) => lock.packs.find((p) => p.id === id)!;
const rawStyle = (id: string) => JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", id, "style.json"), "utf8")) as Record<string, unknown>;
const DESIGNED = "hermes-designed-explainer";
const designedPack = parsePack(rawStyle(DESIGNED), lockPack(DESIGNED).sha256) as StylePack;
const VENDORED = Object.keys(lockPack(DESIGNED).files).filter((f) => f.startsWith("render/") && f !== "render/index.html").map((f) => f.slice("render/".length));
const REFERENCE = readFileSync(path.join(STYLES_DIR, "packs", DESIGNED, "render/index.html"), "utf8");

const GOOD = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../pack/fonts/fonts.css"><style>body{margin:0}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg><main id="s"></main><script src="scene.js"></script><script>
window.VENSTUDIO = {
  async init(p) { this.p = p; return { totalFrames: p.totalFrames, fps: p.fps, width: p.width, height: p.height }; },
  renderFrame(f) { document.getElementById("s").style.opacity = String(f / this.p.totalFrames); }
};
</script></body></html>`;
const SCENE_JS = "// draws the scenes\nconst ease = (t) => t * t;";
const files = (html: string, extra: PageFile[] = [{ path: "scene.js", text: SCENE_JS }]): PageFile[] => [{ path: "index.html", text: html }, ...extra];
const check = { vendored: VENDORED };
const issuesOf = (html: string, extra?: PageFile[]) => pageIssues(files(html, extra), check);
const one = (html: string, re: RegExp, why: string) => {
  const got = issuesOf(html);
  assert.ok(got.some((i) => re.test(i)), `${why}: ${JSON.stringify(got)}`);
};
const inject = (code: string) => GOOD.replace("this.p = p;", `this.p = p; ${code}`);

test("the pack's reference page and a clean page pass; the vendored files are the pack's render/ files without index.html", () => {
  assert.deepEqual(VENDORED, ["fonts/OFL-inter.txt", "fonts/OFL-intertight.txt", "fonts/fonts.css"]);
  assert.deepEqual(pageIssues([{ path: "index.html", text: REFERENCE }], check), []);
  assert.deepEqual(issuesOf(GOOD), [], "an SVG namespace is an identifier, not a request");
});

test("no external URL anywhere: http(s), ws, //host, @import of a host, <base>", () => {
  one(inject(`await fetch('https://evil.example/x');`), /names an external URL \(https:\/\/evil\.example\/x\)/, "fetch to a host");
  one(GOOD.replace("<style>", `<img src="http://198.51.100.7/a.png"><style>`), /names an external URL \(http:\/\/198\.51\.100\.7/, "an external img");
  one(GOOD.replace("<style>body{margin:0}", `<style>@import url("https://fonts.example/x.css");body{margin:0}`), /names an external URL/, "@import of a host");
  one(GOOD.replace("<style>body{margin:0}", `<style>@import "//fonts.example/x.css";body{margin:0}`), /names another host \(\/\/fonts\.example/, "protocol-relative @import");
  one(GOOD.replace(`href="../pack/fonts/fonts.css"`, `href="//cdn.example.com/a.css"`), /names another host/, "protocol-relative link");
  one(GOOD.replace("body{margin:0}", "body{background:url(//img.example.org/a.png)}"), /names another host/, "protocol-relative url()");
  one(inject(`const u = "wss://evil.example/live";`), /names an external URL \(wss:/, "a socket URL");
  one(GOOD.replace("<head>", `<head><base href="/">`), /uses a <base> element/, "<base>");
  // A namespace URI used as a source is a request, not an identifier.
  one(GOOD.replace("<style>", `<img src="http://www.w3.org/2000/svg"><style>`), /names an external URL \(http:\/\/www\.w3\.org\/2000\/svg/, "namespace as a src");
  // A line comment is not a URL.
  assert.deepEqual(issuesOf(inject("const x = 1; // slow ease-out")), []);
});

test("data: URLs only for images; fonts only from the pack's vendored files or the run's font", () => {
  assert.deepEqual(issuesOf(GOOD.replace("body{margin:0}", "body{background:url(data:image/png;base64,iVBORw0KGgo=)}")), []);
  one(GOOD.replace("body{margin:0}", "@font-face{font-family:X;src:url(data:font/woff2;base64,d09GMg==)}"), /inlines a font as a data: URL/, "an inlined font has no recorded licence");
  one(GOOD.replace("body{margin:0}", "@font-face{font-family:X;src:url(myfont.woff2)}"), /loads a font from myfont\.woff2\. Fonts come only from \.\.\/pack\//, "a font next to the page");
  assert.deepEqual(issuesOf(GOOD.replace("body{margin:0}", "@font-face{font-family:X;src:url(../in/font.ttf)}")), [], "the run's font");
  one(GOOD.replace(`<script src="scene.js">`, `<script src="data:text/javascript;base64,YWxlcnQoMSk=">`), /data: URL that is not an image/, "data: script");
  one(GOOD.replace("<style>", `<a href="data:text/html,<b>x</b>">x</a><style>`), /data: URL that is not an image/, "data: html");
});

test("every forbidden construct is refused, by name", () => {
  const cases: Array<[string, RegExp]> = [
    [`<iframe src="x.html"></iframe>`, /uses an <iframe>/],
    [`<object data="x.svg"></object>`, /uses an <object>/],
    [`<embed src="x.svg">`, /uses an <embed>/],
    [`<form action="/x"></form>`, /uses a <form action>/],
    [`<meta http-equiv="refresh" content="0;url=x">`, /uses a <meta http-equiv>/],
    // Any http-equiv: the worker's DOM check refuses them all, so the validator does too (Hermes is told at once).
    [`<meta http-equiv="Content-Type" content="text/html; charset=utf-8">`, /uses a <meta http-equiv>/],
  ];
  for (const [markup, re] of cases) one(GOOD.replace("<style>", `${markup}<style>`), re, markup);
  const code: Array<[string, RegExp]> = [
    [`navigator.serviceWorker.register("sw.js");`, /uses a service worker/],
    [`new Worker(URL.createObjectURL(new Blob(["x"])));`, /uses a Worker/],
    [`const b = "blob:abc";`, /uses a blob: URL/],
    [`new WebSocket("x");`, /uses WebSocket/],
    [`fetch("scene.json");`, /uses fetch\(/],
    [`new XMLHttpRequest();`, /uses XMLHttpRequest/],
    [`new EventSource("x");`, /uses EventSource/],
    [`navigator.sendBeacon("x");`, /uses navigator\.sendBeacon/],
    [`await import("./mod.js");`, /uses import\(\)/],
    [`eval("1+1");`, /uses eval\(/],
    [`new Function("return 1")();`, /uses new Function/],
    [`setTimeout("go()", 10);`, /uses a timer given code as text/],
    [`window.open("x");`, /uses window\.open/],
    [`location.href = "x";`, /uses a navigation \(location\)/],
    [`const s = atob("aHR0cA==");`, /built from encoded text/],
    [`gsap.to(".a", { x: 1 });`, /uses GSAP/],
  ];
  for (const [js, re] of code) one(inject(js), re, js);
  // In an extra file too.
  assert.ok(pageIssues(files(GOOD, [{ path: "scene.js", text: `${SCENE_JS}\nfetch("x");` }]), check).some((i) => /^scene\.js line 3 uses fetch\(/.test(i)));
});

test("the contract: window.VENSTUDIO with init and renderFrame", () => {
  one(GOOD.replace("window.VENSTUDIO =", "window.STUDIO ="), /must define window\.VENSTUDIO = \{ init\(props\), renderFrame\(frame\) \}/, "missing contract");
  one(GOOD.replace("renderFrame(f)", "draw(f)"), /needs renderFrame\(frame\)/, "missing renderFrame");
  one(GOOD.replace("async init(p)", "async start(p)"), /needs init\(props\)/, "missing init");
});

test("fonts and libraries: only the pack's vendored files (../pack/), the page's own files, ../in/; no local() fonts", () => {
  one(GOOD.replace("../pack/fonts/fonts.css", "../pack/vendor/gsap/gsap.min.js"), /loads \.\.\/pack\/vendor\/gsap\/gsap\.min\.js, which this pack does not vendor/, "a library the pack does not vendor");
  one(GOOD.replace("../pack/fonts/fonts.css", "../pack/../../job/page.json"), /does not vendor|climbs/, "climbing out of ../pack/");
  one(GOOD.replace(`src="scene.js"`, `src="missing.js"`), /loads missing\.js, which is not one of the page's files/, "a missing file");
  one(GOOD.replace(`src="scene.js"`, `src="/etc/passwd"`), /outside the page/, "an absolute path");
  one(GOOD.replace(`src="scene.js"`, `src="../page.json"`), /outside the page/, "the job folder");
  one(GOOD.replace("body{margin:0}", "@font-face{font-family:X;src:local('Arial')}"), /uses a local\(\) font/, "a system font");
  assert.deepEqual(issuesOf(GOOD.replace("body{margin:0}", "body{background:url(../in/plate.png)}")), [], "the run's media");
  // Built in code: not a path, so not checked here (the worker's sandbox covers it).
  assert.deepEqual(issuesOf(inject(`const face = new FontFace("Run", "url(" + p.font + ")");`)), []);
});

test("size and file limits, text only, plain file names", () => {
  one(GOOD + "<!--" + "x".repeat(PAGE_LIMITS.totalBytes) + "-->", /The page is 30\d KB; at most 300 KB are allowed/, "300 KB");
  const many = Array.from({ length: PAGE_LIMITS.files }, (_, i) => ({ path: `f${i}.js`, text: "1" }));
  assert.ok(pageIssues(files(GOOD, many), check).some((i) => /The page has 21 files; at most 20/.test(i)));
  assert.ok(pageIssues(files(GOOD, [{ path: "font.woff2", text: "x" }]), check).some((i) => /extra files are small \.js, \.css or \.svg files/.test(i)));
  assert.ok(pageIssues(files(GOOD, [{ path: "../x.js", text: "x" }]), check).some((i) => /plain relative names/.test(i)));
  assert.ok(pageIssues(files(GOOD, [{ path: "bin.js", text: "a\u0000b" }]), check).some((i) => /bin\.js is not plain text/.test(i)));
  assert.ok(pageIssues([{ path: "scene.js", text: "window.VENSTUDIO = { init() {}, renderFrame() {} }" }], check).some((i) => /needs an index\.html/.test(i)));
});

const SCENES = [
  { beat: "hook", seconds: 3, caption: "Why is the sky blue?" },
  { beat: "body", seconds: 4, caption: "Sunlight carries every colour." },
  { beat: "payoff", seconds: 4, caption: "Air scatters the blue the most." },
];
const reply = (extra: Record<string, unknown> = {}) => ({ html: GOOD, files: [{ path: "scene.js", text: SCENE_JS }], note: "Light and dark scenes in turn, one bar per idea.", scenes: SCENES, ...extra });

test("Hermes's reply: html, files, a short note and a scene list; the page issues are the validator's issues", () => {
  const ok = validateHtmlDesign(reply({ backend: "claude-sonnet", plugin: "html-designer" }), check);
  assert.ok(ok.ok);
  if (!ok.ok) return;
  assert.deepEqual(ok.value.files.map((f) => f.path), ["index.html", "scene.js"]);
  assert.deepEqual([ok.value.backend, ok.value.plugin], ["claude-sonnet", "html-designer"]);
  const bad = validateHtmlDesign(reply({ html: inject(`await fetch('https://evil.example');`) }), check);
  assert.ok(!bad.ok && bad.issues.some((i) => /https:\/\/evil\.example/.test(i)) && bad.issues.some((i) => /uses fetch\(/.test(i)), "the retry carries the exact issue");
  const shapes: Array<[Record<string, unknown>, RegExp]> = [
    [{ html: "" }, /html must be the whole index\.html/],
    [{ files: "x" }, /files must be a list/],
    [{ files: [{ path: "index.html", text: "x" }] }, /index\.html goes in html/],
    [{ files: [{ path: "a.js", text: "1" }, { path: "a.js", text: "2" }] }, /names a\.js twice/],
    [{ note: "" }, /note is empty/],
    [{ note: "x".repeat(PAGE_LIMITS.note + 1) }, /note is longer than 600/],
    [{ scenes: [] }, /scenes must hold 1 to/],
    [{ scenes: [{ beat: "intro", seconds: 3, caption: "x" }] }, /Scene 1 beat must be one of/],
    [{ scenes: [{ beat: "hook", seconds: 0, caption: "x" }] }, /Scene 1 seconds must be a number above 0/],
    [{ backend: "a b/c" }, /backend must be a short name/],
  ];
  for (const [extra, re] of shapes) {
    const r = validateHtmlDesign(reply(extra), check);
    assert.ok(!r.ok && r.issues.some((i) => re.test(i)), String(re));
  }
  assert.ok(!validateHtmlDesign("<html>", check).ok);
});

test("the stored design reads back; its shots, lines, bundle and gate", () => {
  const v = validateHtmlDesign(reply(), check);
  assert.ok(v.ok);
  if (!v.ok) return;
  const back = readHtmlDesign(JSON.parse(JSON.stringify(v.value)));
  assert.deepEqual(back, v.value);
  assert.equal(readHtmlDesign({ files: [{ path: "scene.js", text: "x" }], note: "n", scenes: SCENES }), null, "no index.html: nothing to read");
  const shots = htmlDesignShots(v.value);
  assert.deepEqual(shots.map((s) => [s.beatRole, s.seconds, s.imagePrompt]), [["hook", 3, ""], ["body", 4, ""], ["payoff", 4, ""]], "no picture is asked for");
  assert.match(htmlDesignLines(v.value)[0], /^File index\.html: \d+ KB$/);
  assert.equal(htmlDesignLines(v.value).at(-1), "3. payoff, 4 s: Air scatters the blue the most.");
  const bundle = JSON.parse(pageBundle(v.value)) as { format: number; kind: string; files: Record<string, string> };
  assert.deepEqual([bundle.format, bundle.kind, Object.keys(bundle.files)], [1, PAGE_BUNDLE_KIND, ["index.html", "scene.js"]]);
  assert.equal(pageBundle(v.value), pageBundle(JSON.parse(JSON.stringify(v.value))), "the same design gives the same bytes");
  const template = seedTemplates().find((t) => t.id === "tpl-explainer-flat-vector");
  assert.ok(template);
  if (!template) return;
  const full = validateHtmlDesign(reply({ scenes: ["hook", "setup", "body", "payoff", "cta"].map((beat) => ({ beat, seconds: 3, caption: `${beat} line` })) }), check);
  assert.ok(full.ok);
  if (full.ok) assert.deepEqual(htmlDesignGate(template, full.value, 15).issues, []);
  assert.deepEqual(htmlDesignGate(template, v.value, 11).issues, ["No scene covers the setup beat", "No scene covers the cta beat"], "the storyboard's beat rules, in scenes");
  const long = validateHtmlDesign(reply({ scenes: [{ beat: "hook", seconds: 30, caption: "x" }] }), check);
  assert.ok(long.ok);
  if (long.ok) assert.ok(htmlDesignGate(template, long.value, 30).issues.some((i) => /scene/.test(i) && !/\bshot\b/.test(i)), "pacing issues speak of scenes");
  // The Review card: the files and scenes, the note, and what the card is.
  const card = planReview("html-design", v.value).plan;
  assert.equal(card?.kind, "html-design");
  assert.equal(card?.note, HTML_DESIGN_NOTE);
  assert.equal(card?.text, v.value.note);
  assert.equal(parsePlanPayload(card)?.kind, "html-design");
});

test("the prompt carries the rules, the pack's design brief, its vendored files and the frame; it names the stage", () => {
  const brief: DesignBrief = {
    name: designedPack.name,
    ...designedPack.design!,
    elements: designedPack.plan?.elements ?? [],
    motionTokens: designedPack.plan?.motionTokens ?? [],
    vendored: VENDORED,
    width: 1080,
    height: 1920,
    fps: 30,
    safeAreaPct: 8,
    drawsCaptions: false,
  };
  const ctx = { niche: "science", plan: "", language: "en", format: "short", durationSec: 45, purposes: [], subtitles: [] } as unknown as DirectorContext;
  const [, user] = htmlDesignPrompt(ctx, "Why is the sky blue? Sunlight carries every colour.", brief, "Make it calmer");
  assert.match(user.content, /^VENSTUDIO_STAGE: html-design$/m);
  for (const re of [/1080x1920, 30 fps/, /window\.VENSTUDIO = \{ async init\(props\)/, /no http:\/\/ or https:\/\/, no \/\/host/, /data: URLs only for images \(never for fonts\)/, /fetch, XMLHttpRequest/, /eval, new Function/, /\.\.\/pack\/fonts\/fonts\.css/, /no GSAP/, /keep the bottom 30% clear/, /#F4EFE6/, /Inter Tight/, /"scenes":\[\{"beat":string/, /owner revision note/]) {
    assert.match(user.content, re);
  }
});

test("research only: an html-design run is always a trial, never published, never auto-approved; its pack never above Trial", () => {
  assert.ok(isDesignedPack(designedPack));
  const run = runStylePack(designedPack);
  assert.deepEqual([run.trial, run.designed], [true, true]);
  // Whatever a stored config claims.
  assert.equal(parseRunStylePack({ id: DESIGNED, version: "0.1.0", status: "listed", trial: false, designed: true })?.trial, true);
  const flow = workflowForPack(designedPack);
  assert.ok(flow.ok);
  const cfg = parseRunConfig({ format: "short", stylePack: { id: DESIGNED, version: "0.1.0", status: "listed", trial: false }, workflow: flow.ok ? flow.workflow : null });
  assert.deepEqual([cfg.stylePack?.trial, cfg.stylePack?.designed], [true, true], "the html-design workflow alone makes the run a trial");
  assert.equal(publishRefusal(run), `${HTML_DESIGN_BADGE}: a video drawn from a page Hermes wrote is never published.`);
  assert.match(publishRefusal({ id: DESIGNED, version: "0.1.0", status: "listed", trial: false }, null, "html-design") ?? "", /never published/, "by recipe too");
  for (const action of ["auto-approve", "auto-publish"]) {
    const d = guardFinalDecision({ action, reason: "policy" }, { id: DESIGNED, version: "0.1.0", status: "listed", trial: false }, null, "html-design");
    assert.equal(d.action, "ask-owner", action);
  }
  // The page and the still frames are the owner's at every autonomy level, whatever a stored list says.
  assert.deepEqual([...OWNER_ONLY_STAGES], ["html-design", "preview"]);
  for (const stage of OWNER_ONLY_STAGES) assert.ok(alwaysReviewed({ workflow: { recipe: "html-design", stages: ["idea", "research", "script", "html-design", "preview", "voice", "render", "qc"], review: [] } }, stage), stage);
  // A pack that claims more than Trial, or another engine, is left out.
  for (const status of ["proven", "listed"]) assert.equal(parsePack({ ...rawStyle(DESIGNED), status }, "x"), null, status);
  assert.equal(parsePack({ ...rawStyle(DESIGNED), renderer: { engine: "remotion-2d", minWorkerVersion: "0.11.0", composition: "x" } }, "x"), null);
  // New Video: never in the main list, even if a pack said listed; only in the Trial section, with its badge.
  const listedClaim = { ...designedPack, status: "listed" as const };
  const offer = newVideoStyles(mergeRegistry(STYLES, [listedClaim]), [`pack:${DESIGNED}@${designedPack.version}`, "html-capture"]);
  assert.deepEqual([offer.listed.map((e) => e.id), offer.trial.map((e) => e.id)], [[], [DESIGNED]]);
  assert.equal(HTML_DESIGN_BADGE, "Hermes-designed page (research only)");
});

test("preview: the stills' times, the worker states and the fallback, the payload and the result", () => {
  // The middle of each scene; spread over more scenes; filled up over fewer.
  assert.deepEqual(previewTimes([0, 3, 7], 11, 3), [1.5, 5, 9]);
  assert.deepEqual(previewTimes([0, 2, 4, 6, 8, 10, 12, 14], 16, 6).length, 6);
  const few = previewTimes([0, 5], 10, 6);
  assert.equal(few.length, 6);
  assert.ok(few.every((t, i) => t >= 0 && t < 10 && (i === 0 || t - few[i - 1] >= 0.25)));
  assert.deepEqual(previewTimes([0], 0), []);
  assert.deepEqual(sceneStartsOf({ shots: [{ seconds: 3 }, { seconds: 4 }, { seconds: 4 }] as never, transitionSec: 0 }), [0, 3, 7]);
  assert.deepEqual(sceneStartsOf({ shots: [{ seconds: 3 }, { seconds: 4 }] as never, transitionSec: 0.5 }), [0, 2.5]);
  // Which workers can take them (stored rows only).
  const cap = `pack:animated-line-graph@0.1.2`;
  assert.equal(previewWorkers([["ffmpeg", "html-capture", cap]], cap), "no-worker", "a 0.10.0 worker reports no preview-frames");
  assert.equal(previewWorkers(null, cap), "no-worker");
  assert.equal(previewWorkers([["preview-frames", "html-capture"]], cap), "waiting-pack");
  assert.equal(previewWorkers([["preview-frames", "html-capture"], ["preview-frames", cap]], cap), "ready");
  assert.match(NO_PREVIEW_CONTINUE, /continue with the spec text only/);
  assert.match(HTML_DESIGN_NEEDS_PREVIEW, /never rendered without its still-frame check/);
  // The payload: the render payload without the narration, with the times and the page.
  const plate = "11111111-1111-4111-8111-111111111111";
  const page = "22222222-2222-4222-8222-222222222222";
  const render = buildRenderPayload({
    format: "short",
    shots: [{ shotRef: "shot-01", seconds: 3 }, { shotRef: "shot-02", seconds: 4 }],
    shotAssets: { "shot-01": plate, "shot-02": plate },
    narrationAssetId: PREVIEW_NARRATION_PLACEHOLDER,
    narrationSec: 7,
    captions: ["One.", "Two."],
    targetLufs: -14,
    maxShotSeconds: 5,
    engine: "html-capture",
    fontAssetId: null,
    runId: "33333333-3333-4333-8333-333333333333",
  });
  assert.ok(render.ok);
  if (!render.ok) return;
  const p = previewPayload(render.payload, [1.5, 5], page);
  assert.equal(p.narrationAssetId, undefined);
  assert.equal(p.narrationSec, undefined);
  assert.deepEqual(p.inputs, [plate, page]);
  assert.deepEqual(p.preview, { times: [1.5, 5], page });
  assert.equal(p.runId, "33333333-3333-4333-8333-333333333333");
  assert.deepEqual((previewPayload(render.payload, [1], null).preview as Record<string, unknown>).page, undefined, "scene-spec: the pack's own page");
  // The worker's answer, read back.
  const r = parsePreviewResult({ stills: [{ name: "still-01.jpg", atSec: 1.5 }, { name: "../x", atSec: 1 }], consoleErrors: ["x"], blocked: [], page: "uploaded", drawsCaptions: false });
  assert.deepEqual(r.stills, [{ name: "still-01.jpg", atSec: 1.5 }]);
  assert.match(previewNote({ stills: 6, drawsCaptions: false, designed: true }), /^6 still frames of the page Hermes wrote \(research only\).*Captions are burned in at the render.*back to the page\.$/);
});

test("preview routing: an owner-only production stage; a failed job becomes a card; the summary says what it shows", () => {
  assert.deepEqual(productionStageAction({ stage: "preview", idleMinutes: 1, jobStatus: "failed", jobError: "page threw" }), { action: "complete" });
  assert.deepEqual(productionStageAction({ stage: "preview", idleMinutes: 1, jobStatus: "succeeded", jobError: null }), { action: "complete" });
  assert.deepEqual(productionStageAction({ stage: "preview", idleMinutes: 1, jobStatus: "running", jobError: null }), { action: "none" });
  assert.match(productionSummary("preview", { stills: [1, 2, 3, 4, 5, 6], page: "uploaded" }), /^6 still frames of the page Hermes designed \(research only\)/);
  assert.match(productionSummary("preview", { stills: [], skipped: "no-worker" }), /^No still frames: no worker reports preview-frames yet/);
});

test("wording: runs without pictures keep the plan, not the pictures", () => {
  assert.equal(keptWord(false), "the plan");
  assert.equal(tightenLabel(false), "Tighten the script, keep the plan");
  assert.equal(tightenLabel(true, true), "Lengthen the script, keep the pictures");
  assert.equal(decisionLabel("tighten", "gate-failure", "voice", { pictures: false }), "Tighten the script, keep the plan");
  assert.equal(decisionLabel("tighten", "gate-failure", "voice", {}), "Tighten the script, keep the pictures", "an image-sequence run as before");
  assert.match(decisionHint("tighten", "gate-failure", "voice", { pictures: false }) ?? "", /The plan is kept\.$/);
  assert.ok(!/pictures|image/.test(decisionHint("revise", "gate-failure", "voice", { pictures: false }) ?? ""));
  assert.ok(!/images/.test(decisionHint("reject", "gate-failure", "voice", { pictures: false }) ?? ""));
  assert.match(decisionHint("revise", "approval", "preview") ?? "", /goes back to the step these stills show/);
});

test("the portal's page limits and bundle kind are the worker's (0.11.0), and the worker reads the bundle the portal writes", async () => {
  const worker = (await import(new URL("../../../worker/venstudio-worker.ts", import.meta.url).href)) as {
    HTML_PAGE_LIMITS: { files: number; totalBytes: number };
    PAGE_BUNDLE_KIND: string;
    parsePageBundle: (raw: unknown) => Array<{ path: string; text: string }>;
  };
  assert.deepEqual([worker.HTML_PAGE_LIMITS.files, worker.HTML_PAGE_LIMITS.totalBytes], [PAGE_LIMITS.files, PAGE_LIMITS.totalBytes]);
  assert.equal(worker.PAGE_BUNDLE_KIND, PAGE_BUNDLE_KIND);
  const v = validateHtmlDesign(reply(), check);
  assert.ok(v.ok);
  if (v.ok) assert.deepEqual(worker.parsePageBundle(JSON.parse(pageBundle(v.value))).map((f) => f.path), ["index.html", "scene.js"]);
});

test("a scene-spec card promises stills only when the run has a preview stage (runs started before previews keep their note)", async () => {
  const { SCENE_SPEC_NO_PREVIEW_NOTE, SCENE_SPEC_PREVIEW_NOTE } = await import("./plan-review.ts");
  const spec = { scenes: [{ seconds: 3, beat: "hook", elements: [{ kind: "heading", text: "Solar" }], tokens: [], caption: "Solar grew." }] };
  assert.equal(planReview("scene-spec", spec, ["idea", "research", "script", "scene-spec", "preview", "voice", "render", "qc"]).plan?.note, SCENE_SPEC_PREVIEW_NOTE);
  assert.equal(planReview("scene-spec", spec, ["idea", "research", "script", "scene-spec", "voice", "render", "qc"]).plan?.note, SCENE_SPEC_NO_PREVIEW_NOTE);
});
