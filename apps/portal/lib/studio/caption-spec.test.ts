import { test } from "node:test";
import assert from "node:assert/strict";
import { captionSpecFor, captionSpecIssues } from "./caption-spec.ts";

test("at the reference frame the spec is the measured one", () => {
  const s = captionSpecFor({ width: 1920, height: 1080, fontAssetId: "f1" });
  assert.equal(s.fontSizePx, 44);
  assert.deepEqual([s.minFontSizePx, s.maxFontSizePx], [36, 44]);
  assert.equal(s.outlinePx, 4);
  assert.equal(s.shadowPx, 3);
  assert.equal(s.marginXPx, 90);
  // 8 percent of 1080 is 86, wider than the measured 74: the safe area wins at the bottom, where platform
  // controls sit. The sides keep the measured ratio instead.
  assert.equal(s.marginBottomPx, 86);
  assert.equal(s.maxWidthPx, 1740);
  assert.equal(s.lineSpacingPx, 15);
  assert.equal(s.fontAssetId, "f1");
});

test("a narrow face gets the larger sizes the reference used", () => {
  const wide = captionSpecFor({ width: 1920, height: 1080 });
  const narrow = captionSpecFor({ width: 1920, height: 1080, narrowFace: true });
  assert.equal(narrow.fontSizePx, 58);
  assert.equal(narrow.minFontSizePx, 54);
  assert.ok(narrow.fontSizePx > wide.fontSizePx);
  assert.ok(narrow.outlinePx * 2 < narrow.fontSizePx);
});

test("the same spec is right in portrait, because it scales by height", () => {
  const s = captionSpecFor({ width: 1080, height: 1920, safeAreaPct: 8 });
  assert.equal(s.fontSizePx, 78); // 44 * 1920/1080 = 78.2
  assert.equal(s.marginXPx, 51); // 90 * 1080/1920 = 50.6
  assert.equal(s.marginBottomPx, 154); // 8 percent of 1920 beats 74 scaled to 132
  assert.equal(s.maxWidthPx, 1080 - 102);
  assert.deepEqual(captionSpecIssues(s, { width: 1080, height: 1920 }), []);
});

test("a missing font only fails a template that requires captions", () => {
  const s = captionSpecFor({ width: 1080, height: 1920 });
  assert.deepEqual(captionSpecIssues(s, { width: 1080, height: 1920 }), []);
  const required = captionSpecIssues(s, { width: 1080, height: 1920 }, { required: true });
  assert.equal(required.length, 1);
  assert.match(required[0], /no font/);
});

test("every frame the catalogue can make gets captions that fit", () => {
  for (const [w, h] of [
    [1080, 1920],
    [1920, 1080],
    [720, 1280],
    [3840, 2160],
  ]) {
    const s = captionSpecFor({ width: w, height: h, fontAssetId: "f1" });
    assert.deepEqual(captionSpecIssues(s, { width: w, height: h }, { required: true }), [], `${w}x${h}`);
    assert.equal(s.fontSizePx % 2, 0);
    assert.ok(s.maxWidthPx > 0);
  }
});