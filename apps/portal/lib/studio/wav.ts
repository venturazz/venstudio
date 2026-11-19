/**
 * Pure WAV helpers for portal-side narration. The portal image has no ffmpeg, so chunks of Kokoro audio are
 * joined here. Only 16-bit PCM is supported; anything else is rejected with a plain message.
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
  /** The raw PCM16 little-endian sample bytes of the data chunk. */
  pcm: Uint8Array;
  durationSec: number;
  /** Largest absolute sample, 0 to 1. */
  peak: number;
  /** Share of samples at full scale (32767 or -32768), 0 to 1. */
  clippedRatio: number;
}

/** More than this share of full-scale samples counts as clipped narration. */
export const CLIP_RATIO_LIMIT = 0.001;

export class WavError extends Error {}

function tag(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") {
    throw new WavError("The narration is not a WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Uint8Array | null = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(bytes, pos);
    const declared = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (id === "fmt ") {
      if (declared < 16 || start + 16 > bytes.length) throw new WavError("The WAV header is damaged");
      fmt = {
        format: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === "data") {
      // Streaming encoders write 0 or 0xFFFFFFFF as the size. Use what is actually there.
      const size = declared === 0 || start + declared > bytes.length ? bytes.length - start : declared;
      data = bytes.subarray(start, start + size);
      break;
    }
    pos = start + declared + (declared % 2);
  }
  if (!fmt) throw new WavError("The WAV file has no format header");
  if (!data) throw new WavError("The WAV file has no audio data");
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new WavError(`Only 16-bit PCM WAV is supported (this file is format ${fmt.format}, ${fmt.bits}-bit)`);
  }
  if (fmt.channels < 1 || fmt.channels > 2 || fmt.sampleRate < 8000 || fmt.sampleRate > 192000) {
    throw new WavError("The WAV file has an unusual channel count or sample rate");
  }
  const usable = data.length - (data.length % (2 * fmt.channels));
  const pcm = data.subarray(0, usable);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const total = usable / 2;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < total; i++) {
    const s = dv.getInt16(i * 2, true);
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (s === 32767 || s === -32768) clipped++;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: 16,
    pcm,
    durationSec: total / fmt.channels / fmt.sampleRate,
    peak: Math.min(1, peak / 32768),
    clippedRatio: total === 0 ? 0 : clipped / total,
  };
}

export function isClipped(info: Pick<WavInfo, "clippedRatio">): boolean {
  return info.clippedRatio > CLIP_RATIO_LIMIT;
}

/** Builds a canonical 44-byte-header WAV from PCM16 bytes. */
export function makeWav(args: { sampleRate: number; channels: number; pcm: Uint8Array }): Uint8Array {
  const { sampleRate, channels, pcm } = args;
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Joins WAV files that share one sample rate and channel count. */
export function concatWav(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) throw new WavError("There is no audio to join");
  const infos = parts.map(parseWav);
  const first = infos[0];
  infos.forEach((p, i) => {
    if (p.sampleRate !== first.sampleRate || p.channels !== first.channels) {
      throw new WavError(
        `Audio part ${i + 1} is ${p.sampleRate} Hz with ${p.channels} channel(s), but part 1 is ${first.sampleRate} Hz with ${first.channels}; they cannot be joined`,
      );
    }
  });
  const size = infos.reduce((n, p) => n + p.pcm.length, 0);
  const pcm = new Uint8Array(size);
  let at = 0;
  for (const p of infos) {
    pcm.set(p.pcm, at);
    at += p.pcm.length;
  }
  return makeWav({ sampleRate: first.sampleRate, channels: first.channels, pcm });
}

/** PCM16 silence of the given length. */
export function silencePcm(seconds: number, sampleRate: number, channels: number): Uint8Array {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  return new Uint8Array(frames * channels * 2);
}

/** Adds silence before and after a WAV, for example a short pause between chunks or a tail. */
export function padWithSilence(wav: Uint8Array, leadSec: number, tailSec: number): Uint8Array {
  const info = parseWav(wav);
  const lead = silencePcm(leadSec, info.sampleRate, info.channels);
  const tail = silencePcm(tailSec, info.sampleRate, info.channels);
  const pcm = new Uint8Array(lead.length + info.pcm.length + tail.length);
  pcm.set(lead, 0);
  pcm.set(info.pcm, lead.length);
  pcm.set(tail, lead.length + info.pcm.length);
  return makeWav({ sampleRate: info.sampleRate, channels: info.channels, pcm });
}
