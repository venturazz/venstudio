/**
 * What a video needed and the library did not have.
 *
 * This is the half of the asset pipeline that makes the library grow with use. The seed script fills the vocabulary the
 * styles are expected to want; this records what a *real* run actually reached for and missed. Without it, growth is a
 * guess about moods nobody asked for. With it, the next find run has a list ordered by how often the studio was blocked.
 *
 * A need is one tag in one class — `music/mystery`, `sfx/riser`, `ambience/rain` — never "more assets". A need that is not
 * specific cannot be satisfied, and a library that grows by vague demand grows in the wrong direction.
 *
 * Pure: given a run's sound request, its storyboard and the library's inventory, say what is missing. The server records
 * the answer; the finder resolves it. Nothing here touches a database, so the rule is testable.
 */

import { pairCues, sfxCues, type SfxAsset, type SfxMode } from "./sound.ts";

export type AssetClass = "music" | "sfx" | "ambience";

export interface AssetNeed {
  assetClass: AssetClass;
  tag: string;
  /** One sentence the owner can read on the Assets page. */
  reason: string;
}

export interface Inventory {
  /** tag -> how many stored assets carry it (kind audio, with a file). */
  counts: Record<string, number>;
}

export function has(inventory: Inventory, tag: string): boolean {
  return (inventory.counts[tag] ?? 0) > 0;
}

/**
 * Music: a run with `bed: auto` that finds nothing is the strongest signal there is — the video goes out (or stalls)
 * without music. The mood comes from the style or the brief; `bed` is the honest fallback when nothing named a mood.
 */
export function musicNeed(i: { bedChoice: string; mood?: string | null; inventory: Inventory }): AssetNeed | null {
  if (i.bedChoice === "none") return null; // a decision, not a miss
  if (i.bedChoice !== "auto") return null; // a named track the owner picked; if it is gone, that is a library error, not a need
  const tag = (i.mood ?? "bed").toLowerCase();
  if (has(i.inventory, tag) || has(i.inventory, "music")) return null;
  return { assetClass: "music", tag, reason: `A video asked for a ${tag} music bed and the library had none.` };
}

/**
 * Effects: cues are derived from the storyboard exactly as the mix derives them, then each cue's tag is checked against the
 * library. A cue whose tag is missing is dropped from the mix — silence where the picture changes — so it is a need.
 */
export function sfxNeeds(i: {
  shots: ReadonlyArray<{ seconds: number; beatRole?: string }>;
  mode: SfxMode;
  inventory: Inventory;
}): AssetNeed[] {
  if (i.mode === "off") return [];
  const cues = sfxCues(i.shots, i.mode);
  const tags = [...new Set(cues.map((c) => c.tag))].filter((t) => !has(i.inventory, t));
  return tags.map((t) => ({ assetClass: "sfx" as const, tag: t, reason: `A cue needed a ${t} and the library had none, so it was dropped.` }));
}

/** Ambience: named atmosphere for the scene (rain, city, room tone). Without one, the mix falls back to synthesised noise. */
export function ambienceNeed(i: { ambience: boolean | string; sceneTag?: string | null; inventory: Inventory }): AssetNeed | null {
  if (i.ambience === false) return null;
  const tag = (typeof i.ambience === "string" ? i.ambience : (i.sceneTag ?? "")).toLowerCase();
  if (!tag) return null;
  if (has(i.inventory, tag)) return null;
  return { assetClass: "ambience", tag, reason: `A scene wanted ${tag} atmosphere and the library had none, so it played synthesised noise.` };
}

/** Everything one video asked for and did not get, deduplicated, in the order the mix uses them. */
export function needsForRun(i: {
  bedChoice: string;
  mood?: string | null;
  shots: ReadonlyArray<{ seconds: number; beatRole?: string }>;
  mode: SfxMode;
  ambience: boolean | string;
  sceneTag?: string | null;
  inventory: Inventory;
}): AssetNeed[] {
  const out: AssetNeed[] = [];
  const music = musicNeed({ bedChoice: i.bedChoice, mood: i.mood, inventory: i.inventory });
  if (music) out.push(music);
  out.push(...sfxNeeds({ shots: i.shots, mode: i.mode, inventory: i.inventory }));
  const amb = ambienceNeed({ ambience: i.ambience, sceneTag: i.sceneTag, inventory: i.inventory });
  if (amb) out.push(amb);
  return dedupe(out);
}

export function dedupe(needs: readonly AssetNeed[]): AssetNeed[] {
  const seen = new Set<string>();
  const out: AssetNeed[] = [];
  for (const n of needs) {
    const key = `${n.assetClass}/${n.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * Which cues a run would silently lose, given the library — the honest version of "the mix used what it had". Used by QC
 * so a video that dropped three of five accents can say so instead of looking finished.
 */
export function droppedCues(shots: ReadonlyArray<{ seconds: number; beatRole?: string }>, mode: SfxMode, assets: readonly SfxAsset[]): number {
  const cues = sfxCues(shots, mode);
  return cues.length - pairCues(cues, assets).length;
}