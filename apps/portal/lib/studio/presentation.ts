/**
 * The presentation score (G-presentation, docs/style-packs.md): the owner's rating of a final video on its Review
 * card, and Hermes's optional vision advisory. Pure, so the Review card, the server action, the curation log and the
 * tests share one rule.
 *
 * The owner rates five things from 1 to 5 stars. The score is the mean mapped to 0-100 (1 star = 0, 5 stars = 100)
 * and gated by presentationGate with PRESENTATION_PASS. A trial run needs it before its final decision; other runs
 * may have it. Hermes's advisory uses the same rubric but is stored beside the score and never decides anything.
 */
import type { ChatMessage, Validated } from "./director.ts";
import { PRESENTATION_PASS, presentationGate, type GateResult } from "./qc.ts";

export const PRESENTATION_RUBRIC = [
  { id: "hook", label: "Hook", hint: "The first seconds make you want to keep watching." },
  { id: "pacing", label: "Pacing", hint: "Shots change at the right moments; nothing drags or rushes." },
  { id: "legibility", label: "Legibility", hint: "Captions and on-screen text are easy to read on a phone." },
  { id: "polish", label: "Visual polish", hint: "Pictures, motion and layout look finished." },
  { id: "audio", label: "Audio", hint: "The voice is clear and the levels and music fit." },
] as const;

export type RubricId = (typeof PRESENTATION_RUBRIC)[number]["id"];
export type Stars = 1 | 2 | 3 | 4 | 5;
export type Rubric = Record<RubricId, Stars>;

export const RUBRIC_IDS: readonly RubricId[] = PRESENTATION_RUBRIC.map((r) => r.id);

/** Form field name of one rubric line on the Review card. */
export function rubricField(id: RubricId): string {
  return `rubric-${id}`;
}

const isStars = (n: number): n is Stars => Number.isInteger(n) && n >= 1 && n <= 5;

/** Reads the five ratings (from a form or JSON). Every line is required, 1 to 5 whole stars. */
export function parseRubric(read: (id: RubricId) => unknown): Validated<Rubric> {
  const out: Partial<Rubric> = {};
  const missing: string[] = [];
  for (const r of PRESENTATION_RUBRIC) {
    const raw = read(r.id);
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (isStars(n)) out[r.id] = n;
    else missing.push(r.label);
  }
  if (missing.length > 0) return { ok: false, issues: [`Rate every line from 1 to 5 stars (missing: ${missing.join(", ")})`] };
  return { ok: true, value: out as Rubric };
}

/** The 0-100 score of a rubric: the mean of the stars, 1 star = 0 and 5 stars = 100, rounded. */
export function presentationScoreOf(r: Rubric): number {
  const stars = RUBRIC_IDS.map((id) => r[id]);
  const mean = stars.reduce((a, b) => a + b, 0) / stars.length;
  return Math.round(((mean - 1) / 4) * 100);
}

/** One line per rubric entry, for the gate's notes and the curation record. */
export function rubricText(r: Partial<Record<RubricId, number>>): string {
  return PRESENTATION_RUBRIC.flatMap((x) => (typeof r[x.id] === "number" ? [`${x.label.toLowerCase()} ${r[x.id]}`] : [])).join(", ");
}

/** The G-presentation result of the owner's rating. */
export function ownerPresentationGate(r: Rubric, min: number = PRESENTATION_PASS): GateResult {
  const g = presentationGate(presentationScoreOf(r), min, [`Owner rating: ${rubricText(r)}`]);
  return { ...g, executor: "owner", notes: [`Owner rating: ${rubricText(r)}`] };
}

/** Decisions on a final video (the qc card) that need the owner's score first on a trial run. */
export const SCORED_DECISIONS: readonly string[] = ["approve", "override", "reject"];

/** Why this decision cannot be taken yet, or null. Only trial runs require the score; other runs may skip it. */
export function presentationRefusal(i: { stage: string; trial: boolean; decision: string; scored: boolean }): string | null {
  if (i.stage !== "qc" || !i.trial || i.scored || !SCORED_DECISIONS.includes(i.decision)) return null;
  return "This is a trial run: the owner scores the video (hook, pacing, legibility, visual polish, audio) before deciding. Save the score first.";
}

// ---------------------------------------------------------------------------------------------------------------
// Hermes vision advisory

/** Stills qc-video samples for the advisory (worker 0.10.0+; older workers ignore the field). */
export const ADVISORY_FRAMES = 6;

export interface PresentationAdvisory {
  score: number;
  rubric: Partial<Record<RubricId, Stars>>;
  notes: string;
  /** How many stills Hermes was shown. */
  frames: number;
  at: string;
}

/** What Hermes is asked: the pack's contract and the stills, for a JSON rating against the same rubric. */
export function advisoryMessages(i: {
  topic: string;
  format: string;
  durationSec: number | null;
  packId: string | null;
  contract: unknown;
  frames: ReadonlyArray<{ atSec: number }>;
}): ChatMessage[] {
  const lines = [
    "VENSTUDIO_STAGE: presentation-advisory",
    `Rate how this finished ${i.format} video presents, from ${i.frames.length} stills sampled evenly through it (attached in order).`,
    `Topic: ${i.topic.slice(0, 300)}`,
    i.durationSec ? `Length: ${Math.round(i.durationSec)} s. Stills at ${i.frames.map((f) => `${f.atSec} s`).join(", ")}.` : `Stills at ${i.frames.map((f) => `${f.atSec} s`).join(", ")}.`,
    i.packId ? `Style pack: ${i.packId}. Its contract (pacing, on-screen elements, captions, audio):` : "No style pack; judge it as a faceless explainer.",
    ...(i.contract ? [JSON.stringify(i.contract).slice(0, 4000)] : []),
    "Rate each line from 1 to 5 stars: hook (the opening makes you keep watching), pacing, legibility (captions and text on a phone), polish (pictures, motion, layout), audio (judge only what the stills show; say so in notes).",
    'Answer with JSON only: {"rubric":{"hook":1-5,"pacing":1-5,"legibility":1-5,"polish":1-5,"audio":1-5},"notes":"at most 400 characters"}.',
    "This rating is advisory: the owner decides.",
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

/** Hermes's advisory reply. The score is computed here from the rubric, never taken from the reply. */
export function parseAdvisory(raw: unknown): Validated<{ rubric: Rubric; notes: string; score: number }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: ["Answer with one JSON object"] };
  const o = raw as Record<string, unknown>;
  const rubricRaw = typeof o.rubric === "object" && o.rubric !== null ? (o.rubric as Record<string, unknown>) : {};
  const r = parseRubric((id) => rubricRaw[id]);
  if (!r.ok) return r;
  const notes = typeof o.notes === "string" ? o.notes.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  return { ok: true, value: { rubric: r.value, notes, score: presentationScoreOf(r.value) } };
}

/** A stored advisory as read back from jsonb, or null. */
export function readAdvisory(raw: unknown): PresentationAdvisory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.score !== "number" || !Number.isFinite(o.score) || o.score < 0 || o.score > 100) return null;
  const rubricRaw = typeof o.rubric === "object" && o.rubric !== null ? (o.rubric as Record<string, unknown>) : {};
  const rubric: Partial<Record<RubricId, Stars>> = {};
  for (const id of RUBRIC_IDS) {
    const n = Number(rubricRaw[id]);
    if (isStars(n)) rubric[id] = n;
  }
  return {
    score: Math.round(o.score),
    rubric,
    notes: typeof o.notes === "string" ? o.notes.slice(0, 400) : "",
    frames: typeof o.frames === "number" ? o.frames : 0,
    at: typeof o.at === "string" ? o.at : "",
  };
}

/** A stored owner rubric as read back from qc_reports.details, or null. */
export function readRubric(raw: unknown): Rubric | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const r = parseRubric((id) => o[id]);
  return r.ok ? r.value : null;
}
