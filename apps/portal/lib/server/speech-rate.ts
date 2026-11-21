import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { db } from "./db.ts";
import { DEFAULT_PACE, paceFor, sampleWpm, voiceKey, type Pace, type SpeechSample } from "../studio/speech-rate.ts";

/**
 * Measured speech rate per voice (table voice_speech_rates, migration 0013). Pure rules in lib/studio/speech-rate.ts.
 * Writes are best effort: a failed write is logged and never fails a narration or a Test voice. Reads fall back to
 * the default pace on any error, so a missing table (before the migration) behaves like no samples.
 */

type Q = Sql | TransactionSql;

/** Samples read per language: enough for the newest voice to have its LEARN_WINDOW. */
const READ_LIMIT = 60;

export interface SpeechSampleInput {
  provider: string;
  model: string;
  voice: string;
  language: string;
  words: number;
  seconds: number;
  source: "narration" | "test";
  runId?: string | null;
}

/** Records one measured narration. Returns the words per minute stored, or null when the sample was not usable. */
export async function recordSpeechSample(s: SpeechSampleInput): Promise<number | null> {
  const wpm = sampleWpm(s.words, s.seconds);
  if (wpm === null) return null;
  try {
    const key = voiceKey(s);
    await db()`
      INSERT INTO voice_speech_rates (voice_key, provider, model, voice, language, words, seconds, wpm, source, run_id)
      VALUES (${key}, ${s.provider.slice(0, 120)}, ${s.model.slice(0, 120)}, ${s.voice.slice(0, 120)}, ${s.language.slice(0, 12)},
              ${Math.round(s.words)}, ${s.seconds}, ${wpm}, ${s.source}, ${s.runId ?? null})
    `;
    return wpm;
  } catch (err) {
    console.error("speech rate: could not record a sample", err);
    return null;
  }
}

async function samplesFor(q: Q, language: string): Promise<SpeechSample[]> {
  const rows = await q`
    SELECT voice_key, wpm FROM voice_speech_rates WHERE language = ${language}
    ORDER BY created_at DESC LIMIT ${READ_LIMIT}
  `;
  // postgres.js rows are untyped: map them into plain samples before the pure code sees them.
  return rows.map((r) => ({ key: String(r.voice_key), wpm: Number(r.wpm) })).filter((r) => r.key && Number.isFinite(r.wpm));
}

/**
 * The pace to plan a run with. With `voice` (after the narration is made) that voice's samples decide; without it,
 * the voice that spoke last for this language (the likely voice of the run). Default pace on any error.
 */
export async function paceForRun(language: string, voice?: { provider: string; model: string; voice: string }, q: Q = db()): Promise<Pace> {
  try {
    const samples = await samplesFor(q, language);
    return paceFor(samples, voice ? voiceKey(voice) : undefined);
  } catch (err) {
    console.error("speech rate: could not read samples", err);
    return DEFAULT_PACE;
  }
}
