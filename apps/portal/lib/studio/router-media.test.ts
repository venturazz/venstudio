import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AudioJoinError,
  id3v2Length,
  joinAudioChunks,
  joinMp3,
  pickRouterImageModel,
  pickRouterVoice,
  planVoice,
  resolveKokoroProvider,
  readRouterImageItem,
  retryWaitSec,
  routerImageSize,
  routerProviderName,
  routerVoiceSource,
  routerVoiceVerified,
} from "./router-media.ts";
import { makeWav, parseWav } from "./wav.ts";

const m = (id: string, ownedBy = "", kind = "") => ({ id, ownedBy, kind });

test("pickRouterVoice prefers af_heart, then an American voice, then the first Kokoro entry", () => {
  const list = [m("edge-tts/en-US-AriaNeural"), m("kokoro/bf_emma"), m("kokoro/am_adam"), m("kokoro/af_heart")];
  assert.equal(pickRouterVoice(list, "en")?.id, "kokoro/af_heart");
  assert.equal(pickRouterVoice(list.slice(0, 3), "en")?.id, "kokoro/am_adam");
  assert.equal(pickRouterVoice([m("edge-tts/x"), m("kokoro/bf_emma")], "en")?.id, "kokoro/bf_emma");
});

test("pickRouterVoice never picks a non-Kokoro voice", () => {
  assert.equal(pickRouterVoice([m("edge-tts/vi-VN-HoaiMyNeural"), m("openai/tts-1")], "en"), null);
  assert.equal(pickRouterVoice([], "en"), null);
});

test("pickRouterVoice maps other languages to the Kokoro voice name and refuses when it is missing", () => {
  const list = [m("kokoro/af_heart"), m("kokoro/ef_dora")];
  assert.equal(pickRouterVoice(list, "es")?.id, "kokoro/ef_dora");
  assert.equal(pickRouterVoice(list, "fr"), null);
  assert.equal(pickRouterVoice(list, "id"), null);
});

test("pickRouterVoice honors an English voice override that exists", () => {
  const list = [m("kokoro/af_heart"), m("kokoro/am_michael")];
  assert.equal(pickRouterVoice(list, "en", "am_michael")?.id, "kokoro/am_michael");
  assert.equal(pickRouterVoice(list, "en", "nope")?.id, "kokoro/af_heart");
});

test("routerVoiceVerified is true only for English af_heart", () => {
  assert.equal(routerVoiceVerified(m("kokoro/af_heart"), "en"), true);
  assert.equal(routerVoiceVerified(m("kokoro/am_adam"), "en"), false);
  assert.equal(routerVoiceVerified(m("kokoro/af_heart"), "es"), false);
});

test("routerProviderName uses the first path segment and isolates combos", () => {
  assert.equal(routerProviderName("kokoro/af_heart", "kokoro"), "kokoro");
  assert.equal(routerProviderName("Edge-TTS/vi-VN-HoaiMyNeural", ""), "edge-tts");
  assert.equal(routerProviderName("fast-voice", "combo"), "9router-combo-fast-voice");
  assert.equal(routerProviderName("kokoro/af_heart", "combo"), "9router-combo-kokoro-af-heart");
  assert.equal(routerProviderName("plainmodel", "acme"), "acme");
  assert.ok(routerProviderName("x".repeat(80), "combo").length <= 49);
});

test("resolveKokoroProvider never lets Hermes borrow the confirmed kokoro provider", () => {
  assert.equal(resolveKokoroProvider("Kokoro"), "hermes-kokoro");
  assert.notEqual(resolveKokoroProvider("kokoro"), "kokoro");
  assert.equal(resolveKokoroProvider("kokoro tts"), "unlisted-kokoro-tts");
  assert.equal(resolveKokoroProvider("capcut"), "unlisted-capcut");
  assert.equal(resolveKokoroProvider(""), "unlisted-unknown");
});

function id3(payload: number): Uint8Array {
  const out = new Uint8Array(10 + 4 + payload);
  out.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4]);
  return out;
}

function mp3Piece(withTag: boolean, fill: number): Uint8Array {
  const frames = new Uint8Array(8).fill(fill);
  frames[0] = 0xff;
  frames[1] = 0xfb;
  if (!withTag) return frames;
  const tag = id3(0);
  const out = new Uint8Array(tag.length + frames.length);
  out.set(tag);
  out.set(frames, tag.length);
  return out;
}

test("id3v2Length reads the synchsafe size", () => {
  assert.equal(id3v2Length(id3(0)), 14);
  assert.equal(id3v2Length(new Uint8Array([0xff, 0xfb, 0, 0])), 0);
});

test("joinMp3 strips the tag of every piece but the first", () => {
  const out = joinMp3([mp3Piece(true, 1), mp3Piece(true, 2), mp3Piece(false, 3)]);
  assert.equal(out.length, 14 + 8 + 8 + 8);
  assert.equal(out[0], 0x49);
  assert.equal(out[14], 0xff);
  assert.equal(out[22], 0xff);
  assert.equal(out[23], 0xfb);
  assert.equal(out[32], 3);
});

function wav(n: number, rate = 24000): Uint8Array {
  return makeWav({ sampleRate: rate, channels: 1, pcm: new Uint8Array(n * 2) });
}

test("joinAudioChunks joins WAV with a gap and MP3 without one", () => {
  const w = joinAudioChunks([wav(2400), wav(2400)], 0.25);
  assert.equal(w.mime, "audio/wav");
  assert.equal(parseWav(w.audio).durationSec, 0.45);
  const mp3 = joinAudioChunks([mp3Piece(true, 1), mp3Piece(true, 2)], 0.25);
  assert.equal(mp3.mime, "audio/mpeg");
  assert.equal(mp3.audio.length, 14 + 8 + 8);
});

test("joinAudioChunks refuses mixed, unknown and empty input with a clear message", () => {
  assert.throws(() => joinAudioChunks([wav(2400), mp3Piece(false, 1)], 0.25), (e: unknown) => e instanceof AudioJoinError && /mix of WAV and MP3/.test(e.message));
  assert.throws(() => joinAudioChunks([new Uint8Array([1, 2, 3, 4, 5])], 0.25), /not a WAV or MP3/);
  assert.throws(() => joinAudioChunks([], 0.25), /no audio/);
  assert.throws(() => joinAudioChunks([wav(2400, 24000), wav(2400, 22050)], 0.25), AudioJoinError);
});

const base = {
  languageCode: "en",
  overrideConfigured: false,
  router: { configured: true, models: [m("kokoro/af_heart")] },
  hermesConfigured: true,
  backupOn: true,
};

test("planVoice order with only 9router and Hermes: router, Hermes Kokoro, CapCut", () => {
  const p = planVoice(base);
  assert.deepEqual(p.attempts.map((a) => a.engine), ["router", "hermes-kokoro", "hermes-capcut"]);
  assert.equal(p.attempts[0].model?.id, "kokoro/af_heart");
  assert.deepEqual(p.skipped, []);
});

test("planVoice puts the KOKORO_BASE_URL override first and only when set", () => {
  assert.deepEqual(planVoice({ ...base, overrideConfigured: true }).attempts.map((a) => a.engine), ["kokoro-override", "router", "hermes-kokoro", "hermes-capcut"]);
});

test("planVoice sends languages Kokoro does not cover straight to CapCut and says why", () => {
  const p = planVoice({ ...base, languageCode: "id" });
  assert.deepEqual(p.attempts.map((a) => a.engine), ["hermes-capcut"]);
  assert.equal(p.skipped.length, 2);
});

test("planVoice reports each skipped path and can end empty", () => {
  const p = planVoice({ ...base, router: { configured: true, models: [m("edge-tts/x")] }, hermesConfigured: false });
  assert.equal(p.attempts.length, 0);
  assert.equal(p.skipped.length, 3);
  assert.match(p.skipped[0], /no Kokoro voice/);
  const off = planVoice({ ...base, backupOn: false, router: { configured: false, models: [] } });
  assert.deepEqual(off.attempts.map((a) => a.engine), ["hermes-kokoro"]);
  assert.match(off.skipped.join(" "), /TTS_BACKUP=off/);
  const down = planVoice({ ...base, router: { configured: true, models: [], error: "HTTP 503" } });
  assert.match(down.skipped[0], /could not be listed: HTTP 503/);
});

test("pickRouterImageModel takes the first plain model, honors the owner order, and uses combos last", () => {
  const list = [m("combo-art", "combo"), m("openai/gpt-image-1", "openai"), m("flux/dev", "flux")];
  assert.equal(pickRouterImageModel(list)?.id, "openai/gpt-image-1");
  assert.equal(pickRouterImageModel(list, ["Flux"])?.id, "flux/dev");
  assert.equal(pickRouterImageModel([m("combo-art", "combo")])?.id, "combo-art");
  assert.equal(pickRouterImageModel([m("v/clip", "v", "video")]), null);
  assert.equal(pickRouterImageModel([]), null);
});

test("routerImageSize follows the video shape", () => {
  assert.equal(routerImageSize("short"), "1024x1792");
  assert.equal(routerImageSize("long"), "1792x1024");
});

test("retryWaitSec honors Retry-After, defaults to 5 and caps at 20", () => {
  assert.equal(retryWaitSec("3"), 3);
  assert.equal(retryWaitSec("0"), 0);
  assert.equal(retryWaitSec("600"), 20);
  assert.equal(retryWaitSec(null), 5);
  assert.equal(retryWaitSec("soon"), 5);
  assert.equal(retryWaitSec("-4"), 5);
});

test("readRouterImageItem reads b64_json first, then a url, else null", () => {
  assert.deepEqual(readRouterImageItem({ data: [{ b64_json: "AAAA", url: "https://x/y.png" }] }), { kind: "b64", value: "AAAA" });
  assert.deepEqual(readRouterImageItem({ data: [{ url: "https://x/y.png" }] }), { kind: "url", value: "https://x/y.png" });
  assert.equal(readRouterImageItem({ data: [] }), null);
  assert.equal(readRouterImageItem({ data: [{ b64_json: "" }] }), null);
  assert.equal(readRouterImageItem(null), null);
  assert.equal(readRouterImageItem({ data: "x" }), null);
});

const scan = (over: { ok?: boolean; tts?: { ok: boolean; error?: string }; list?: ReturnType<typeof m>[] }) => ({
  status: { ok: over.ok ?? true },
  probes: (over.tts ? { tts: over.tts } : {}) as Record<string, { ok: boolean; error?: string }>,
  lists: { tts: over.list ?? [] },
});

test("routerVoiceSource trusts a stored list only when the TTS probe worked and a Kokoro voice is in it", () => {
  assert.equal(routerVoiceSource(scan({ tts: { ok: true }, list: [m("kokoro/af_heart")] })).use, "stored");
  assert.equal(routerVoiceSource(null).use, "probe");
  // The router as a whole answered, but the TTS probe failed: the empty list is not an answer.
  const failed = routerVoiceSource(scan({ tts: { ok: false, error: "HTTP 503" } }));
  assert.equal(failed.use, "probe");
  assert.match(failed.reason, /HTTP 503/);
  // A voice added after the last scan: the stored list has none, so look live.
  assert.equal(routerVoiceSource(scan({ tts: { ok: true }, list: [m("edge-tts/x")] })).use, "probe");
  assert.equal(routerVoiceSource(scan({ tts: { ok: true }, list: [] })).use, "probe");
  assert.equal(routerVoiceSource(scan({ ok: false, list: [m("kokoro/af_heart")] })).use, "probe");
});
