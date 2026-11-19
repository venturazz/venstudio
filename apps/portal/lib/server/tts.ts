import "server-only";
import { env } from "./env.ts";
import { explainFetchError } from "./ai-gateway.ts";
import { hermesTrustedOrigins } from "./executors/hermes-image.ts";
import { hermesText } from "./hermes-json.ts";
import { getCapabilities } from "./capabilities.ts";
import { mp3DurationSec } from "../studio/mp3.ts";
import { fetchMedia } from "./safe-fetch.ts";
import { normalizeGatewayBase } from "../gateway-url.ts";
import { LANGUAGE_BY_CODE } from "../studio/catalog.ts";
import { ttsCapcutPrompt, ttsKokoroPrompt, type ProvenanceExecutor } from "../studio/asset-plan.ts";
import { missingCapabilityMessage, parseRouterList, scanStateOf, skillHintsFor, type CapabilitySnapshot, type RouterModel } from "../studio/capabilities.ts";
import {
  joinAudioChunks,
  planVoice,
  resolveKokoroProvider,
  routerProviderName,
  routerVoiceVerified,
  type VoiceAttempt,
} from "../studio/router-media.ts";
import type { Validated } from "../studio/director.ts";
import { audioIssues, capcutAudioIssues, decodeInlineSource, MAX_AUDIO_BYTES, parseAudioReply, sniffAudio } from "../studio/image-result.ts";
import { chunkScript, kokoroVoiceFor } from "../studio/voice.ts";
import { concatWav, isClipped, padWithSilence, parseWav } from "../studio/wav.ts";

/**
 * Narration. Nothing has to be set up for it: the voice is found through 9router and Hermes. Order of paths:
 * (1) KOKORO_BASE_URL, an optional override that is used only when the owner set it, (2) the Kokoro voice 9router
 * lists, (3) Hermes asked for Kokoro, (4) Hermes' CapCut workflow (unless TTS_BACKUP=off). Which path made the
 * audio is recorded in the Narration and its provenance.
 */

const KOKORO_INTERNAL = "http://<kokoro container name>:8880";
const HEALTH_TIMEOUT_MS = 15_000;
const SPEAK_TIMEOUT_MS = 120_000;
const CHUNK_CHARS = 400;
const CHUNK_GAP_SEC = 0.25;
const CACHE_OK_MS = 5 * 60_000;
const CACHE_FAIL_MS = 60_000;
const ROUTER_LIST_TIMEOUT_MS = 20_000;
const ROUTER_RETRY_DEFAULT_SEC = 5;
const ROUTER_RETRY_MAX_SEC = 20;

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

function routerConfig() {
  const { NINEROUTER_BASE_URL, NINEROUTER_API_KEY } = env();
  if (!NINEROUTER_BASE_URL) return null;
  return { base: normalizeGatewayBase(NINEROUTER_BASE_URL), key: NINEROUTER_API_KEY };
}

const ROUTER_INTERNAL = "http://<9router container name>:20128";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the audio out of a 9router speech reply: raw bytes by default, or {audio: base64, format} as JSON. */
async function routerAudioBytes(res: Response): Promise<Uint8Array> {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("json")) return new Uint8Array(await res.arrayBuffer());
  const body = (await res.json().catch(() => null)) as { audio?: unknown } | null;
  if (!body || typeof body.audio !== "string" || !body.audio) throw new TtsError("9router answered with JSON that has no audio");
  return new Uint8Array(Buffer.from(body.audio, "base64"));
}

function routerHttpMessage(status: number, detail: string): string {
  if (status === 401 || status === 403) return "9router rejected the API key. Copy a key from the 9router dashboard into NINEROUTER_API_KEY.";
  if (status === 400 && /invalid model format/i.test(detail)) {
    return "9router said Invalid model format. The voice model id it listed was not accepted; press Scan now on Settings > Capabilities.";
  }
  if (status === 503) return "9router said All accounts unavailable for this voice. Try again in a minute or connect another account in 9router.";
  return `9router answered HTTP ${status}${detail ? `: ${detail.slice(0, 160)}` : ""}.`;
}

/** One POST per chunk. A 503 is retried once after Retry-After (at most 20 s). Nothing else is retried. */
async function routerSpeakChunk(url: string, key: string | undefined, modelId: string, input: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({ model: modelId, input }),
        signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      const e = explainFetchError(err, url, { name: "9router", internal: ROUTER_INTERNAL }, SPEAK_TIMEOUT_MS);
      throw new TtsError(e.hint ? `${e.error}. ${e.hint}` : e.error);
    }
    if (res.status === 503 && attempt === 0) {
      const asked = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitSec = Math.min(ROUTER_RETRY_MAX_SEC, Number.isFinite(asked) && asked >= 0 ? asked : ROUTER_RETRY_DEFAULT_SEC);
      await res.arrayBuffer().catch(() => undefined);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TtsError(routerHttpMessage(res.status, detail));
    }
    try {
      return await routerAudioBytes(res);
    } catch (err) {
      if (err instanceof TtsError) throw err;
      throw new TtsError("The audio from 9router could not be read");
    }
  }
  throw new TtsError(routerHttpMessage(503, ""));
}

/**
 * Speech through 9router: POST /v1/audio/speech {model, input} per chunk of the script, joined into one file.
 * Only runs when a stage or a Settings test asks for it, never while a page renders.
 */
export async function routerSpeak(text: string, modelId: string): Promise<{ audio: Uint8Array; mime: "audio/wav" | "audio/mpeg" }> {
  const cfg = routerConfig();
  if (!cfg) throw new TtsError("9router is not configured. Set NINEROUTER_BASE_URL and NINEROUTER_API_KEY.");
  const url = `${cfg.base}/v1/audio/speech`;
  const chunks = chunkScript(text, CHUNK_CHARS);
  if (chunks.length === 0) throw new TtsError("There is no text to speak");
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const bytes = await routerSpeakChunk(url, cfg.key, modelId, chunk);
    if (!sniffAudio(bytes)) throw new TtsError("9router did not return a WAV or MP3 file for this voice");
    parts.push(bytes);
  }
  try {
    const joined = joinAudioChunks(parts, CHUNK_GAP_SEC);
    const issues = audioIssues(sniffAudio(joined.audio));
    if (issues.length > 0) throw new TtsError(`${issues[0]}.`);
    return joined;
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw new TtsError(err instanceof Error ? err.message : "The voice pieces could not be joined");
  }
}

/** A one-off read of 9router's TTS list, used only when no stored capability scan exists. */
async function probeRouterVoices(): Promise<{ models: RouterModel[]; error?: string }> {
  const cfg = routerConfig();
  if (!cfg) return { models: [] };
  const url = `${cfg.base}/v1/models/tts`;
  try {
    const res = await fetch(url, { headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}, signal: AbortSignal.timeout(ROUTER_LIST_TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    return { models: parseRouterList(await res.json().catch(() => null)) };
  } catch (err) {
    return { models: [], error: explainFetchError(err, url, undefined, ROUTER_LIST_TIMEOUT_MS).error };
  }
}

async function readSnapshot(): Promise<CapabilitySnapshot | null> {
  try {
    return await getCapabilities();
  } catch {
    return null;
  }
}

/** The 9router voice list: the stored scan when it has one, else one bounded probe. */
async function routerVoiceList(snap: CapabilitySnapshot | null, probeIfUnknown: boolean): Promise<{ configured: boolean; models: RouterModel[]; error?: string }> {
  if (!routerConfig()) return { configured: false, models: [] };
  if (snap?.router?.status.ok) return { configured: true, models: snap.router.lists.tts };
  if (!probeIfUnknown) return { configured: true, models: [], error: snap?.router ? (snap.router.status.error ?? "unreachable") : "not scanned yet" };
  const probed = await probeRouterVoices();
  return { configured: true, ...probed };
}

function planFor(language: string, router: { configured: boolean; models: RouterModel[]; error?: string }) {
  const { KOKORO_BASE_URL, KOKORO_VOICE, HERMES_BASE_URL, TTS_BACKUP } = env();
  return planVoice({
    languageCode: language,
    overrideConfigured: Boolean(KOKORO_BASE_URL),
    router,
    hermesConfigured: Boolean(HERMES_BASE_URL),
    backupOn: TTS_BACKUP !== "off",
    kokoroVoice: KOKORO_VOICE,
  });
}

export interface Narration {
  /** The provider that really made the voice, for example "kokoro", "capcut" or "unlisted-<name>". */
  provider: string;
  executor: ProvenanceExecutor;
  via: "9router" | "hermes" | "direct";
  voice: string;
  model: string;
  /** True only for voices someone has heard and checked (English). */
  voiceVerified: boolean;
  audio: Uint8Array;
  mime: "audio/wav" | "audio/mpeg" | "audio/ogg";
  ext: "wav" | "mp3" | "ogg";
  /** Known only for WAV and MP3. */
  durationSec: number | null;
  clipped: boolean | null;
  /** True when duration and clipping must be measured later, on the finished video (non-WAV audio). */
  deferredCheck: boolean;
  /** Which paths were skipped or failed before this one made the voice. Empty when the first path worked. */
  note: string;
  skipped: string[];
}

export type SynthesisResult = { ok: true; narration: Narration } | { ok: false; error: string };

function measure(audio: Uint8Array): { durationSec: number | null; clipped: boolean | null; deferredCheck: boolean } {
  try {
    const info = parseWav(audio);
    return { durationSec: Math.round(info.durationSec * 100) / 100, clipped: isClipped(info), deferredCheck: false };
  } catch {
    // MP3 length can be read from the frame headers. Clipping is checked later, by the render. Ogg never gets here.
    const mp3 = mp3DurationSec(audio);
    return { durationSec: mp3, clipped: null, deferredCheck: true };
  }
}

const EXT: Record<"audio/wav" | "audio/mpeg" | "audio/ogg", "wav" | "mp3" | "ogg"> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg" };

type HermesVoice = { audio: Uint8Array; mime: "audio/wav" | "audio/mpeg" | "audio/ogg"; model: string; provider: string };

/**
 * Narration through Hermes: asked for its Kokoro voice, or for its CapCut workflow. The reply is checked by magic
 * bytes like any other media. The provider Hermes names for Kokoro is a self-report, so only "kokoro" is kept as is.
 */
export async function hermesSpeak(engine: "kokoro" | "capcut", script: string, language: string, skillHints: string[] = []): Promise<SynthesisResult> {
  const what = engine === "kokoro" ? "Kokoro through Hermes" : "The backup voice (CapCut through Hermes)";
  if (!env().HERMES_BASE_URL) return { ok: false, error: `${what} needs Hermes. Set HERMES_BASE_URL and HERMES_API_KEY.` };
  const trusted = hermesTrustedOrigins();
  const label = LANGUAGE_BY_CODE[language]?.label ?? language;
  const messages =
    engine === "kokoro"
      ? ttsKokoroPrompt({ text: script, languageLabel: label, languageCode: language, skillHints })
      : ttsCapcutPrompt({ text: script, languageLabel: label, languageCode: language });
  const result = await hermesText<HermesVoice>(messages, async (reply): Promise<Validated<HermesVoice>> => {
    const parsed = parseAudioReply(reply);
    if (!parsed.ok) return { ok: false, issues: parsed.issues };
    let audio: Uint8Array;
    try {
      const inline = decodeInlineSource(parsed.source);
      audio = inline ?? (await fetchMedia(parsed.source.value, { maxBytes: MAX_AUDIO_BYTES, timeoutMs: 90_000, trustedOrigins: trusted })).bytes;
    } catch (err) {
      return { ok: false, issues: [`${err instanceof Error ? err.message : "The audio could not be read"}. Return a public https URL or base64 audio data.`] };
    }
    const info = sniffAudio(audio);
    const issues = capcutAudioIssues(info);
    if (issues.length > 0 || !info) return { ok: false, issues };
    const provider = engine === "kokoro" ? resolveKokoroProvider(parsed.provider) : "capcut";
    return { ok: true, value: { audio, mime: info.mime, model: parsed.model, provider } };
  });
  if (!result.ok) return { ok: false, error: `${what} failed. ${result.error}` };
  const { audio, mime, model, provider } = result.value;
  return {
    ok: true,
    narration: {
      provider,
      executor: engine === "kokoro" ? "hermes-kokoro" : "hermes-capcut",
      via: "hermes",
      voice: engine,
      model,
      voiceVerified: false,
      audio,
      mime,
      ext: EXT[mime],
      ...measure(audio),
      note: "",
      skipped: [],
    },
  };
}

/** CapCut text to speech through Hermes. */
export function capcutSpeak(script: string, language: string): Promise<SynthesisResult> {
  return hermesSpeak("capcut", script, language);
}

async function runAttempt(a: VoiceAttempt, text: string, language: string, snap: CapabilitySnapshot | null): Promise<SynthesisResult> {
  if (a.engine === "kokoro-override") {
    const choice = kokoroVoiceFor(language, env().KOKORO_VOICE);
    if (!choice) return { ok: false, error: "Kokoro does not list this language." };
    try {
      const audio = await kokoroSpeak(text, choice.voice);
      return {
        ok: true,
        narration: {
          provider: "kokoro",
          executor: "kokoro",
          via: "direct",
          voice: choice.voice,
          model: kokoroConfig()?.model ?? "kokoro",
          voiceVerified: choice.verified,
          audio,
          mime: "audio/wav",
          ext: "wav",
          ...measure(audio),
          note: "",
          skipped: [],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof TtsError ? err.message : "Kokoro failed." };
    }
  }
  if (a.engine === "router" && a.model) {
    try {
      const out = await routerSpeak(text, a.model.id);
      return {
        ok: true,
        narration: {
          provider: routerProviderName(a.model.id, a.model.ownedBy),
          executor: "router-tts",
          via: "9router",
          voice: a.model.id,
          model: a.model.id,
          voiceVerified: routerVoiceVerified(a.model, language),
          audio: out.audio,
          mime: out.mime,
          ext: EXT[out.mime],
          ...measure(out.audio),
          note: "",
          skipped: [],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof TtsError ? err.message : "9router voice failed." };
    }
  }
  if (a.engine === "hermes-kokoro") return hermesSpeak("kokoro", text, language, skillHintsFor("voice", snap));
  return hermesSpeak("capcut", text, language);
}

/**
 * Tries the voice paths in order (see planVoice). Every skipped path and every failure is kept and reported, so a
 * failed narration says what was tried and why. With nothing to try the message says what is missing.
 */
export async function synthesize(script: string, language: string): Promise<SynthesisResult> {
  const text = script.trim();
  if (!text) return { ok: false, error: "The script is empty, so there is nothing to narrate." };
  const snap = await readSnapshot();
  const failures: string[] = [];
  // The owner's own Kokoro server goes first and needs no 9router list, so a working override never waits on a probe.
  const overrideFirst = planFor(language, { configured: false, models: [] }).attempts.find((a) => a.engine === "kokoro-override");
  if (overrideFirst) {
    const r = await runAttempt(overrideFirst, text, language, snap);
    if (r.ok) return { ok: true, narration: r.narration };
    failures.push(r.error);
  }
  const router = await routerVoiceList(snap, true);
  const plan = planFor(language, router);
  const notes = [...failures, ...plan.skipped];
  const attempts = plan.attempts.filter((a) => a.engine !== "kokoro-override");
  if (attempts.length === 0) {
    return { ok: false, error: [missingCapabilityMessage("voice", scanStateOf(snap)), ...notes].join(" ") };
  }
  for (const a of attempts) {
    const r = await runAttempt(a, text, language, snap);
    if (r.ok) {
      return { ok: true, narration: { ...r.narration, skipped: notes, note: notes.length > 0 ? `Other voice paths: ${notes.join(" ")}` : "" } };
    }
    notes.push(r.error);
  }
  return { ok: false, error: `No voice path worked. ${notes.join(" ")}`.slice(0, 900) };
}

export interface VoicePathInfo {
  /** One line per path in the order it is tried, for the Settings panel. */
  paths: string[];
  skipped: string[];
  backup: string;
}

/** What the voice stage would do today for English, from the stored scan and the environment. No network. */
export async function describeVoicePath(): Promise<VoicePathInfo> {
  const snap = await readSnapshot();
  const router = await routerVoiceList(snap, false);
  const plan = planFor("en", router);
  const paths = plan.attempts.map((a) => {
    if (a.engine === "kokoro-override") return "Your Kokoro server (KOKORO_BASE_URL override)";
    if (a.engine === "router") return `9router voice ${a.model?.id ?? ""}`.trim();
    if (a.engine === "hermes-kokoro") return "Hermes, asked for Kokoro";
    return "Hermes, CapCut workflow";
  });
  return { paths, skipped: plan.skipped, backup: env().TTS_BACKUP === "off" ? "off" : "CapCut through Hermes" };
}

/** A short clip for the Settings "Test voice" button, made the same way the voice stage makes narration. */
export async function voiceTest(): Promise<
  | { ok: true; provider: string; via: string; model: string; durationSec: number | null; bytes: number; ms: number; skipped: string[] }
  | { ok: false; error: string }
> {
  const started = Date.now();
  const r = await synthesize("This is a VenStudio voice test.", "en");
  if (!r.ok) return { ok: false, error: r.error };
  const n = r.narration;
  return { ok: true, provider: n.provider, via: n.via, model: n.model, durationSec: n.durationSec, bytes: n.audio.length, ms: Date.now() - started, skipped: n.skipped };
}
