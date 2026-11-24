/**
 * What a run asks of its soundtrack: which bed, how busy the accents are, whether ambience plays.
 *
 * The mix itself is not decided here. `audio-plan.ts` owns the numbers (bed normalised to −20 LUFS then lifted 3.5 dB,
 * ducked 4:1 under the voice; ambience brown noise at −26 dBFS; master −14 LUFS / −1 dBTP) and `music-bed.ts` owns which
 * track may be a bed at all (music tag, licence, confirmed terms, never the narration). This file answers the two
 * questions the owner answers, and the one the storyboard answers: which track, how many accents, and where.
 *
 * Accents sit on shot boundaries, because that is where the picture changes and the ear expects a sound. Two rules keep
 * that from turning into noise: nothing closer than `SFX_MIN_GAP_SEC` (the same three seconds the reference mix measured),
 * and never on the first shot, which already carries the narration's hook. `sparse` keeps one accent per three shots —
 * the reference's one per three or four; `rich` keeps every candidate that clears the gap.
 *
 * A cue with no asset whose tags match is dropped rather than replaced with a random sound: a wrong whoosh is worse than
 * silence, and the run can say it had no accent for that beat.
 */

import { SFX_MIN_GAP_SEC } from "./audio-plan.ts";

export type SfxMode = "off" | "sparse" | "rich";
export const SFX_MODES: readonly SfxMode[] = ["off", "sparse", "rich"];
export const SFX_MODE_LABEL: Record<SfxMode, string> = {
  off: "No sound effects",
  sparse: "Sparse (one per three or four shots)",
  rich: "Rich (every shot, still three seconds apart)",
};

/** `auto` lets the library choose under the style's policy; `none` is a decision, not a failure. */
export type BedChoice = "auto" | "none" | string;

export interface SoundRequest {
  bed: BedChoice;
  sfx: SfxMode;
  ambience: boolean;
}

/** Auto bed, sparse accents, ambience on: the reference mix, for anything narrated. */
export const DEFAULT_SOUND: SoundRequest = { bed: "auto", sfx: "sparse", ambience: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tolerant: a run written before sound existed reads as the default, and an unknown track id falls back to auto. */
export function parseSound(value: unknown): SoundRequest {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const rawBed = typeof o.bed === "string" ? o.bed.trim() : "";
  const bed: BedChoice = rawBed === "none" ? "none" : UUID_RE.test(rawBed) ? rawBed : "auto";
  const sfx: SfxMode = SFX_MODES.includes(o.sfx as SfxMode) ? (o.sfx as SfxMode) : DEFAULT_SOUND.sfx;
  const ambience = typeof o.ambience === "boolean" ? o.ambience : DEFAULT_SOUND.ambience;
  return { bed, sfx, ambience };
}

/** `sparse` keeps one accent per this many candidates. */
export const SFX_SPARSE_EVERY = 3;

/** Which kind of accent a beat earns. An unknown beat gets a neutral whoosh. */
export function sfxTagFor(beatRole: string | undefined): string {
  switch (beatRole) {
    case "payoff":
      return "impact";
    case "cta":
      return "riser";
    case "setup":
      return "transition";
    default:
      return "whoosh";
  }
}

export interface Cue {
  atSec: number;
  tag: string;
}

/**
 * Cue points for a storyboard, in time order: never on the first shot, never closer than three seconds.
 */
export function sfxCues(shots: ReadonlyArray<{ seconds: number; beatRole?: string }>, mode: SfxMode): Cue[] {
  if (mode === "off") return [];
  const candidates: Cue[] = [];
  let at = 0;
  shots.forEach((shot, n) => {
    const seconds = Number.isFinite(shot.seconds) && shot.seconds > 0 ? shot.seconds : 0;
    if (n > 0 && seconds > 0) candidates.push({ atSec: round(at), tag: sfxTagFor(shot.beatRole) });
    at += seconds;
  });
  const spaced: Cue[] = [];
  for (const cue of candidates) {
    const last = spaced[spaced.length - 1];
    if (last && cue.atSec - last.atSec < SFX_MIN_GAP_SEC) continue;
    spaced.push(cue);
  }
  if (mode === "rich") return spaced;
  return spaced.filter((_, i) => i % SFX_SPARSE_EVERY === 0);
}

export interface SfxAsset {
  id: string;
  tags: readonly string[];
}

/**
 * Pairs each cue with an asset carrying its tag, rotating through the matches so a series does not reuse one click,
 * and dropping a cue when nothing matches rather than substituting an unrelated sound.
 */
export function pairCues(cues: readonly Cue[], assets: readonly SfxAsset[]): Array<{ atSec: number; assetId: string }> {
  const byTag = new Map<string, string[]>();
  for (const a of assets) for (const t of a.tags) byTag.set(t, [...(byTag.get(t) ?? []), a.id]);
  const used = new Map<string, number>();
  const out: Array<{ atSec: number; assetId: string }> = [];
  for (const cue of cues) {
    const matches = byTag.get(cue.tag) ?? [];
    if (matches.length === 0) continue;
    const n = used.get(cue.tag) ?? 0;
    out.push({ atSec: cue.atSec, assetId: matches[n % matches.length] });
    used.set(cue.tag, n + 1);
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}