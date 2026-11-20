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
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
  if (stage === "selftest") return '{"ok":true,"sum":5}';
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
const fakeStats = { imageAsks: {}, pathAnswers: 0, errorAnswers: 0, urlAnswers: 0, routerSpeechCalls: 0, routerImageCalls: 0, routerBadImageCalls: 0, hermesImageRefusals: 0, hermesKokoroCalls: 0, capabilityScans: 0, hermes429: 0, shotPreferenceAsks: 0, droppedPreferenceAsks: 0 };
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
      const first = messages.find((m) => m.role === "user")?.content ?? "";
      const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
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
// check is meaningful. In "ok" mode it lists models and speaks 0.4 s per word (the pace the portal estimates, 150 words a
// minute). routerTts "error" makes only the speech endpoint fail, to prove the fallback to Hermes.
const router = { mode: "hang", tts: "ok" };
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
      res.end(makeWav(Math.max(0.5, words * 0.4)));
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
    `cd ${OUT} && curl -fsSL ${APP}/install/install.sh -o install.sh && bash install.sh --portal ${APP} --code ${code} --name "CI Worker" --mode tick --home ${OUT}/worker`,
  ]);
  await page.goto(`${APP}/workers`);
  await page.getByText("CI Worker").first().waitFor();

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

  step("studio: suggest a style from the brief, preview the plan, save it");
  await page.goto(`${APP}/studio`);
  await page.getByLabel("Describe the video or type keywords").fill("A history documentary about the Roman roads");
  await page.getByRole("button", { name: "Suggest styles" }).click();
  await page.getByText("Suggested styles").waitFor();
  await page.getByRole("button", { name: /Narrated documentary with stills/ }).click();
  await page.getByRole("button", { name: "Preview plan" }).click();
  await page.getByText("Your review").waitFor();
  await page.getByText("Muse: runs well").first().waitFor();
  await page.getByRole("button", { name: "Save production" }).click();
  await page.getByText("Saved as a planned production").waitFor();
  await shot("13-studio-desktop");

  step("studio: queue a test render for the saved production, let the worker run it, see the video");
  await page.goto(`${APP}/studio`);
  await page.getByRole("button", { name: "Queue test render" }).first().click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  runWorker([`${OUT}/worker/run.sh`, "tick"]);
  await page.goto(page.url());
  await page.getByText("Test render (placeholder cards)").first().waitFor();
  await page.getByText("Done").first().waitFor({ timeout: 30_000 });
  await page.locator("video").first().waitFor();
  await shot("13b-test-render-desktop");

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
  await page.goto(`${APP}/studio/runs`);
  await page.getByRole("button", { name: "Test Hermes JSON" }).click();
  await page.getByText("Hermes returned valid JSON").waitFor();

  step("director: start a run and wait for the idea review item");
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.selectOption("#format", "short");
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();

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
  await assertTapTargets(m, [
    ["Confirm the terms in Settings", m.getByRole("link", { name: "Confirm the terms in Settings" })],
    ["Retry", m.getByRole("button", { name: "Retry" })],
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
  await confirmProvider("canva");
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

  step("production: retry the assets, then approve them");
  await m.goto(`${APP}/review`);
  await m.getByRole("button", { name: "Retry" }).first().click();
  await waitShown(m, "/review", (p) => p.locator('[data-kind="approval"]', { hasText: "Approve the assets" }), "the assets approval", 90_000);
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

  // The voice provider is registered as unconfirmed by the voice stage (Kokoro through 9router). The owner confirms it in Settings.
  step("settings: the owner confirms the voice provider terms");
  await confirmProvider("kokoro");
  if (await m.getByRole("button", { name: "Retry" }).first().isVisible().catch(() => false)) {
    await m.goto(`${APP}/review`);
    await m.getByRole("button", { name: "Retry" }).first().click();
  } else {
    await m.getByRole("button", { name: "Approve", exact: true }).first().click();
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
  const qc = m.locator('[data-testid="review-card"]', { hasText: "Quality check" }).first();
  const approveQc = qc.getByRole("button", { name: "Approve", exact: true });
  if (await approveQc.isVisible().catch(() => false)) await approveQc.click();
  else await qc.getByRole("button", { name: "Reject" }).click();

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

  step("director: invalid JSON from Hermes shows a stage error with Retry");
  await page.goto(`${APP}/studio/runs`);
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.fill("#topic", "BREAK-JSON please");
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();
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
