/**
 * The run's narration on Hermes's picture (research only). Pure.
 *
 * A Hermes render of a run that recorded its own voice (hermes.voice "run", and any hermes render of a run with a voice
 * stage) cannot rely on Hermes for the sound: the narration lives in the portal's storage, which Hermes cannot read, so
 * Hermes was told to render without a voice and the video came back silent. Instead the portal takes Hermes's clip as
 * the picture and queues a render-video job with engine hermes-mux: a worker downloads the clip and the narration like
 * any job input and lays the soundtrack on with the shared audio chain (buildMuxArgs and audioMixFilter: narration
 * tempo, the music bed and ambience of the audio plan, mastered loudness). Hermes's own audio is dropped.
 *
 * Only a worker that reports the hermes-mux capability (0.13.0+, reported where its ffmpeg has the whole mix chain and
 * tpad) runs it; with none, the stage stops with a stage error naming the fix, never with a silent video. A skill that
 * voices itself (hermes.voice "skill") keeps Hermes's audio, and the quality check says when it is silent.
 */
import type { AudioPlan } from "./audio-plan.ts";

export const HERMES_MUX_ENGINE = "hermes-mux";
export const HERMES_MUX_CAPABILITY = "hermes-mux";
/** The first worker release that runs engine hermes-mux. */
export const HERMES_MUX_WORKER_VERSION = "0.13.0";

/** Up to this much longer than the narration, Hermes's picture plays whole and the narration ends in silence. */
export const MUX_MAX_PAD_SEC = 3;
/** A picture cut to the narration keeps this much after the last word. */
export const MUX_TAIL_SEC = 0.5;
/** Below this, a longer picture is a match, not a pad. */
export const MUX_MATCH_SEC = 0.05;

export type MuxMode = "match" | "freeze" | "pad" | "trim";

export interface MuxPlan {
  mode: MuxMode;
  /** The finished video's length. */
  durationSec: number;
  /** Hermes's picture as it came. */
  clipSec: number;
  /** The narration as it plays (after its tempo). */
  narrationSec: number;
  /** freeze: how long the last frame is held (ffmpeg tpad stop_mode=clone). */
  freezeSec: number;
  /** pad: the silence after the narration, to the end of the picture. */
  padSec: number;
  /** trim: how much of the picture's end is cut. */
  trimSec: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * How the picture and the narration are made the same length. Mirror of hermesMuxPlan in apps/worker (the worker
 * decides from the clip it measured; render-engines.test.ts checks both agree):
 * - the picture is shorter than the narration (by more than a frame): its last frame is held until the narration ends;
 * - it is longer by at most MUX_MAX_PAD_SEC: it plays whole and the narration is padded with silence;
 * - it is longer than that: it is cut MUX_TAIL_SEC after the narration ends;
 * - otherwise (within a frame shorter, or under MUX_MATCH_SEC longer): a match, the picture's length.
 */
export function hermesMuxPlan(i: { clipSec: number; narrationSec: number; fps: number }): MuxPlan {
  const clip = r3(i.clipSec);
  const narr = r3(i.narrationSec);
  const frame = i.fps > 0 ? 1 / i.fps : 1 / 30;
  const base = { clipSec: clip, narrationSec: narr, freezeSec: 0, padSec: 0, trimSec: 0 };
  if (clip < narr - frame) return { ...base, mode: "freeze", durationSec: narr, freezeSec: r3(narr - clip) };
  if (clip > narr + MUX_MAX_PAD_SEC) {
    const durationSec = r3(narr + MUX_TAIL_SEC);
    return { ...base, mode: "trim", durationSec, trimSec: r3(clip - durationSec) };
  }
  const pad = r3(clip - narr);
  if (pad < MUX_MATCH_SEC) return { ...base, mode: "match", durationSec: clip };
  return { ...base, mode: "pad", durationSec: clip, padSec: pad };
}

/** Reads the plan the worker reports in its result (result.mux). Null when it is missing or malformed. */
export function readMuxPlan(raw: unknown): MuxPlan | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? r3(v) : null);
  const mode = r.mode === "match" || r.mode === "freeze" || r.mode === "pad" || r.mode === "trim" ? r.mode : null;
  const durationSec = n(r.durationSec);
  const clipSec = n(r.clipSec);
  const narrationSec = n(r.narrationSec);
  if (!mode || durationSec === null || clipSec === null || narrationSec === null) return null;
  return { mode, durationSec, clipSec, narrationSec, freezeSec: n(r.freezeSec) ?? 0, padSec: n(r.padSec) ?? 0, trimSec: n(r.trimSec) ?? 0 };
}

const s1 = (n: number) => `${Math.round(n * 10) / 10} s`;

/** One line for the card: what the studio did to fit the narration to Hermes's picture. */
export function muxNote(p: MuxPlan): string {
  const both = `Hermes's picture is ${s1(p.clipSec)} and the narration ${s1(p.narrationSec)}`;
  if (p.mode === "freeze") return `${both}: the last frame is held for ${s1(p.freezeSec)} so the narration ends on screen.`;
  if (p.mode === "pad") return `${both}: the picture plays whole and the narration ends ${s1(p.padSec)} before it.`;
  if (p.mode === "trim") return `${both}: the picture is cut ${s1(MUX_TAIL_SEC)} after the narration ends (${s1(p.trimSec)} cut).`;
  return `${both}: they match.`;
}

/** Why no hermes-mux job can be queued, or null when a worker reports the capability. `lists` null: unreadable. */
export function muxWorkerIssue(lists: readonly (readonly string[])[] | null): string | null {
  if (lists && lists.some((caps) => caps.includes(HERMES_MUX_CAPABILITY))) return null;
  return (
    `Hermes renders the picture of this style and a worker adds the run's narration to it, but no worker reports ${HERMES_MUX_CAPABILITY} ` +
    `(worker ${HERMES_MUX_WORKER_VERSION} or later, with a full ffmpeg). Update the worker (its signed self-update brings ${HERMES_MUX_WORKER_VERSION}), then press Retry. ` +
    "No video was kept, so no silent video reaches you."
  );
}

export interface HermesMuxInput {
  runId: string;
  format: string;
  width: number;
  height: number;
  fps: number;
  /** Hermes's clip, stored as a video asset. */
  pictureAssetId: string;
  narrationAssetId: string;
  /** The narration as it plays (after `tempo`), as on every render-video payload. */
  narrationSec: number;
  tempo: number;
  targetLufs: number;
  /** The run's audio plan (audio-plan.ts), planned for the played narration, or null for the narration alone. */
  audio: AudioPlan | null;
}

/**
 * The render-video payload of a hermes-mux job. Every file is a job input, downloaded the normal way; nothing is
 * fetched from Hermes by the worker.
 */
export function hermesMuxPayload(i: HermesMuxInput): Record<string, unknown> {
  const mixFiles = i.audio ? [...(i.audio.bed ? [i.audio.bed.assetId] : []), ...i.audio.sfx.map((s) => s.assetId)] : [];
  return {
    runId: i.runId,
    engine: HERMES_MUX_ENGINE,
    format: i.format,
    width: i.width,
    height: i.height,
    fps: i.fps,
    picture: { assetId: i.pictureAssetId },
    narrationAssetId: i.narrationAssetId,
    narrationSec: Math.round(i.narrationSec * 1000) / 1000,
    ...(i.tempo !== 1 ? { narrationTempo: i.tempo } : {}),
    targetLufs: i.targetLufs,
    ...(i.audio ? { audio: i.audio } : {}),
    inputs: [...new Set([i.pictureAssetId, i.narrationAssetId, ...mixFiles])],
  };
}
