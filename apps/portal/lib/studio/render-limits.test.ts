import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES, VIDEO_FORMATS, type Format } from "./catalog.ts";
import { MAX_SHOTS } from "./director.ts";
import { MAX_SCENES } from "./scene-plan.ts";
import { MAX_CAPTION_LINES } from "./production.ts";
import { RENDER_LIMITS } from "./render-limits.ts";
import { buildRenderPayload } from "./render.ts";
import { buildPlan, renderLimitWarning } from "./planner.ts";

test("the render limits come from the catalogue: the longest video at the fastest cut is 600 shots", () => {
  const longest = Math.max(...Object.values(VIDEO_FORMATS).map((f) => f.durationSec[1]));
  const fastest = Math.min(...STYLES.map((s) => s.shotSeconds[0]));
  assert.equal(longest / fastest, RENDER_LIMITS.maxShots);
  assert.ok(RENDER_LIMITS.maxSeconds >= longest);
  assert.equal(RENDER_LIMITS.maxCaptions, RENDER_LIMITS.maxShots * 2);
  // One number, everywhere a shot or a caption line is counted before work is spent.
  assert.equal(MAX_SHOTS, RENDER_LIMITS.maxShots);
  assert.equal(MAX_SCENES, RENDER_LIMITS.maxShots);
  assert.equal(MAX_CAPTION_LINES, RENDER_LIMITS.maxCaptions);
});

test("every style fits one render in every format it offers, so the planner raises no limit warning today", () => {
  for (const style of STYLES) {
    for (const format of style.formats as Format[]) assert.equal(renderLimitWarning(style, format), null, `${style.id} ${format}`);
  }
  const plan = buildPlan({ brief: "How blades are forged", format: "long", styleId: "explainer-flat-vector" });
  assert.ok(plan.ok && !plan.plan.warnings.some((w) => w.includes("one render takes")));
});

test("a style that would need more shots than one render takes is warned about at planning, before any work", () => {
  const w = renderLimitWarning({ label: "Strobe cuts", shotSeconds: [1, 2] }, "long");
  assert.equal(w, "Strobe cuts cuts as often as every 1 s, so a 20-minute video can need 1200 shots, more than the 600 one render takes. Keep this video under 10 minutes, or split it into parts.");
});

test("buildRenderPayload refuses more shots or caption lines than the worker takes, before the job is queued", () => {
  const shots = Array.from({ length: 601 }, (_, i) => ({ shotRef: `s${i}`, seconds: 2 }));
  const shotAssets = Object.fromEntries(shots.map((s, i) => [s.shotRef, `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`]));
  const plan = buildRenderPayload({
    format: "long",
    shots,
    shotAssets,
    narrationAssetId: "aaaaaaaa-1111-4111-8111-0000000000ff",
    narrationSec: 1202,
    captions: Array.from({ length: 1201 }, () => "A line."),
    targetLufs: -14,
    maxShotSeconds: 4,
  });
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.ok(plan.issues.includes("601 shots is more than the 600 one render takes"), plan.issues.join(" | "));
    assert.ok(plan.issues.includes("1201 caption lines is more than the 1200 one render takes"), plan.issues.join(" | "));
  }
});
