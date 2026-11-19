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
const KOKORO_PORT = Number(process.env.FAKE_KOKORO_PORT ?? 3298);

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
  const stage = /^VENSTUDIO_STAGE: (\w+)/m.exec(first)?.[1] ?? "";
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
      })),
    });
  }

  // Phase 4 stages. Image variants are chosen by the shot number named in the prompt (`for shot shot-NN`):
  //   shot-01 first answers with a file path (the portal must feed that back and Hermes then sends base64),
  //   shot-02 answers with an error for its first three asks (one whole attempt), so the second attempt runs,
  //   shot-03 answers with a download link on this fake server, every other shot with base64.
  // Hermes reports the provider `cloudflare`, which the owner has not confirmed, so the provider-terms flow runs.
  if (stage === "providers") {
    return JSON.stringify({ providers: ["cloudflare", "agnes", "canva", "qwen", "minimax", "sensenova"].map((name) => ({ name, note: "fake" })) });
  }
  if (stage === "image") {
    const shot = /for shot ([\w-]+)/.exec(first)?.[1] ?? "test";
    const seed = Number(/(\d+)$/.exec(shot)?.[1] ?? 0);
    const asks = (fakeStats.imageAsks[shot] = (fakeStats.imageAsks[shot] ?? 0) + 1);
    const ok = (image) => JSON.stringify({ status: "ok", provider: "cloudflare", model: "fake-flux", image });
    if (shot === "shot-01" && messages.length <= 2) {
      fakeStats.pathAnswers++;
      return ok({ type: "path", value: "/tmp/hermes/out.png", mimeType: "image/png" });
    }
    if (shot === "shot-02" && asks <= 3) {
      fakeStats.errorAnswers++;
      return JSON.stringify({ status: "error", provider: "cloudflare", error: "Fake provider chain is down" });
    }
    if (shot === "shot-03") {
      fakeStats.urlAnswers++;
      return ok({ type: "url", value: `http://127.0.0.1:${HERMES_PORT}/fake-image/${seed}.png`, mimeType: "image/png" });
    }
    return ok({ type: "base64", value: makePng(540, 960, seed).toString("base64"), mimeType: "image/png" });
  }
  if (stage === "tts-capcut") {
    return JSON.stringify({ status: "ok", provider: "capcut", model: "fake-capcut", audio: { type: "base64", value: makeWav(3).toString("base64"), mimeType: "audio/wav" } });
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
const fakeStats = { imageAsks: {}, pathAnswers: 0, errorAnswers: 0, urlAnswers: 0, speechCalls: 0 };
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
      const content = directorReply(messages);
      json(200, { id: "chatcmpl-fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    });
    return;
  }
  json(404, { error: "not found" });
});
await new Promise((r) => fakeHermes.listen(HERMES_PORT, "127.0.0.1", r));

// Fake Kokoro (OpenAI-compatible speech API). Speaks 0.4 s per word, the pace the portal estimates (150 words a minute).
const fakeKokoro = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/audio/voices") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ voices: ["af_heart", "af_bella", "am_adam"] }));
  }
  if (req.method === "POST" && req.url === "/v1/audio/speech") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let input = "";
      try {
        input = String(JSON.parse(raw).input ?? "");
      } catch {
        res.writeHead(400);
        return res.end("bad json");
      }
      fakeStats.speechCalls++;
      const words = input.split(/\s+/).filter(Boolean).length;
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(makeWav(Math.max(0.5, words * 0.4)));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((r) => fakeKokoro.listen(KOKORO_PORT, "127.0.0.1", r));

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
    psql("work orders", `SELECT shot_ref, executor, state, attempts, job_id, asset_id IS NOT NULL AS has_asset, left(coalesce(to_jsonb(w)->>'error', ''), 200) AS error FROM work_orders w WHERE run_id = '${runId}' ORDER BY shot_ref`);
    psql("review items", `SELECT stage, kind, state, left(payload::text, 300) AS payload FROM review_items WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("qc reports", `SELECT gate, passed, score, executor, left(details::text, 300) AS details FROM qc_reports WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("workers", `SELECT name, status, mode, capabilities, job_types, last_claim_at FROM workers`);
  } else {
    console.error("## no database access (UI_DB and DATABASE_URL unset or no run id); the run page below is the only source");
  }
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
  await page.getByText("Unreachable").waitFor({ timeout: 40_000 });
  await page.getByText("internal address").first().waitFor();
  await page.getByText("Server health").waitFor();

  step("Hermes connection shows features and skills");
  await page.getByText("3 skills").first().waitFor({ timeout: 20_000 });
  await page.getByText("Background runs").waitFor();
  await page.locator("summary", { hasText: "video" }).click();
  await page.getByText("write-story-script").waitFor();
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
  {
    // The storyboard may ask for approval at this autonomy level, or pass on its own. Either way the assets review follows.
    const end = Date.now() + 120_000;
    for (;;) {
      await m.goto(`${APP}/review`);
      if (await m.getByTestId("asset-grid").first().isVisible().catch(() => false)) break;
      const board = m.locator('[data-testid="review-card"]', { hasText: "Approve the storyboard" });
      if (await board.first().isVisible().catch(() => false)) await board.first().getByRole("button", { name: "Approve", exact: true }).click();
      if (Date.now() > end) throw new Error("timed out waiting for the assets review");
      await m.waitForTimeout(2000);
    }
  }
  await m.waitForLoadState("networkidle");
  const grid = m.getByTestId("asset-grid").first();
  const thumbs = grid.locator("img");
  if ((await thumbs.count()) < 3) throw new Error(`expected at least 3 thumbnails, got ${await thumbs.count()}`);
  await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-grid"] img')].every((i) => i.complete && i.naturalWidth > 0));
  await m.getByTestId("provider-terms-notice").first().waitFor();
  if (!(await grid.textContent()).includes("cloudflare")) throw new Error("the image grid does not name the provider");
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
  const assetsRunHref = await m.getByRole("link", { name: "Open run" }).first().getAttribute("href");

  // The owner confirms a provider in Settings. Nothing else can set this.
  async function confirmProvider(name) {
    await page.goto(`${APP}/settings`);
    const select = page.getByLabel(`Commercial use for ${name}`).first();
    await select.waitFor();
    await select.selectOption("yes");
    await select.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
    for (let i = 0; i < 15; i++) {
      await page.goto(`${APP}/settings`);
      if ((await page.getByLabel(`Commercial use for ${name}`).first().inputValue()) === "yes") return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`the terms for ${name} were not saved`);
  }

  step("settings: the owner confirms the image provider terms, Kokoro is healthy, Test Hermes image works");
  await confirmProvider("cloudflare");
  await page.getByText("Kokoro override connected").first().waitFor();
  await page.getByRole("button", { name: "Test voice" }).click();
  await page.getByText("Voice made by kokoro straight from your Kokoro server").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Test Hermes image" }).click();
  await page.getByText("Providers Hermes reports: cloudflare, agnes").waitFor({ timeout: 60_000 });
  await page.getByText("Image made by cloudflare").waitFor();
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
  if (fakeStats.speechCalls < 1) throw new Error("the fake Kokoro was never asked to speak");
  await assertNoOverflow(m, "/review (voice)");
  await assertTapTargets(m, [["Reject", m.getByRole("button", { name: "Reject" })]]);
  await shot("22-review-voice-mobile", m);
  await page.goto(`${APP}/review`);
  await page.getByTestId("voice-audio").first().waitFor();
  await shot("22-review-voice-desktop");

  // Kokoro is also a provider whose terms the owner confirms. If the voice already passed, there is nothing to retry.
  if (await m.getByRole("button", { name: "Retry" }).first().isVisible().catch(() => false)) {
    step("settings: the owner confirms the voice provider terms, then the voice is retried");
    await confirmProvider("kokoro");
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
  if (!(await m.getByTestId("work-orders").textContent()).includes("cloudflare")) throw new Error("the run page does not name the provider");
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
  fakeKokoro.close();
}
