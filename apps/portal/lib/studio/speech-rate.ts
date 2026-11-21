/**
 * Measured speech rate per voice, pure. Every narration and every Settings "Test voice" whose length was measured
 * records words per minute for the voice that spoke (provider + model + voice). The script, the storyboard and the
 * voice gate then estimate narration length with the learned rate of the run's voice instead of a fixed guess.
 * The database side lives in lib/server/speech-rate.ts (table voice_speech_rates, migration 0013).
 */
import { DEFAULT_WORDS_PER_MINUTE } from "./director.ts";

/** A sample shorter than this is mostly the silence at its start and end, so it says little about the pace. */
export const MIN_SAMPLE_WORDS = 25;
/** A measured pace outside this range is broken audio or a bad measurement and is not recorded. */
export const SAMPLE_WPM_RANGE: readonly [number, number] = [60, 260];
/** The learned rate is the median of this many newest samples of one voice. */
export const LEARN_WINDOW = 5;
/** Fewer samples than this and the default pace is used. The median of three ignores one odd sample. */
export const MIN_LEARN_SAMPLES = 3;
/** The learned rate is kept inside this range, so one odd voice cannot ask for an absurd script length. */
export const LEARNED_WPM_CLAMP: readonly [number, number] = [100, 200];
const KEY_PART_MAX = 120;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The identity a pace belongs to. Lower case, trimmed and cut, so the same voice always maps to the same key. */
export function voiceKey(v: { provider: string; model: string; voice: string }): string {
  const part = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").slice(0, KEY_PART_MAX);
  return `${part(v.provider)}|${part(v.model)}|${part(v.voice)}`;
}

/** Words per minute of one measured narration, or null when it is too short or outside the plausible range. */
export function sampleWpm(words: number, seconds: number): number | null {
  if (!Number.isFinite(words) || !Number.isFinite(seconds) || words < MIN_SAMPLE_WORDS || seconds <= 0) return null;
  const wpm = (words / seconds) * 60;
  if (wpm < SAMPLE_WPM_RANGE[0] || wpm > SAMPLE_WPM_RANGE[1]) return null;
  return Math.round(wpm * 10) / 10;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Pace {
  /** Words per minute to plan with. */
  wpm: number;
  /** True when wpm comes from measured samples of this voice, false for the default. */
  learned: boolean;
  /** How many samples were used (0 when the default is used). */
  samples: number;
  /** The voice key the pace belongs to, or empty for the default. */
  key: string;
}

export const DEFAULT_PACE: Pace = { wpm: DEFAULT_WORDS_PER_MINUTE, learned: false, samples: 0, key: "" };

/**
 * The pace learned from one voice's samples, newest first: the median of the newest LEARN_WINDOW plausible
 * samples, clamped to LEARNED_WPM_CLAMP, once there are at least MIN_LEARN_SAMPLES. Otherwise the default.
 */
export function learnedPace(samplesNewestFirst: readonly number[], key: string = ""): Pace {
  const usable = samplesNewestFirst.filter((w) => Number.isFinite(w) && w >= SAMPLE_WPM_RANGE[0] && w <= SAMPLE_WPM_RANGE[1]).slice(0, LEARN_WINDOW);
  if (usable.length < MIN_LEARN_SAMPLES) return DEFAULT_PACE;
  const wpm = Math.min(LEARNED_WPM_CLAMP[1], Math.max(LEARNED_WPM_CLAMP[0], median(usable)));
  return { wpm: Math.round(wpm), learned: true, samples: usable.length, key };
}

export interface SpeechSample {
  key: string;
  wpm: number;
}

/**
 * The pace for a run before its voice is made. The voice chain is the same for every run of a language, so the voice
 * that spoke last for this language is the one this run will most likely get. `samples` are newest first and already
 * filtered to the run's language. With a known `key` (the voice gate, after the voice is made) that voice is used.
 */
export function paceFor(samples: readonly SpeechSample[], key?: string): Pace {
  const k = key ?? samples[0]?.key;
  if (!k) return DEFAULT_PACE;
  return learnedPace(samples.filter((s) => s.key === k).map((s) => s.wpm), k);
}

/** One plain line for the stage summary and Settings. */
export function paceText(p: Pace): string {
  return p.learned
    ? `${Math.round(p.wpm)} words per minute, measured from ${p.samples} recordings of this voice`
    : `${Math.round(p.wpm)} words per minute (default; the voice has fewer than ${MIN_LEARN_SAMPLES} measured recordings)`;
}
