import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PACE, countWords, learnedPace, paceFor, paceText, sampleWpm, voiceKey, MIN_SAMPLE_WORDS } from "./speech-rate.ts";
import { estimateNarrationSec } from "./voice.ts";
import { scriptGate, storyboardGate, voiceGate } from "./qc.ts";
import { scriptPrompt, storyboardPrompt, wordsPerMinuteFor, DEFAULT_WORDS_PER_MINUTE } from "./director.ts";
import { seedTemplates } from "./templates.ts";

test("sampleWpm: measured words per minute, or null for short or implausible samples", () => {
  assert.equal(sampleWpm(119, 55), 129.8);
  assert.equal(sampleWpm(MIN_SAMPLE_WORDS - 1, 10), null, "too few words");
  assert.equal(sampleWpm(40, 3), null, "800 words per minute is broken audio");
  assert.equal(sampleWpm(40, 60), null, "40 words per minute is mostly silence");
  assert.equal(sampleWpm(40, 0), null);
  assert.equal(sampleWpm(Number.NaN, 10), null);
});

test("learnedPace: default with no or few samples", () => {
  assert.deepEqual(learnedPace([]), DEFAULT_PACE);
  assert.deepEqual(learnedPace([130, 131]), DEFAULT_PACE);
  assert.equal(DEFAULT_PACE.wpm, DEFAULT_WORDS_PER_MINUTE);
});

test("learnedPace: median of the newest five, outliers ignored, clamped to 100 to 200", () => {
  assert.deepEqual(learnedPace([130, 128, 132], "k"), { wpm: 130, learned: true, samples: 3, key: "k" });
  // Only the newest five count: the old 160s are past the window.
  assert.equal(learnedPace([130, 129, 131, 128, 132, 160, 160, 160]).wpm, 130);
  // One odd sample does not move the median.
  assert.equal(learnedPace([130, 250, 129, 131, 128]).wpm, 130);
  // Implausible values are not samples at all.
  assert.deepEqual(learnedPace([130, 900, 5]), DEFAULT_PACE);
  assert.equal(learnedPace([90, 92, 95]).wpm, 100);
  assert.equal(learnedPace([230, 240, 235]).wpm, 200);
  assert.equal(learnedPace([130, 131, 140, 141]).wpm, 136, "an even count averages the middle two");
});

test("voiceKey and paceFor: per voice, with the newest voice of the language as the run's guess", () => {
  const kokoro = voiceKey({ provider: "kokoro", model: "kokoro/af_heart", voice: "af_heart" });
  assert.equal(kokoro, voiceKey({ provider: " Kokoro ", model: "KOKORO/af_heart", voice: "af_heart" }));
  const other = voiceKey({ provider: "hermes-kokoro", model: "x", voice: "af_bella" });
  const samples = [
    { key: kokoro, wpm: 130 },
    { key: other, wpm: 170 },
    { key: kokoro, wpm: 129 },
    { key: other, wpm: 171 },
    { key: kokoro, wpm: 131 },
    { key: other, wpm: 169 },
  ];
  assert.equal(paceFor(samples).wpm, 130);
  assert.equal(paceFor(samples, other).wpm, 170);
  assert.deepEqual(paceFor(samples, "unknown"), DEFAULT_PACE);
  assert.deepEqual(paceFor([]), DEFAULT_PACE);
  assert.match(paceText(paceFor(samples)), /130 words per minute, measured from 3 recordings/);
  assert.match(paceText(DEFAULT_PACE), /default/);
  assert.equal(countWords("  one two\nthree "), 3);
});

test("a learned pace makes the script, storyboard and voice checks agree on the owner's voice", () => {
  const template = seedTemplates().find((t) => t.styleId === "explainer-flat-vector") ?? seedTemplates()[0];
  const wpm = wordsPerMinuteFor(template, 130);
  assert.equal(wpm, 130);
  assert.equal(wordsPerMinuteFor(template, 400), DEFAULT_WORDS_PER_MINUTE, "an absurd pace falls back to the default");
  assert.equal(wordsPerMinuteFor(template, null), DEFAULT_WORDS_PER_MINUTE);
  const ctx = { niche: "n", plan: "p", language: "en", format: "short" as const, durationSec: 45, template, wordsPerMinute: 130 };
  const scriptAsk = scriptPrompt(ctx, { title: "t", hook: "h", angle: "a" }, []).map((m) => m.content).join("\n");
  assert.match(scriptAsk, /about 98 words \(130 words per minute for 45 seconds/);
  assert.match(scriptAsk, /Narration pace: 130 words per minute/);
  // 98 words at 130 wpm is 45 s: the script gate passes it and the voice gate sees no difference.
  const script = Array(98).fill("word").join(" ") + ".";
  const gate = scriptGate({ script, hooks: ["a", "b", "c"], format: "short", durationSec: 45, wordsPerMinute: wpm, sources: [], requiresSources: false });
  assert.ok(!gate.issues.some((i) => /words; about/.test(i)), gate.issues.join(" "));
  const estimate = estimateNarrationSec(script, wpm);
  assert.equal(Math.round(estimate), 45);
  const v = voiceGate({ languageCode: "en", provider: "kokoro", scriptEstimateSec: estimate, narrationSec: 45.6, clipped: false });
  assert.equal(v.notes, undefined);
  const boardAsk = storyboardPrompt(ctx, script).map((m) => m.content).join("\n");
  assert.match(boardAsk, /The narration runs about 45 seconds/);
  const shots = template.beats.map((b) => ({ beatRole: b.role, seconds: template.pacing.maxShotSeconds }));
  while (shots.length * template.pacing.maxShotSeconds < 45 * 1.1) shots.push({ beatRole: "body", seconds: template.pacing.maxShotSeconds });
  assert.ok(!storyboardGate(template, shots, estimate).issues.some((i) => /narration is about/.test(i)));
});
