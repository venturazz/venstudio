import { test } from "node:test";
import assert from "node:assert/strict";
import { mp3DurationSec } from "./mp3.ts";

/** MPEG1 layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes per frame, 1152 samples. */
function frames(n: number, tag = 0): Uint8Array {
  const out = new Uint8Array(tag + n * 417);
  if (tag > 0) {
    out.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (tag - 10) >> 7, (tag - 10) & 0x7f]);
  }
  for (let i = 0; i < n; i++) out.set([0xff, 0xfb, 0x90, 0x00], tag + i * 417);
  return out;
}

test("mp3DurationSec adds up frame lengths", () => {
  const sec = mp3DurationSec(frames(100)) as number;
  assert.ok(Math.abs(sec - (100 * 1152) / 44100) < 0.01, String(sec));
});

test("mp3DurationSec skips an ID3 tag", () => {
  const sec = mp3DurationSec(frames(50, 200)) as number;
  assert.ok(Math.abs(sec - (50 * 1152) / 44100) < 0.01, String(sec));
});

test("mp3DurationSec returns null for other data", () => {
  assert.equal(mp3DurationSec(new Uint8Array(1000)), null);
  assert.equal(mp3DurationSec(new TextEncoder().encode("RIFF....WAVE")), null);
  assert.equal(mp3DurationSec(frames(2)), null);
});
