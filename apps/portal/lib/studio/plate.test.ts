// The plain-colour plate of a scene-spec run: a real PNG of the frame size, the same bytes every time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { solidPng, PLATE_EXECUTOR, PLATE_LICENCE } from "./plate.ts";

test("solidPng is a valid RGB PNG of the asked size, one colour, deterministic", () => {
  const png = Buffer.from(solidPng(1080, 1920));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [1080, 1920, 8, 2]);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 1920 * (1 + 1080 * 3));
  assert.ok(raw.every((b) => b === 0), "black, filter 0 on every row");
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
  assert.ok(png.length < 64 * 1024, `a plain plate is small (${png.length} bytes)`);
  assert.deepEqual(solidPng(1080, 1920), solidPng(1080, 1920));
  assert.equal(Buffer.from(solidPng(8, 4, [255, 0, 0])).readUInt32BE(16), 8);
  assert.equal(PLATE_EXECUTOR, "portal-plate");
  assert.match(PLATE_LICENCE, /no model, no third-party content/);
});
