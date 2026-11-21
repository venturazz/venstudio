/**
 * Which library track may play under a video as its music bed. Pure, so the rule is tested without a database.
 *
 * The render stage used to take the newest `audio` asset, and narration is saved as `audio` too, so the bed was
 * usually the run's own narration mixed under itself. Only a track the owner marked as music qualifies now, and it
 * has to pass the same checks as every other input of a published video:
 *
 * - kind `audio`, a stored file, and the `music` tag (set by "This is a music track for video beds" on Assets);
 * - never speech: not a TTS output (metadata.providerKind "tts"), not this run's narration, not tagged as a voice;
 * - allowed by the template's music policy (`none` forbids a bed; `licensed` and `self-generated` narrow the source)
 *   and by its asset policy (allowed sources, forbidden kinds), as G-assets judges the images;
 * - provenance complete for publishing (a licence, and an origin link for uploads and licensed files);
 * - a maker whose commercial-use terms the owner confirmed in Settings when it came from a provider. Unknown terms
 *   do not pass: an image with unknown terms is flagged at publish, but a bed is chosen by code, so it is never
 *   chosen on terms nobody confirmed. Only the owner sets terms; nothing here writes them;
 * - shared, or of the run's channel.
 *
 * Of the tracks that qualify, the run's channel's own beats a shared one, then the newest wins. Each track that was
 * passed over keeps its reason, so the run can say why it has no music.
 */
import type { AssetKind, AssetSource } from "./catalog.ts";
import { normalizeProvider, providerTermsIssues, type ProviderKind, type ProviderTerms } from "./asset-plan.ts";
import { provenanceIssues } from "./provenance.ts";
import type { MusicPolicy, Template } from "./templates.ts";

/** The tag that marks a library track as music for video beds. */
export const MUSIC_TAG = "music";
/** Tags that mark speech. A track carrying one is never a bed, whatever else it is tagged. */
export const SPEECH_TAGS: readonly string[] = ["narration", "voice", "tts", "speech"];

/** Sources each policy accepts. An upload is the owner's own file with the owner's stated licence, so it fits both. */
const POLICY_SOURCES: Record<Exclude<MusicPolicy, "none">, readonly AssetSource[]> = {
  licensed: ["licensed", "upload"],
  "self-generated": ["generated", "hermes", "muse", "worker", "upload"],
  "self-or-licensed": ["licensed", "upload", "generated", "hermes", "muse", "worker"],
};

/** A library asset as the render stage reads it. */
export interface BedCandidate {
  id: string;
  title: string;
  kind: AssetKind;
  source: AssetSource;
  license: string;
  originUrl: string;
  tags: readonly string[];
  /** metadata.provider: who made it, when a provider did. Empty for an upload. */
  provider: string;
  /** metadata.providerKind ("tts" for a voice). */
  providerKind: string;
  /** metadata.runId: the run that made it, when one did. */
  runId: string | null;
  channelId: string | null;
  hasFile: boolean;
  /** Seconds, when known (metadata.durationSec). Decides loop or trim; unknown loops and trims. */
  durationSec?: number | null;
}

export interface BedContext {
  template: Pick<Template, "assetPolicy"> & { audio: Pick<Template["audio"], "musicPolicy"> };
  runId: string;
  channelId: string | null;
  /** Every narration asset of this run (the current voice result and earlier attempts). */
  narrationAssetIds: readonly string[];
  providerTerms: readonly ProviderTerms[];
}

export interface BedPick {
  bed: BedCandidate | null;
  /** Tracks tagged as music that were passed over, each with the first reason. Capped. */
  skipped: Array<{ title: string; reason: string }>;
}

const MAX_SKIPPED = 6;

/** Why this track may not be a bed, or null when it may. Tracks without the music tag are not music at all. */
export function bedRefusal(c: BedCandidate, ctx: BedContext): string | null {
  const tags = c.tags.map((t) => t.toLowerCase());
  if (c.kind !== "audio") return "it is not an audio file";
  if (!c.hasFile) return "the file was never stored";
  if (!tags.includes(MUSIC_TAG)) return `it is not tagged "${MUSIC_TAG}"`;
  if (c.providerKind === "tts" || tags.some((t) => SPEECH_TAGS.includes(t))) return "it is speech, not music";
  if (ctx.narrationAssetIds.includes(c.id)) return "it is this video's narration";
  const policy = ctx.template.audio.musicPolicy;
  if (policy === "none") return "the template allows no music";
  if (!POLICY_SOURCES[policy].includes(c.source)) return `the template takes ${policy} music, and this is a ${c.source} file`;
  if (ctx.template.assetPolicy.forbidKinds.includes("audio")) return "the template allows no audio assets";
  if (!ctx.template.assetPolicy.allowedSources.includes(c.source)) return `source ${c.source} is not allowed in this template`;
  if (c.channelId && c.channelId !== ctx.channelId) return "it belongs to another channel";
  const provenance = provenanceIssues([{ title: c.title, kind: c.kind, source: c.source, license: c.license, originUrl: c.originUrl, tags: [...c.tags] }], "publish");
  if (provenance.length > 0) return provenance[0].replace(`${c.title}: `, "");
  if (c.provider.trim()) {
    const kind: ProviderKind = c.providerKind === "image" || c.providerKind === "video" ? c.providerKind : "library";
    const terms = providerTermsIssues([{ title: c.title, provider: c.provider, kind }], [...ctx.providerTerms]);
    if (terms.length > 0) return `the commercial-use terms of ${normalizeProvider(c.provider)} are not confirmed in Settings`;
  }
  return null;
}

/**
 * The bed for this run: the best track that qualifies, or null. `candidates` should be newest first; a track of the
 * run's channel is preferred over a shared one, and order decides among equals.
 */
export function pickMusicBed(candidates: readonly BedCandidate[], ctx: BedContext): BedPick {
  const skipped: BedPick["skipped"] = [];
  const ok: BedCandidate[] = [];
  for (const c of candidates) {
    const why = bedRefusal(c, ctx);
    if (why === null) ok.push(c);
    // A narration or a test voice without the music tag is not a track anyone meant as music: no need to list it.
    else if (c.tags.map((t) => t.toLowerCase()).includes(MUSIC_TAG) && skipped.length < MAX_SKIPPED) skipped.push({ title: c.title, reason: why });
  }
  const own = ok.find((c) => ctx.channelId !== null && c.channelId === ctx.channelId);
  return { bed: own ?? ok[0] ?? null, skipped };
}

/** One line for the render stage: which track plays under the video, or why none does. */
export function bedNote(pick: BedPick, policy: MusicPolicy): string {
  if (pick.bed) return `Music bed: ${pick.bed.title} (${pick.bed.license}).`;
  if (policy === "none") return "No music: the template allows none.";
  const why = pick.skipped.map((s) => `${s.title}: ${s.reason}`).join("; ");
  return why
    ? `No music bed: no track qualifies (${why}). The mix is the narration and ambience.`
    : `No music bed: no audio in Assets is marked as a music track. Upload one and tick "This is a music track for video beds". The mix is the narration and ambience.`;
}
