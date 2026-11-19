/** Narration helpers: Kokoro voices per language, script chunking, duration estimate. Pure. */
import { DEFAULT_WORDS_PER_MINUTE } from "./director.ts";
import { LANGUAGE_BY_CODE } from "./catalog.ts";

export interface VoiceChoice {
  voice: string;
  /** True only for voices someone has heard and checked. Only English is verified. */
  verified: boolean;
}

/** Kokoro default voice per language code. Names follow Kokoro's published voice list; only English is verified. */
export const KOKORO_DEFAULT_VOICES: Record<string, VoiceChoice> = {
  en: { voice: "af_heart", verified: true },
  es: { voice: "ef_dora", verified: false },
  fr: { voice: "ff_siwis", verified: false },
  hi: { voice: "hf_alpha", verified: false },
  it: { voice: "if_sara", verified: false },
  ja: { voice: "jf_alpha", verified: false },
  zh: { voice: "zf_xiaobei", verified: false },
  pt: { voice: "pf_dora", verified: false },
};

/** The voice to ask Kokoro for. `override` is the owner's KOKORO_VOICE, used for English only. */
export function kokoroVoiceFor(languageCode: string, override?: string): VoiceChoice | null {
  const base = KOKORO_DEFAULT_VOICES[languageCode];
  if (!base) return null;
  const custom = (override ?? "").trim();
  if (custom && languageCode === "en") return { voice: custom, verified: false };
  return base;
}

/** True when Kokoro does not cover the language, so the backup voice path must be used. */
export function needsBackup(languageCode: string): boolean {
  const lang = LANGUAGE_BY_CODE[languageCode];
  return !lang || lang.tts !== "kokoro";
}

export function estimateNarrationSec(script: string, wordsPerMinute: number = DEFAULT_WORDS_PER_MINUTE): number {
  const words = script.split(/\s+/).filter(Boolean).length;
  return Math.round((words / wordsPerMinute) * 60 * 100) / 100;
}

/** Splits a script into pieces of at most maxChars, breaking on sentence ends, then commas, then spaces. */
export function chunkScript(text: string, maxChars: number): string[] {
  const limit = Math.max(20, Math.floor(maxChars));
  const sentences = text
    .replace(/\r/g, "")
    .split(/(?<=[.!?。！？])\s+|\n{2,}|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= limit) pieces.push(s);
    else pieces.push(...splitLong(s, limit));
  }
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + 1 + p.length > limit) {
      chunks.push(cur);
      cur = p;
    } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitLong(s: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of s.split(/(?<=[,;:])\s+|\s+/)) {
    if (part.length > limit) {
      if (cur) out.push(cur);
      cur = "";
      for (let i = 0; i < part.length; i += limit) out.push(part.slice(i, i + limit));
      continue;
    }
    if (cur && cur.length + 1 + part.length > limit) {
      out.push(cur);
      cur = part;
    } else cur = cur ? `${cur} ${part}` : part;
  }
  if (cur) out.push(cur);
  return out;
}
