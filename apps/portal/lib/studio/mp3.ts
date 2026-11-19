/** Duration of an MP3 file by walking its frame headers. Pure. Covers constant and variable bit rate files. */

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES_V1 = [44100, 48000, 32000];
const MIN_FRAMES = 4;

/** Seconds of audio, or null when the bytes are not a clean run of MPEG layer III frames. */
export function mp3DurationSec(bytes: Uint8Array): number | null {
  let pos = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    pos = 10 + size;
  }
  // Find the first frame header, allowing a little padding after a tag.
  const limit = Math.min(bytes.length - 4, pos + 4096);
  while (pos < limit && !header(bytes, pos)) pos++;
  let seconds = 0;
  let frames = 0;
  while (pos + 4 <= bytes.length) {
    const h = header(bytes, pos);
    if (!h) break;
    seconds += h.samples / h.sampleRate;
    frames++;
    pos += h.length;
  }
  return frames >= MIN_FRAMES ? Math.round(seconds * 100) / 100 : null;
}

function header(b: Uint8Array, i: number): { length: number; samples: number; sampleRate: number } | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (b[i + 1] >> 3) & 3; // 0 = 2.5, 2 = 2, 3 = 1
  const layerBits = (b[i + 1] >> 1) & 3; // 1 = layer III
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIndex = (b[i + 2] >> 4) & 15;
  const rateIndex = (b[i + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const padding = (b[i + 2] >> 1) & 1;
  const v1 = versionBits === 3;
  const sampleRate = RATES_V1[rateIndex] / (v1 ? 1 : versionBits === 2 ? 2 : 4);
  const bitrate = (v1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
  const samples = v1 ? 1152 : 576;
  const length = Math.floor(((v1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return length >= 4 ? { length, samples, sampleRate } : null;
}
