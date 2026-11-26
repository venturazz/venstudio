import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "./planner.ts";
import { previewSpec } from "./preview.ts";

test("test render spec uses the plan's format and lists its choices", () => {
  const built = buildPlan({ brief: "The rise of Rome", format: "short", styleId: "documentary", themeId: "history", purposeIds: ["educate"], language: "es", subtitles: ["en"] });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const spec = previewSpec(built.plan, "The rise of Rome");
  assert.equal(spec.width, 1080);
  assert.equal(spec.height, 1920);
  assert.equal(spec.durationSec, 20);
  assert.equal(spec.cards.length, 4);
  assert.match(spec.cards[0], /Narration \(|Documentary/);
  assert.equal(spec.cards[1], "History · Educate");
  assert.match(spec.cards[2], /Narration: Spanish · Subtitles: English/);
});

test("long productions get a 16:9 test render", () => {
  const built = buildPlan({ brief: "Roman roads", format: "long", styleId: "documentary" });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const spec = previewSpec(built.plan, "Roman roads");
  assert.equal([spec.width, spec.height].join("x"), "1920x1080");
  assert.equal(spec.cards[1], "No theme or purpose set");
});
