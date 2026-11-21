/**
 * Does the narration fit the video, and if not, what fixes it without throwing work away. Pure.
 *
 * The voice gate judges the narration by what really breaks a video: the format's length limits (VIDEO_FORMATS) and
 * the storyboard's shots, which the render planner stretches up to the template's maxShotSeconds and shrinks down to
 * MIN_SHOT_SECONDS (the same limits render.ts and the storyboard gate use). A difference from the word-count estimate
 * is only a note, unless it is so large that the audio itself is probably broken.
 *
 * Fixes, in the order the card offers them:
 * - fit: a small tempo change (ffmpeg atempo on the worker, TEMPO_RANGE) that makes the played length fit the shots;
 * - tighten: Hermes rewrites the script to a target length that fits, keeping the storyboard and every image;
 * - approve anyway (owner only): only for a soft problem, the large mismatch with the estimate.
 */
import { VIDEO_FORMATS, type Format } from "./catalog.ts";
import { COVER_TOLERANCE_SEC, MIN_SHOT_SECONDS, maxCoverSec } from "./render.ts";

/** Above this difference from the script estimate the card shows a note. Below it nothing is said. */
export const VOICE_NOTE_TOLERANCE = 0.1;
/**
 * Above this difference from the script estimate the voice fails: a narration 40 percent off its word count is more
 * likely cut off, padded with silence or read in another language than just a slow or fast voice. Calm and quick
 * narrators differ by about 25 percent (120 to 160 words per minute against the 150 default), so 40 leaves room.
 */
export const VOICE_GROSS_MISMATCH = 0.4;
/** The tempo the worker may apply. atempo keeps the pitch; outside about 10 to 15 percent speech starts to sound wrong. */
export const TEMPO_RANGE: readonly [number, number] = [0.9, 1.15];
/** A fit or a tighten target stays this far inside the limits, so rounding and measuring never land on the edge. */
export const FIT_MARGIN_SEC = 0.25;
/** "Shorter" or "longer" from the owner moves the target at least this share of the narration. */
export const NOTE_STEP = 0.1;

export type VoiceProblemCode = "language" | "clipped" | "format" | "coverage" | "mismatch";

export interface VoiceProblem {
  code: VoiceProblemCode;
  text: string;
}

/** Problems a small tempo change or a shorter or longer script fixes. */
export const LENGTH_PROBLEMS: readonly VoiceProblemCode[] = ["format", "coverage"];
/** Problems the owner may approve anyway after listening. Terms, clipping and language never are. */
export const SOFT_PROBLEMS: readonly VoiceProblemCode[] = ["mismatch"];

export function isVoiceProblemCode(v: unknown): v is VoiceProblemCode {
  return v === "language" || v === "clipped" || v === "format" || v === "coverage" || v === "mismatch";
}

export interface FitShape {
  format?: Format;
  /** Shots of the approved storyboard. */
  shotCount?: number;
  /** The template's longest shot. */
  maxShotSeconds?: number;
}

/** The narration lengths the video can carry: inside the format and coverable by the shots. Null bounds are open. */
export interface FitWindow {
  /** The shortest narration that works. */
  min: number;
  /** The longest narration that works. */
  max: number;
  /** What limits each side, for the text. */
  minBy: "format" | "shots" | "none";
  maxBy: "format" | "shots" | "none";
}

export function fitWindow(s: FitShape): FitWindow {
  let min = 0;
  let max = Number.POSITIVE_INFINITY;
  let minBy: FitWindow["minBy"] = "none";
  let maxBy: FitWindow["maxBy"] = "none";
  if (s.format) {
    const [lo, hi] = VIDEO_FORMATS[s.format].durationSec;
    min = lo;
    max = hi;
    minBy = "format";
    maxBy = "format";
  }
  const n = s.shotCount ?? 0;
  if (n > 0 && s.maxShotSeconds && s.maxShotSeconds > 0) {
    // The render accepts shots within COVER_TOLERANCE_SEC of the narration on either side.
    const most = maxCoverSec(n, s.maxShotSeconds) + COVER_TOLERANCE_SEC;
    const least = n * MIN_SHOT_SECONDS - COVER_TOLERANCE_SEC;
    if (most < max) {
      max = most;
      maxBy = "shots";
    }
    if (least > min) {
      min = least;
      minBy = "shots";
    }
  }
  return { min, max, minBy, maxBy };
}

export function fitsWindow(sec: number, w: FitWindow): boolean {
  return sec >= w.min && sec <= w.max;
}

/** The window with FIT_MARGIN_SEC kept inside each limit (COVER_TOLERANCE_SEC too on the shots side). Null when empty. */
function targetWindow(w: FitWindow): { min: number; max: number } | null {
  const min = w.min + (w.minBy === "shots" ? COVER_TOLERANCE_SEC : 0) + (w.minBy === "none" ? 0 : FIT_MARGIN_SEC);
  const max = Number.isFinite(w.max) ? w.max - (w.maxBy === "shots" ? COVER_TOLERANCE_SEC : 0) - FIT_MARGIN_SEC : w.max;
  return min <= max ? { min, max } : null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The tempo the narration is played at: 1 for anything missing or outside TEMPO_RANGE. */
export function tempoOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= TEMPO_RANGE[0] && v <= TEMPO_RANGE[1] ? v : 1;
}

/** How long the narration lasts when played at `tempo`. */
export function playedSec(narrationSec: number, tempo: number = 1): number {
  return round2(narrationSec / tempoOf(tempo));
}

/**
 * The tempo that makes a narration that does not fit the window fit it, or null when it already fits, cannot be
 * fitted (an empty window), or would need more than TEMPO_RANGE allows. Rounded so the played length stays inside.
 */
export function fitTempo(narrationSec: number, w: FitWindow): number | null {
  if (!(narrationSec > 0) || fitsWindow(narrationSec, w)) return null;
  const t = targetWindow(w);
  if (!t) return null;
  // Faster when too long (round the factor up), slower when too short (round it down).
  const factor = narrationSec > w.max ? Math.ceil((narrationSec / t.max) * 1000) / 1000 : Math.floor((narrationSec / t.min) * 1000) / 1000;
  if (factor < TEMPO_RANGE[0] || factor > TEMPO_RANGE[1]) return null;
  return fitsWindow(narrationSec / factor, w) ? round3(factor) : null;
}

export type LengthDirection = "fit" | "shorter" | "longer";

/**
 * The narration length a rewritten script should aim at, or null when no length fits. "fit" aims at the storyboard's
 * planned length (the sum of its shots) kept inside the window; "shorter" and "longer" (an owner note) move at least
 * NOTE_STEP from the current narration in that direction, still inside the window.
 */
export function tightenTargetSec(input: { narrationSec: number; plannedSec?: number; window: FitWindow; direction?: LengthDirection }): number | null {
  const t = targetWindow(input.window);
  if (!t || !(input.narrationSec > 0)) return null;
  const clamp = (x: number) => Math.min(t.max, Math.max(t.min, x));
  const planned = input.plannedSec && input.plannedSec > 0 ? input.plannedSec : input.narrationSec;
  const base = clamp(planned);
  const dir = input.direction ?? "fit";
  let target = base;
  if (dir === "shorter") target = clamp(Math.min(base, input.narrationSec * (1 - NOTE_STEP)));
  if (dir === "longer") target = clamp(Math.max(base, input.narrationSec * (1 + NOTE_STEP)));
  return Math.round(target * 10) / 10;
}

export interface VoiceAssessInput extends FitShape {
  narrationSec: number;
  scriptEstimateSec: number;
  /** The tempo already chosen for this narration (a fit). Default 1. */
  tempo?: number;
  /** The storyboard's planned length (sum of its shots), for the tighten target. */
  plannedSec?: number;
  /** The pace the estimate used, for the note. */
  wordsPerMinute?: number;
}

/** What the voice card needs to offer the fixes. Stored in the review payload; never trusted for a write. */
export interface VoiceFix {
  problems: VoiceProblemCode[];
  /** Raw narration length. */
  narrationSec: number;
  /** Length as it will play (after a chosen tempo). */
  playedSec: number;
  /** The tempo already chosen, 1 when none. */
  tempo: number;
  /** A tempo that would make it fit, or null. */
  fitTempo: number | null;
  /** A script length (seconds) that would fit, or null. Offered only for a length problem. */
  tightenSec: number | null;
  /** Shots of the storyboard and the template's longest shot, for the text. */
  shotCount: number;
  maxShotSeconds: number;
}

export interface VoiceAssessment {
  problems: VoiceProblem[];
  notes: string[];
  fix: VoiceFix;
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** The length part of the voice gate: format, coverage and the estimate. Language and clipping are added by voiceGate. */
export function assessNarrationLength(i: VoiceAssessInput): VoiceAssessment {
  const problems: VoiceProblem[] = [];
  const notes: string[] = [];
  const tempo = tempoOf(i.tempo);
  const played = playedSec(i.narrationSec, tempo);
  const w = fitWindow(i);
  const shots = i.shotCount ?? 0;
  const maxShot = i.maxShotSeconds ?? 0;
  const at = tempo !== 1 ? ` played at ${tempo}x` : "";
  if (i.format && i.narrationSec > 0) {
    const [lo, hi] = VIDEO_FORMATS[i.format].durationSec;
    if (played > hi) problems.push({ code: "format", text: `The narration is ${fmt(played)} s${at}, longer than the ${hi} s a ${i.format} video may last` });
    else if (played < lo) problems.push({ code: "format", text: `The narration is ${fmt(played)} s${at}, shorter than the ${lo} s a ${i.format} video needs` });
  }
  if (shots > 0 && maxShot > 0 && i.narrationSec > 0) {
    const most = maxCoverSec(shots, maxShot);
    const least = shots * MIN_SHOT_SECONDS;
    if (played > most + COVER_TOLERANCE_SEC) {
      problems.push({ code: "coverage", text: `The narration is ${fmt(played)} s${at}, but the ${shots} shots can fill at most ${fmt(most)} s (${maxShot} s each)` });
    } else if (played < least - COVER_TOLERANCE_SEC) {
      problems.push({ code: "coverage", text: `The narration is ${fmt(played)} s${at}, but the ${shots} shots need at least ${fmt(least)} s` });
    }
  }
  if (i.scriptEstimateSec > 0 && i.narrationSec > 0) {
    const off = (i.narrationSec - i.scriptEstimateSec) / i.scriptEstimateSec;
    const pct = Math.round(Math.abs(off) * 100);
    const way = off > 0 ? "longer" : "shorter";
    const pace = i.wordsPerMinute ? ` at ${Math.round(i.wordsPerMinute)} words per minute` : "";
    if (Math.abs(off) > VOICE_GROSS_MISMATCH) {
      problems.push({
        code: "mismatch",
        text: `The narration is ${fmt(i.narrationSec)} s, ${pct} percent ${way} than the script estimate of ${fmt(i.scriptEstimateSec)} s${pace}. That much usually means cut-off or padded audio: listen to it`,
      });
    } else if (Math.abs(off) > VOICE_NOTE_TOLERANCE) {
      const fits = problems.length === 0 ? " It fits the video, so this is only a note." : "";
      notes.push(`The narration is ${fmt(i.narrationSec)} s, ${pct} percent ${way} than the script estimate of ${fmt(i.scriptEstimateSec)} s${pace}. This voice speaks at its own pace.${fits}`);
    }
  }
  if (tempo !== 1 && problems.length === 0) notes.push(`The narration plays at ${tempo}x (${fmt(played)} s instead of ${fmt(i.narrationSec)} s) so it fits the shots.`);
  const length = problems.some((p) => LENGTH_PROBLEMS.includes(p.code));
  const fix: VoiceFix = {
    problems: problems.map((p) => p.code),
    narrationSec: i.narrationSec,
    playedSec: played,
    tempo,
    // A fit is worked out on the raw narration: a new tempo replaces the old one.
    fitTempo: length ? fitTempo(i.narrationSec, w) : null,
    tightenSec: length ? tightenTargetSec({ narrationSec: i.narrationSec, plannedSec: i.plannedSec, window: w }) : null,
    shotCount: shots,
    maxShotSeconds: maxShot,
  };
  return { problems, notes, fix };
}

/** Reads a stored VoiceFix back from a review payload. Anything malformed is null. */
export function parseVoiceFix(raw: unknown): VoiceFix | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const problems = Array.isArray(r.problems) ? r.problems.filter(isVoiceProblemCode) : [];
  const narrationSec = n(r.narrationSec);
  if (narrationSec === null) return null;
  const fit = n(r.fitTempo);
  return {
    problems,
    narrationSec,
    playedSec: n(r.playedSec) ?? narrationSec,
    tempo: tempoOf(r.tempo),
    fitTempo: fit !== null && fit >= TEMPO_RANGE[0] && fit <= TEMPO_RANGE[1] ? fit : null,
    tightenSec: n(r.tightenSec),
    shotCount: n(r.shotCount) ?? 0,
    maxShotSeconds: n(r.maxShotSeconds) ?? 0,
  };
}

/**
 * Where a revision note on a voice card goes. Notes about length or speed rewrite the script to fit and keep the
 * pictures ("tighten"); notes about the voice itself stay on the voice stage; anything else is sorted as before (null).
 */
const LENGTH_NOTE = /\b(shorter|longer|lengthen|length|too long|too short|faster|slower|too fast|too slow|speed|pace|tight(?:en|er)?|trim|seconds?|fit)\b/i;
const VOICE_NOTE = /\b(voice|voices|accent|pronounc\w*|tone of voice|male|female|robotic|speaker|narrator)\b/i;

export function voiceRevisionRoute(note: string): { route: "tighten"; direction: LengthDirection } | { route: "voice" } | null {
  if (LENGTH_NOTE.test(note)) {
    const shorter = /\b(shorter|too long|faster|trim|tight(?:en|er)?)\b/i.test(note);
    const longer = /\b(longer|too short|slower|lengthen)\b/i.test(note);
    return { route: "tighten", direction: shorter && !longer ? "shorter" : longer && !shorter ? "longer" : "fit" };
  }
  if (VOICE_NOTE.test(note)) return { route: "voice" };
  return null;
}

/** What a "fit the script" request carries from the card to the voice stage. Stored in the pending stage's output. */
export interface TightenRequest {
  targetSec: number;
  /** Measured pace of the voice on the narration being replaced, so the word target matches this voice. */
  wordsPerMinute: number;
  direction: LengthDirection;
  /** The owner's note, when the request came from Send revision. Untrusted text. */
  note: string;
}

/** Plausible measured pace for a word target; outside it the fallback pace is used. */
const MEASURED_WPM: readonly [number, number] = [60, 260];

/**
 * Plans a script fit from the narration on the card: the target length (tightenTargetSec) and the pace to turn it
 * into words. The pace is this voice's own, measured on this narration (the TTS is deterministic, so it will speak a
 * new script at the same rate); an implausible measurement falls back to `fallbackWpm`. Null when nothing fits.
 */
export function tightenRequest(i: {
  narrationSec: number;
  words: number;
  plannedSec?: number;
  window: FitWindow;
  direction: LengthDirection;
  fallbackWpm: number;
  note?: string;
}): TightenRequest | null {
  const targetSec = tightenTargetSec({ narrationSec: i.narrationSec, plannedSec: i.plannedSec, window: i.window, direction: i.direction });
  if (targetSec === null) return null;
  const measured = i.narrationSec > 0 && i.words > 0 ? (i.words / i.narrationSec) * 60 : NaN;
  const wpm = Number.isFinite(measured) && measured >= MEASURED_WPM[0] && measured <= MEASURED_WPM[1] ? measured : i.fallbackWpm;
  return { targetSec, wordsPerMinute: Math.round(wpm * 10) / 10, direction: i.direction, note: (i.note ?? "").slice(0, 1000) };
}

/** Reads a stored TightenRequest back. Anything malformed is null. */
export function parseTightenRequest(raw: unknown): TightenRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const targetSec = typeof r.targetSec === "number" && Number.isFinite(r.targetSec) && r.targetSec > 0 ? r.targetSec : null;
  const wpm = typeof r.wordsPerMinute === "number" && Number.isFinite(r.wordsPerMinute) && r.wordsPerMinute >= MEASURED_WPM[0] && r.wordsPerMinute <= MEASURED_WPM[1] ? r.wordsPerMinute : null;
  if (targetSec === null || wpm === null) return null;
  const direction: LengthDirection = r.direction === "shorter" || r.direction === "longer" ? r.direction : "fit";
  return { targetSec, wordsPerMinute: wpm, direction, note: typeof r.note === "string" ? r.note.slice(0, 1000) : "" };
}
