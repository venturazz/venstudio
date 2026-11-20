/**
 * Reads what Hermes sends back for an image or audio request, and checks the bytes. Hermes' image_gen and CapCut
 * return formats are not documented, so the reply is parsed tolerantly and anything unusable becomes an issue
 * that is fed back to Hermes on retry. Pure: no network, no zod.
 */
import { VIDEO_FORMATS, type Format } from "./catalog.ts";
import { extractJson } from "./director.ts";

export type MediaKind = "image" | "audio";

export interface MediaSource {
  type: "url" | "base64" | "data-uri";
  value: string;
  mimeType: string;
}

export type MediaReply =
  | { ok: true; source: MediaSource; provider: string; model: string; backend: string }
  | { ok: false; issues: string[] };

export const MIN_IMAGE_SHORT_SIDE = 480;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

const PATH_ISSUE = "The reply gave a file path, which the studio cannot read. Return an https URL or base64 data instead.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const MIME_PREFIX: Record<MediaKind, string> = { image: "image/", audio: "audio/" };

function dataUriSource(uri: string, kind: MediaKind): MediaSource | string {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)?(?:;[a-z0-9=.+-]+)*;base64,([A-Za-z0-9+/=\s_-]+)$/i.exec(uri.trim());
  if (!m) return "The data: URI is not base64 encoded";
  const mime = (m[1] ?? "").toLowerCase();
  if (mime && !mime.startsWith(MIME_PREFIX[kind])) return `The data: URI is ${mime}, expected ${kind}`;
  return { type: "data-uri", value: m[2].replace(/\s+/g, ""), mimeType: mime };
}

function sourceFrom(raw: unknown, kind: MediaKind): MediaSource | string {
  if (typeof raw === "string") return sourceFrom({ type: guessType(raw), value: raw }, kind);
  if (!isRecord(raw)) return `The reply has no ${kind} field`;
  const type = str(raw.type).toLowerCase();
  const value = str(raw.value);
  const mimeType = str(raw.mimeType).toLowerCase();
  if (!value) return `The ${kind} value is empty`;
  if (type === "path" || type === "file") return PATH_ISSUE;
  if (type === "url") {
    if (!/^https?:\/\/\S+$/i.test(value)) return `The ${kind} URL must start with http:// or https://`;
    return { type: "url", value, mimeType };
  }
  if (type === "data-uri" || value.toLowerCase().startsWith("data:")) {
    const d = dataUriSource(value, kind);
    return typeof d === "string" ? d : { ...d, mimeType: d.mimeType || mimeType };
  }
  if (type === "base64") {
    const b64 = value.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64) || b64.length < 16) return `The base64 ${kind} data is not valid`;
    return { type: "base64", value: b64, mimeType };
  }
  if (/^(\/|\.\/|~\/|[A-Za-z]:\\)/.test(value)) return PATH_ISSUE;
  return `The ${kind} type "${type}" is not one of url, base64 or data-uri`;
}

function guessType(v: string): string {
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return "url";
  if (s.toLowerCase().startsWith("data:")) return "data-uri";
  if (/^(\/|\.\/|~\/|[A-Za-z]:\\)/.test(s)) return "path";
  return "base64";
}

function fallbackSource(text: string, kind: MediaKind): MediaSource | null {
  const dataUri = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/i.exec(text);
  if (dataUri) {
    const d = dataUriSource(dataUri[0], kind);
    if (typeof d !== "string") return d;
  }
  const md = /!?\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i.exec(text);
  if (md) return { type: "url", value: md[1], mimeType: "" };
  const bare = /https?:\/\/[^\s<>"')\]]+/i.exec(text);
  if (bare) return { type: "url", value: bare[0].replace(/[.,;:!?]+$/, ""), mimeType: "" };
  return null;
}

function parseMediaReply(text: string, kind: MediaKind): MediaReply {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    const status = str(parsed.status).toLowerCase();
    if (status === "error" || status === "failed" || (parsed.error && !parsed[kind])) {
      return { ok: false, issues: [`Hermes reported an error: ${str(parsed.error) || "no detail given"}`] };
    }
    const src = sourceFrom(parsed[kind] ?? parsed.result, kind);
    if (typeof src === "string") return { ok: false, issues: [src] };
    return { ok: true, source: src, provider: str(parsed.provider), model: str(parsed.model), backend: str(parsed.source) };
  }
  if (/(^|\s)(\/|~\/|[A-Za-z]:\\)\S+\.(png|jpe?g|webp|wav|mp3|ogg)\b/i.test(text) && !fallbackSource(text, kind)) {
    return { ok: false, issues: [PATH_ISSUE] };
  }
  const loose = fallbackSource(text, kind);
  if (loose) return { ok: true, source: loose, provider: "", model: "", backend: "" };
  return { ok: false, issues: [`The reply has no ${kind}. Return the JSON object, or an https URL, or base64 data.`] };
}

export function parseImageReply(text: string): MediaReply {
  return parseMediaReply(text, "image");
}

export function parseAudioReply(text: string): MediaReply {
  return parseMediaReply(text, "audio");
}

/** Decodes base64 or data-uri sources. Returns null for a url source (fetch it instead). */
export function decodeInlineSource(source: MediaSource): Uint8Array | null {
  if (source.type === "url") return null;
  const b64 = source.value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  bytes: number;
}

const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...Array.from(b.subarray(at, at + n)));

/** Identifies png, jpeg and webp by magic bytes and reads the size from the header. Null when unrecognised. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") {
    return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20), bytes: b.length };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let pos = 2;
    while (pos + 9 < b.length) {
      if (b[pos] !== 0xff) {
        pos++;
        continue;
      }
      const marker = b[pos + 1];
      if (marker === 0xff) {
        pos++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { mime: "image/jpeg", height: u16be(b, pos + 5), width: u16be(b, pos + 7), bytes: b.length };
      pos += 2 + u16be(b, pos + 2);
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 ") return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, bytes: b.length };
    if (chunk === "VP8L" && b[20] === 0x2f) {
      const width = 1 + (b[21] | ((b[22] & 0x3f) << 8));
      const height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
      return { mime: "image/webp", width, height, bytes: b.length };
    }
    if (chunk === "VP8X") return { mime: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27), bytes: b.length };
  }
  return null;
}

export function imageIssues(info: ImageInfo | null, format: Format): string[] {
  if (!info) return ["The file is not a PNG, JPEG or WebP image"];
  const issues: string[] = [];
  const target = VIDEO_FORMATS[format];
  if (info.width < 1 || info.height < 1) issues.push("The image has no size");
  else if (Math.min(info.width, info.height) < MIN_IMAGE_SHORT_SIDE) {
    issues.push(
      `The image is ${info.width}x${info.height}; the short side must be at least ${MIN_IMAGE_SHORT_SIDE} px for a ${target.width}x${target.height} video`,
    );
  }
  if (info.bytes > MAX_IMAGE_BYTES) issues.push(`The image is ${Math.round(info.bytes / 1048576)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB`);
  return issues;
}

export interface AudioInfo {
  mime: "audio/wav" | "audio/mpeg" | "audio/ogg";
  bytes: number;
}

/** Identifies wav, mp3 and ogg by magic bytes. Null when unrecognised. */
export function sniffAudio(b: Uint8Array): AudioInfo | null {
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return { mime: "audio/wav", bytes: b.length };
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", bytes: b.length };
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return { mime: "audio/mpeg", bytes: b.length };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { mime: "audio/mpeg", bytes: b.length };
  return null;
}

/** CapCut backup audio: WAV or MP3 only, because the portal can measure their length and Ogg it cannot. */
export function capcutAudioIssues(info: AudioInfo | null): string[] {
  const base = audioIssues(info);
  if (base.length > 0) return base;
  if (info && info.mime === "audio/ogg") return ["The audio is Ogg. Return the narration as a WAV or MP3 file instead"];
  return [];
}

export function audioIssues(info: AudioInfo | null): string[] {
  if (!info) return ["The file is not a WAV, MP3 or OGG audio file"];
  if (info.bytes < 1000) return ["The audio file is almost empty"];
  if (info.bytes > MAX_AUDIO_BYTES) return [`The audio is ${Math.round(info.bytes / 1048576)} MB; the limit is ${MAX_AUDIO_BYTES / 1048576} MB`];
  return [];
}
