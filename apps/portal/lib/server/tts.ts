import "server-only";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { hermesOrigin } from "./executors/hermes-image.ts";
import { hermesText } from "./hermes-json.ts";
import { mp3DurationSec } from "../studio/mp3.ts";
import { fetchMedia } from "./safe-fetch.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";
import { LANGUAGE_BY_CODE } from "../studio/catalog.ts";
import { ttsCapcutPrompt } from "../studio/asset-plan.ts";
import type { Validated } from "../studio/director.ts";
import { audioIssues, decodeInlineSource, MAX_AUDIO_BYTES, parseAudioReply, sniffAudio } from "../studio/image-result.ts";
import { chunkScript, kokoroVoiceFor, needsBackup } from "../studio/voice.ts";
import { concatWav, isClipped, padWithSilence, parseWav } from "../studio/wav.ts";

/**
 * Narration. Kokoro is the primary voice. When Kokoro is not configured, is unreachable, fails, or does not cover
 * the language, the voice is asked from Hermes' CapCut workflow (TTS_BACKUP=hermes-capcut, the default).
 */

const KOKORO_INTERNAL = "http://<kokoro container name>:8880";
const HEALTH_TIMEOUT_MS = 15_000;
const SPEAK_TIMEOUT_MS = 120_000;
const CHUNK_CHARS = 400;
const CHUNK_GAP_SEC = 0.25;
const CACHE_OK_MS = 5 * 60_000;
const CACHE_FAIL_MS = 60_000;

function kokoroConfig() {
  const { KOKORO_BASE_URL, KOKORO_API_KEY, KOKORO_MODEL, KOKORO_VOICE } = env();
  if (!KOKORO_BASE_URL) return null;
  return { base: normalizeGatewayBase(KOKORO_BASE_URL), key: KOKORO_API_KEY, model: KOKORO_MODEL || "kokoro", voice: KOKORO_VOICE };
}

function headers(key?: string): Record<string, string> {
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

export interface KokoroStatus {
  configured: boolean;
  ok: boolean;
  url?: string;
  voices: string[];
  latencyMs?: number;
  error?: string;
  hint?: string;
  checkedAt?: string;
}

let cache: { at: number; status: KokoroStatus } | undefined;

async function checkKokoro(): Promise<KokoroStatus> {
  const cfg = kokoroConfig();
  if (!cfg) return { configured: false, ok: false, voices: [] };
  const url = `${cfg.base}/v1/audio/voices`;
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(url, { headers: headers(cfg.key), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), cache: "no-store" });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "Kokoro rejected the key. Set KOKORO_API_KEY to the key your Kokoro server expects."
          : res.status === 404
            ? "Nothing at /v1/audio/voices. KOKORO_BASE_URL should be the Kokoro server address, for example http://kokoro:8880 (Kokoro-FastAPI)."
            : "";
      return { configured: true, ok: false, url, voices: [], latencyMs, error: `HTTP ${res.status}`, hint, checkedAt };
    }
    const body = ((await res.json().catch(() => null)) ?? {}) as { voices?: unknown; data?: unknown };
    const raw: unknown[] = Array.isArray(body.voices) ? body.voices : Array.isArray(body.data) ? body.data : [];
    const voices = raw
      .map((v) => (typeof v === "string" ? v : typeof (v as { id?: unknown })?.id === "string" ? (v as { id: string }).id : ""))
      .filter(Boolean)
      .sort();
    return { configured: true, ok: true, url, voices, latencyMs, checkedAt };
  } catch (err) {
    return { configured: true, ok: false, url, voices: [], checkedAt, ...explainFetchError(err, url, { name: "Kokoro", internal: KOKORO_INTERNAL }, HEALTH_TIMEOUT_MS) };
  }
}

/** Cached for 5 min when healthy, 1 min after a failure. `fresh` skips the cache. */
export async function kokoroHealth(opts: { fresh?: boolean } = {}): Promise<KokoroStatus> {
  if (!opts.fresh && cache) {
    const ttl = cache.status.ok ? CACHE_OK_MS : CACHE_FAIL_MS;
    if (Date.now() - cache.at < ttl) return cache.status;
  }
  const status = await checkKokoro();
  cache = { at: Date.now(), status };
  return status;
}

export class TtsError extends Error {}

/** One Kokoro call per chunk, joined into one WAV. Throws TtsError with a plain message. */
export async function kokoroSpeak(text: string, voice: string): Promise<Uint8Array> {
  const cfg = kokoroConfig();
  if (!cfg) throw new TtsError("Kokoro is not configured. Set KOKORO_BASE_URL (and KOKORO_API_KEY if your server needs one).");
  const url = `${cfg.base}/v1/audio/speech`;
  const chunks = chunkScript(text, CHUNK_CHARS);
  if (chunks.length === 0) throw new TtsError("There is no text to speak");
  const parts: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let bytes: Uint8Array;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(cfg.key),
        body: JSON.stringify({ model: cfg.model, input: chunks[i], voice, response_format: "wav" }),
        signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " Check KOKORO_API_KEY." : res.status === 404 ? " Check KOKORO_BASE_URL." : "";
        throw new TtsError(`Kokoro answered HTTP ${res.status}.${hint}`);
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof TtsError) throw err;
      const e = explainFetchError(err, url, { name: "Kokoro", internal: KOKORO_INTERNAL }, SPEAK_TIMEOUT_MS);
      throw new TtsError(e.hint ? `${e.error}. ${e.hint}` : e.error);
    }
    try {
      parseWav(bytes);
    } catch (err) {
      throw new TtsError(`Kokoro did not return a 16-bit WAV file (${err instanceof Error ? err.message : "unreadable audio"}). Check that your Kokoro server supports response_format wav.`);
    }
    parts.push(i < chunks.length - 1 ? padWithSilence(bytes, 0, CHUNK_GAP_SEC) : bytes);
  }
  try {
    return concatWav(parts);
  } catch (err) {
    throw new TtsError(err instanceof Error ? err.message : "The voice pieces could not be joined");
  }
}

export interface Narration {
  provider: "kokoro" | "capcut";
  voice: string;
  model: string;
  /** True only for voices someone has heard and checked (English). */
  voiceVerified: boolean;
  audio: Uint8Array;
  mime: "audio/wav" | "audio/mpeg" | "audio/ogg";
  ext: "wav" | "mp3" | "ogg";
  /** Known only for WAV. */
  durationSec: number | null;
  clipped: boolean | null;
  /** True when duration and clipping must be measured later, on the finished video (non-WAV audio). */
  deferredCheck: boolean;
  /** Why the primary voice was skipped, when the backup made this one. */
  note: string;
}

export type SynthesisResult = { ok: true; narration: Narration } | { ok: false; error: string };

function measure(audio: Uint8Array): { durationSec: number | null; clipped: boolean | null; deferredCheck: boolean } {
  try {
    const info = parseWav(audio);
    return { durationSec: Math.round(info.durationSec * 100) / 100, clipped: isClipped(info), deferredCheck: false };
  } catch {
    // MP3 length can be read from the frame headers. Clipping and Ogg length are checked later, by the render.
    const mp3 = mp3DurationSec(audio);
    return { durationSec: mp3, clipped: null, deferredCheck: true };
  }
}

const EXT: Record<"audio/wav" | "audio/mpeg" | "audio/ogg", "wav" | "mp3" | "ogg"> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg" };

/** CapCut text to speech through Hermes. The reply is checked by magic bytes like any other media. */
export async function capcutSpeak(script: string, language: string): Promise<SynthesisResult> {
  if (!env().HERMES_BASE_URL) return { ok: false, error: "The backup voice needs Hermes. Set HERMES_BASE_URL and HERMES_API_KEY." };
  const trusted = hermesOrigin();
  const label = LANGUAGE_BY_CODE[language]?.label ?? language;
  const result = await hermesText<{ audio: Uint8Array; mime: "audio/wav" | "audio/mpeg" | "audio/ogg"; model: string }>(
    ttsCapcutPrompt({ text: script, languageLabel: label, languageCode: language }),
    async (reply): Promise<Validated<{ audio: Uint8Array; mime: "audio/wav" | "audio/mpeg" | "audio/ogg"; model: string }>> => {
      const parsed = parseAudioReply(reply);
      if (!parsed.ok) return { ok: false, issues: parsed.issues };
      let audio: Uint8Array;
      try {
        const inline = decodeInlineSource(parsed.source);
        audio = inline ?? (await fetchMedia(parsed.source.value, { maxBytes: MAX_AUDIO_BYTES, timeoutMs: 90_000, trustedOrigins: trusted ? [trusted] : [] })).bytes;
      } catch (err) {
        return { ok: false, issues: [`${err instanceof Error ? err.message : "The audio could not be read"}. Return a public https URL or base64 audio data.`] };
      }
      const info = sniffAudio(audio);
      const issues = audioIssues(info);
      if (issues.length > 0 || !info) return { ok: false, issues };
      return { ok: true, value: { audio, mime: info.mime, model: parsed.model } };
    },
  );
  if (!result.ok) return { ok: false, error: `The backup voice (CapCut through Hermes) failed. ${result.error}` };
  const { audio, mime, model } = result.value;
  return {
    ok: true,
    narration: { provider: "capcut", voice: "capcut", model, voiceVerified: false, audio, mime, ext: EXT[mime], ...measure(audio), note: "" },
  };
}

/** Kokoro first, then the Hermes CapCut backup when allowed. Every failure message says what to set or fix. */
export async function synthesize(script: string, language: string): Promise<SynthesisResult> {
  const text = script.trim();
  if (!text) return { ok: false, error: "The script is empty, so there is nothing to narrate." };
  const backupOn = env().TTS_BACKUP === "hermes-capcut";
  const choice = kokoroVoiceFor(language, env().KOKORO_VOICE);
  let why = "";
  if (needsBackup(language) || !choice) {
    why = `Kokoro does not list ${LANGUAGE_BY_CODE[language]?.label ?? language}.`;
  } else if (!kokoroConfig()) {
    why = "Kokoro is not configured. Set KOKORO_BASE_URL.";
  } else {
    try {
      const audio = await kokoroSpeak(text, choice.voice);
      return {
        ok: true,
        narration: {
          provider: "kokoro",
          voice: choice.voice,
          model: kokoroConfig()?.model ?? "kokoro",
          voiceVerified: choice.verified,
          audio,
          mime: "audio/wav",
          ext: "wav",
          ...measure(audio),
          note: "",
        },
      };
    } catch (err) {
      why = err instanceof TtsError ? err.message : "Kokoro failed.";
    }
  }
  if (!backupOn) return { ok: false, error: `${why} The backup voice is off (TTS_BACKUP=off). Fix Kokoro or set TTS_BACKUP=hermes-capcut.` };
  const backup = await capcutSpeak(text, language);
  if (!backup.ok) return { ok: false, error: `${why} ${backup.error}` };
  return { ok: true, narration: { ...backup.narration, note: `Backup voice used. ${why}` } };
}

/** A short clip for the Settings "Test voice" button. */
export async function kokoroTest(): Promise<{ ok: true; durationSec: number; bytes: number; voice: string; ms: number } | { ok: false; error: string }> {
  const cfg = kokoroConfig();
  if (!cfg) return { ok: false, error: "Kokoro is not configured. Set KOKORO_BASE_URL." };
  const voice = kokoroVoiceFor("en", cfg.voice)?.voice ?? "af_heart";
  const started = Date.now();
  try {
    const audio = await kokoroSpeak("This is a VenStudio voice test.", voice);
    const info = parseWav(audio);
    return { ok: true, durationSec: Math.round(info.durationSec * 100) / 100, bytes: audio.length, voice, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Kokoro test failed" };
  }
}
