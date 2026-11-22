// Browser end-to-end: drives the real UI the way a user would, then runs the real worker.
// Saves desktop and mobile screenshots to .e2e-ui/screenshots.
//
// Needs: portal running at APP_URL against an EMPTY database, SETUP_TOKEN set on it, ffmpeg, Playwright Chromium.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { totp } from "../apps/portal/lib/crypto/totp.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL ?? "http://localhost:3200";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "ui-setup-token";
const OUT = path.join(ROOT, ".e2e-ui");
const SHOTS = path.join(OUT, "screenshots");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const EMAIL = "owner@venstudio.test";
const PASSWORD = "correct horse battery staple";

// Fake Hermes API server (same shapes as the real /v1/capabilities and /v1/skills).
const { createServer } = await import("node:http");
const HERMES_KEY = process.env.HERMES_API_KEY ?? "test-hermes-key";
const HERMES_PORT = Number(process.env.FAKE_HERMES_PORT ?? 3299);
const ROUTER_PORT = Number(process.env.FAKE_ROUTER_PORT ?? 3297);

// Generators for fake media. No dependencies: PNG through node:zlib, WAV as raw PCM16.
import { deflateSync } from "node:zlib";
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** A valid RGB PNG with a diagonal gradient. 540x960 passes the portal minimum size check. */
export function makePng(width = 540, height = 960, seed = 0) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = (40 + seed * 50 + (x * 120) / width) & 255;
      raw[at + 1] = (60 + (y * 140) / height) & 255;
      raw[at + 2] = (150 + seed * 20 + ((x + y) * 50) / (width + height)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A mono 16-bit PCM WAV with a quiet sine wave (peak 0.3, so it never clips). */
export function makeWav(seconds, sampleRate = 24000, hz = 220) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.3 * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
// Fake director replies. Every prompt starts with a `VENSTUDIO_STAGE: <stage>` line; retries append more messages, so the
// marker is read from the first user message. A topic hint containing BREAK-JSON makes the idea stage answer with text
// that is not JSON, to prove the failure path. The script and storyboard are sized from numbers in the prompt itself,
// so they satisfy the script and storyboard gates for whichever template is used.
function directorReply(messages) {
  const first = textOf(messages.find((m) => m.role === "user")?.content);
  const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
  if (stage === "selftest") return '{"ok":true,"sum":5}';
  // Renderer hermes (research only): Hermes renders the whole video and publishes it under /clip/ on its media host.
  if (stage === "hermes-render") {
    fakeStats.hermesRenders++;
    return JSON.stringify({ status: "ok", video: { type: "url", value: `http://127.0.0.1:${HERMES_PORT}/clip/render-${fakeStats.hermesRenders}.mp4`, mimeType: "video/mp4" }, provider: "capcut", source: "capcut", model: "fake-capcut-render" });
  }
  // The presentation advisory: a vision rating of the stills the quality check sampled (attached as image parts).
  if (stage === "presentation-advisory") {
    fakeStats.advisoryAsks++;
    const user = messages.find((m) => m.role === "user")?.content;
    fakeStats.advisoryImages = Math.max(fakeStats.advisoryImages, Array.isArray(user) ? user.filter((part) => part?.type === "image_url").length : 0);
    return JSON.stringify({ rubric: { hook: 3, pacing: 4, legibility: 4, polish: 3, audio: 3 }, notes: "Fake advisory: readable captions, plain pictures." });
  }
  if (stage === "classify") return JSON.stringify({ stage: "idea", reason: "The owner wants different ideas" });
  if (stage === "idea") {
    if (first.includes("BREAK-JSON")) return "Sorry, I cannot put that into JSON right now.";
    const note = /<<<DATA owner revision note\n([\s\S]*?)\nDATA owner revision note>>>/.exec(first)?.[1] ?? "";
    const tag = note ? " (revised)" : "";
    return JSON.stringify({
      ideas: ["Orpheus and the silent road", "Why the Norns weave", "The wolf that swallowed the sun", "A bridge made of rainbow", "Persephone's last bargain"].map((t, i) => ({
        title: `${t}${tag}`,
        hook: `What if ${t.toLowerCase()} was never a myth?`,
        angle: "Retell it as a short mystery",
        score: 90 - i * 5,
      })),
    });
  }
  if (stage === "research") {
    return JSON.stringify({
      notes: [1, 2, 3].map((n) => ({ claim: `Marker claim number ${n} about old tales`, sourceUrl: "", sourced: false, summary: `Plain background fact ${n} for the writer` })),
    });
  }
  if (stage === "script") {
    const target = Number(/about (\d+) words/.exec(first)?.[1] ?? 112);
    const opening = "Here is a strange true tale.";
    const filler = "Long ago a traveller crossed the hills and listened closely to every voice along the winding road before the night fell.";
    const words = [];
    while (words.length < target) words.push(...filler.split(" "));
    const body = words.slice(0, Math.max(0, target - opening.split(" ").length)).join(" ");
    return JSON.stringify({ hooks: ["Here is a strange true tale.", "Nobody tells this part.", "You were told the wrong ending."], chosenHook: 0, script: `${opening} ${body}.` });
  }
  if (stage === "script-fit") {
    // Fit the script to the pictures: as many words as the prompt asks for, so the fitted script passes its check.
    fakeStats.scriptFitAsks++;
    const target = Number(/to about (\d+) words/.exec(first)?.[1] ?? 60);
    const filler = "A traveller crossed the hills and listened to every voice along the road before the night fell.".split(" ");
    const words = [];
    while (words.length < target) words.push(...filler);
    return JSON.stringify({ script: `Here is a strange true tale. ${words.slice(0, Math.max(1, target - 6)).join(" ")}.` });
  }
  if (stage === "storyboard") {
    const roles = [...(/Beats in order: (.*)/.exec(first)?.[1] ?? "hook (x), body (x)").matchAll(/(\w+) \(/g)].map((m) => m[1]);
    const maxShot = Number(/Maximum shot length: ([\d.]+) seconds/.exec(first)?.[1] ?? 3);
    const hookMs = Number(/within (\d+) ms/.exec(first)?.[1] ?? 3000);
    // The storyboard gate needs enough shots to cover the narration; the prompt states the least number.
    const minShots = Number(/use at least (\d+) shots/.exec(first)?.[1] ?? 0);
    const count = Math.max(roles.length, minShots);
    return JSON.stringify({
      shots: Array.from({ length: count }, (_, i) => roles[Math.floor((i * roles.length) / count)]).map((role, i) => ({
        beatRole: role,
        seconds: Math.min(maxShot, 3, i === 0 ? hookMs / 1000 : 3),
        description: `A calm scene for the ${role} beat`,
        imagePrompt: `Flat illustration of an old stone road at dusk, ${role} moment`,
        // Per-shot backend preference: agnes is in the fake capability scan, midjourney is not and must be dropped.
        ...(i === 0 ? { provider: "agnes", needs: "text-layout" } : i === 1 ? { provider: "midjourney" } : {}),
      })),
    });
  }

  // Phase 4 stages. Image variants are chosen by the shot number named in the prompt (`for shot shot-NN`):
  //   shot-01 first answers with a file path (the portal must feed that back and Hermes then sends base64),
  //   shot-02 answers with an error for its first three asks (one whole attempt), so the second attempt runs,
  //   shot-03 answers with a download link on this fake server, every other shot with base64.
  // Hermes answers like the live 9router plugin: `provider` is the plugin (9router), `source` the backend that made the
  // file. Most shots come from canva (listed in CI's HERMES_IMAGE_PROVIDER_ORDER, so stored as "canva"); shot-03 comes
  // from cloudflare-9router, which is not listed and is stored as "unlisted-cloudflare-9router". Neither is confirmed
  // yet, so the provider-terms flow runs. Nothing may be stored under the plugin name (unlisted-9router).
  if (stage === "providers") {
    return JSON.stringify({ providers: ["cloudflare", "agnes", "canva", "qwen", "minimax", "sensenova"].map((name) => ({ name, note: "fake" })) });
  }
  if (stage === "image") {
    const shot = /for shot ([\w-]+)/.exec(first)?.[1] ?? "test";
    const seed = Number(/(\d+)$/.exec(shot)?.[1] ?? 0);
    const asks = (fakeStats.imageAsks[shot] = (fakeStats.imageAsks[shot] ?? 0) + 1);
    if (/For this shot use agnes first/.test(first)) fakeStats.shotPreferenceAsks++;
    if (/For this shot use midjourney/.test(first)) fakeStats.droppedPreferenceAsks++;
    const ok = (image, source = "canva") => JSON.stringify({ status: "ok", provider: "9router", source, model: "fake-flux", image });
    if (shot === "shot-01" && messages.length <= 2) {
      fakeStats.pathAnswers++;
      return ok({ type: "path", value: "/tmp/hermes/out.png", mimeType: "image/png" });
    }
    if (shot === "shot-02" && asks <= 3) {
      fakeStats.errorAnswers++;
      return JSON.stringify({ status: "error", provider: "9router", error: "Fake provider chain is down" });
    }
    if (shot === "shot-04") {
      // Hermes never makes this one, so the studio falls through to the 9router image model.
      fakeStats.hermesImageRefusals++;
      return JSON.stringify({ status: "error", provider: "9router", error: "Fake Hermes has no image for this shot" });
    }
    if (shot === "shot-03") {
      fakeStats.urlAnswers++;
      return ok({ type: "url", value: `http://127.0.0.1:${HERMES_PORT}/fake-image/${seed}.png`, mimeType: "image/png" }, "cloudflare-9router");
    }
    return ok({ type: "base64", value: makePng(540, 960, seed).toString("base64"), mimeType: "image/png" });
  }
  if (stage === "capabilities") {
    fakeStats.capabilityScans++;
    return JSON.stringify({
      skills: [
        { name: "clip-animator", description: "Turns a still picture into a short moving clip", category: "video", stages: ["video-clips"] },
        { name: "voice-bridge", description: "Speaks text with a chosen voice engine", category: "audio", stages: ["voice"] },
        { name: "pic-forge", description: "Makes pictures from a prompt", category: "image", stages: ["image"] },
      ],
      imageProviders: ["cloudflare", "agnes"],
      voiceEngines: ["kokoro", "capcut"],
      notes: "fake capability report",
    });
  }
  if (stage === "tts-kokoro") {
    fakeStats.hermesKokoroCalls++;
    return JSON.stringify({ status: "ok", provider: "kokoro", source: "kokoro", model: "fake-hermes-kokoro", audio: { type: "base64", value: makeWav(3).toString("base64"), mimeType: "audio/wav" } });
  }
  if (stage === "tts-capcut") {
    return JSON.stringify({ status: "ok", provider: "capcut", source: "capcut", model: "fake-capcut", audio: { type: "base64", value: makeWav(3).toString("base64"), mimeType: "audio/wav" } });
  }
  if (stage === "cc0") {
    return JSON.stringify({
      url: "https://upload.wikimedia.org/wikipedia/commons/fake-cc0.png",
      title: "Fake CC0 road",
      licence: "CC0 1.0 Public Domain Dedication",
      licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
  }
  return "{}";
}
// The newest first user message per stage marker (idea, research, script, storyboard ...), so the UI test can check
// what the New video form carried into the director prompts.
const lastPrompt = {};
/** Text of a chat message's content: a string, or the text parts of OpenAI-style content parts (vision turns). */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

// The clip the fake Hermes "renders": a real H.264/AAC MP4, made once with ffmpeg, served under /clip/ like the media host.
const FAKE_CLIP = path.join(OUT, "fake-hermes-clip.mp4");
let fakeClip = null;
function fakeClipBytes() {
  if (fakeClip) return fakeClip;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=16", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=16", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", FAKE_CLIP], { timeout: 120_000 });
  fakeClip = readFileSync(FAKE_CLIP);
  return fakeClip;
}

const fakeStats = { hermesRenders: 0, clipDownloads: 0, advisoryAsks: 0, advisoryImages: 0, scriptFitAsks: 0, imageAsks: {}, pathAnswers: 0, errorAnswers: 0, urlAnswers: 0, routerSpeechCalls: 0, routerImageCalls: 0, routerBadImageCalls: 0, hermesImageRefusals: 0, hermesKokoroCalls: 0, capabilityScans: 0, hermes429: 0, shotPreferenceAsks: 0, droppedPreferenceAsks: 0 };
// The first image asks get HTTP 429 with a short Retry-After, like a busy Hermes. The shots must wait and then finish,
// not fail, and the wait must not use up their attempts.
const HERMES_429_BURST = 3;
const HERMES_RETRY_AFTER_SEC = 2;
// The fake 9router lists this image model first and refuses every request for it with the Cloudflare 400 the owner saw.
const ROUTER_BAD_IMAGE_MODEL = "cf/@cf/fake-flux-2";
function cloudflarePromptRequired() {
  const inner = JSON.stringify({ errors: [{ message: "AiError: AiError: prompt is required (fdbccbd5-0000-4000-8000-000000000000)", code: 3030 }], success: false });
  return { error: { message: `[400]: ${inner}` } };
}
const fakeHermes = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // The fake image link is public, like a real image host. It answers before the key check.
  const link = /^\/fake-image\/(\d+)\.png$/.exec(req.url ?? "");
  if (link) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(makePng(540, 960, Number(link[1])));
  }
  // The media host's /clip/ folder, public like the image link.
  if (/^\/clip\/render-\d+\.mp4$/.test(req.url ?? "")) {
    fakeStats.clipDownloads++;
    const body = fakeClipBytes();
    res.writeHead(200, { "content-type": "video/mp4", "content-length": String(body.length) });
    return res.end(body);
  }
  if (req.headers.authorization !== `Bearer ${HERMES_KEY}`) return json(401, { error: { code: "gateway_auth_failed" } });
  if (req.url === "/v1/capabilities") {
    return json(200, {
      object: "hermes.api_server.capabilities",
      platform: "hermes-agent",
      features: { chat_completions: true, run_submission: true, run_events_sse: true, run_stop: true },
    });
  }
  if (req.url === "/v1/skills") {
    return json(200, [
      { name: "write-story-script", description: "Writes a short story script", category: "video" },
      { name: "consistent-character-image", description: "Image workflow with a fixed character", category: "image" },
      { name: "deep-research", description: "Researches a topic with sources", category: "research" },
    ]);
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let messages = [];
      try {
        messages = JSON.parse(raw).messages ?? [];
      } catch {
        return json(400, { error: "bad json" });
      }
      const first = textOf(messages.find((m) => m.role === "user")?.content);
      const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
      if (stage) lastPrompt[stage] = first;
      if (stage === "image" && fakeStats.hermes429 < HERMES_429_BURST) {
        fakeStats.hermes429++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(HERMES_RETRY_AFTER_SEC) });
        return res.end(JSON.stringify({ error: { message: "Rate limit reached for the image provider", type: "rate_limit" } }));
      }
      const content = directorReply(messages);
      json(200, { id: "chatcmpl-fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    });
    return;
  }
  json(404, { error: "not found" });
});
await new Promise((r) => fakeHermes.listen(HERMES_PORT, "127.0.0.1", r));

// Fake 9router. In "hang" mode it accepts connections and never answers, like an unroutable address, so the pages-stay-fast
// check is meaningful. In "ok" mode it lists models and speaks 0.46 s per word: about 130 words a minute, like the owner's
// Kokoro voice, so every narration is about 15 percent longer than the portal's 150 words-a-minute estimate. That must
// be a note on the voice card, not a failure. routerTts "error" makes only the speech endpoint fail, to prove the fallback to Hermes.
const router = { mode: "hang", tts: "ok" };
const FAKE_SECONDS_PER_WORD = 0.46;
const routerSockets = new Set();
const ROUTER_KEY = process.env.NINEROUTER_API_KEY ?? "";
const fakeRouter = createServer((req, res) => {
  if (router.mode === "hang") return; // never answer
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (ROUTER_KEY && req.headers.authorization !== `Bearer ${ROUTER_KEY}`) return json(401, { error: "bad key" });
  const list = (data) => json(200, { object: "list", data });
  const url = (req.url ?? "").split("?")[0];
  if (req.method === "GET") {
    if (url === "/api/health") return json(200, { ok: true });
    if (url === "/v1/models") return list([{ id: "fake/chat-small", owned_by: "fake" }, { id: "fake/chat-large", owned_by: "fake" }]);
    if (url === "/v1/models/image") return list([{ id: ROUTER_BAD_IMAGE_MODEL, owned_by: "cf" }, { id: "fake-img/flux-lite", owned_by: "fake-img" }]);
    if (url === "/v1/models/tts") {
      return list([
        { id: "kokoro/af_heart", owned_by: "kokoro" },
        { id: "kokoro/af_bella", owned_by: "kokoro" },
        { id: "edge-tts/en-US-AriaNeural", owned_by: "edge-tts" },
      ]);
    }
    if (url === "/v1/models/web") return list([{ id: "fake-search/web", owned_by: "fake-search", kind: "webSearch" }]);
    if (url === "/v1/models/stt") return list([{ id: "fake-stt/small", owned_by: "fake-stt" }]);
    res.writeHead(404);
    return res.end("not found");
  }
  if (req.method === "POST" && (url === "/v1/audio/speech" || url === "/v1/images/generations")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "bad json" });
      }
      if (url === "/v1/images/generations") {
        if (body.model === ROUTER_BAD_IMAGE_MODEL) {
          fakeStats.routerBadImageCalls++;
          return json(400, cloudflarePromptRequired());
        }
        fakeStats.routerImageCalls++;
        return json(200, { created: 1, data: [{ b64_json: makePng(540, 960, 7).toString("base64") }] });
      }
      if (router.tts === "error") return json(500, { error: "fake speech failure" });
      fakeStats.routerSpeechCalls++;
      const words = String(body.input ?? "").split(/\s+/).filter(Boolean).length;
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(makeWav(Math.max(0.5, words * FAKE_SECONDS_PER_WORD)));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
fakeRouter.on("connection", (sock) => {
  routerSockets.add(sock);
  sock.on("close", () => routerSockets.delete(sock));
});
await new Promise((r) => fakeRouter.listen(ROUTER_PORT, "127.0.0.1", r));

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await desktop.newPage();
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

async function shot(name, p = page) {
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
function step(msg) {
  console.log(`== ${msg}`);
}
/**
 * One value from the UI database (psql -tA), or null when the script has no database access. Throws when the query
 * fails, so an assertion that needs the database does not pass by accident.
 */
function dbValue(sql) {
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return execFileSync("psql", [dbUrl, "-X", "-tA", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** Runs a statement quietly (no command tag), stopping on the first error; returns its rows like dbValue, or null without a database. */
function dbExec(sql) {
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return execFileSync("psql", [dbUrl, "-X", "-qtA", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function runWorker(args) {
  return execFileSync("bash", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Prints what the production pipeline looks like when a wait gives up: the run, its stages, jobs, work orders, review
 * items, QC reports, the workers and the worker log tail. Uses psql when UI_DB or DATABASE_URL is set, and always
 * prints the run page text as a fallback. Never throws.
 */
async function dumpPipeline(p, runHref, why) {
  console.error(`\n---- pipeline diagnostics: ${why} ----`);
  const runId = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(runHref ?? "")?.[1] ?? null;
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  const psql = (title, sql) => {
    try {
      const out = execFileSync("psql", [dbUrl, "-X", "-A", "-F", " | ", "-P", "footer=off", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
      console.error(`## ${title}\n${out.trim() || "(no rows)"}`);
    } catch (err) {
      console.error(`## ${title}: query failed: ${String(err.stderr || err.message).slice(0, 300)}`);
    }
  };
  if (dbUrl && runId) {
    psql("run", `SELECT id, state, autonomy_level, topic, kind FROM pipeline_runs WHERE id = '${runId}'`);
    psql("stages", `SELECT stage, state, attempt, left(coalesce(error, ''), 300) AS error, left((output - 'result')::text, 400) AS output FROM pipeline_stages WHERE run_id = '${runId}' ORDER BY coalesce(started_at, finished_at, now()), attempt`);
    psql("jobs of this run, and the latest render and qc jobs", `SELECT type, status, attempts || '/' || max_attempts AS tries, priority, capability, worker_id, preferred_worker_id, run_after <= now() AS runnable, progress, left(coalesce(message, ''), 120) AS message, left(coalesce(error, ''), 400) AS error FROM jobs WHERE payload->>'runId' = '${runId}' OR type IN ('render-video', 'qc-video') ORDER BY created_at DESC LIMIT 10`);
    psql("job events of the latest render and qc jobs", `SELECT j.type, e.level, left(e.message, 200) AS message FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.payload->>'runId' = '${runId}' AND j.type IN ('render-video', 'qc-video') ORDER BY e.id DESC LIMIT 20`);
    psql("work orders", `SELECT shot_ref, executor, state, attempts, job_id, asset_id IS NOT NULL AS has_asset, to_jsonb(w)->>'not_before' AS not_before, left(coalesce(to_jsonb(w)->>'wait_reason', ''), 120) AS wait_reason, left(coalesce(to_jsonb(w)->>'error', ''), 200) AS error FROM work_orders w WHERE run_id = '${runId}' ORDER BY shot_ref`);
    psql("speech rates (newest)", `SELECT voice_key, language, words, round(seconds::numeric, 2) AS seconds, round(wpm::numeric, 1) AS wpm, source, run_id = '${runId}' AS this_run FROM voice_speech_rates ORDER BY created_at DESC LIMIT 8`);
    psql("hermes gate", `SELECT * FROM hermes_gate`);
    psql("endpoint health", `SELECT endpoint, model, kind, last_success_at IS NOT NULL AS worked, failure_class, quarantined_at IS NOT NULL AS set_aside, successes, failures, left(last_error, 160) AS last_error FROM endpoint_health ORDER BY updated_at DESC LIMIT 20`);
    psql("review items", `SELECT stage, kind, state, left(payload::text, 300) AS payload FROM review_items WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("qc reports", `SELECT gate, passed, score, executor, left(details::text, 300) AS details FROM qc_reports WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("workers", `SELECT name, status, mode, capabilities, job_types, last_claim_at FROM workers`);
  } else {
    console.error("## no database access (UI_DB and DATABASE_URL unset or no run id); the run page below is the only source");
  }
  console.error(`## fake counters\n${JSON.stringify(fakeStats)}`);
  try {
    await p.goto(`${APP}${runHref}`);
    console.error(`## run page text\n${((await p.locator("body").innerText()) || "").slice(0, 3000)}`);
  } catch (err) {
    console.error(`## run page text: unavailable (${String(err.message).slice(0, 200)})`);
  }
  try {
    const log = readFileSync(path.join(OUT, "worker", "logs", "worker.log"), "utf8").trimEnd().split("\n");
    console.error(`## worker log tail\n${log.slice(-60).join("\n")}`);
  } catch (err) {
    console.error(`## worker log: unavailable (${err.message})`);
  }
  console.error("---- end of pipeline diagnostics ----\n");
}

try {
  step("first-time setup");
  await page.goto(`${APP}/`);
  await page.waitForURL(/\/setup$/);
  await shot("01-setup-desktop");
  await page.fill("#token", "wrong-token");
  await page.fill("#name", "Ven Owner");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.getByText("Setup token is incorrect.").waitFor();
  await page.fill("#token", SETUP_TOKEN);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/settings\?welcome=1/);

  step("turn on two-factor");
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent()).trim();
  await page.fill("#totp-code", totp(secret));
  await page.getByRole("button", { name: "Confirm and turn on" }).click();
  await page.getByText("Two-factor is on.").first().waitFor();
  await shot("02-settings-desktop");

  step("sign out, sign in with password + code");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/login$/);
  await page.fill("#email", EMAIL);
  await page.fill("#password", "wrong password here");
  await page.click("button[type=submit]");
  await page.getByText("Email or password is incorrect.").waitFor();
  await shot("03-login-desktop");
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/login\/verify$/);
  // Wait for a fresh 30 s window so the code differs from the one used at setup (replay protection).
  const nowStep = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((nowStep + 1) * 30_000 - Date.now() + 500);
  await page.fill("#code", totp(secret));
  await page.click("button[type=submit]");
  await page.waitForURL(`${APP}/`);

  step("create a channel");
  await page.goto(`${APP}/channels/new`);
  await page.fill("#name", "Myth Stories");
  await page.fill("#handle", "@mythstories");
  await page.fill("#niche", "Greek and Norse myths, retold");
  await page.fill("#plan", "Retell one myth per video as a short mystery. Two videos a week. No gore.");
  await page.selectOption("#format", "animated-story");
  await page.fill("#googleAccount", "studio.one@example.com");
  await page.selectOption("#status", "active");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);
  await page.goto(`${APP}/channels`);
  await page.getByText("Myth Stories").waitFor();
  await shot("04-channels-desktop");

  step("enroll a worker from the Workers page");
  await page.goto(`${APP}/workers`);
  await page.fill("#label", "CI Worker");
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.getByRole("button", { name: "Create enrollment code" }).click();
  await page.getByText("Code created.").waitFor();
  await shot("05-enroll-desktop");
  const message = (await page.locator("pre").nth(0).textContent()).trim();
  if (!/sha256sum install\.sh/.test(message) || !/run\.sh hold/.test(message)) throw new Error(`setup message incomplete: ${message}`);
  const servedSha = (await import("node:crypto")).createHash("sha256")
    .update(await (await fetch(`${APP}/install/install.sh`)).text()).digest("hex");
  if (!message.includes(servedSha)) throw new Error("setup message sha256 doesn't match the served install.sh");
  const command = (await page.locator("pre").nth(1).textContent()).trim();
  const code = /--code (VS-[A-Z0-9-]+)/.exec(command)?.[1];
  if (!code) throw new Error(`no code in command: ${command}`);
  runWorker([
    "-c",
    // --with-remotion: the production below uses explainer-flat-vector, a remotion-2d style, and an engine no worker
    // can run fails at planning. This also installs Remotion the way a Muse VM does, from the portal.
    `cd ${OUT} && curl -fsSL ${APP}/install/install.sh -o install.sh && bash install.sh --portal ${APP} --code ${code} --name "CI Worker" --mode tick --home ${OUT}/worker --with-remotion`,
  ]);
  await page.goto(`${APP}/workers`);
  await page.getByText("CI Worker").first().waitFor();

  step("worker updates: the owner switches the update mode on the Workers page");
  const updatesCard = page.getByTestId("worker-updates");
  const modeNow = updatesCard.getByTestId("update-mode-current");
  await modeNow.filter({ hasText: "Now: Automatic" }).waitFor();
  await page.locator("#update-mode-approve").check();
  await page.getByRole("button", { name: "Save update mode" }).click();
  await modeNow.filter({ hasText: "Now: Approve each update" }).waitFor();
  await shot("05b-worker-updates-desktop");
  await page.locator("#update-mode-auto").check();
  await page.getByRole("button", { name: "Save update mode" }).click();
  await modeNow.filter({ hasText: "Now: Automatic" }).waitFor();

  step("queue an echo job and a smoke test from the Jobs page");
  for (const [type, label] of [
    ["echo", "Echo (connectivity test)"],
    ["smoke-test", "Render smoke test"],
  ]) {
    await page.goto(`${APP}/jobs`);
    await page.selectOption("#type", type);
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.getByRole("button", { name: "Queue job" }).click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: label }).waitFor();
  }
  runWorker([`${OUT}/worker/run.sh`, "tick"]);

  step("results show in the UI");
  await page.goto(`${APP}/jobs?status=succeeded`);
  const done = page.getByRole("link").filter({ hasText: "Render smoke test" });
  await done.first().click();
  await page.getByText("Done").first().waitFor();
  await page.locator("video").waitFor();
  const result = await page.locator("pre").first().textContent();
  if (!/"realtimeFactor"/.test(result) || !/"seconds": 5/.test(result)) throw new Error(`unexpected result: ${result}`);
  await shot("06-job-desktop");

  step("video supports range requests (needed for streaming and iPhone playback)");
  const videoSrc = await page.locator("video").getAttribute("src");
  const ranged = await page.request.get(`${APP}${videoSrc}`, { headers: { range: "bytes=0-99" } });
  if (ranged.status() !== 206) throw new Error(`range request returned ${ranged.status()}, expected 206`);
  if ((await ranged.body()).length !== 100) throw new Error("range request returned the wrong number of bytes");
  if (!/^bytes 0-99\/\d+$/.test(ranged.headers()["content-range"] ?? "")) throw new Error("bad content-range header");

  step("pages stay fast while 9router is unreachable");
  for (const url of ["/", "/settings", "/jobs", "/workers"]) {
    const t0 = Date.now();
    await page.goto(`${APP}${url}`, { waitUntil: "commit" });
    const ms = Date.now() - t0;
    console.log(`   ${url} first byte in ${ms} ms`);
    if (ms > 2500) throw new Error(`${url} took ${ms} ms to start rendering`);
  }
  await page.goto(`${APP}/settings`);
  // The fake 9router hangs. The page stops waiting after about 3 s (so "load" fires) and shows "Checking"; the card then
  // refreshes itself, and the check ends through its 60 s timeout, so "Unreachable" can take about a minute.
  await page.getByText("Unreachable").waitFor({ timeout: 90_000 });
  await page.getByText("internal address").first().waitFor();
  await page.getByText("Server health").waitFor();

  step("9router comes back: check again, then scan the studio capabilities");
  router.mode = "ok";
  await page.goto(`${APP}/settings`);
  await page.getByRole("button", { name: "Check again" }).last().click();
  await page.getByText(/^\d+ models$/).waitFor({ timeout: 30_000 });
  const capCard = page.locator("ul.gap-3 > li");
  const stageItem = (p, label) => p.locator("ul.gap-3 > li").filter({ has: p.getByRole("heading", { name: label, exact: true }) });
  // A scan that the page started in the background while 9router hung may still be running. Press Scan now until the
  // new answer is shown (each press waits for the running scan, then the next one sees the working 9router).
  let scanned = false;
  for (let i = 0; i < 4 && !scanned; i++) {
    await page.goto(`${APP}/settings`);
    await page.getByRole("button", { name: "Scan now" }).click();
    scanned = await stageItem(page, "Voice")
      .getByText("kokoro/af_heart")
      .first()
      .waitFor({ timeout: 90_000 })
      .then(() => true, () => false);
  }
  if (!scanned) throw new Error("the capabilities scan never listed the 9router voice");
  if ((await capCard.count()) < 5) throw new Error("the capabilities card shows too few stages");
  if (!(await stageItem(page, "Voice").innerText()).includes("via 9router")) throw new Error("the voice stage does not show a 9router executor");
  if (!(await stageItem(page, "Images").innerText()).includes("via Hermes")) throw new Error("the image stage does not show a Hermes executor");
  const videoText = await stageItem(page, "Video clips").innerText();
  if (!videoText.includes("Found, not used yet")) throw new Error(`video clips should be found but not used yet, saw: ${videoText.replace(/\s+/g, " ")}`);
  if (fakeStats.capabilityScans < 1) throw new Error("the fake Hermes never answered the capabilities stage");
  // The page reads only the stored scan: starting to render must stay fast with the snapshot present.
  for (const url of ["/settings", "/"]) {
    const t0 = Date.now();
    await page.goto(`${APP}${url}`, { waitUntil: "commit" });
    const ms = Date.now() - t0;
    console.log(`   ${url} first byte in ${ms} ms after the scan`);
    if (ms > 2500) throw new Error(`${url} took ${ms} ms to start rendering after the capabilities scan`);
  }
  await page.goto(`${APP}/settings`);
  await shot("06c-settings-capabilities-desktop");

  step("settings: the capability card says the 9router models are listed, not proven");
  const imagesCard = await stageItem(page, "Images").innerText();
  if (!/listed, not proven yet/i.test(imagesCard)) throw new Error(`the image stage should show 9router models as listed, not proven: ${imagesCard.replace(/\s+/g, " ")}`);

  step("settings: Test 9router image sets the refusing model aside and proves the working one");
  await page.goto(`${APP}/settings`);
  await page.getByText("none is proven by a real call yet").first().waitFor();
  await page.getByRole("button", { name: "Test 9router image" }).click();
  // The raw 9router JSON is shortened to the provider's own message.
  await page.getByText("Cloudflare: prompt is required (code 3030)").first().waitFor({ timeout: 60_000 });
  await page.getByText("fake-img/flux-lite: worked").first().waitFor({ timeout: 60_000 });
  if (fakeStats.routerBadImageCalls !== 1) throw new Error(`the refusing 9router model was asked ${fakeStats.routerBadImageCalls} times, expected 1`);
  await page.goto(`${APP}/settings`);
  const routerHealth = page.getByTestId("router-image-health");
  await routerHealth.locator('[data-proof="quarantined"]', { hasText: ROUTER_BAD_IMAGE_MODEL }).waitFor();
  await routerHealth.locator('[data-proof="proven"]', { hasText: "fake-img/flux-lite" }).waitFor();
  const imagesProven = await stageItem(page, "Images").innerText();
  if (!imagesProven.includes("set aside after a request error") || !imagesProven.includes("proven by a real call")) {
    throw new Error(`the image stage should show one model set aside and one proven: ${imagesProven.replace(/\s+/g, " ")}`);
  }
  const routerImageCallsBeforeRun = fakeStats.routerImageCalls;

  step("Hermes connection shows features and skills");
  await page.getByText("3 skills").first().waitFor({ timeout: 20_000 });
  await page.getByText("Background runs").waitFor();
  await page.locator("summary", { hasText: "video" }).click();
  await page.getByText("write-story-script", { exact: true }).waitFor();
  await shot("06b-settings-gateway-down");
  await page.goto(`${APP}/`);
  await shot("07-overview-desktop");

  step("studio: the Studio page leads with New video; the old planner is gone");
  await page.goto(`${APP}/studio`);
  const studioNav = page.getByRole("navigation", { name: "Studio" });
  await studioNav.getByRole("link", { name: "New video", exact: true }).waitFor();
  for (const name of ["Runs", "Styles", "Templates", "Test render"]) await studioNav.getByRole("link", { name, exact: true }).waitFor();
  if ((await page.getByText("New production", { exact: true }).count()) !== 0) throw new Error("/studio still offers New production");
  if ((await page.getByText(/Planning only/).count()) !== 0) throw new Error("/studio still says Planning only");
  // Old links keep working: the run list moved to /studio.
  await page.goto(`${APP}/studio/runs`);
  await page.waitForURL(`${APP}/studio`);
  await shot("13-studio-desktop");

  step("studio: queue a test render from Test render, let the worker run it, see the video");
  await page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "Test render", exact: true }).click();
  await page.waitForURL(/\/studio\/test-render$/);
  await page.selectOption("#test-style", "documentary-stills");
  await page.selectOption("#test-format", "short");
  await page.getByRole("button", { name: "Queue test render", exact: true }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  runWorker([`${OUT}/worker/run.sh`, "tick"]);
  await page.goto(page.url());
  await page.getByText("Test render (placeholder cards)").first().waitFor();
  await page.getByText("Done").first().waitFor({ timeout: 30_000 });
  await page.locator("video").first().waitFor();
  await shot("13b-test-render-desktop");
  await page.goto(`${APP}/studio/test-render`);
  await page.getByTestId("saved-production").filter({ hasText: "Test render: Narrated documentary with stills" }).first().waitFor();

  step("assets: upload a reference video with its licence");
  const refPath = path.join(OUT, "reference.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:d=3:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=7",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", refPath,
  ]);
  await page.goto(`${APP}/assets`);
  await page.setInputFiles("input[name=file]", refPath);
  await page.fill("input[name=title]", "Test reference");
  await page.selectOption("select[name=kind]", "reference-video");
  await page.fill("input[name=license]", "Own test clip, study only");
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText("Saved Test reference.").waitFor();

  step("assets: upload a music track, marked as music for video beds");
  const musicPath = path.join(OUT, "music-bed.wav");
  // Two chords, 6 s: short, so a render has to loop it under the narration.
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=262:duration=6", "-f", "lavfi", "-i", "sine=frequency=330:duration=6",
    "-filter_complex", "[0:a][1:a]amix=inputs=2,volume=0.6[a]", "-map", "[a]", "-ar", "44100", musicPath,
  ]);
  await page.goto(`${APP}/assets`);
  await page.setInputFiles("input[name=file]", musicPath);
  await page.fill("input[name=title]", "Test music bed");
  await page.selectOption("select[name=kind]", "audio");
  await page.fill("input[name=license]", "Own composition for tests, all rights");
  await page.fill("input[name=originUrl]", "https://example.com/venstudio-test-music");
  await page.getByLabel("This is a music track for video beds").check();
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText("Saved Test music bed.").waitFor();
  await page.locator("li", { hasText: "Test music bed" }).getByText("music", { exact: true }).waitFor();

  step("assets: analyze the reference, run the worker, see the cuts");
  await page.locator("li", { hasText: "Test reference" }).getByRole("button", { name: "Analyze" }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  runWorker([`${OUT}/worker/run.sh`, "tick"]);
  await page.goto(`${APP}/assets`);
  await page.locator("li", { hasText: "Test reference" }).getByText("2 cuts").waitFor({ timeout: 20_000 });
  await shot("14-assets-desktop");
  for (const url of ["/assets", "/studio"]) {
    await page.goto(`${APP}${url}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) throw new Error(`${url} overflows horizontally on desktop`);
  }

  step("save a worker output to Assets");
  await page.goto(`${APP}/jobs?status=succeeded`);
  await page.getByRole("link").filter({ hasText: "Render smoke test" }).first().click();
  await page.getByRole("button", { name: "Save to Assets" }).first().click();
  await page.waitForURL(/\/assets$/);
  await page.getByText("smoke-test: smoke-test.mp4").waitFor();

  step("templates: every style is a candidate, nothing is proven");
  await page.goto(`${APP}/studio/templates`);
  await page.getByText("Candidate: not yet proven").first().waitFor();
  if ((await page.getByText("Proven", { exact: true }).count()) !== 0) throw new Error("a template shows as Proven before any trial");
  if ((await page.getByText("Allowed", { exact: true }).count()) !== 0) throw new Error("a template is allowed to run without the owner");
  await shot("16-templates-desktop");

  step("mobile screenshots");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    storageState: await desktop.storageState(),
  });
  const m = await mobile.newPage();
  // The 12-settings-mobile screenshot from an earlier run is 1940 px wide at 2x scale (970 CSS px), so /settings
  // already overflowed at 390 px before this change (the signed-in device user agent string). It is screenshotted
  // but not asserted. The other pages were 780 px wide (fit) in those screenshots; templates is new and asserted.
  const NO_OVERFLOW_CHECK = new Set(["/settings"]);
  for (const [name, url] of [
    ["08-overview-mobile", "/"],
    ["09-channels-mobile", "/channels"],
    ["10-workers-mobile", "/workers"],
    ["11-jobs-mobile", "/jobs"],
    ["12-settings-mobile", "/settings"],
    ["13-studio-mobile", "/studio"],
    ["13c-new-video-mobile", "/studio/new"],
    ["13d-test-render-mobile", "/studio/test-render"],
    ["14-assets-mobile", "/assets"],
    ["15-styles-mobile", "/studio/styles"],
    ["16-templates-mobile", "/studio/templates"],
  ]) {
    await m.goto(`${APP}${url}`);
    await m.waitForLoadState("networkidle");
    await shot(name, m);
    if (NO_OVERFLOW_CHECK.has(url)) continue;
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(`mobile layout overflows horizontally on ${url}`);
  }

  step("mobile: the capabilities card fits in 390 px");
  await m.goto(`${APP}/settings`);
  await m.waitForLoadState("networkidle");
  await m.locator("ul.gap-3 > li").first().waitFor();
  const wide = await m.evaluate(() => {
    const list = document.querySelector("ul.gap-3");
    const card = list?.closest("section") ?? list?.parentElement;
    if (!list || !card) return "the capabilities card was not found";
    for (const el of [card, ...card.querySelectorAll("*")]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) return `${el.tagName.toLowerCase()} ends at ${Math.round(r.right)} px`;
    }
    return "";
  });
  if (wide) throw new Error(`the capabilities card overflows at 390 px: ${wide}`);
  await m.locator("ul.gap-3").first().scrollIntoViewIfNeeded();
  await shot("16-capabilities-mobile", m);

  step("director: Test Hermes JSON passes against the fake Hermes");
  await page.goto(`${APP}/studio/test-render`);
  await page.getByRole("button", { name: "Test Hermes JSON" }).click();
  await page.getByText("Hermes returned valid JSON").waitFor();

  // Waits until the fake Hermes has seen a prompt for a stage that passes the check.
  async function waitPrompt(stage, ok, what, ms = 30_000) {
    const end = Date.now() + ms;
    while (!(lastPrompt[stage] && ok(lastPrompt[stage]))) {
      if (Date.now() > end) throw new Error(`the ${stage} prompt never carried ${what}. Last ${stage} prompt:\n${String(lastPrompt[stage] ?? "(none)").slice(0, 3000)}`);
      await page.waitForTimeout(500);
    }
    return lastPrompt[stage];
  }
  const dataBlock = (prompt, label) => new RegExp(`<<<DATA ${label}\\n([\\s\\S]*?)\\nDATA ${label}>>>`).exec(prompt)?.[1] ?? "";

  step("director: start a video from /studio with a style, purposes, theme, language and subtitles");
  const STUDIO_BRIEF = "A myth about the wolf that swallows the sun, told as a mystery";
  await page.goto(`${APP}/studio`);
  await page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "New video", exact: true }).click();
  await page.waitForURL(/\/studio\/new$/);
  await page.selectOption("#channelId", { label: "Myth Stories" });
  // The channel's plan and autonomy are shown, read only.
  const channelContext = await page.getByTestId("channel-context").innerText();
  if (!channelContext.includes("Retell one myth per video") || !/Level \d/.test(channelContext)) throw new Error(`the channel context is incomplete: ${channelContext.replace(/\s+/g, " ")}`);
  await page.fill("#brief", STUDIO_BRIEF);
  await page.getByRole("button", { name: "Suggest from brief", exact: true }).click();
  await page.getByTestId("style-suggestions").waitFor();
  // Style packs: every pack is in Trial, so the main list is empty and the research-only section offers them, once the
  // worker reports the pack. Planned catalogue styles are never options.
  const trialSection = page.getByTestId("trial-styles");
  await trialSection.getByRole("heading", { name: "Trial styles (research only, not for publishing)", exact: true }).waitFor();
  await trialSection.getByTestId("trial-style-explainer-flat-vector").getByText("Trial style", { exact: true }).waitFor();
  // The Hermes research pack is rendered by the portal, so it is offered here (only here) once Hermes is set up.
  await trialSection.getByTestId("trial-style-hermes-research-explainer").getByTestId("hermes-render-label").getByText("Hermes render (research only)", { exact: true }).waitFor();
  await page.getByTestId("no-listed-styles").waitFor();
  const styleOptions = await page.locator("#templateId option").evaluateAll((os) => os.map((o) => o.value));
  for (const planned of ["tpl-kinetic-facts", "tpl-math-explainer", "tpl-blender-3d", "tpl-ai-character-sketch"]) {
    if (styleOptions.includes(planned)) throw new Error(`New Video offers the planned style ${planned}: ${styleOptions.join(", ")}`);
  }
  if (!styleOptions.includes("tpl-explainer-flat-vector")) throw new Error(`New Video does not offer the trial pack: ${styleOptions.join(", ")}`);
  const trialGroup = await page.locator("#templateId optgroup").evaluateAll((gs) => gs.map((g) => g.label));
  if (!trialGroup.includes("Trial styles (research only, not for publishing)")) throw new Error(`no trial group in the style list: ${trialGroup.join(", ")}`);
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.getByTestId("trial-style-note").waitFor();
  await page.selectOption("#format", "short");
  const engineInfo = await page.getByTestId("engine-info").innerText();
  if (!engineInfo.includes("Muse: runs well") || !engineInfo.includes("A worker reports remotion-2d")) throw new Error(`the engine line is wrong: ${engineInfo.replace(/\s+/g, " ")}`);
  await page.selectOption("#themeId", "myth");
  await page.getByRole("checkbox", { name: /^Affiliate links/ }).check();
  await page.getByRole("checkbox", { name: /^Series \(recurring episodes\)/ }).check();
  await page.selectOption("#language", "en");
  await page.getByTestId("kokoro-flag").getByText("Kokoro voice", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Spanish", exact: true }).check();
  // Selects keep their values while the form works (no React form reset).
  if ((await page.inputValue("#templateId")) !== "tpl-explainer-flat-vector" || (await page.inputValue("#themeId")) !== "myth") throw new Error("a select lost its value");
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();
  if ((await page.inputValue("#channelId")) === "" || (await page.inputValue("#language")) !== "en") throw new Error("the form was reset after the run started");
  const startedHref = await page.getByTestId("run-started-link").getAttribute("href");
  if (!startedHref) throw new Error("no link to the started run");

  step("director: the run config and the idea prompt carry the form's choices");
  const ideaAsk = await waitPrompt("idea", (t) => t.includes(STUDIO_BRIEF), "the brief");
  const purposeData = dataBlock(ideaAsk, "video purpose");
  for (const want of ["Purpose: Affiliate links (affiliate)", "Purpose: Series (recurring episodes) (series)", "Planning step: Series bible"]) {
    if (!purposeData.includes(want)) throw new Error(`the idea prompt's purpose block misses "${want}": ${purposeData.slice(0, 800)}`);
  }
  if (!dataBlock(ideaAsk, "theme").includes("Theme: Myth and folklore (myth)")) throw new Error("the idea prompt has no theme block for myth");
  if (!dataBlock(ideaAsk, "subtitle languages").includes("Spanish (es)")) throw new Error("the idea prompt has no Spanish subtitles");
  if (!ideaAsk.includes("language code en")) throw new Error("the idea prompt does not name the narration language");
  if (!/one episode of a recurring series/.test(ideaAsk)) throw new Error("the idea prompt does not steer the series purpose");
  await page.goto(`${APP}${startedHref}`);
  // The section is collapsed; open it like the owner would, so innerText includes the list.
  await page.getByTestId("run-settings").locator("summary").click();
  await page.getByTestId("run-settings").locator("dl").waitFor();
  const settingsText = await page.getByTestId("run-settings").innerText();
  for (const want of ["Affiliate links, Series (recurring episodes)", "Myth and folklore, chosen for this video", "Spanish", "English (Kokoro voice)", STUDIO_BRIEF, "explainer-flat-vector 1.0.0, Trial: research only, not for publishing"]) {
    if (!settingsText.includes(want)) throw new Error(`the run settings miss "${want}": ${settingsText.replace(/\s+/g, " ")}`);
  }
  // A run started with a Trial pack carries the badge, and its config records the pack (additive).
  await page.getByTestId("trial-badge").getByText("Trial style: research only, not for publishing", { exact: true }).waitFor();
  const startedId = startedHref.split("/").pop();
  const storedPack = dbValue(`SELECT config->'stylePack'->>'id' || '@' || (config->'stylePack'->>'version') || ':' || (config->'stylePack'->>'trial') FROM pipeline_runs WHERE id = '${startedId}'`);
  if (storedPack !== null && storedPack !== "explainer-flat-vector@1.0.0:true") throw new Error(`the run config does not mark the trial pack: ${storedPack}`);
  await page.goto(`${APP}/studio`);
  await page.getByTestId("studio-runs").getByRole("link").filter({ hasText: "Myth Stories" }).first().waitFor();

  // Polls a page until a locator shows. The server works in the background after the click returns.
  async function waitShown(p, url, locator, what, ms = 45_000) {
    const end = Date.now() + ms;
    for (;;) {
      await p.goto(`${APP}${url}`);
      if (await locator(p).first().isVisible().catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what} on ${url}`);
      await p.waitForTimeout(1500);
    }
  }
  async function assertTapTargets(p, locators) {
    for (const [label, loc] of locators) {
      const box = await loc.first().boundingBox();
      if (!box) throw new Error(`${label} is not visible`);
      if (box.height < 44) throw new Error(`${label} is ${box.height}px tall, under 44px`);
    }
  }
  /** Rates every rubric line on a quality-check card, saves the score and waits for the card to show it. */
  async function scoreVideo(card, stars, shown) {
    const labels = { hook: "Hook", pacing: "Pacing", legibility: "Legibility", polish: "Visual polish", audio: "Audio" };
    for (const [id, n] of Object.entries(stars)) await card.getByTestId(`rubric-${id}`).getByRole("radio", { name: `${labels[id]}: ${n} of 5`, exact: true }).check();
    await card.getByTestId("presentation-score").getByRole("button", { name: /^(Save|Update) score$/ }).click();
    await card.getByTestId("presentation-value").getByText(shown, { exact: true }).waitFor({ timeout: 20_000 });
  }
  async function assertNoOverflow(p, url) {
    const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) throw new Error(`mobile layout overflows horizontally on ${url}`);
  }

  step("director: the Review inbox works at 390 px");
  await waitShown(m, "/review", (p) => p.getByRole("button", { name: "Approve this idea" }), "the idea review item");
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review");
  await assertTapTargets(m, [
    ["Approve this idea", m.getByRole("button", { name: "Approve this idea" })],
    ["revision note", m.getByLabel("What should change?")],
    ["Send revision", m.getByRole("button", { name: "Send revision" })],
    ["Reject", m.getByRole("button", { name: "Reject" })],
  ]);
  await m.getByTestId("review-card").filter({ has: m.getByRole("button", { name: "Approve this idea" }) }).first().getByTestId("trial-badge").waitFor();
  await shot("17-review-mobile", m);
  const runHref = await m.getByRole("link", { name: "Open run" }).first().getAttribute("href");
  if (!runHref) throw new Error("review card has no link to its run");

  step("director: request a revision with a note and see a new attempt");
  await m.getByLabel("What should change?").first().fill("Only Norse myths, please");
  await m.getByRole("button", { name: "Send revision" }).first().click();
  await waitShown(m, "/review", (p) => p.getByText("(revised)"), "the revised ideas");
  await m.goto(`${APP}${runHref}`);
  await m.getByText("attempt 2").first().waitFor();

  step("production: approve the idea and reach the assets review (thumbnails, provider terms notice)");
  await m.goto(`${APP}/review`);
  await m.getByRole("button", { name: "Approve this idea" }).first().click();
  let sawHermesWait = false;
  {
    // The storyboard may ask for approval at this autonomy level, or pass on its own. Either way the assets review follows.
    // Hermes answers the first image asks with 429, so the assets stage waits a few seconds on the way.
    const end = Date.now() + 150_000;
    for (;;) {
      await m.goto(`${APP}/review`);
      if (!sawHermesWait) sawHermesWait = await m.getByTestId("hermes-waiting").first().isVisible().catch(() => false);
      if (await m.getByTestId("asset-grid").first().isVisible().catch(() => false)) break;
      if (await m.locator('[data-kind="stage-error"]').first().isVisible().catch(() => false)) {
        await dumpPipeline(m, runHref, "a stage error appeared while the assets were being made");
        throw new Error(`a stage error appeared instead of the assets review: ${(await m.locator('[data-kind="stage-error"]').first().innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
      }
      if (!sawHermesWait) {
        await page.goto(`${APP}${runHref}`);
        sawHermesWait = await page.getByTestId("hermes-wait").isVisible().catch(() => false);
      }
      const board = m.locator('[data-testid="review-card"]', { hasText: "Approve the storyboard" });
      if (await board.first().isVisible().catch(() => false)) await board.first().getByRole("button", { name: "Approve", exact: true }).click();
      if (Date.now() > end) {
        await dumpPipeline(m, runHref, "the assets review never appeared");
        throw new Error("timed out waiting for the assets review");
      }
      await m.waitForTimeout(sawHermesWait ? 2000 : 700);
    }
  }
  // The 429 burst was served and the shots still finished (no stage error, the grid is there). The wait itself lasts
  // only a few seconds here, so seeing it on a page is logged, not required.
  if (fakeStats.hermes429 !== HERMES_429_BURST) throw new Error(`the fake Hermes answered 429 ${fakeStats.hermes429} times, expected ${HERMES_429_BURST}`);
  console.log(`   Hermes 429 burst of ${HERMES_429_BURST} absorbed; waiting status ${sawHermesWait ? "was" : "was not"} caught on a page`);
  // A storyboard provider Hermes never reported must never reach the image prompt. Whether agnes was kept depends on
  // the capability scan having run before the storyboard, so that part is logged, not asserted.
  if (fakeStats.droppedPreferenceAsks !== 0) throw new Error("the storyboard's unknown provider (midjourney) reached the image prompt");
  console.log(`   per-shot preference: agnes asked first ${fakeStats.shotPreferenceAsks} time(s) (0 means no scan had run before the storyboard)`);
  await m.waitForLoadState("networkidle");
  const grid = m.getByTestId("asset-grid").first();
  const thumbs = grid.locator("img");
  if ((await thumbs.count()) < 3) throw new Error(`expected at least 3 thumbnails, got ${await thumbs.count()}`);
  await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-grid"] img')].every((i) => i.complete && i.naturalWidth > 0));
  await m.getByTestId("provider-terms-notice").first().waitFor();
  const gridText = (await grid.textContent()) ?? "";
  if (!gridText.includes("canva via 9router")) throw new Error(`the image grid does not name the backend and plugin (canva via 9router): ${gridText.slice(0, 300)}`);
  if (!gridText.includes("unlisted-cloudflare-9router")) throw new Error("the image grid does not name the unlisted backend of shot-03 (unlisted-cloudflare-9router)");
  if (gridText.includes("unlisted-9router")) throw new Error("an image is credited to the plugin (unlisted-9router) instead of its backend");
  await assertNoOverflow(m, "/review (assets)");
  // The card names the exact asset_providers rows that block it, each with the owner's choices right there.
  const assetsGateCard = () => m.locator('[data-testid="review-card"][data-stage="assets"][data-kind="gate-failure"]').first();
  const blockingRow = (card, name) => card.locator(`[data-testid="blocking-provider"][data-provider="${name}"]`);
  const blockingNames = (card) => card.locator('[data-testid="blocking-provider"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-provider")}:${e.getAttribute("data-kind")}`));
  // Images the run asked for (Hermes per shot, and 9router). The Settings test image is shot "test" and is not counted.
  const productionImageCalls = () => Object.entries(fakeStats.imageAsks).filter(([k]) => k.startsWith("shot-")).reduce((n, [, v]) => n + v, 0) + fakeStats.routerImageCalls;
  const ttsCalls = () => fakeStats.routerSpeechCalls + fakeStats.hermesKokoroCalls;
  {
    const names = await blockingNames(assetsGateCard());
    for (const want of ["canva:image", "unlisted-cloudflare-9router:image", "fake-img:image"]) {
      if (!names.includes(want)) throw new Error(`the assets card does not list the blocking provider ${want}; it lists: ${names.join(", ")}`);
    }
    if (names.some((n) => n.startsWith("unlisted-9router:"))) throw new Error("the assets card lists the plugin row unlisted-9router");
    // Terms are the only issue and no shot failed, so the card offers the re-check and no Retry.
    if ((await assetsGateCard().getByRole("button", { name: /Retry/ }).count()) !== 0) throw new Error("the terms-only assets card still offers Retry");
  }
  await assertTapTargets(m, [
    ["Check the terms again", assetsGateCard().getByRole("button", { name: "Check the terms again", exact: true })],
    ["Commercial use OK (canva)", blockingRow(assetsGateCard(), "canva").getByRole("button", { name: "Commercial use OK", exact: true })],
    ["Not for commercial use (canva)", blockingRow(assetsGateCard(), "canva").getByRole("button", { name: "Not for commercial use", exact: true })],
    ["note (canva)", blockingRow(assetsGateCard(), "canva").getByLabel("Note for canva", { exact: true })],
    ["Confirm the terms in Settings", assetsGateCard().getByRole("link", { name: "Confirm the terms in Settings", exact: true })],
  ]);
  await shot("20-review-assets-mobile", m);
  await page.goto(`${APP}/review`);
  await page.getByTestId("asset-grid").first().waitFor();
  await shot("20-review-assets-desktop");
  if (fakeStats.pathAnswers < 1) throw new Error("the path answer variant never ran");
  if (fakeStats.errorAnswers < 3) throw new Error("the failing image variant never ran its first attempt");
  if (fakeStats.urlAnswers < 1) throw new Error("the download link variant never ran");
  // shot-04 is refused by Hermes every time, so 9router made it: it was asked, and the grid names its provider.
  if (fakeStats.hermesImageRefusals < 1) throw new Error("the Hermes image refusal variant never ran");
  if (fakeStats.routerImageCalls < 1) throw new Error("9router was never asked for an image after Hermes refused");
  if (!(await grid.textContent()).includes("fake-img")) throw new Error("the image grid does not show the 9router image provider (fake-img)");
  if (fakeStats.routerImageCalls <= routerImageCallsBeforeRun) throw new Error("the run never used the proven 9router image model");
  if (fakeStats.routerBadImageCalls !== 1) throw new Error(`the set-aside 9router model was used again by the run (${fakeStats.routerBadImageCalls} calls)`);
  const assetsRunHref = await m.getByRole("link", { name: "Open run" }).first().getAttribute("href");

  step("review: the owner confirms canva on the assets card; the card is checked again without making images");
  const imagesBeforeTerms = productionImageCalls();
  {
    const card = assetsGateCard();
    const oldId = await card.getAttribute("data-review-id");
    await blockingRow(card, "canva").getByRole("button", { name: "Commercial use OK", exact: true }).click();
    // The server action saves, re-checks the card and returns the new page: the old card goes away in place.
    await m.locator(`[data-testid="review-card"][data-review-id="${oldId}"]`).waitFor({ state: "detached", timeout: 30_000 });
    await m.goto(`${APP}/review`);
    const next = assetsGateCard();
    try {
      await next.waitFor({ timeout: 20_000 });
    } catch (err) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "no assets card after confirming canva on the card");
      throw err;
    }
    if ((await next.getAttribute("data-review-id")) === oldId) throw new Error("the assets card was not checked again after canva was confirmed on it");
    const names = await blockingNames(next);
    if (names.includes("canva:image")) throw new Error(`canva still blocks after it was confirmed on the card: ${names.join(", ")}`);
    if (!names.includes("unlisted-cloudflare-9router:image") || !names.includes("fake-img:image")) throw new Error(`the checked card lost a row that still blocks: ${names.join(", ")}`);
    await next.getByTestId("rechecked").waitFor();
    if (productionImageCalls() !== imagesBeforeTerms) throw new Error(`confirming terms made new images (${imagesBeforeTerms} -> ${productionImageCalls()} image calls)`);
    await assertNoOverflow(m, "/review (assets checked again)");
    await shot("20b-review-assets-rechecked-mobile", m);
  }

  // The owner confirms a provider in Settings. Nothing else can set this.
  async function confirmProvider(name) {
    await page.goto(`${APP}/settings`);
    const select = page.getByLabel(`Commercial use for ${name}`, { exact: true }).first();
    await select.waitFor();
    await select.selectOption("yes");
    await select.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
    for (let i = 0; i < 15; i++) {
      await page.goto(`${APP}/settings`);
      if ((await page.getByLabel(`Commercial use for ${name}`, { exact: true }).first().inputValue()) === "yes") return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`the terms for ${name} were not saved`);
  }

  step("settings: the owner confirms the image provider terms, Kokoro is healthy, Test Hermes image works");
  // Asset providers lists each backend, never the plugin in front of them.
  await page.goto(`${APP}/settings`);
  for (const name of ["canva", "unlisted-cloudflare-9router"]) {
    if ((await page.locator(`[data-testid="provider-row"][data-provider="${name}"]`).count()) !== 1) {
      const rows = await page.locator('[data-testid="provider-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")));
      throw new Error(`Asset providers has no row for the backend ${name}; rows: ${rows.join(", ")}`);
    }
  }
  if ((await page.locator('[data-testid="provider-row"][data-provider="unlisted-9router"]').count()) !== 0) {
    throw new Error("Asset providers has a row for the plugin unlisted-9router; images must be credited to their backend");
  }
  // canva was confirmed on the Review card: Settings shows the same row as confirmed.
  if ((await page.getByLabel("Commercial use for canva", { exact: true }).first().inputValue()) !== "yes") throw new Error("canva, confirmed on the Review card, is not confirmed in Settings");
  await confirmProvider("unlisted-cloudflare-9router");
  await confirmProvider("fake-img");
  // No KOKORO_BASE_URL is set: the voice comes from the Kokoro model 9router lists, and Hermes is only the fallback.
  await page.getByText("9router voice kokoro/af_heart").first().waitFor();
  await page.getByRole("button", { name: "Test voice" }).click();
  await page.getByText("Voice made by kokoro through 9router").waitFor({ timeout: 30_000 });
  const calls = fakeStats.routerSpeechCalls;
  router.tts = "error";
  await page.getByRole("button", { name: "Test voice" }).click();
  try {
    await page.getByText("Voice made by hermes-kokoro through Hermes").waitFor({ timeout: 60_000 });
  } catch (err) {
    const panel = await page.locator("form", { has: page.getByRole("button", { name: "Test voice" }) }).first().innerText().catch(() => "(voice panel not readable)");
    console.error(`Test voice fallback did not show. Voice panel text:\n${panel}\nfakeStats: ${JSON.stringify(fakeStats)}\nrouter: ${JSON.stringify(router)}`);
    throw err;
  }
  router.tts = "ok";
  if (fakeStats.hermesKokoroCalls < 1) throw new Error("the voice did not fall back to Hermes Kokoro when 9router speech failed");
  if (fakeStats.routerSpeechCalls !== calls) throw new Error("the failing 9router speech endpoint was counted as a success");
  await page.getByRole("button", { name: "Test Hermes image" }).click();
  await page.getByText("Providers Hermes reports: cloudflare, agnes").waitFor({ timeout: 60_000 });
  await page.getByText("Image made by canva via 9router plugin (fake-flux)", { exact: true }).waitFor();
  await shot("21-settings-media-desktop");

  step("production: the assets pass once every provider is confirmed, without making images again");
  {
    // Saving terms in Settings re-checks the card in after(). If that has not landed yet, the owner's button does the same.
    let pressed = false;
    const start = Date.now();
    for (;;) {
      await m.goto(`${APP}/review`);
      if (await m.locator('[data-testid="review-card"][data-stage="assets"][data-kind="approval"]').first().isVisible().catch(() => false)) break;
      const stale = assetsGateCard();
      if (!pressed && Date.now() - start > 15_000 && (await stale.isVisible().catch(() => false))) {
        const left = await blockingNames(stale);
        if (left.length !== 0) throw new Error(`the assets card still lists blocking providers after Settings confirmed them: ${left.join(", ")}`);
        await stale.getByTestId("terms-now-confirmed").waitFor();
        const id = await stale.getAttribute("data-review-id");
        await stale.getByRole("button", { name: "Check the terms again", exact: true }).click();
        await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
        pressed = true;
        continue;
      }
      if (Date.now() - start > 60_000) {
        await dumpPipeline(m, assetsRunHref ?? runHref, "the assets approval never appeared after every provider was confirmed");
        throw new Error("timed out waiting for the assets approval after the terms were confirmed");
      }
      await m.waitForTimeout(1500);
    }
    console.log(`   assets passed after the Settings confirmations via ${pressed ? "Check the terms again" : "the automatic re-check"}`);
    if (productionImageCalls() !== imagesBeforeTerms) throw new Error(`the assets were made again (${imagesBeforeTerms} -> ${productionImageCalls()} image calls)`);
  }
  await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-grid"] img')].every((i) => i.complete && i.naturalWidth > 0));
  await assertNoOverflow(m, "/review (assets approved terms)");
  await m.getByRole("button", { name: "Approve", exact: true }).first().click();

  step("production: voice review with an audio player");
  await waitShown(m, "/review", (p) => p.getByTestId("voice-audio"), "the voice review", 120_000);
  await m.waitForLoadState("networkidle");
  const audioSrc = await m.getByTestId("voice-audio").first().getAttribute("src");
  if (!/^\/api\/assets\/[0-9a-f-]{36}$/.test(audioSrc ?? "")) throw new Error(`unexpected audio source ${audioSrc}`);
  const audioRes = await m.request.get(`${APP}${audioSrc}`);
  if (audioRes.status() !== 200 || !(audioRes.headers()["content-type"] ?? "").startsWith("audio/")) throw new Error("the narration asset is not served as audio");
  if (fakeStats.routerSpeechCalls < 1) throw new Error("the fake 9router was never asked to speak");
  await assertNoOverflow(m, "/review (voice)");
  await assertTapTargets(m, [["Reject", m.getByRole("button", { name: "Reject" })]]);
  await shot("22-review-voice-mobile", m);
  await page.goto(`${APP}/review`);
  await page.getByTestId("voice-audio").first().waitFor();
  await shot("22-review-voice-desktop");

  // The voice provider is registered as unconfirmed by the voice stage (Kokoro through 9router), as a voice (tts) row.
  step("review: the voice card names kokoro; check again, then confirm it on the card, without recording again");
  {
    await m.goto(`${APP}/review`);
    const voiceGateCard = () => m.locator('[data-testid="review-card"][data-stage="voice"][data-kind="gate-failure"]').first();
    if (!(await voiceGateCard().isVisible().catch(() => false))) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "the voice card is not held up by the kokoro terms");
      throw new Error("expected the voice card to be held up by the unconfirmed kokoro terms");
    }
    const names = await blockingNames(voiceGateCard());
    if (names.join(",") !== "kokoro:tts") throw new Error(`the voice card should list exactly kokoro (voice); it lists: ${names.join(", ")}`);
    if ((await voiceGateCard().getByRole("button", { name: "Retry", exact: true }).count()) !== 0) throw new Error("the voice card has an unnamed Retry");
    await voiceGateCard().getByRole("button", { name: "Make the voice again", exact: true }).waitFor();
    // The fake voice speaks about 15 percent slower than the estimate. That is a note on the card, never a failed check.
    const voiceIssues = await voiceGateCard().locator("ul.list-disc > li").allInnerTexts();
    if (voiceIssues.some((t) => /script estimate|limit 10 percent|shots can fill/.test(t))) {
      throw new Error(`the voice card fails on the narration length: ${voiceIssues.join(" | ")}`);
    }
    const voiceNote = (await voiceGateCard().getByTestId("review-notes").innerText()).replace(/\s+/g, " ");
    if (!/percent longer than the script estimate/.test(voiceNote) || !/only a note/.test(voiceNote)) throw new Error(`the voice card has no length note: ${voiceNote}`);
    // Approve anyway is never offered while provider terms are open; Fit is not offered for a narration that fits.
    if ((await voiceGateCard().getByRole("button", { name: "Approve anyway", exact: true }).count()) !== 0) throw new Error("Approve anyway is offered on a card held up by provider terms");
    if ((await voiceGateCard().getByRole("button", { name: "Fit the narration to the video", exact: true }).count()) !== 0) throw new Error("Fit the narration is offered for a narration that fits");
    await voiceGateCard().getByTestId("reject-hint").getByText("stay in Assets", { exact: false }).waitFor();

    // A note about length on the voice card fits the script to the pictures: Hermes rewrites the script, only the voice
    // is recorded again, and no image is made again.
    {
      const imagesBefore = productionImageCalls();
      const ttsBeforeFit = ttsCalls();
      const fitAsksBefore = fakeStats.scriptFitAsks;
      const fitId = await voiceGateCard().getAttribute("data-review-id");
      await voiceGateCard().getByRole("textbox", { name: "What should change?", exact: true }).fill("Make the narration a bit shorter");
      await voiceGateCard().getByRole("button", { name: "Send revision", exact: true }).click();
      await m.locator(`[data-testid="review-card"][data-review-id="${fitId}"]`).waitFor({ state: "detached", timeout: 30_000 });
      let fitted = false;
      for (const end = Date.now() + 60_000; Date.now() < end && !fitted; ) {
        await m.goto(`${APP}/review`);
        fitted = (await voiceGateCard().isVisible().catch(() => false)) && (await voiceGateCard().getAttribute("data-review-id")) !== fitId;
        if (!fitted) await m.waitForTimeout(1000);
      }
      if (!fitted) {
        await dumpPipeline(m, assetsRunHref ?? runHref, "the voice card did not come back after a length note");
        throw new Error("the voice card did not come back after the length note");
      }
      if (fakeStats.scriptFitAsks <= fitAsksBefore) throw new Error("a length note on the voice card did not ask Hermes to fit the script");
      if (!/Keep every beat, in the same order/.test(lastPrompt["script-fit"] ?? "")) throw new Error("the script-fit prompt does not keep the storyboard's beats");
      if (productionImageCalls() !== imagesBefore) throw new Error(`fitting the script made images again (${imagesBefore} -> ${productionImageCalls()} image calls)`);
      // The narration is spoken in chunks of up to 400 characters, so one recording may be more than one speech call.
      if (ttsCalls() <= ttsBeforeFit) throw new Error(`fitting the script did not record the voice again (${ttsBeforeFit} -> ${ttsCalls()} speech calls)`);
      if ((await voiceGateCard().getByText(/The script was fitted to the pictures \(\d+ words\)/).count()) !== 1) {
        throw new Error(`the new voice card does not say the script was fitted: ${(await voiceGateCard().innerText()).slice(0, 400)}`);
      }
      if ((await blockingNames(voiceGateCard())).join(",") !== "kokoro:tts") throw new Error("the fitted voice card does not name kokoro");
      console.log(`   length note: script fitted by Hermes, voice recorded again, images kept (${imagesBefore} image calls)`);
    }
    await assertTapTargets(m, [
      ["Check the terms again (voice)", voiceGateCard().getByRole("button", { name: "Check the terms again", exact: true })],
      ["Commercial use OK (kokoro)", blockingRow(voiceGateCard(), "kokoro").getByRole("button", { name: "Commercial use OK", exact: true })],
    ]);
    const ttsBefore = ttsCalls();

    // Nothing changed yet: checking again replaces the card with one that still names kokoro.
    let id = await voiceGateCard().getAttribute("data-review-id");
    await voiceGateCard().getByRole("button", { name: "Check the terms again", exact: true }).click();
    await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
    await m.goto(`${APP}/review`);
    await voiceGateCard().waitFor({ timeout: 20_000 });
    if ((await voiceGateCard().getAttribute("data-review-id")) === id) throw new Error("Check the terms again did not replace the voice card");
    await voiceGateCard().getByTestId("rechecked").waitFor();
    if ((await blockingNames(voiceGateCard())).join(",") !== "kokoro:tts") throw new Error("the checked voice card does not name kokoro any more");
    if (ttsCalls() !== ttsBefore) throw new Error(`checking the terms again recorded the voice again (${ttsBefore} -> ${ttsCalls()} speech calls)`);

    // The owner confirms kokoro on the card: the card is checked again and asks for approval.
    id = await voiceGateCard().getAttribute("data-review-id");
    await blockingRow(voiceGateCard(), "kokoro").getByRole("button", { name: "Commercial use OK", exact: true }).click();
    await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
    // Once the terms pass, the stage concludes under the run's autonomy: either a voice approval card, or (at a level
    // where a passed voice stage needs no owner) the run moves on by itself and no voice card is left. Both are right.
    const voiceApproval = () => m.locator('[data-testid="review-card"][data-stage="voice"][data-kind="approval"]');
    const anyVoiceCard = () => m.locator('[data-testid="review-card"][data-stage="voice"]');
    let voiceOutcome = "";
    for (const end = Date.now() + 30_000; Date.now() < end && !voiceOutcome; ) {
      await m.goto(`${APP}/review`);
      if (await voiceApproval().first().isVisible().catch(() => false)) voiceOutcome = "approval";
      else if ((await anyVoiceCard().count()) === 0) voiceOutcome = "continued";
      else await m.waitForTimeout(1000);
    }
    if (!voiceOutcome) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "the voice stage did not conclude after kokoro was confirmed on the card");
      throw new Error("the voice stage did not conclude after kokoro was confirmed on the card");
    }
    console.log(`   voice after confirming kokoro: ${voiceOutcome === "approval" ? "approval card" : "passed and the run continued on its own"}`);
    if (ttsCalls() !== ttsBefore) throw new Error(`confirming kokoro recorded the voice again (${ttsBefore} -> ${ttsCalls()} speech calls)`);
    if (voiceOutcome === "approval") {
      await voiceApproval().first().getByTestId("voice-audio").waitFor();
      await assertNoOverflow(m, "/review (voice approved terms)");
      await voiceApproval().first().getByRole("button", { name: "Approve", exact: true }).click();
      await m.waitForLoadState("networkidle");
    }
  }

  step("production: render with the real worker, then the quality check");
  let qcCard = false;
  const productionRunHref = assetsRunHref ?? runHref;
  // A render or voice problem will not fix itself by waiting: stop at once and say what happened.
  const brokenCard = m.locator('[data-testid="review-card"]', { hasText: /(Video|Voice|Assets) (stopped with an error|did not pass the checks)/ });
  for (let i = 0; i < 14 && !qcCard; i++) {
    runWorker([`${OUT}/worker/run.sh`, "tick"]);
    await m.goto(`${APP}/review`);
    // Not on the first pass: the voice card that was just retried or approved may still be listed for a moment.
    if (i > 0 && (await brokenCard.first().isVisible().catch(() => false))) {
      const text = ((await brokenCard.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 600);
      await dumpPipeline(m, productionRunHref, `a production step failed on tick ${i + 1}`);
      throw new Error(`a production step failed before the quality check: ${text}`);
    }
    const video = m.getByTestId("render-video").first();
    const approveVideo = m.locator('[data-kind="approval"]', { hasText: "Approve the video" });
    if (await approveVideo.first().isVisible().catch(() => false)) {
      await video.waitFor();
      await assertNoOverflow(m, "/review (render)");
      await shot("23-review-render-mobile", m);
      await approveVideo.first().getByRole("button", { name: "Approve", exact: true }).click();
      // The decision is saved by a server action. Let it finish so the next tick finds the quality check job.
      await m.waitForLoadState("networkidle");
    }
    qcCard = await m.locator('[data-testid="review-card"]', { hasText: "Quality check" }).first().isVisible().catch(() => false);
    if (!qcCard) await m.waitForTimeout(3000);
  }
  if (!qcCard) {
    await dumpPipeline(m, productionRunHref, "the quality check review never appeared after 14 worker ticks");
    throw new Error("the quality check review never appeared");
  }
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review (quality check)");
  await shot("24-review-qc-mobile", m);
  const qc = m.locator('[data-testid="review-card"][data-stage="qc"]').first();
  // A trial run's final video is scored by the owner on its card before the decision (hook, pacing, legibility,
  // visual polish, audio; 1-5 stars, 0-100 on the server). Deciding first is refused by name.
  const approveQc = qc.getByRole("button", { name: "Approve", exact: true });
  const canApprove = await approveQc.isVisible().catch(() => false);
  await (canApprove ? approveQc : qc.getByRole("button", { name: "Reject", exact: true })).click();
  await qc.getByText(/^This is a trial run: the owner scores the video/).waitFor();
  await scoreVideo(qc, { hook: 5, pacing: 4, legibility: 4, polish: 4, audio: 4 }, "80/100 by the owner");
  await shot("24b-review-qc-scored-mobile", m);
  if (canApprove) await qc.getByRole("button", { name: "Approve", exact: true }).click();
  else await qc.getByRole("button", { name: "Reject", exact: true }).click();
  await m.waitForLoadState("networkidle");

  step("style packs: the render was routed by the pack, the trial outcome is in the curation log, and Styles shows it");
  {
    const prodRunId = /([0-9a-f-]{36})$/.exec(productionRunHref ?? "")?.[1] ?? "";
    const cap = dbValue(`SELECT capability FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${prodRunId}' ORDER BY created_at DESC LIMIT 1`);
    if (cap !== null && cap !== "pack:explainer-flat-vector@1.0.0") throw new Error(`the render job is queued under ${cap}, not the pack capability`);
    // The decision is saved by a server action; the log row follows it.
    let outcome = null;
    for (let i = 0; i < 20; i++) {
      outcome = dbValue(
        `SELECT pack_id || '@' || pack_version || ' ' || qc_passed::text || ' ' || coalesce(owner_decision, 'none') || ' ' || (video_asset_id IS NOT NULL)::text FROM style_trial_outcomes WHERE run_id = '${prodRunId}'`,
      );
      if (outcome === null || / (approved|rejected) /.test(outcome)) break;
      await m.waitForTimeout(1000);
    }
    if (outcome === null) console.log("   no database access (UI_DB unset): the curation log check is skipped");
    else if (!/^explainer-flat-vector@1\.0\.0 (true|false) (approved|rejected) true$/.test(outcome)) {
      await dumpPipeline(m, productionRunHref, "the trial outcome was not recorded");
      throw new Error(`the trial outcome is "${outcome}", expected the pack version, the QC result, the owner's decision and the video`);
    }
    await page.goto(`${APP}/studio/styles`);
    const explainerCard = page.getByTestId("style-pack-explainer-flat-vector");
    await explainerCard.getByText("Trial", { exact: true }).first().waitFor();
    await explainerCard.getByTestId("pack-availability").getByText("A worker reports pack:explainer-flat-vector@1.0.0", { exact: true }).waitFor();
    if (outcome !== null) {
      // Counted with the owner's score: 80 from 5, 4, 4, 4, 4 stars.
      await explainerCard.getByTestId("trial-record").getByText(/^Trial runs of v1\.0\.0: 1 .*mean presentation 80 \(1 scored\)/).waitFor();
      const scored = dbValue(`SELECT presentation_score::text || ' ' || coalesce(presentation_by, 'none') || ' ' || coalesce(owner_rubric->>'hook', '?') || ' ' || coalesce(renderer, '?') FROM style_trial_outcomes WHERE run_id = '${prodRunId}'`);
      if (scored !== "80 owner 5 remotion-2d") throw new Error(`the curation log has "${scored}", expected the owner's 80 with its rubric and the remotion-2d renderer`);
      await explainerCard.getByTestId("promotion-issues").getByText("Needs at least 5 trial runs (has 1)", { exact: true }).waitFor();
    }
    const plannedCard = page.getByTestId("planned-style-kinetic-facts");
    await plannedCard.getByText("Planned", { exact: true }).waitFor();
    await plannedCard.getByText("Not selectable for a run", { exact: true }).waitFor();
    await page.getByTestId("planned-styles").getByRole("heading", { name: "Planned styles (not selectable)", exact: true }).waitFor();
    await shot("15b-styles-desktop");
  }

  step("hermes render (research only): a trial run Hermes renders goes through QC and Review with its badge, is scored and counted");
  {
    const prodRunId = /([0-9a-f-]{36})$/.exec(productionRunHref ?? "")?.[1] ?? "";
    // The run reuses the finished production's approved script, storyboard, pictures and narration (copied rows), so
    // only the render, the quality check and the review run again. It is a trial of the Hermes research pack.
    const hermesRunId = prodRunId
      ? dbExec(`INSERT INTO pipeline_runs (channel_id, template_id, template_version, topic, autonomy_level, config, state)
          SELECT channel_id, 'tpl-hermes-research-explainer', (SELECT current_version FROM templates WHERE id = 'tpl-hermes-research-explainer'),
                 topic || ' (Hermes render)', autonomy_level,
                 jsonb_set(jsonb_set(config, '{styleId}', '"hermes-research-explainer"'), '{stylePack}',
                   '{"id":"hermes-research-explainer","version":"0.1.0","status":"trial","trial":true,"engine":"hermes"}'), 'running'
          FROM pipeline_runs WHERE id = '${prodRunId}' RETURNING id`)
      : null;
    if (!hermesRunId) console.log("   no database access (UI_DB unset): the Hermes render run is skipped");
    else {
      dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
        SELECT '${hermesRunId}', stage, state, attempt, output, finished_at FROM pipeline_stages
        WHERE run_id = '${prodRunId}' AND state = 'passed' AND stage IN ('idea', 'research', 'script', 'storyboard', 'assets', 'voice')`);
      try {
        dbExec(`INSERT INTO work_orders (run_id, stage, shot_ref, executor, spec, state, asset_id)
          SELECT '${hermesRunId}', stage, shot_ref, executor, spec, state, asset_id FROM work_orders WHERE run_id = '${prodRunId}' AND stage = 'assets' AND state = 'done'`);
      } catch (err) {
        console.log(`   the pictures were not copied (${String(err).slice(0, 200)}); Hermes draws those shots from their descriptions`);
      }
      dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt) VALUES ('${hermesRunId}', 'render', 'pending', 1)`);
      const hermesHref = `/studio/runs/${hermesRunId}`;
      // The Review page restarts a running run with a pending stage; the portal then asks Hermes (no worker job).
      const hermesCard = (stage) => m.locator(`[data-testid="review-card"][data-stage="${stage}"]`).filter({ has: m.getByTestId("hermes-render-badge") });
      let qcShown = false;
      for (let i = 0; i < 14 && !qcShown; i++) {
        await m.goto(`${APP}/review`);
        const broken = m.locator('[data-testid="review-card"][data-kind="stage-error"]').filter({ has: m.getByTestId("hermes-render-badge") });
        if (await broken.first().isVisible().catch(() => false)) {
          await dumpPipeline(m, hermesHref, "the Hermes render stopped with an error");
          throw new Error(`the Hermes render stopped: ${((await broken.first().innerText()) || "").replace(/\s+/g, " ").slice(0, 500)}`);
        }
        const renderCard = hermesCard("render");
        if (await renderCard.first().isVisible().catch(() => false)) {
          await renderCard.first().getByTestId("render-video").waitFor();
          await renderCard.first().getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
          await renderCard.first().getByRole("button", { name: "Approve", exact: true }).click();
          await m.waitForLoadState("networkidle");
        }
        // The quality check is the worker's qc-video, as for any render.
        runWorker([`${OUT}/worker/run.sh`, "tick"]);
        await m.goto(`${APP}/review`);
        qcShown = await hermesCard("qc").first().isVisible().catch(() => false);
        if (!qcShown) await m.waitForTimeout(3000);
      }
      if (!qcShown) {
        await dumpPipeline(m, hermesHref, "the Hermes render's quality check never reached Review");
        throw new Error("the Hermes render's quality check never reached Review");
      }
      if (fakeStats.hermesRenders < 1 || fakeStats.clipDownloads < 1) throw new Error(`Hermes was asked ${fakeStats.hermesRenders} time(s) and its clip downloaded ${fakeStats.clipDownloads} time(s)`);
      const renderAsk = lastPrompt["hermes-render"] ?? "";
      for (const want of ['"scenePlan"', '"contract"', '"shots"', '"id":"hermes-research-explainer"', "/clip/"]) {
        if (!renderAsk.includes(want)) throw new Error(`the hermes-render request misses ${want}`);
      }
      const renderJobs = dbValue(`SELECT count(*) FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${hermesRunId}'`);
      if (renderJobs !== "0") throw new Error(`a Hermes render queued ${renderJobs} worker render job(s)`);
      const provenance = dbValue(`SELECT a.metadata->>'executor' || ' ' || coalesce(a.metadata->>'backend', '?') || ' ' || a.origin_url FROM assets a
        WHERE a.id = (SELECT (output->'result'->>'assetId')::uuid FROM pipeline_stages WHERE run_id = '${hermesRunId}' AND stage = 'render' AND state = 'passed' LIMIT 1)`);
      if (!/^hermes-render capcut http:\/\/127\.0\.0\.1:\d+\/clip\/render-\d+\.mp4$/.test(provenance ?? "")) throw new Error(`the Hermes render's provenance is "${provenance}"`);
      const card = hermesCard("qc").first();
      await card.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
      await card.getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
      // Hermes's advisory on the sampled stills arrives in the background; it is shown, never decides.
      for (let i = 0; i < 10 && !(await card.getByTestId("presentation-advisory").isVisible().catch(() => false)); i++) {
        await m.waitForTimeout(2000);
        await m.goto(`${APP}/review`);
      }
      await card.getByTestId("presentation-advisory").getByText(/^Hermes advisory \(from \d+ stills, does not decide\): 60\/100/).waitFor();
      if (fakeStats.advisoryImages < 1) throw new Error("the advisory was asked without the sampled stills");
      await assertNoOverflow(m, "/review (Hermes render)");
      await scoreVideo(card, { hook: 4, pacing: 4, legibility: 5, polish: 4, audio: 3 }, "75/100 by the owner");
      await shot("24c-review-hermes-render-mobile", m);
      const approve = card.getByRole("button", { name: "Approve", exact: true });
      if (await approve.isVisible().catch(() => false)) await approve.click();
      else await card.getByRole("button", { name: "Reject", exact: true }).click();
      await m.waitForLoadState("networkidle");
      let logged = null;
      for (let i = 0; i < 20; i++) {
        logged = dbValue(`SELECT pack_id || '@' || pack_version || ' ' || coalesce(renderer, '?') || ' ' || coalesce(presentation_score::text, 'none') || ' ' || coalesce(owner_decision, 'none') || ' ' || coalesce(hermes_advisory->>'score', 'none') FROM style_trial_outcomes WHERE run_id = '${hermesRunId}'`);
        if (logged && / (approved|rejected) /.test(logged)) break;
        await m.waitForTimeout(1000);
      }
      if (!/^hermes-research-explainer@0\.1\.0 hermes 75 (approved|rejected) 60$/.test(logged ?? "")) {
        await dumpPipeline(m, hermesHref, "the Hermes render's trial outcome was not recorded");
        throw new Error(`the Hermes render's curation entry is "${logged}"`);
      }
      await page.goto(`${APP}${hermesHref}`);
      await page.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
      await page.goto(`${APP}/studio/styles`);
      const hermesPack = page.getByTestId("style-pack-hermes-research-explainer");
      await hermesPack.getByTestId("pack-availability").getByText("Rendered by the portal through Hermes", { exact: true }).waitFor();
      await hermesPack.getByTestId("trial-record").getByText(/^Trial runs of v0\.1\.0: 1 .*mean presentation 75 \(1 scored\)/).waitFor();
      await shot("15c-styles-hermes-desktop");
    }
  }

  step("production: the render mixed the tagged music track as its bed, never the narration");
  {
    const musicId = dbValue(`SELECT id FROM assets WHERE title = 'Test music bed' AND 'music' = ANY(tags) ORDER BY created_at DESC LIMIT 1`);
    if (musicId === null) {
      console.log("   no database access (UI_DB unset): the bed check is skipped");
    } else {
      if (!/^[0-9a-f-]{36}$/.test(musicId)) throw new Error(`the uploaded music track has no music tag (got "${musicId}")`);
      const row = dbValue(
        `SELECT coalesce(payload->'audio'->'bed'->>'assetId', 'none') || ' ' || coalesce(payload->>'narrationAssetId', '') || ' ' || ` +
          `coalesce(payload->'audio'->'ambient'->>'color', 'none') || ' ' || (payload->'inputs' ? '${musicId}')::text || ' ' || (payload ? 'captionStyle')::text ` +
          `FROM jobs WHERE type = 'render-video' AND payload ? 'runId' ORDER BY created_at DESC LIMIT 1`,
      );
      const [bedId, narrationId, ambient, listed, styled] = (row ?? "").split(" ");
      if (bedId !== musicId) {
        await dumpPipeline(m, productionRunHref, "the render job's bed is not the tagged music track");
        throw new Error(`the render job's bed is ${bedId}, not the uploaded music track ${musicId}`);
      }
      if (!narrationId || bedId === narrationId) throw new Error(`the render job uses its narration ${narrationId} as the bed`);
      if (ambient !== "brown") throw new Error(`the render job's mix has no ambience (${ambient})`);
      if (listed !== "true") throw new Error("the music track is not among the render job's inputs, so the worker could not download it");
      if (styled !== "true") throw new Error("the render job carries no captionStyle, though the worker reports caption-style");
      const result = dbValue(`SELECT coalesce(result->'audioMix'->'bed'->>'assetId', 'none') FROM jobs WHERE type = 'render-video' AND payload ? 'runId' ORDER BY created_at DESC LIMIT 1`);
      if (result !== musicId) throw new Error(`the worker did not report mixing the bed (result.audioMix.bed = ${result})`);
      const licence = dbValue(`SELECT license FROM assets WHERE kind = 'video' AND metadata->>'executor' = 'render-video' ORDER BY created_at DESC LIMIT 1`) ?? "";
      if (!licence.includes("Music bed: Test music bed (uploaded from https://example.com/venstudio-test-music): Own composition for tests, all rights")) {
        throw new Error(`the render's licence does not name the music bed: ${licence.slice(0, 300)}`);
      }
      console.log(`   bed ${musicId} (looped under the narration ${narrationId}), named in the render's licence`);
    }
  }

  step("director: the script and storyboard prompts carried the purposes and subtitles");
  {
    const scriptAsk = lastPrompt.script ?? "";
    for (const want of ["contains affiliate links", "call to action", "hook to the next episode", "translate well"]) {
      if (!scriptAsk.includes(want)) throw new Error(`the script prompt misses "${want}"`);
    }
    if (!dataBlock(scriptAsk, "owner brief").includes(STUDIO_BRIEF)) throw new Error("the script prompt has no owner brief block");
    const boardAsk = lastPrompt.storyboard ?? "";
    for (const want of ["disclosure card", "same in every shot", "bottom fifth of every frame"]) {
      if (!boardAsk.includes(want)) throw new Error(`the storyboard prompt misses "${want}"`);
    }
  }

  step("production: the run page lists each work order");
  await m.goto(`${APP}${assetsRunHref ?? runHref}`);
  await m.getByTestId("work-orders").waitFor();
  if ((await m.getByTestId("work-order").count()) < 3) throw new Error("the run page shows fewer than 3 work orders");
  if (!(await m.getByTestId("work-orders").textContent()).includes("canva")) throw new Error("the run page does not name the backend (canva)");
  // shot-01 got every 429 of the burst. Waiting for Hermes must not have used up its attempts.
  const firstOrder = await m.getByTestId("work-order").filter({ hasText: "shot-01" }).first().innerText();
  if (!/\b1 attempt\b(?!s)/.test(firstOrder)) throw new Error(`shot-01 should show 1 attempt after the 429 burst, saw: ${firstOrder.replace(/\s+/g, " ")}`);
  if ((await m.locator('[data-testid="work-order"][data-state="failed"]').count()) !== 0) throw new Error("a work order failed during the run");
  if (fakeStats.routerBadImageCalls !== 1) throw new Error("the set-aside 9router image model was asked again later in the run");
  await assertNoOverflow(m, "run page");
  await shot("25-run-production-mobile", m);
  await m.goto(`${APP}/review`);
  await m.getByText("Nothing waiting for you.").waitFor();

  step("director: invalid JSON from Hermes shows a stage error with Retry (an Indonesian video, no brief beyond the marker)");
  await page.goto(`${APP}/studio/new`);
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.fill("#brief", "BREAK-JSON please");
  await page.selectOption("#language", "id");
  await page.getByTestId("kokoro-flag").getByText("Not in Kokoro", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();
  await waitPrompt("idea", (t) => t.includes("BREAK-JSON") && t.includes("language code id"), "the Indonesian narration language");
  await waitShown(m, "/review", (p) => p.locator('[data-kind="stage-error"]'), "the stage error card");
  await m.getByRole("button", { name: "Retry" }).first().waitFor();
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review");
  await assertTapTargets(m, [["Retry", m.getByRole("button", { name: "Retry" })]]);
  await shot("19-review-error-mobile", m);

  step("director: reject cancels the run and empties the inbox");
  await m.getByRole("button", { name: "Reject" }).first().click();
  await m.getByText("Nothing waiting for you.").waitFor();

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("UI E2E PASS");
} catch (err) {
  await shot("zz-failure").catch(() => {});
  console.error(errors.join("\n"));
  throw err;
} finally {
  await browser.close();
  fakeHermes.close();
  fakeRouter.close();
  for (const sock of routerSockets) sock.destroy();
}
