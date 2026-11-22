/**
 * The html-design workflow's page (recipe html-design, recipes.ts), pure: the Hermes prompt, the validator of its JSON,
 * the gate, the shots the render plans from, the Review lines and the page bundle the worker gets. Research only (owner
 * decision): this is the one place in the studio where model-written code runs, so the page is checked here before
 * anything runs and the worker (0.11.0) runs it sandboxed all the same (docs/html-capture.md, "Pages Hermes writes").
 *
 * Hermes answers through the gate with JSON: one self-contained index.html (inline CSS and JS), optional small JS, CSS
 * or SVG files, a short design note, and a scene list mapping the script's beats to times. validateHtmlDesign checks the
 * shape and pageIssues the code (best effort, by token scan): size and file limits, text only, no URL to another host
 * anywhere, data: only for images and fonts, none of the constructs that open a frame, a worker, a socket or a request,
 * or turn text into code, the window.VENSTUDIO contract, fonts only from the pack's vendored files or the run's font,
 * libraries only from the pack (no GSAP). The issues go back to Hermes through hermesJson's retry, then the owner's
 * revision loop. Nothing here executes the page.
 */
import {
  MAX_NOTE_CHARS,
  MAX_SCRIPT_CHARS,
  MAX_SHOTS,
  MAX_SHOT_SECONDS,
  channelLines,
  dataBlock,
  paceOf,
  runLines,
  system,
  templateLines,
  type ChatMessage,
  type DirectorContext,
  type Shot,
  type Validated,
} from "./director.ts";
import { storyboardGate, type GateResult } from "./qc.ts";
import type { BeatRole, Template } from "./templates.ts";

export const HTML_DESIGN_STAGE = "html-design";
/** What the owner reads on New Video, the run page and Review next to a run of an html-design pack. */
export const HTML_DESIGN_BADGE = "Hermes-designed page (research only)";
/** The page's limits, the same as the worker's HTML_PAGE_LIMITS (a test checks). */
export const PAGE_LIMITS = { totalBytes: 300 * 1024, files: 20, note: 600, caption: 200 } as const;
/** The kind of the page bundle stored as the run's html-page asset (the worker reads the same, parsePageBundle). */
export const PAGE_BUNDLE_KIND = "venstudio-html-page";
export const PAGE_EXECUTOR = "hermes-html-design";
export const PAGE_LICENCE =
  "Written by Hermes for this run from the pack's design brief (research only, never published). Fonts and libraries only from the pack's vendored files (their licences are in the pack) or the run's font.";

const BEATS: readonly BeatRole[] = ["hook", "setup", "body", "payoff", "cta", "outro"];
/** Extra files a page may have: small scripts, style sheets and SVG. index.html is the only page. */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}(\/[A-Za-z0-9][A-Za-z0-9_-]{0,60}){0,2}\.(js|css|svg)$/;
/** XML namespace names are identifiers, never fetched: the only http: text a page may hold (outside any URL attribute). */
const NAMESPACES = ["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink", "http://www.w3.org/1999/xhtml", "http://www.w3.org/XML/1998/namespace"];
/**
 * data: URLs a page may embed: pictures only. A font comes from the pack's vendored files (../pack/) or the run's font
 * (props.font, ../in/), never inlined by the page, so every font a page uses has a recorded licence.
 */
const DATA_OK = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i;
const DATA_FONT = /^data:(font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/i;

export interface PageFile {
  path: string;
  text: string;
}

export interface DesignScene {
  beat: BeatRole;
  seconds: number;
  /** The part of the narration spoken during the scene, in script order. */
  caption: string;
}

export interface HtmlDesign {
  /** index.html first, then the extra files in the order Hermes gave them. */
  files: PageFile[];
  /** A short note on the design, for Review. */
  note: string;
  scenes: DesignScene[];
  /** What Hermes says it wrote the page with (its backend and plugin), for the provenance. Optional in the reply. */
  backend?: string;
  plugin?: string;
}

/** What the page is designed from: the pack's design brief and contract, and the frame. */
export interface DesignBrief {
  name: string;
  brief: string;
  palette: readonly string[];
  typography: string;
  layout: string;
  elements: readonly string[];
  motionTokens: readonly string[];
  /** The pack's vendored render files a page may load as ../pack/<path> (index.html, the reference page, excluded). */
  vendored: readonly string[];
  width: number;
  height: number;
  fps: number;
  safeAreaPct: number;
  /** The worker burns the captions (drawsCaptions false), so the page keeps the caption area clear. */
  drawsCaptions: boolean;
}

export interface PageCheck {
  /** The pack's vendored files (../pack/<path>). */
  vendored: readonly string[];
  /** Reading a stored design back: its ../pack/ paths were checked against the pack when Hermes wrote it. */
  anyVendored?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Line number of an index in a text (1-based), for issues Hermes can act on. */
function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/**
 * Constructs a page may not hold, by token scan (best effort: the worker refuses them again at run time). Each is a
 * way to reach the network, open another document, start other code, or turn text into code.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /<\s*iframe\b/i, what: "an <iframe>" },
  { re: /<\s*frame(set)?\b/i, what: "a <frame>" },
  { re: /<\s*object\b/i, what: "an <object>" },
  { re: /<\s*embed\b/i, what: "an <embed>" },
  { re: /<\s*portal\b/i, what: "a <portal>" },
  { re: /<\s*base\b/i, what: "a <base> element" },
  { re: /<\s*form\b[^>]*\baction\s*=/i, what: "a <form action>" },
  { re: /\bformaction\s*=/i, what: "a formaction attribute" },
  { re: /<\s*meta\b[^>]*http-equiv/i, what: "a <meta http-equiv> (refresh, CSP or any other; the worker sets the headers)" },
  { re: /\bserviceWorker\b/, what: "a service worker" },
  { re: /\b(?:Shared)?Worker\s*\(/, what: "a Worker" },
  { re: /\bimportScripts\s*\(/, what: "importScripts()" },
  { re: /\.addModule\s*\(/, what: "a worklet (addModule)" },
  { re: /\bURL\s*\.\s*createObjectURL\b|\bblob:/i, what: "a blob: URL" },
  { re: /\bWebSocket\b/, what: "WebSocket" },
  { re: /\bWebTransport\b/, what: "WebTransport" },
  { re: /\bRTCPeerConnection\b/, what: "RTCPeerConnection" },
  { re: /\bfetch\s*\(/, what: "fetch(" },
  { re: /\bXMLHttpRequest\b/, what: "XMLHttpRequest" },
  { re: /\bEventSource\b/, what: "EventSource" },
  { re: /\bsendBeacon\b/, what: "navigator.sendBeacon" },
  { re: /\bimport\s*\(/, what: "import()" },
  { re: /\beval\s*\(/, what: "eval(" },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/, what: "new Function" },
  { re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/, what: "a timer given code as text" },
  { re: /\bwindow\s*\.\s*open\s*\(|\bopen\s*\(\s*["'`]/, what: "window.open" },
  { re: /\blocation\s*(?:\.\s*(?:href|assign|replace)\s*)?(?:=(?!=)|\()/, what: "a navigation (location)" },
  { re: /\bdocument\s*\.\s*domain\b/, what: "document.domain" },
  { re: /\batob\s*\(|\bfromCharCode\s*\(/, what: "code or URLs built from encoded text (atob, fromCharCode)" },
  { re: /\bjavascript\s*:/i, what: "a javascript: URL" },
  { re: /\blocal\s*\(\s*["']?/i, what: "a local() font (fonts come only from ../pack/ or the run's font)" },
  { re: /\bgsap\b|\bTweenMax\b|\bTimelineMax\b/i, what: "GSAP (its licence is not approved; use plain JavaScript)" },
];

/** References a file makes: src/href attributes, CSS url() and @import, JS module imports. */
function refsOf(text: string): Array<{ ref: string; at: number }> {
  const out: Array<{ ref: string; at: number }> = [];
  const res = [
    /\b(?:src|href|xlink:href|poster|data|srcset)\s*=\s*["']([^"']*)["']/gi,
    /\burl\(\s*["']?([^"')]*)["']?\s*\)/gi,
    /@import\s+(?:url\()?\s*["']([^"']+)["']/gi,
    /\bfrom\s+["']([^"']+)["']/g,
  ];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // A reference built in code ("url(" + props.font + ")") is not a path: the worker's sandbox covers it at run time.
      if (/[+$`{}]/.test(m[1])) continue;
      // Only a srcset lists several URLs; a data: URL has its own comma.
      const parts = /^\s*data:/i.test(m[1]) ? [m[1]] : m[1].split(",");
      for (const part of parts) out.push({ ref: part.trim().split(/\s+/)[0] ?? "", at: m.index });
    }
  }
  return out;
}

/** Folds "a/./b" and "a/x/../b"; null when the path climbs out of its start. */
function normalize(p: string): string | null {
  const parts: string[] = [];
  for (const s of p.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(s);
  }
  return parts.join("/");
}

/**
 * The problems of a page's files, in plain words Hermes can act on, or []. Best effort by token scan; the worker runs the
 * page sandboxed whatever this says (CSP, request blocking, the page guard).
 */
export function pageIssues(files: readonly PageFile[], check: PageCheck): string[] {
  const issues: string[] = [];
  const names = new Set(files.map((f) => f.path));
  const vendored = new Set(check.vendored);
  if (!names.has("index.html")) issues.push("The page needs an index.html");
  if (files.length > PAGE_LIMITS.files) issues.push(`The page has ${files.length} files; at most ${PAGE_LIMITS.files} are allowed`);
  const total = files.reduce((n, f) => n + bytes(f.text), 0);
  if (total > PAGE_LIMITS.totalBytes) issues.push(`The page is ${Math.ceil(total / 1024)} KB; at most ${PAGE_LIMITS.totalBytes / 1024} KB are allowed (inline only what the page needs)`);
  for (const f of files) {
    if (f.path !== "index.html" && !FILE_RE.test(f.path)) issues.push(`${short(f.path)}: extra files are small .js, .css or .svg files with plain relative names`);
    // Text only: no NUL or other control characters (tabs and line breaks are fine).
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(f.text)) issues.push(`${f.path} is not plain text`);
    const t = f.text;
    // URLs to another host, anywhere: http(s), ws(s), ftp, file, and protocol-relative //host.
    for (const m of t.matchAll(/\b(?:https?|wss?|ftp|file):\/\/[^\s"'`)<>]*/gi)) {
      const url = m[0];
      const before = t.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
      const asUrl = /(?:src|href|action|data|poster)\s*=\s*["']?\s*$|url\(\s*["']?\s*$|@import\s+(?:url\()?\s*["']?\s*$/i.test(before);
      if (!asUrl && NAMESPACES.includes(url.replace(/["'`]$/, ""))) continue;
      issues.push(`${f.path} line ${lineOf(t, m.index ?? 0)} names an external URL (${short(url)}). Pages render offline: draw from props and the page's own files, ../pack/ and ../in/ only.`);
    }
    for (const m of t.matchAll(/["'`(=]\s*(\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s"'`)]*)/g)) {
      issues.push(`${f.path} line ${lineOf(t, m.index ?? 0)} names another host (${short(m[1])}). Pages render offline: use relative paths to the page's own files, ../pack/ and ../in/ only.`);
    }
    for (const m of t.matchAll(/\bdata:[^\s"'`)]{0,80}/gi)) {
      if (DATA_FONT.test(m[0])) issues.push(`${f.path} line ${lineOf(t, m.index ?? 0)} inlines a font as a data: URL (${short(m[0])}). Fonts come only from ../pack/ (the pack's vendored fonts) or the run's font (props.font).`);
      else if (!DATA_OK.test(m[0])) issues.push(`${f.path} line ${lineOf(t, m.index ?? 0)} has a data: URL that is not an image (${short(m[0])}). data: is only for images; fonts come from ../pack/ or the run's font.`);
    }
    // @font-face sources: only the pack's vendored fonts (../pack/) or the run's inputs (../in/).
    for (const block of t.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
      for (const u of block[0].matchAll(/url\(\s*["']?([^"')]*)/gi)) {
        const src = u[1].trim();
        if (!src.startsWith("../pack/") && !src.startsWith("../in/") && !/^data:/i.test(src) && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) {
          issues.push(`${f.path} line ${lineOf(t, block.index ?? 0)} loads a font from ${short(src)}. Fonts come only from ../pack/ (the pack's vendored fonts) or the run's font (props.font).`);
        }
      }
    }
    for (const { re, what } of FORBIDDEN) {
      const m = re.exec(t);
      if (m) issues.push(`${f.path} line ${lineOf(t, m.index)} uses ${what}, which pages Hermes writes may not use. Draw everything from props and the frame number.`);
    }
    for (const { ref, at } of refsOf(t)) {
      if (!ref || ref.startsWith("#") || /^data:/i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue; // schemes and hosts are reported above
      const clean = ref.split(/[?#]/)[0];
      if (clean.startsWith("../pack/")) {
        const p = normalize(clean.slice("../pack/".length));
        if (!p || (!check.anyVendored && !vendored.has(p))) issues.push(`${f.path} line ${lineOf(t, at)} loads ../pack/${short(p ?? clean)}, which this pack does not vendor (it has: ${[...vendored].slice(0, 8).join(", ") || "nothing"}).`);
        else if (/(^|\/)vendor\/[^/]*gsap/i.test(p)) issues.push(`${f.path} line ${lineOf(t, at)} loads GSAP; its licence is not approved. Use plain JavaScript.`);
        continue;
      }
      if (clean.startsWith("../in/")) {
        if (!normalize(clean.slice("../in/".length))) issues.push(`${f.path} line ${lineOf(t, at)} climbs out of ../in/`);
        continue;
      }
      if (clean.startsWith("/") || clean.startsWith("../")) {
        issues.push(`${f.path} line ${lineOf(t, at)} loads ${short(clean)}, outside the page. A page may load its own files, ../pack/<vendored file> and ../in/<input> only.`);
        continue;
      }
      const p = normalize(clean);
      if (!p || !names.has(p)) issues.push(`${f.path} line ${lineOf(t, at)} loads ${short(clean)}, which is not one of the page's files.`);
    }
  }
  const all = files.map((f) => f.text).join("\n");
  if (!/\b(?:window|globalThis|self)\s*\.\s*VENSTUDIO\s*=/.test(all)) issues.push("The page must define window.VENSTUDIO = { init(props), renderFrame(frame) }");
  else {
    if (!/\binit\s*\(|\binit\s*:/.test(all)) issues.push("window.VENSTUDIO needs init(props), which answers { totalFrames, fps, width, height }");
    if (!/\brenderFrame\b/.test(all)) issues.push("window.VENSTUDIO needs renderFrame(frame), which draws frame `frame` from the frame number");
  }
  // One issue per problem kind and place is enough for a retry; keep the list short.
  return [...new Set(issues)].slice(0, 24);
}

function text(v: unknown, label: string, max: number, issues: string[]): string {
  if (typeof v !== "string") {
    issues.push(`${label} must be text`);
    return "";
  }
  const s = v.trim();
  if (!s) issues.push(`${label} is empty`);
  else if (s.length > max) issues.push(`${label} is longer than ${max} characters`);
  return s;
}

/**
 * Validates Hermes's JSON: { html, files?, note, scenes }. The page itself is checked by pageIssues; pacing and
 * coverage are the gate's (htmlDesignGate). `readBack` reads a stored design (the pack's vendored list is not at hand,
 * so ../pack/ references are not checked against it).
 */
export function validateHtmlDesign(value: unknown, check: PageCheck & { readBack?: boolean }): Validated<HtmlDesign> {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['Expected an object: {"html": string, "files"?: [{"path", "text"}], "note": string, "scenes": [...]}'] };
  const files: PageFile[] = [];
  if (typeof value.html !== "string" || !value.html.trim()) issues.push("html must be the whole index.html as text");
  else files.push({ path: "index.html", text: value.html });
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) issues.push("files must be a list of {path, text}");
    else
      value.files.forEach((f, i) => {
        if (!isRecord(f) || typeof f.path !== "string" || typeof f.text !== "string") return issues.push(`files[${i + 1}] must be {"path": string, "text": string}`);
        if (f.path === "index.html") return issues.push("index.html goes in html, not in files");
        if (files.some((x) => x.path === f.path)) return issues.push(`files names ${f.path} twice`);
        files.push({ path: f.path, text: f.text });
      });
  }
  const note = text(value.note, "note", PAGE_LIMITS.note, issues);
  const scenes: DesignScene[] = [];
  const raw = Array.isArray(value.scenes) ? value.scenes : [];
  if (raw.length < 1 || raw.length > MAX_SHOTS) issues.push(`scenes must hold 1 to ${MAX_SHOTS} items`);
  raw.slice(0, MAX_SHOTS).forEach((r, i) => {
    const n = i + 1;
    if (!isRecord(r)) return issues.push(`Scene ${n} must be an object`);
    const beat = BEATS.find((b) => b === r.beat);
    if (!beat) issues.push(`Scene ${n} beat must be one of ${BEATS.join(", ")}`);
    let seconds = 0;
    if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || r.seconds <= 0 || r.seconds > MAX_SHOT_SECONDS) issues.push(`Scene ${n} seconds must be a number above 0 and at most ${MAX_SHOT_SECONDS}`);
    else seconds = r.seconds;
    const caption = text(r.caption, `Scene ${n} caption`, PAGE_LIMITS.caption, issues);
    scenes.push({ beat: beat ?? "body", seconds, caption });
  });
  const who: { backend?: string; plugin?: string } = {};
  for (const k of ["backend", "plugin"] as const) {
    const v = value[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._:@+-]{0,79}$/.test(v)) issues.push(`${k} must be a short name (letters, digits, . _ : @ + -)`);
    else who[k] = v;
  }
  if (files.length > 0) issues.push(...pageIssues(files, check.readBack ? { vendored: [], anyVendored: true } : check));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { files, note, scenes, ...who } };
}

/** A stored design (a passed stage's result), read back for the preview, the render and the voice check, or null. */
export function readHtmlDesign(raw: unknown): HtmlDesign | null {
  if (!isRecord(raw) || !Array.isArray(raw.files)) return null;
  const files = raw.files.filter((f): f is PageFile => isRecord(f) && typeof f.path === "string" && typeof f.text === "string");
  const index = files.find((f) => f.path === "index.html");
  if (!index) return null;
  const r = validateHtmlDesign({ html: index.text, files: files.filter((f) => f.path !== "index.html"), note: raw.note, scenes: raw.scenes, backend: raw.backend, plugin: raw.plugin }, { vendored: [], readBack: true });
  return r.ok ? r.value : null;
}

/** The gate: the scene list's pacing and narration coverage, with the storyboard's shared limits. */
export function htmlDesignGate(template: Template, design: HtmlDesign, narrationSec?: number): GateResult {
  const pacing = storyboardGate(template, design.scenes.map((s) => ({ beatRole: s.beat, seconds: s.seconds })), narrationSec);
  const issues = pacing.issues.map((i) => i.replace(/\bshot\(s\)/g, "scene(s)").replace(/\bshot\b/g, "scene").replace(/\bstoryboard\b/g, "scene list"));
  return { gate: "G-storyboard", passed: issues.length === 0, issues, executor: "hermes" };
}

/** The scene list as storyboard shots (no picture is made; the page draws everything), for the plan and the render. */
export function htmlDesignShots(design: HtmlDesign): Shot[] {
  return design.scenes.map((s) => ({ beatRole: s.beat, seconds: s.seconds, description: s.caption, imagePrompt: "", onScreen: { elements: [{ kind: "plate" }] } }));
}

/** Lines for the Review card: the note, each file with its size, and each scene. */
export function htmlDesignLines(design: HtmlDesign): string[] {
  return [
    ...design.files.map((f) => `File ${f.path}: ${Math.max(1, Math.round(bytes(f.text) / 1024))} KB`),
    ...design.scenes.map((s, i) => `${i + 1}. ${s.beat}, ${s.seconds} s: ${s.caption}`),
  ];
}

/** The page bundle stored as the run's html-page asset and handed to the worker. The same design gives the same bytes. */
export function pageBundle(design: HtmlDesign): string {
  const files: Record<string, string> = {};
  for (const f of [...design.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) files[f.path] = f.text;
  return JSON.stringify({ format: 1, kind: PAGE_BUNDLE_KIND, files });
}

/** The props the worker hands init(props), in words, for the prompt (docs/html-capture.md). */
const PROPS_TEXT =
  "init(props) gets: width, height, fps, durationSec, totalFrames, transitionSec, shots ({shotRef, seconds, image}), timeline ({startFrames, frames, totalFrames, fadeFrames}: where each of your scenes starts and how many frames it lasts, in the order of your scene list), scenes (the same order), captions (empty: the worker burns them), font (a relative URL of the run's font, or null). It must resolve to {totalFrames, fps, width, height} exactly as given. renderFrame(frame) draws frame `frame` (0-based) and may return a promise.";

/** The prompt: the approved script, the design brief and the rules the page is checked against. */
export function htmlDesignPrompt(ctx: DirectorContext, script: string, brief: DesignBrief, retryHint?: string): ChatMessage[] {
  const maxShot = ctx.template ? ctx.template.pacing.maxShotSeconds : 6;
  const narrationSec = Math.round((script.split(/\s+/).filter(Boolean).length / paceOf(ctx)) * 60);
  const minScenes = Math.ceil((narrationSec * 1.15) / maxShot);
  const vendored = brief.vendored.length > 0 ? brief.vendored.map((v) => `../pack/${v}`).join(", ") : "none";
  return [
    system(`Design and write the HTML page for this video, in the ${brief.name} style. Research only.`),
    {
      role: "user",
      content: [
        "VENSTUDIO_STAGE: html-design",
        `Write one self-contained web page that the VenStudio worker captures frame by frame in headless Chromium at ${brief.width}x${brief.height}, ${brief.fps} fps. No picture is generated for it: the page draws everything with HTML, CSS, SVG or canvas.`,
        `The page defines window.VENSTUDIO = { async init(props) { ... }, renderFrame(frame) { ... } }. ${PROPS_TEXT}`,
        "Everything on screen must be a pure function of the frame number. Time is virtual: Date, performance.now, timers and requestAnimationFrame follow the frame, so draw in renderFrame from the frame number rather than with running animations.",
        "Rules the page is checked against before anything runs: html is the whole index.html with inline CSS and JS. files is optional: at most a few small .js, .css or .svg files next to it. At most 300 KB and 20 files together, text only.",
        "No URL to another host anywhere: no http:// or https://, no //host, no @import of a host, no <base>. data: URLs only for images (never for fonts). Do not use <iframe>, <object>, <embed>, <form action>, <meta http-equiv>, service workers, Worker, WebSocket, fetch, XMLHttpRequest, EventSource, navigator.sendBeacon, import(), eval, new Function, window.open or location.",
        `Fonts only from the pack's vendored files or the run's font (props.font, load it with new FontFace). Files this pack vendors, loadable by relative path: ${vendored}. No other library: no GSAP; write plain JavaScript.`,
        brief.drawsCaptions
          ? "The page draws the captions it is given in props.captions."
          : `The worker burns the captions at the bottom of the frame: keep the bottom ${Math.max(30, brief.safeAreaPct * 3)}% clear of anything that matters, and ${brief.safeAreaPct}% margins on the sides.`,
        `Design brief: ${brief.brief}`,
        `Palette: ${brief.palette.join(", ")}. Typography: ${brief.typography}`,
        `Layout: ${brief.layout}`,
        `On-screen elements this style uses: ${brief.elements.join(", ")}. Motion: ${brief.motionTokens.join(", ") || "none"}.`,
        `scenes is the scene list your page follows, in order: per scene its beat (${BEATS.join(", ")}), seconds and caption (the part of the narration spoken during it, at most ${PAGE_LIMITS.caption} characters, in script order). The narration runs about ${narrationSec} seconds, so use at least ${minScenes} scenes; no scene longer than ${maxShot} seconds. The worker hands the page the same scenes in props.timeline.`,
        `note is a short design note for the owner (at most ${PAGE_LIMITS.note} characters): the idea of the look and how it moves.`,
        "Show only what the script says. A number on screen must be one the script states.",
        ...channelLines(ctx),
        ...templateLines(ctx),
        'backend and plugin (optional) name what you wrote the page with, for the provenance record.',
        'Schema: {"html":string,"files"?:[{"path":string,"text":string}],"note":string,"scenes":[{"beat":string,"seconds":number,"caption":string}],"backend"?:string,"plugin"?:string}',
        dataBlock("script", script, MAX_SCRIPT_CHARS),
        ...runLines(ctx, "storyboard"),
        retryHint ? dataBlock("owner revision note", retryHint, MAX_NOTE_CHARS) : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    },
  ];
}
