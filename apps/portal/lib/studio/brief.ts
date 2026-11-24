/**
 * The brief: the owner's decision, in one shape every stage reads.
 *
 * Before this file the brief was `config.topicHint`, a free string. Every stage invented its own reading of it, and a
 * style pack could not say which fields it was promised. The brief is now an object with fixed fields, written when the
 * run starts, and **frozen** when the owner approves one of the ideas — from that point the script stage reads the frozen
 * brief and nothing else, so "what the video is about" cannot drift between the idea the owner picked and the script
 * that gets written. See docs/plans/2026-11-24-brief-and-duration.md.
 *
 * Pure: no database, no network, no clock of its own (callers pass `at`).
 */

export interface StudioBrief {
  /** 1 from the day the brief became an object; 0 for a run read back from `topicHint` alone. */
  version: 0 | 1;
  /** What the video is about, in the owner's words. */
  topic: string;
  /** The angle the owner approved, or "" before an idea is chosen. */
  angle: string;
  /** Who it is for, in the owner's words. "" when the brief did not say. */
  audience: string;
  /** The length the script is written to. */
  durationSec: number;
  /** The narration language. */
  language: string;
  /** Things the video must contain (a name, a source, a claim). */
  mustInclude: string[];
  /** Things it must not do. */
  mustAvoid: string[];
  /** The approved idea's title, once one is chosen. */
  title?: string;
  /** When the owner froze it. Absent: still a draft the idea stage may still be proposing against. */
  frozenAt?: string;
  /** Who froze it: the owner's approval, or the auto approval when nobody was watching. */
  frozenBy?: "owner" | "auto";
}

const MAX_FIELD = 2000;
const MAX_ITEM = 300;

function text(value: unknown, max = MAX_FIELD): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => text(v, MAX_ITEM)).filter(Boolean).slice(0, 20);
  // A textarea's lines mean the same thing as a list.
  return text(value)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

export interface BriefInput {
  topic: string;
  durationSec: number;
  language: string;
  audience?: string;
  mustInclude?: string[] | string;
  mustAvoid?: string[] | string;
}

/** The brief a run starts with: the owner's topic and length, nothing approved yet. */
export function briefFromInput(input: BriefInput): StudioBrief {
  return {
    version: 1,
    topic: text(input.topic),
    angle: "",
    audience: text(input.audience, MAX_ITEM),
    durationSec: Math.max(1, Math.round(input.durationSec)),
    language: text(input.language, 10) || "en",
    mustInclude: lines(input.mustInclude),
    mustAvoid: lines(input.mustAvoid),
  };
}

export interface FrozenIdea {
  title: string;
  angle: string;
}

/** The same brief, with the idea the owner approved written into it. Idempotent: freezing twice keeps the first time. */
export function freezeBrief(brief: StudioBrief, idea: FrozenIdea, at: string, by: "owner" | "auto" = "owner"): StudioBrief {
  if (brief.frozenAt) return brief;
  const angle = text(idea.angle, MAX_ITEM) || brief.angle;
  const title = text(idea.title, MAX_ITEM) || brief.title;
  return { ...brief, angle, title, frozenAt: at, frozenBy: by, version: 1 };
}

export function isFrozen(brief: StudioBrief | null | undefined): boolean {
  return Boolean(brief?.frozenAt);
}

/**
 * Reads a stored brief back. Tolerant on purpose: a run from before the brief was an object stored only `topicHint`, and
 * it must still read back as a brief (version 0) rather than as a run with no brief at all.
 */
export function parseBrief(value: unknown, fallback?: { topicHint?: string; durationSec?: number; language?: string }): StudioBrief | null {
  if (typeof value === "string") {
    const topic = text(value);
    return topic ? { ...briefFromInput({ topic, durationSec: fallback?.durationSec ?? 45, language: fallback?.language ?? "en" }), version: 0 } : null;
  }
  if (!value || typeof value !== "object") {
    const topic = text(fallback?.topicHint);
    return topic ? { ...briefFromInput({ topic, durationSec: fallback?.durationSec ?? 45, language: fallback?.language ?? "en" }), version: 0 } : null;
  }
  const r = value as Record<string, unknown>;
  // An object was written by this code, so an empty topic is the owner's empty brief, not a missing one.
  const topic = text(r.topic) || text(fallback?.topicHint);
  const durationSec = Number(r.durationSec);
  const brief: StudioBrief = {
    version: r.version === 0 ? 0 : 1,
    topic,
    angle: text(r.angle, MAX_ITEM),
    audience: text(r.audience, MAX_ITEM),
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : (fallback?.durationSec ?? 45),
    language: text(r.language, 10) || fallback?.language || "en",
    mustInclude: lines(r.mustInclude),
    mustAvoid: lines(r.mustAvoid),
  };
  const title = text(r.title, MAX_ITEM);
  if (title) brief.title = title;
  const frozenAt = text(r.frozenAt, 40);
  if (frozenAt) brief.frozenAt = frozenAt;
  if (r.frozenBy === "owner" || r.frozenBy === "auto") brief.frozenBy = r.frozenBy;
  return brief;
}

/** The brief as the one paragraph the prompts already take, so a frozen brief needs no second prompt path. */
export function briefParagraph(brief: StudioBrief): string {
  const parts = [brief.title ? `${brief.title}.` : "", brief.topic, brief.angle, brief.audience ? `For ${brief.audience}.` : ""];
  const must = brief.mustInclude.length > 0 ? `Must include: ${brief.mustInclude.join("; ")}.` : "";
  const avoid = brief.mustAvoid.length > 0 ? `Must avoid: ${brief.mustAvoid.join("; ")}.` : "";
  return [parts.filter(Boolean).join(" "), must, avoid].filter(Boolean).join(" ").slice(0, MAX_FIELD);
}