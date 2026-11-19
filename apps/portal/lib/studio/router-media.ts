/**
 * Voice and image choices made from what 9router lists. Pure: no network, no database. Nothing here names a model the
 * owner must have; ids come from the lists 9router returns (/v1/models/tts, /v1/models/image).
 */
import { normalizeProvider, PROVIDER_NAME_MAX } from "./asset-plan.ts";
import type { RouterModel } from "./capabilities.ts";
import type { Format } from "./catalog.ts";
import { sniffAudio } from "./image-result.ts";
import { kokoroVoiceFor, needsBackup } from "./voice.ts";
import { concatWav, padWithSilence } from "./wav.ts";

function isKokoro(m: RouterModel): boolean {
  return m.id.toLowerCase().includes("kokoro");
}

/**
 * The Kokoro voice to ask 9router for, or null when 9router lists none for the language. Never falls back to a
 * non-Kokoro voice: an unknown engine would be recorded as Kokoro-quality narration it is not.
 * English prefers af_heart (the checked voice), then any American voice, then the first Kokoro entry. Other
 * languages need an entry whose id contains the voice name Kokoro uses for that language.
 */
export function pickRouterVoice(models: readonly RouterModel[], languageCode: string, override?: string): RouterModel | null {
  const kokoro = models.filter(isKokoro);
  if (kokoro.length === 0) return null;
  const wanted = (override ?? "").trim().toLowerCase();
  if (wanted && languageCode === "en") {
    const hit = kokoro.find((m) => m.id.toLowerCase().includes(wanted));
    if (hit) return hit;
  }
  if (languageCode === "en") {
    return (
      kokoro.find((m) => m.id.toLowerCase().includes("af_heart")) ??
      kokoro.find((m) => /(^|[/:_-])a[fm]_/i.test(m.id)) ??
      kokoro[0]
    );
  }
  const choice = kokoroVoiceFor(languageCode);
  if (!choice) return null;
  const name = choice.voice.toLowerCase();
  return kokoro.find((m) => m.id.toLowerCase().includes(name)) ?? null;
}

/** True only for the voice someone has heard and checked: the English af_heart voice. */
export function routerVoiceVerified(model: RouterModel, languageCode: string): boolean {
  return languageCode === "en" && model.id.toLowerCase().includes("af_heart");
}

/**
 * Provider name recorded for something 9router made. The first path segment of the model id is the underlying
 * provider. A combo is its own provider ("9router-combo-<id>") because 9router may route it to anything, so it
 * never borrows the terms the owner confirmed for another provider.
 */
export function routerProviderName(modelId: string, ownedBy: string): string {
  if (ownedBy.trim().toLowerCase() === "combo") return normalizeProvider(`9router-combo-${modelId}`).slice(0, PROVIDER_NAME_MAX);
  const slash = modelId.indexOf("/");
  const head = slash > 0 ? modelId.slice(0, slash) : ownedBy.trim() || modelId;
  return normalizeProvider(head);
}

/** Hermes may claim any provider name for Kokoro. Only "kokoro" is recorded as is; anything else is its own unconfirmed provider. */
export function resolveKokoroProvider(claimed: string | null | undefined): string {
  const name = normalizeProvider(claimed);
  if (name === "kokoro") return "kokoro";
  return `unlisted-${name}`.slice(0, PROVIDER_NAME_MAX);
}

// ---------------------------------------------------------------------------------------------------------------
// Joining audio pieces

/** Bytes of an ID3v2 tag at the start of the data, 0 when there is none. */
export function id3v2Length(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = (b[5] & 0x10) !== 0 ? 10 : 0;
  const total = 10 + size + footer;
  return total <= b.length ? total : 0;
}

/** Joins MP3 pieces: the ID3v2 tag of every piece after the first is dropped, then the frames are concatenated. */
export function joinMp3(parts: readonly Uint8Array[]): Uint8Array {
  const kept = parts.map((p, i) => (i === 0 ? p : p.subarray(id3v2Length(p))));
  const out = new Uint8Array(kept.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of kept) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class AudioJoinError extends Error {}

/**
 * Joins the pieces 9router returned, one per chunk of the script. All WAV (a short gap is added between pieces)
 * or all MP3. Mixed or unknown audio is refused with a plain message instead of producing a broken file.
 */
export function joinAudioChunks(parts: readonly Uint8Array[], gapSec: number): { audio: Uint8Array; mime: "audio/wav" | "audio/mpeg" } {
  if (parts.length === 0) throw new AudioJoinError("There is no audio to join");
  const mimes = parts.map((p) => sniffAudio(p)?.mime ?? null);
  if (mimes.some((m) => m === null)) throw new AudioJoinError("9router returned audio that is not a WAV or MP3 file");
  if (mimes.some((m) => m === "audio/ogg")) throw new AudioJoinError("9router returned Ogg audio. The studio can only join WAV or MP3");
  const first = mimes[0];
  if (mimes.some((m) => m !== first)) throw new AudioJoinError("9router returned a mix of WAV and MP3 pieces, so they cannot be joined into one narration");
  if (first === "audio/wav") {
    try {
      const padded = parts.map((p, i) => (i < parts.length - 1 ? padWithSilence(p, 0, gapSec) : p));
      return { audio: concatWav(padded), mime: "audio/wav" };
    } catch (err) {
      throw new AudioJoinError(err instanceof Error ? err.message : "The WAV pieces could not be joined");
    }
  }
  return { audio: joinMp3(parts), mime: "audio/mpeg" };
}

// ---------------------------------------------------------------------------------------------------------------
// Which voice path to try

export type VoiceEngine = "kokoro-override" | "router" | "hermes-kokoro" | "hermes-capcut";

export interface VoiceAttempt {
  engine: VoiceEngine;
  /** The 9router model, for the router engine. */
  model?: RouterModel;
}

export interface VoicePlanInput {
  languageCode: string;
  /** KOKORO_BASE_URL is set. */
  overrideConfigured: boolean;
  router: { configured: boolean; models: readonly RouterModel[]; error?: string };
  hermesConfigured: boolean;
  /** TTS_BACKUP is not "off". */
  backupOn: boolean;
  kokoroVoice?: string;
}

export interface VoicePlan {
  attempts: VoiceAttempt[];
  /** Why each path that will not be tried was left out, in the order they would have been tried. */
  skipped: string[];
}

/** The order voice paths are tried: owner override, 9router, Hermes asked for Kokoro, Hermes CapCut. */
export function planVoice(i: VoicePlanInput): VoicePlan {
  const attempts: VoiceAttempt[] = [];
  const skipped: string[] = [];
  const kokoroCovers = !needsBackup(i.languageCode) && kokoroVoiceFor(i.languageCode) !== null;
  const lang = i.languageCode;

  if (i.overrideConfigured) {
    if (kokoroCovers) attempts.push({ engine: "kokoro-override" });
    else skipped.push(`The Kokoro server from KOKORO_BASE_URL does not cover language ${lang}.`);
  }

  if (!i.router.configured) skipped.push("9router is not configured, so its voices were not used.");
  else if (!kokoroCovers) skipped.push(`Kokoro does not cover language ${lang}, so 9router Kokoro was not used.`);
  else if (i.router.error) skipped.push(`9router voices could not be listed: ${i.router.error}`);
  else {
    const model = pickRouterVoice(i.router.models, lang, i.kokoroVoice);
    if (model) attempts.push({ engine: "router", model });
    else skipped.push("9router lists no Kokoro voice for this language.");
  }

  if (!i.hermesConfigured) skipped.push("Hermes is not configured, so it was not asked to speak.");
  else if (!kokoroCovers) skipped.push(`Kokoro does not cover language ${lang}, so Hermes was not asked for Kokoro.`);
  else attempts.push({ engine: "hermes-kokoro" });

  if (!i.backupOn) skipped.push("The CapCut backup voice is off (TTS_BACKUP=off).");
  else if (!i.hermesConfigured) skipped.push("The CapCut backup voice needs Hermes, which is not configured.");
  else attempts.push({ engine: "hermes-capcut" });

  return { attempts, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Images

/**
 * The 9router image model to use. A model whose id starts with a name in the owner's HERMES_IMAGE_PROVIDER_ORDER
 * wins, in that order. Otherwise the first model listed. Combos are only used when nothing else is listed.
 */
export function pickRouterImageModel(models: readonly RouterModel[], order: readonly string[] = []): RouterModel | null {
  const usable = models.filter((m) => m.kind !== "video");
  if (usable.length === 0) return null;
  const plain = usable.filter((m) => m.ownedBy !== "combo");
  const pool = plain.length > 0 ? plain : usable;
  for (const raw of order) {
    const want = normalizeProvider(raw);
    const hit = pool.find((m) => routerProviderName(m.id, m.ownedBy) === want);
    if (hit) return hit;
  }
  return pool[0];
}

export function routerImageSize(format: Format): string {
  return format === "short" ? "1024x1792" : "1792x1024";
}
