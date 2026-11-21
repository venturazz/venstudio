import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceAssessment, voiceGate } from "./qc.ts";
import {
  fitTempo,
  fitWindow,
  parseTightenRequest,
  parseVoiceFix,
  playedSec,
  tempoOf,
  tightenRequest,
  tightenTargetSec,
  voiceRevisionRoute,
  TEMPO_RANGE,
  type VoiceFix,
} from "./voice-fit.ts";
import { decisionHint, decisionLabel, decisionOptions } from "./review.ts";
import { tempoReadyFor, tempoWorkerMessage } from "./render-gate.ts";

// The owner's run: a flat-vector short, 9 shots of at most 6 s, Kokoro speaking about 130 words per minute.
const owner = {
  languageCode: "en",
  provider: "kokoro",
  scriptEstimateSec: 47.6,
  narrationSec: 55.01,
  clipped: false,
  format: "short" as const,
  shotCount: 10,
  maxShotSeconds: 6,
  plannedSec: 48,
  wordsPerMinute: 150,
};

test("voice gate: a narration 16 percent over its estimate that fits the shots passes with a note", () => {
  const g = voiceGate(owner);
  assert.equal(g.passed, true);
  assert.deepEqual(g.issues, []);
  assert.equal(g.notes?.length, 1);
  assert.match(g.notes?.[0] ?? "", /55 s, 16 percent longer than the script estimate of 47.6 s at 150 words per minute/);
  assert.match(g.notes?.[0] ?? "", /only a note/);
  // Within 10 percent nothing is said.
  assert.equal(voiceGate({ ...owner, narrationSec: 50 }).notes, undefined);
});

test("voice gate: fails when the shots cannot cover the narration even at maxShotSeconds", () => {
  const a = voiceAssessment({ ...owner, shotCount: 9 });
  assert.equal(a.passed, false);
  assert.deepEqual(a.fix.problems, ["coverage"]);
  assert.match(a.issues[0], /the 9 shots can fill at most 54 s \(6 s each\)/);
  // 54 s plus the 0.5 s the render tolerates: 54.4 s still fits.
  assert.equal(voiceGate({ ...owner, shotCount: 9, narrationSec: 54.4 }).passed, true);
  // Too few seconds for the shots at 1 s each is a coverage problem too.
  assert.deepEqual(voiceAssessment({ ...owner, shotCount: 30, narrationSec: 20, scriptEstimateSec: 20 }).fix.problems, ["coverage"]);
});

test("voice gate: fails on the format's limits", () => {
  const long = voiceAssessment({ ...owner, shotCount: 12, narrationSec: 63, scriptEstimateSec: 60 });
  assert.deepEqual(long.fix.problems, ["format"]);
  assert.match(long.issues[0], /longer than the 60 s a short video may last/);
  const short = voiceAssessment({ ...owner, shotCount: 3, narrationSec: 12, scriptEstimateSec: 12 });
  assert.deepEqual(short.fix.problems, ["format"]);
});

test("voice gate: a gross mismatch with the estimate fails as probably broken audio", () => {
  const a = voiceAssessment({ ...owner, narrationSec: 20 });
  assert.ok(a.fix.problems.includes("mismatch"));
  assert.match(a.issues.join(" "), /58 percent shorter .* listen to it/);
  assert.equal(voiceGate({ ...owner, scriptEstimateSec: 38, narrationSec: 55 }).passed, false);
  assert.equal(voiceGate({ ...owner, scriptEstimateSec: 40, narrationSec: 55 }).passed, true);
});

test("voice gate: clipping and language still fail; without format and shots only the estimate is judged", () => {
  assert.deepEqual(voiceAssessment({ ...owner, clipped: true }).fix.problems, ["clipped"]);
  assert.deepEqual(voiceAssessment({ ...owner, languageCode: "xx" }).fix.problems, ["language"]);
  const bare = { languageCode: "en", provider: null, scriptEstimateSec: 40, narrationSec: 70, clipped: false };
  assert.equal(voiceGate(bare).passed, false);
  assert.equal(voiceGate({ ...bare, narrationSec: 52 }).passed, true);
});

test("voice gate: a chosen tempo is judged as played", () => {
  const fitted = voiceAssessment({ ...owner, shotCount: 9, tempo: 1.024 });
  assert.equal(fitted.passed, true);
  assert.equal(fitted.fix.tempo, 1.024);
  assert.equal(fitted.fix.playedSec, 53.72);
  assert.match((fitted.notes ?? []).join(" "), /plays at 1.024x \(53.7 s instead of 55 s\)/);
});

test("fitTempo: only for a narration that does not fit, and only within 0.9 to 1.15", () => {
  const w = fitWindow({ format: "short", shotCount: 9, maxShotSeconds: 6 });
  assert.equal(w.max, 54.5);
  assert.equal(w.maxBy, "shots");
  assert.equal(fitTempo(55.01, w), 1.024);
  assert.ok(55.01 / 1.024 <= w.max);
  assert.equal(fitTempo(54, w), null, "already fits");
  assert.equal(fitTempo(70, w), null, "needs more than 1.15x");
  // Too short for the format: slowed down a little.
  const shortW = fitWindow({ format: "short", shotCount: 3, maxShotSeconds: 6 });
  const slow = fitTempo(14.2, shortW);
  assert.ok(slow !== null && slow < 1 && slow >= TEMPO_RANGE[0]);
  assert.ok(14.2 / (slow as number) >= 15);
  assert.equal(fitTempo(10, shortW), null, "would need less than 0.9x");
  assert.equal(tempoOf(1.5), 1);
  assert.equal(tempoOf("1.1"), 1);
  assert.equal(playedSec(55, 1.1), 50);
});

test("tightenTargetSec: aims at the storyboard's planned length inside the window, or moves with the note", () => {
  const w = fitWindow({ format: "short", shotCount: 9, maxShotSeconds: 6 });
  assert.equal(tightenTargetSec({ narrationSec: 55, plannedSec: 48, window: w }), 48);
  // A planned length above what the shots can cover is clamped under the limit.
  assert.equal(tightenTargetSec({ narrationSec: 55, plannedSec: 70, window: w }), 53.8);
  assert.equal(tightenTargetSec({ narrationSec: 40, plannedSec: 40, window: w, direction: "shorter" }), 36);
  assert.equal(tightenTargetSec({ narrationSec: 40, plannedSec: 40, window: w, direction: "longer" }), 44);
  // No length fits both the format and these shots.
  assert.equal(tightenTargetSec({ narrationSec: 40, window: fitWindow({ format: "short", shotCount: 2, maxShotSeconds: 6 }) }), null);
});

test("tightenRequest: uses this voice's measured pace, and falls back for an implausible one", () => {
  const w = fitWindow({ format: "short", shotCount: 9, maxShotSeconds: 6 });
  const r = tightenRequest({ narrationSec: 55, words: 119, plannedSec: 48, window: w, direction: "fit", fallbackWpm: 150, note: "x" });
  assert.deepEqual(r, { targetSec: 48, wordsPerMinute: 129.8, direction: "fit", note: "x" });
  assert.equal(tightenRequest({ narrationSec: 3, words: 119, window: w, direction: "fit", fallbackWpm: 150 })?.wordsPerMinute, 150);
  assert.deepEqual(parseTightenRequest(r), r);
  assert.equal(parseTightenRequest({ targetSec: 48 }), null);
  assert.equal(parseTightenRequest({ targetSec: 48, wordsPerMinute: 5 }), null);
});

test("voiceRevisionRoute: length and speed notes fit the script, voice notes stay on the voice", () => {
  assert.deepEqual(voiceRevisionRoute("Make it shorter please"), { route: "tighten", direction: "shorter" });
  assert.deepEqual(voiceRevisionRoute("It is too long for a short"), { route: "tighten", direction: "shorter" });
  assert.deepEqual(voiceRevisionRoute("faster"), { route: "tighten", direction: "shorter" });
  assert.deepEqual(voiceRevisionRoute("a bit longer, it ends too soon"), { route: "tighten", direction: "longer" });
  assert.deepEqual(voiceRevisionRoute("fit it to the video length"), { route: "tighten", direction: "fit" });
  assert.deepEqual(voiceRevisionRoute("Use a different voice, the accent is odd"), { route: "voice" });
  assert.equal(voiceRevisionRoute("Pick another topic"), null);
  // "cut off" is about broken audio, not length.
  assert.equal(voiceRevisionRoute("the audio is cut off at the end"), null);
});

const termsIssue = "Confirm the commercial-use terms for kokoro in Settings (Asset providers). 1 voice from it cannot publish until you do.";

function fixFor(input: Parameters<typeof voiceAssessment>[0]): { issues: string[]; voice: VoiceFix } {
  const a = voiceAssessment(input);
  return { issues: a.issues, voice: a.fix };
}

test("voice card options: a narration that does not fit offers fit and tighten, not Make the voice again", () => {
  const c = fixFor({ ...owner, shotCount: 9 });
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", ...c, tempoReady: true }), ["fit", "tighten", "recheck", "revise", "reject"]);
  // Without a worker that can play the tempo, fit is not offered.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", ...c, tempoReady: false }), ["tighten", "recheck", "revise", "reject"]);
  // Too far off for a tempo change: only tighten.
  const far = fixFor({ ...owner, shotCount: 7, scriptEstimateSec: 50 });
  assert.equal(far.voice.fitTempo, null);
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", ...far, tempoReady: true }), ["tighten", "recheck", "revise", "reject"]);
  assert.equal(decisionLabel("fit", "gate-failure", "voice", { stage: "voice", ...c }), "Fit the narration to the video");
  assert.equal(decisionLabel("tighten", "gate-failure", "voice", { stage: "voice", ...c }), "Tighten the script, keep the pictures");
  assert.match(decisionHint("fit", "gate-failure", "voice", { stage: "voice", ...c }) ?? "", /a little faster \(1.024x, 53.7 s instead of 55 s\).*nothing is made again/);
  assert.match(decisionHint("tighten", "gate-failure", "voice", { stage: "voice", ...c }) ?? "", /about 48 s .*storyboard and every image are kept/);
  // A narration too short for its shots lengthens.
  const short = fixFor({ ...owner, shotCount: 3, narrationSec: 12, scriptEstimateSec: 12, plannedSec: 18 });
  assert.equal(decisionLabel("tighten", "gate-failure", "voice", { stage: "voice", ...short }), "Lengthen the script, keep the pictures");
});

test("voice card options: Approve anyway only for a soft problem with no terms issue; never for clipping or language", () => {
  const soft = fixFor({ ...owner, narrationSec: 20, shotCount: 5 });
  assert.deepEqual(soft.voice.problems, ["mismatch"]);
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", ...soft }), ["recheck", "retry", "override", "revise", "reject"]);
  assert.ok(!decisionOptions("gate-failure", { stage: "voice", issues: [...soft.issues, termsIssue], voice: soft.voice }).includes("override"));
  const clipped = fixFor({ ...owner, clipped: true });
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", ...clipped }), ["retry", "recheck", "revise", "reject"]);
  const lang = fixFor({ ...owner, languageCode: "xx" });
  assert.ok(!decisionOptions("gate-failure", { stage: "voice", ...lang }).includes("override"));
  // Length problems are not approvable: the render could not fit them.
  assert.ok(!decisionOptions("gate-failure", { stage: "voice", ...fixFor({ ...owner, shotCount: 9 }), tempoReady: true }).includes("override"));
  assert.equal(decisionLabel("override", "gate-failure", "voice"), "Approve anyway");
  assert.match(decisionHint("override", "gate-failure", "voice") ?? "", /Owner only.*audit log/);
  // Terms only: unchanged.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "voice", issues: [termsIssue], voice: fixFor(owner).voice }), ["recheck", "retry", "revise", "reject"]);
});

test("reject hint: cancels the run, the work stays in Assets", () => {
  assert.match(decisionHint("reject", "gate-failure", "voice") ?? "", /Cancels the run\. The images and narration already made stay in Assets/);
  assert.equal(decisionHint("reject", "idea", "idea"), "Cancels the run.");
});

test("parseVoiceFix reads a stored fix and drops bad fields", () => {
  const f = fixFor({ ...owner, shotCount: 9 }).voice;
  assert.deepEqual(parseVoiceFix(JSON.parse(JSON.stringify(f))), f);
  assert.equal(parseVoiceFix(null), null);
  assert.equal(parseVoiceFix({ problems: ["coverage"] }), null);
  assert.deepEqual(parseVoiceFix({ narrationSec: 50, problems: ["coverage", "bogus"], fitTempo: 3 })?.problems, ["coverage"]);
  assert.equal(parseVoiceFix({ narrationSec: 50, fitTempo: 3 })?.fitTempo, null);
});

test("tempoReadyFor: every render worker must report narration-tempo", () => {
  assert.equal(tempoReadyFor([]), false);
  assert.equal(tempoReadyFor([["echo"]]), false);
  assert.equal(tempoReadyFor([["echo", "ffmpeg", "narration-tempo"]]), true);
  assert.equal(tempoReadyFor([["ffmpeg", "narration-tempo"], ["ffmpeg", "xfade"]]), false, "an older worker could claim the job");
  assert.equal(tempoReadyFor([["ffmpeg", "narration-tempo"], ["echo"]]), true, "a worker that cannot render does not matter");
  assert.match(tempoWorkerMessage(1.024), /1.024x .*0.6.0 or later/);
});
