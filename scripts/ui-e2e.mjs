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
  const secret = (await page.locator("code").first().textContent()).trim();
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
  const command = (await page.locator("pre").nth(1).textContent()).trim();
  const code = /--code (VS-[A-Z0-9-]+)/.exec(command)?.[1];
  if (!code) throw new Error(`no code in command: ${command}`);
  runWorker([
    "-c",
    `curl -fsSL ${APP}/install/install.sh | bash -s -- --portal ${APP} --code ${code} --name "CI Worker" --mode tick --home ${OUT}/worker`,
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
  await page.goto(`${APP}/`);
  await shot("07-overview-desktop");

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
}
