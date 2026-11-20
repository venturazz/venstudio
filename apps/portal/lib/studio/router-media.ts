/**
 * Voice and image choices made from what 9router lists. Pure: no network, no database. Nothing here names a model the
 * owner must have; ids come from the lists 9router returns (/v1/models/tts, /v1/models/image).
 */
import { normalizeProvider, PROVIDER_NAME_MAX, type HermesMaker } from "./asset-plan.ts";
import type { RouterModel } from "./capabilities.ts";
import type { Format } from "./catalog.ts";
import { sniffAudio } from "./image-result.ts";
import { kokoroVoiceFor, needsBackup } from "./voice.ts";
import { concatWav, padWithSilence } from "./wav.ts";
import { findHealth, isProven, isQuarantined, type EndpointHealth } from "./endpoint-health.ts";

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

/**
 * The Kokoro voice to ask 9router for, using what real calls showed. A voice set aside after a 4xx is never picked.
 * The owner's KOKORO_VOICE wins when it is listed and not set aside; then a proven voice; then the usual choice among
 * the listed ones, so a listed Kokoro voice is still tried (that is how it gets proven).
 */
export function pickRouterVoiceWithHealth(
  models: readonly RouterModel[],
  languageCode: string,
  override: string | undefined,
  health: readonly EndpointHealth[],
  nowMs: number,
): RouterModel | null {
  const open = models.filter((m) => !isQuarantined(findHealth(health, "9router", m.id, "tts"), nowMs));
  const wanted = (override ?? "").trim().toLowerCase();
  if (wanted && languageCode === "en") {
    const hit = open.find((m) => isKokoro(m) && m.id.toLowerCase().includes(wanted));
    if (hit) return hit;
  }
  const proven = open.filter((m) => isProven(findHealth(health, "9router", m.id, "tts"), nowMs));
  return pickRouterVoice(proven, languageCode, override) ?? pickRouterVoice(open, languageCode, override);
}

/** True when 9router lists Kokoro voices but every one of them is set aside. */
export function allKokoroQuarantined(models: readonly RouterModel[], health: readonly EndpointHealth[], nowMs: number): boolean {
  const kokoro = models.filter(isKokoro);
  return kokoro.length > 0 && kokoro.every((m) => isQuarantined(findHealth(health, "9router", m.id, "tts"), nowMs));
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

/**
 * What Hermes claims is a self-report, so a Hermes voice never borrows the terms the owner confirmed for the real
 * "kokoro" provider (the one 9router or the owner's own server made). A claim of Kokoro is recorded as "hermes-kokoro",
 * any other name as its own "unlisted-<name>". The owner confirms those terms separately.
 */
export function resolveKokoroProvider(claimed: string | null | undefined): string {
  const name = normalizeProvider(claimed);
  if (name === "kokoro") return "hermes-kokoro";
  return `unlisted-${name}`.slice(0, PROVIDER_NAME_MAX);
}

/**
 * Names a Hermes voice by the engine that really spoke (`source`), not by the plugin in front of it: the CapCut plugin
 * falls back to kokoro, gemini, edge and google_translate, each with its own terms. A Kokoro engine is "hermes-kokoro"
 * (a Hermes claim never borrows the confirmed "kokoro"), CapCut is "capcut" only when CapCut was asked, any other engine
 * is "unlisted-<engine>". Without an engine report: the Kokoro request keeps resolveKokoroProvider on the reported name,
 * and the CapCut request is "unlisted-<plugin>" because the plugin may have fallen through to anything.
 */
export function resolveHermesVoice(engine: "kokoro" | "capcut", reported: { provider?: string | null; backend?: string | null }): HermesMaker {
  const plugin = (reported.provider ?? "").trim() ? normalizeProvider(reported.provider) : "";
  const raw = (reported.backend ?? "").trim() ? normalizeProvider(reported.backend) : "";
  const backend = raw === "unknown" ? "" : raw;
  if (backend) {
    if (backend === "kokoro") return { provider: "hermes-kokoro", backend, plugin };
    if (backend === "capcut" && engine === "capcut") return { provider: "capcut", backend, plugin };
    return { provider: `unlisted-${backend}`.slice(0, PROVIDER_NAME_MAX), backend, plugin };
  }
  if (engine === "kokoro") return { provider: resolveKokoroProvider(reported.provider), backend: "", plugin };
  return { provider: `unlisted-${plugin || "capcut"}`.slice(0, PROVIDER_NAME_MAX), backend: "", plugin };
}

/** Seconds to wait before retrying a 503, from the Retry-After header: its value, 5 s without one, never more than 20. */
export function retryWaitSec(header: string | null | undefined): number {
  const asked = Number.parseInt(header ?? "", 10);
  return Math.min(20, Number.isFinite(asked) && asked >= 0 ? asked : 5);
}

/** The image 9router returned: base64 data or a URL, from {data: [{b64_json | url}]}. Null when there is none. */
export function readRouterImageItem(body: unknown): { kind: "b64"; value: string } | { kind: "url"; value: string } | null {
  const data = (body as { data?: unknown } | null)?.data;
  const item = (Array.isArray(data) ? data[0] : null) as { b64_json?: unknown; url?: unknown } | null;
  if (!item) return null;
  if (typeof item.b64_json === "string" && item.b64_json) return { kind: "b64", value: item.b64_json };
  if (typeof item.url === "string" && item.url) return { kind: "url", value: item.url };
  return null;
}

/**
 * Where the 9router voice list comes from. The stored scan is used only when its TTS probe worked and it lists a Kokoro
 * voice. An empty list, a failed TTS probe or a list without Kokoro is checked live, so a voice added in 9router after
 * the last scan is found, and a failed probe reports its real cause.
 */
export function routerVoiceSource(scan: { status: { ok: boolean; error?: string }; probes: Record<string, { ok: boolean; error?: string }>; lists: { tts: readonly RouterModel[] } } | null | undefined): {
  use: "stored" | "probe";
  /** Why the stored list cannot be used. Empty when it can. */
  reason: string;
} {
  if (!scan) return { use: "probe", reason: "not scanned yet" };
  const tts = scan.probes.tts;
  if (tts && !tts.ok) return { use: "probe", reason: `the last scan could not list voices: ${tts.error ?? "no answer"}` };
  if (!scan.status.ok) return { use: "probe", reason: scan.status.error ?? "unreachable" };
  if (!scan.lists.tts.some(isKokoro)) return { use: "probe", reason: "the last scan found no Kokoro voice" };
  return { use: "stored", reason: "" };
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
  /**
   * What real calls showed about 9router voices. When given, voices set aside after a 4xx are skipped and proven
   * voices come first. Without it (older callers) the listed voices are used as before.
   */
  health?: readonly EndpointHealth[];
  nowMs?: number;
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
    const now = i.nowMs ?? Date.now();
    const model = i.health ? pickRouterVoiceWithHealth(i.router.models, lang, i.kokoroVoice, i.health, now) : pickRouterVoice(i.router.models, lang, i.kokoroVoice);
    if (model) attempts.push({ engine: "router", model });
    else if (i.health && allKokoroQuarantined(i.router.models, i.health, now)) {
      skipped.push("Every Kokoro voice 9router lists was set aside after 9router refused a request for it. Test voice in Settings tries them again.");
    } else skipped.push("9router lists no Kokoro voice for this language.");
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

/**
 * The 9router image model the automatic chain may use: only one a real call has proven, never one that is set aside
 * or that failed with a 4xx earlier in this stage (`exclude`). A name in HERMES_IMAGE_PROVIDER_ORDER wins among the
 * proven ones, then the most recent success. Null when nothing is proven: listed is not the same as working.
 */
export function pickProvenImageModel(
  models: readonly RouterModel[],
  health: readonly EndpointHealth[],
  order: readonly string[],
  exclude: ReadonlySet<string>,
  nowMs: number,
): RouterModel | null {
  const proven = models.filter((m) => m.kind !== "video" && !exclude.has(m.id) && isProven(findHealth(health, "9router", m.id, "image"), nowMs));
  if (proven.length === 0) return null;
  for (const raw of order) {
    const want = normalizeProvider(raw);
    const hit = proven.find((m) => routerProviderName(m.id, m.ownedBy) === want);
    if (hit) return hit;
  }
  const last = (m: RouterModel) => findHealth(health, "9router", m.id, "image")?.lastSuccessAt ?? 0;
  return [...proven].sort((a, b) => last(b) - last(a))[0];
}

/**
 * The order the Settings image test tries models in: proven first (a quick confirmation), then listed models that were
 * never tried (plain before combos), then ones set aside, at most `max`. The test stops at the first success.
 */
export function routerImageTestOrder(models: readonly RouterModel[], health: readonly EndpointHealth[], nowMs: number, max = 3): RouterModel[] {
  const usable = models.filter((m) => m.kind !== "video");
  const h = (m: RouterModel) => findHealth(health, "9router", m.id, "image");
  const proven = usable.filter((m) => isProven(h(m), nowMs));
  const open = usable.filter((m) => !isProven(h(m), nowMs) && !isQuarantined(h(m), nowMs));
  const plainFirst = [...open.filter((m) => m.ownedBy !== "combo"), ...open.filter((m) => m.ownedBy === "combo")];
  const aside = usable.filter((m) => isQuarantined(h(m), nowMs));
  return [...proven, ...plainFirst, ...aside].slice(0, Math.max(1, max));
}

export function routerImageSize(format: Format): string {
  return format === "short" ? "1024x1792" : "1792x1024";
}
