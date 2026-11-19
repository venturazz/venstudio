// Browser end-to-end: drives the real UI the way a user would, then runs the real worker.
// Saves desktop and mobile screenshots to .e2e-ui/screenshots.
//
// Needs: portal running at APP_URL against an EMPTY database, SETUP_TOKEN set on it, ffmpeg, Playwright Chromium.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
const fakeHermes = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
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
  json(404, { error: "not found" });
});
await new Promise((r) => fakeHermes.listen(Number(process.env.FAKE_HERMES_PORT ?? 3299), "127.0.0.1", r));

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
  for (const [name, url] of [
    ["08-overview-mobile", "/"],
    ["09-channels-mobile", "/channels"],
    ["10-workers-mobile", "/workers"],
    ["11-jobs-mobile", "/jobs"],
    ["12-settings-mobile", "/settings"],
    ["13-studio-mobile", "/studio"],
    ["14-assets-mobile", "/assets"],
    ["15-styles-mobile", "/studio/styles"],
  ]) {
    await m.goto(`${APP}${url}`);
    await m.waitForLoadState("networkidle");
    await shot(name, m);
  }
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("mobile layout overflows horizontally");

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("UI E2E PASS");
} catch (err) {
  await shot("zz-failure").catch(() => {});
  console.error(errors.join("\n"));
  throw err;
} finally {
  await browser.close();
  fakeHermes.close();
}
