import { test } from "node:test";
import assert from "node:assert/strict";
import { concatWav, isClipped, makeWav, padWithSilence, parseWav, silencePcm, WavError } from "./wav.ts";

function tone(samples: number[], sampleRate = 24000, channels = 1): Uint8Array {
  const pcm = new Uint8Array(samples.length * 2);
  const dv = new DataView(pcm.buffer);
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
  return makeWav({ sampleRate, channels, pcm });
}

test("parseWav roundtrips duration, peak and format", () => {
  const info = parseWav(tone(Array.from({ length: 24000 }, (_, i) => (i % 2 ? 8192 : -8192))));
  assert.equal(info.sampleRate, 24000);
  assert.equal(info.channels, 1);
  assert.equal(info.durationSec, 1);
  assert.equal(info.peak, 0.25);
  assert.equal(info.clippedRatio, 0);
  assert.equal(isClipped(info), false);
});

test("parseWav reports clipped samples", () => {
  const info = parseWav(tone([32767, -32768, 0, 0, 100, 100, 100, 100, 100, 100]));
  assert.equal(info.clippedRatio, 0.2);
  assert.equal(isClipped(info), true);
});

test("parseWav rejects non-WAV and non-PCM16", () => {
  assert.throws(() => parseWav(new Uint8Array(10)), WavError);
  const w = tone([1, 2, 3, 4]);
  new DataView(w.buffer).setUint16(34, 8, true);
  assert.throws(() => parseWav(w), /16-bit PCM/);
  const f = tone([1, 2, 3, 4]);
  new DataView(f.buffer).setUint16(20, 3, true);
  assert.throws(() => parseWav(f), /16-bit PCM/);
});

test("parseWav copes with a streaming data size of zero", () => {
  const w = tone([1, 2, 3, 4]);
  new DataView(w.buffer).setUint32(40, 0, true);
  assert.equal(parseWav(w).pcm.length, 8);
});

test("concatWav joins parts into one valid WAV", () => {
  const joined = concatWav([tone([1, 2]), tone([3, 4, 5])]);
  const info = parseWav(joined);
  assert.equal(info.pcm.length, 10);
  assert.equal(new DataView(info.pcm.buffer, info.pcm.byteOffset).getInt16(8, true), 5);
});

test("concatWav rejects mismatched formats and empty input", () => {
  assert.throws(() => concatWav([tone([1, 2], 24000), tone([1, 2], 16000)]), /cannot be joined/);
  assert.throws(() => concatWav([tone([1, 2], 24000, 1), tone([1, 2], 24000, 2)]), /cannot be joined/);
  assert.throws(() => concatWav([]), WavError);
});

test("padWithSilence adds lead and tail", () => {
  const padded = parseWav(padWithSilence(tone(new Array(24000).fill(1000)), 0.5, 0.25));
  assert.equal(padded.durationSec, 1.75);
  assert.equal(silencePcm(1, 100, 2).length, 400);
});
