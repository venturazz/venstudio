/**
 * The audio layers a narrated explainer needs, as data.
 *
 * The worker's mix was narration alone: loudnorm, then apad. The reference this style chases mixes three
 * layers, and the numbers that measured right on it are the ones below — a bed normalised to -20 LUFS and
 * then lifted 3.5 dB, ducked 4:1 under the voice at a 0.02 threshold with a 15 ms attack and a 350 ms
 * release; ambience, brown noise band-passed 90-3200 Hz, sitting 26 dB down; and accents kept sparse, one
 * per three or four shots.
 *
 * Two traps the numbers encode. A gentle duck over a *normalised* bed is audible; an 8:1 duck, or a raw
 * `volume=0.12` on an un-normalised mp3, is effectively silence — that pairing produced two separate
 * "I cannot hear the music at all" review passes. And a bed that ends before the video does is
 * indistinguishable from a missing bed, so a shorter one is looped up to the cut rather than left short.
 *
 * Ambience needs no asset: it is noise, so the worker synthesises it. The bed is the one layer that needs
 * a real track, and a mix built without one carries `bed: null` rather than pretending.
 */
import type { MusicPolicy } from "./templates.ts";

/** A bed is normalised to this before anything else touches it. */
export const BED_SOURCE_LUFS = -20;
/** Lifted by this after normalising, so the duck has something to duck. */
export const BED_GAIN_DB = 3.5;
export const BED_DUCK = { threshold: 0.02, ratio: 4, attackMs: 15, releaseMs: 350, makeup: 1 } as const;
export const AMBIENT_BAND_HZ: [number, number] = [90, 3200];
/** -26 dBFS, the same as `volume=0.05`. */
export const AMBIENT_GAIN_DB = -26;
export const AMBIENT_NOISE_COLOR = "brown";
export const MASTER_LUFS = -14;
export const MASTER_TRUE_PEAK_DB = -1;
/** Accents no closer together than this. The reference uses one per three or four shots. */
export const SFX_MIN_GAP_SEC = 3;
export const MAX_AUDIO_ISSUES = 6;

export interface DuckSpec {
  threshold: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeup: number;
}

export interface BedSpec {
  assetId: string;
  sourceLufs: number;
  gainDb: number;
  duck: DuckSpec;
  /** Trim a longer bed to the cut, loop a shorter one up to it. An unknown length loops and trims. */
  cover: "trim" | "loop";
}

export interface AmbientSpec {
  /** Noise the worker synthesises, so ambience never waits on an asset. */
  color: "brown";
  bandHz: [number, number];
  gainDb: number;
}

export interface AudioPlan {
  master: { targetLufs: number; maxTruePeakDb: number };
  /** Music bed, or null when the policy forbids one or none was chosen. */
  bed: BedSpec | null;
  /** Fills the gaps between beats. Absent for a video with no narration. */
  ambient: AmbientSpec | null;
  sfx: Array<{ atSec: number; assetId: string }>;
}

export interface AudioPlanInput {
  /** Music policy from the template. "none" forbids a bed outright. */
  policy: MusicPolicy;
  /** True when the video carries narration, which is what the ambience sits between. */
  narrated: boolean;
  /** Length of the finished cut, used to decide whether the bed is trimmed or looped. */
  durationSec: number;
  targetLufs?: number;
  maxTruePeakDb?: number;
  bed?: { assetId: string; durationSec?: number } | null;
  sfx?: readonly { atSec: number; assetId: string }[];
}

export type AudioPlanResult = { ok: true; plan: AudioPlan } | { ok: false; issues: string[] };

const round = (n: number) => Math.round(n * 1000) / 1000;

export function buildAudioPlan(i: AudioPlanInput): AudioPlanResult {
  const issues: string[] = [];
  if (!(i.durationSec > 0)) issues.push("The mix has no length to fill");
  if (i.bed && i.policy === "none") issues.push("The template forbids music, but a bed is attached to this mix");
  if (i.bed && !i.bed.assetId) issues.push("A bed was chosen with no asset id");
  const sfx = [...(i.sfx ?? [])].map((s) => ({ atSec: round(s.atSec), assetId: s.assetId })).sort((a, b) => a.atSec - b.atSec);
  for (const s of sfx) {
    if (!(s.atSec >= 0) || s.atSec >= i.durationSec) issues.push(`An accent sits at ${s.atSec} s, outside a ${round(i.durationSec)} s video`);
  }
  for (let n = 1; n < sfx.length; n++) {
    const gap = round(sfx[n].atSec - sfx[n - 1].atSec);
    if (gap < SFX_MIN_GAP_SEC) issues.push(`Two accents ${gap} s apart; keep them at least ${SFX_MIN_GAP_SEC} s apart so they read as accents`);
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_AUDIO_ISSUES) };

  return {
    ok: true,
    plan: {
      master: { targetLufs: i.targetLufs ?? MASTER_LUFS, maxTruePeakDb: i.maxTruePeakDb ?? MASTER_TRUE_PEAK_DB },
      bed:
        i.policy !== "none" && i.bed
          ? {
              assetId: i.bed.assetId,
              sourceLufs: BED_SOURCE_LUFS,
              gainDb: BED_GAIN_DB,
              duck: { ...BED_DUCK },
              // A bed shorter than the cut has to be looped, or the last stretch plays in silence.
              cover: i.bed.durationSec !== undefined && i.bed.durationSec >= i.durationSec ? "trim" : "loop",
            }
          : null,
      ambient: i.narrated ? { color: AMBIENT_NOISE_COLOR, bandHz: [...AMBIENT_BAND_HZ] as [number, number], gainDb: AMBIENT_GAIN_DB } : null,
      sfx,
    },
  };
}
