/**
 * Provider terms on the Review card, pure: which asset_providers rows block an assets or voice card, a hint when the
 * owner confirmed a near-identical row, and when a card may be checked again without making anything new.
 * Nothing here writes terms: asset_providers.commercial_ok is only ever set by the owner (lib/server/provider-terms.ts).
 */
import { normalizeProvider, type ProviderKind, type ProviderTerms, type ProviderUse } from "./asset-plan.ts";
import { isTermsIssue, onlyTermsIssues } from "./production.ts";
import type { ReviewKind, ReviewMedia } from "./review.ts";

/** One asset_providers row a stage's work is saved under, and how many files it made. */
export interface ProviderRowUse {
  name: string;
  kind: ProviderKind;
  count: number;
}

/** A row that keeps a card from passing: never confirmed, or marked "Not for commercial use". */
export interface BlockingRow extends ProviderRowUse {
  status: "unknown" | "no";
  note: string;
  /** Set when the owner confirmed a row that differs only by the unlisted- prefix or by kind. Never acted on. */
  hint: string | null;
}

export const PROVIDER_KINDS: readonly ProviderKind[] = ["image", "tts", "library", "video"];

const KIND_WORD: Record<ProviderKind, string> = { image: "image", tts: "voice", library: "library", video: "video" };

export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === "string" && (PROVIDER_KINDS as readonly string[]).includes(v);
}

/** Reads stored payload.providers back, keeping only well-formed rows. */
export function parseProviderRows(raw: unknown): ProviderRowUse[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderRowUse[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name.trim() || !isProviderKind(r.kind)) continue;
    out.push({ name: normalizeProvider(r.name), kind: r.kind, count: typeof r.count === "number" && r.count > 0 ? Math.floor(r.count) : 1 });
  }
  return out.slice(0, 40);
}

/** Groups uses by row (normalised name and kind), in first-seen order, with a count per row. */
export function providerRowsUsed(uses: readonly ProviderUse[]): ProviderRowUse[] {
  const out: ProviderRowUse[] = [];
  for (const u of uses) {
    const name = normalizeProvider(u.provider);
    const cur = out.find((r) => r.name === name && r.kind === u.kind);
    if (cur) cur.count++;
    else out.push({ name, kind: u.kind, count: 1 });
  }
  return out;
}

/**
 * The rows a review item's work is saved under. Newer items store them (payload.providers); older ones are read back
 * from the media: images as kind image, the narration as kind tts.
 */
export function providersFromPayload(stage: string, payload: { providers?: ProviderRowUse[]; media?: ReviewMedia }): ProviderRowUse[] {
  if (payload.providers && payload.providers.length > 0) return payload.providers;
  const media = payload.media;
  if (stage === "assets") return providerRowsUsed((media?.images ?? []).map((i) => ({ title: i.shotRef, provider: i.provider, kind: "image" as const })));
  if (stage === "voice" && media?.voiceProvider) return [{ name: normalizeProvider(media.voiceProvider), kind: "tts", count: 1 }];
  return [];
}

function termsFor(terms: readonly ProviderTerms[], name: string, kind: ProviderKind): ProviderTerms | undefined {
  const n = normalizeProvider(name);
  return terms.find((t) => t.kind === kind && normalizeProvider(t.name) === n);
}

/**
 * A nudge when the owner already confirmed a row that is almost this one: the same backend without (or with) the
 * unlisted- prefix, or the same name under another kind. It only explains; the owner still has to confirm this row.
 */
export function confirmHint(row: { name: string; kind: ProviderKind }, terms: readonly ProviderTerms[]): string | null {
  const name = normalizeProvider(row.name);
  if (name.startsWith("unlisted-")) {
    const bare = normalizeProvider(name.slice("unlisted-".length));
    if (termsFor(terms, bare, row.kind)?.commercialOk === "yes") {
      return `You confirmed ${bare}; this one is ${name} (Hermes said ${bare} made it). Confirm it too?`;
    }
  } else {
    const unlisted = `unlisted-${name}`;
    if (termsFor(terms, unlisted, row.kind)?.commercialOk === "yes") return `You confirmed ${unlisted}; this one is ${name}. Confirm it too?`;
  }
  const other = terms.find((t) => t.kind !== row.kind && normalizeProvider(t.name) === name && t.commercialOk === "yes");
  if (other) {
    return `You confirmed ${name} as a${other.kind === "image" ? "n" : ""} ${KIND_WORD[other.kind]} provider; this row is ${name} as a${row.kind === "image" ? "n" : ""} ${KIND_WORD[row.kind]} provider. Confirm it too?`;
  }
  return null;
}

/** The rows that block, against the terms as they are now. A confirmed row ("yes") never blocks. */
export function blockingRows(used: readonly ProviderRowUse[], terms: readonly ProviderTerms[]): BlockingRow[] {
  const out: BlockingRow[] = [];
  for (const u of used) {
    const rec = termsFor(terms, u.name, u.kind);
    const status = rec?.commercialOk ?? "unknown";
    if (status === "yes") continue;
    out.push({ name: normalizeProvider(u.name), kind: u.kind, count: u.count, status, note: rec?.note ?? "", hint: confirmHint(u, terms) });
  }
  return out;
}

export function hasTermsIssues(issues: readonly string[] | undefined): boolean {
  return (issues ?? []).some(isTermsIssue);
}

/** Stages whose gate checks provider terms on work that is already made, so the gate alone can run again. */
export function isTermsStage(stage: string): stage is "assets" | "voice" {
  return stage === "assets" || stage === "voice";
}

/** True when the card may be checked again: an assets or voice gate failure with at least one provider-terms issue. */
export function canRecheck(kind: ReviewKind, stage: string, issues: readonly string[] | undefined): boolean {
  return kind === "gate-failure" && isTermsStage(stage) && hasTermsIssues(issues);
}

/**
 * Whether a terms change made by the owner should re-check this open item on its own: an assets or voice gate
 * failure whose only issues are provider terms, and whose work is saved under the changed row.
 */
export function autoRecheckMatches(
  item: { kind: ReviewKind; stage: string; payload: { issues?: string[]; providers?: ProviderRowUse[]; media?: ReviewMedia } },
  changed: { name: string; kind: ProviderKind },
): boolean {
  if (item.kind !== "gate-failure" || !isTermsStage(item.stage) || !onlyTermsIssues(item.payload.issues ?? [])) return false;
  const name = normalizeProvider(changed.name);
  return providersFromPayload(item.stage, item.payload).some((p) => p.kind === changed.kind && normalizeProvider(p.name) === name);
}

/** Why a card cannot be checked again right now, or null when it can. */
export function recheckRefusal(input: { reviewState: string; kind: ReviewKind; stage: string; issues: readonly string[]; runState: string; stageState: string | null }): string | null {
  if (input.reviewState !== "open") return "This card was already decided or checked again. Refresh to see the new one.";
  if (!canRecheck(input.kind, input.stage, input.issues)) return "Only an assets or voice card held up by provider terms can be checked again.";
  if (input.runState !== "waiting-human") return "This run is no longer waiting for you.";
  if (input.stageState !== "waiting-human") return "This step is no longer waiting for you.";
  return null;
}

/** What concludeStage did with the re-checked work. */
export type ConclusionAction = "approved" | "asked-approval" | "gate-failure" | "blocked" | "revise" | "dropped";

/** The line the owner reads after a re-check. */
export function recheckMessage(stage: "assets" | "voice", action: ConclusionAction, stillBlocking: readonly string[]): string {
  const what = stage === "assets" ? "images" : "narration";
  switch (action) {
    case "approved":
      return `The checks pass now. The ${what} were kept and the studio continues.`;
    case "asked-approval":
      return `The checks pass now. Nothing was made again: approve the ${stage === "assets" ? "assets" : "voice"} to continue.`;
    case "gate-failure":
      return stillBlocking.length > 0
        ? `Checked again. Still blocked by ${stillBlocking.join(", ")}. Nothing was made again.`
        : `Checked again. Other checks still fail. Nothing was made again.`;
    case "blocked":
      return "Checked again. The run is blocked; see the new card.";
    case "revise":
    case "dropped":
      return "Checked again.";
  }
}
