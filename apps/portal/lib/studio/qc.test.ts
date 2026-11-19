import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assetsGate,
  claimsGate,
  combineGates,
  complianceGate,
  PUBLISH_GATES,
  ngramOverlap,
  presentationGate,
  qcSummary,
  scriptGate,
  storyboardGate,
  technicalGate,
  voiceGate,
  type ComplianceFlags,
  type GateResult,
  type TechnicalMeasure,
} from "./qc.ts";
import { seedTemplates, type Template } from "./templates.ts";

const explainer = (): Template => seedTemplates().find((t) => t.styleId === "explainer-flat-vector") as Template;
const ambient = (): Template => seedTemplates().find((t) => t.family === "ambient") as Template;

function good(): TechnicalMeasure {
  return {
    width: 1080, height: 1920, fps: 30, durationSec: 40, hasAudio: true, integratedLufs: -14, truePeakDb: -1.5,
    blackRuns: [], silenceRuns: [], freezeRuns: [], cuts: [2, 6, 10, 14, 18, 22, 26, 30, 34, 38],
  };
}

test("technical gate passes a clean short", () => {
  const r = technicalGate(good(), explainer(), "short");
  assert.deepEqual(r.issues, []);
  assert.equal(r.passed, true);
});

test("loudness: -14 passes, -20 fails, -12 passes at the edge", () => {
  assert.equal(technicalGate({ ...good(), integratedLufs: -12 }, explainer(), "short").passed, true);
  const r = technicalGate({ ...good(), integratedLufs: -20 }, explainer(), "short");
  assert.equal(r.passed, false);
  assert.match(r.issues[0], /Loudness/);
  assert.equal(technicalGate({ ...good(), integratedLufs: null }, explainer(), "short").passed, false);
});

test("true peak: -1 passes, -0.2 fails", () => {
  assert.equal(technicalGate({ ...good(), truePeakDb: -1 }, explainer(), "short").passed, true);
  const r = technicalGate({ ...good(), truePeakDb: -0.2 }, explainer(), "short");
  assert.equal(r.passed, false);
  assert.match(r.issues.join(), /True peak/);
});

test("black frames: middle run fails, short run at the start passes, long run at the start only counts past 0.5 s", () => {
  assert.equal(technicalGate({ ...good(), blackRuns: [{ start: 10, end: 11.5 }] }, explainer(), "short").passed, false);
  assert.equal(technicalGate({ ...good(), blackRuns: [{ start: 0, end: 0.3 }] }, explainer(), "short").passed, true);
  assert.equal(technicalGate({ ...good(), blackRuns: [{ start: 0, end: 1.4 }] }, explainer(), "short").passed, true);
  assert.equal(technicalGate({ ...good(), blackRuns: [{ start: 0, end: 2 }] }, explainer(), "short").passed, false);
  assert.equal(technicalGate({ ...good(), blackRuns: [{ start: 39.7, end: 40 }] }, explainer(), "short").passed, true);
});

test("silence only counts for narrated templates", () => {
  const m = { ...good(), silenceRuns: [{ start: 5, end: 9 }] };
  assert.equal(technicalGate(m, explainer(), "short").passed, false);
  const amb = ambient();
  assert.equal(amb.audio.narrated, false);
  assert.equal(technicalGate({ ...m, cuts: [] }, { ...amb, pacing: { ...amb.pacing, maxShotSeconds: 60 } }, "short").passed, true);
});

test("frozen picture fails except for ambient", () => {
  const m = { ...good(), freezeRuns: [{ start: 5, end: 10 }] };
  assert.equal(technicalGate(m, explainer(), "short").passed, false);
  const amb = { ...ambient(), pacing: { ...ambient().pacing, maxShotSeconds: 60 } };
  assert.equal(technicalGate({ ...m, cuts: [] }, amb, "short").passed, true);
});

test("shot length uses 1.5 times the template limit and the hook window applies to shorts", () => {
  const t = explainer();
  assert.equal(t.pacing.maxShotSeconds, 6);
  assert.equal(technicalGate({ ...good(), cuts: [2, 9, 17, 25, 33] }, t, "short").passed, true);
  const long = technicalGate({ ...good(), cuts: [2, 12, 20, 28, 34] }, t, "short");
  assert.equal(long.passed, false);
  assert.match(long.issues.join(), /shot longer/);
  const late = technicalGate({ ...good(), cuts: [3.5, 8, 14, 20, 26, 32, 38] }, t, "short");
  assert.equal(late.passed, false);
  assert.match(late.issues.join(), /first cut/);
});

test("format mismatches fail", () => {
  assert.equal(technicalGate({ ...good(), width: 1920, height: 1080 }, explainer(), "short").passed, false);
  assert.equal(technicalGate({ ...good(), durationSec: 90 }, explainer(), "short").passed, false);
  assert.equal(technicalGate({ ...good(), hasAudio: false }, explainer(), "short").passed, false);
  assert.equal(technicalGate({ ...good(), fps: 24 }, explainer(), "short").passed, false);
});

test("ngramOverlap", () => {
  const a = "the quick brown fox jumps over the lazy dog near the river bank today";
  assert.ok(ngramOverlap(a, a) > 0.99);
  assert.equal(ngramOverlap(a, "completely different words about space travel and distant planets in orbit"), 0);
  assert.equal(ngramOverlap("too short", a), 0);
  const half = ngramOverlap(a, "the quick brown fox jumps over something else entirely different here");
  assert.ok(half > 0 && half < 1);
});

const sentence = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("script gate: hooks, length window, sources, similarity", () => {
  const base = {
    script: `Why do stars twinkle at night? ${sentence(90)}.`,
    hooks: ["a", "b", "c"], format: "short" as const, durationSec: 40, wordsPerMinute: 150, sources: ["unrelated text about cooking pasta"], requiresSources: true,
  };
  assert.deepEqual(scriptGate(base).issues, []);
  assert.match(scriptGate({ ...base, hooks: ["a", "b"] }).issues.join(), /hook variants/);
  assert.match(scriptGate({ ...base, script: "Short script here." }).issues.join(), /words/);
  assert.match(scriptGate({ ...base, sources: [] }).issues.join(), /sources/);
  const copied = scriptGate({ ...base, sources: [base.script] });
  assert.equal(copied.passed, false);
  assert.match(copied.issues.join(), /copies/);
  const slowOpen = scriptGate({ ...base, script: `${sentence(30)}. ${sentence(70)}.` });
  assert.match(slowOpen.issues.join(), /opening line/);
  assert.equal(scriptGate({ ...base, requiresSources: false, sources: [] }).passed, true);
});

test("storyboard gate", () => {
  const t = explainer();
  const shots = t.beats.map((b) => ({ beatRole: b.role, seconds: 2 }));
  assert.equal(storyboardGate(t, shots).passed, true);
  assert.match(storyboardGate(t, shots.slice(0, 3)).issues.join(), /payoff|cta/);
  assert.match(storyboardGate(t, shots.map((s, i) => (i === 2 ? { ...s, seconds: 20 } : s))).issues.join(), /longer than/);
  assert.match(storyboardGate(t, shots.map((s, i) => (i === 0 ? { ...s, seconds: 5 } : s))).issues.join(), /hook window/);
  assert.equal(storyboardGate(t, []).passed, false);
});

test("assets gate delegates to provenance and checks coverage", () => {
  const ok = { title: "bg", kind: "image" as const, source: "hermes" as const, license: "generated", originUrl: "" };
  const usage = { use: "publish" as const, shotCount: 2, coveredShots: 2, visionFlags: [] };
  assert.equal(assetsGate([ok], usage).passed, true);
  assert.match(assetsGate([{ ...ok, license: "" }], usage).issues.join(), /no licence/);
  assert.match(assetsGate([{ ...ok, kind: "reference-video" }], usage).issues.join(), /reference video/);
  assert.match(assetsGate([ok], { ...usage, coveredShots: 1 }).issues.join(), /no asset/);
  assert.match(assetsGate([ok], { ...usage, visionFlags: ["brand logo at 0:12"] }).issues.join(), /logo/);
  assert.match(assetsGate([{ ...ok, tags: ["person-likeness"] }], usage).issues.join(), /real person/);
  assert.equal(assetsGate([{ ...ok, license: "" }], { ...usage, use: "analyze" }).passed, true);
});

test("voice gate", () => {
  const base = { languageCode: "en", provider: null, scriptEstimateSec: 40, narrationSec: 41, clipped: false };
  assert.equal(voiceGate(base).passed, true);
  assert.equal(voiceGate({ ...base, languageCode: "id" }).passed, false);
  assert.equal(voiceGate({ ...base, languageCode: "id", provider: "9router tts-1" }).passed, true);
  assert.equal(voiceGate({ ...base, languageCode: "xx" }).passed, false);
  assert.equal(voiceGate({ ...base, narrationSec: 50 }).passed, false);
  assert.equal(voiceGate({ ...base, clipped: true }).passed, false);
});

test("presentation gate", () => {
  assert.equal(presentationGate(75).passed, true);
  const r = presentationGate(74, 75, ["caption cut off"]);
  assert.equal(r.passed, false);
  assert.equal(r.score, 74);
  assert.ok(r.issues.includes("caption cut off"));
  assert.equal(presentationGate(78, 80).passed, false);
});

const flags: ComplianceFlags = { paidPromotion: false, madeForKids: false, alteredContent: false, realisticSynthetic: false, checklistSigned: true, musicLicensed: true };
const plan = (purposes: string[], themeId: string | null) => ({ purposes: purposes.map((id) => ({ id, label: id })), themeId });

test("compliance gate derives required flags from the plan", () => {
  assert.equal(complianceGate({ plan: plan(["educate"], "science"), flags }).passed, true);
  assert.equal(complianceGate({ plan: plan(["affiliate"], null), flags }).passed, false);
  assert.equal(complianceGate({ plan: plan(["advertising"], null), flags: { ...flags, paidPromotion: true } }).passed, true);
  assert.match(complianceGate({ plan: plan([], "kids"), flags }).issues.join(), /Made for Kids/);
  assert.equal(complianceGate({ plan: plan([], "kids"), flags: { ...flags, madeForKids: true } }).passed, true);
  assert.match(complianceGate({ plan: plan([], null), flags: { ...flags, realisticSynthetic: true } }).issues.join(), /synthetic/);
  assert.equal(complianceGate({ plan: plan([], null), flags: { ...flags, checklistSigned: false } }).passed, false);
  assert.equal(complianceGate({ plan: plan([], null), flags: { ...flags, musicLicensed: false } }).passed, false);
});

test("claims gate waits, then reads status", () => {
  assert.equal(claimsGate({ status: "clear", waitedHours: 7 }).passed, true);
  assert.equal(claimsGate({ status: "clear", waitedHours: 2 }).passed, false);
  assert.equal(claimsGate({ status: "claim", waitedHours: 7 }).passed, false);
  assert.equal(claimsGate({ status: "unknown", waitedHours: 7 }).passed, false);
  assert.equal(claimsGate({ status: "clear", waitedHours: 1, minWaitHours: 1 }).passed, true);
});

test("combineGates scores, lists failures and flags blocking", () => {
  const t = explainer();
  const ok: GateResult = { gate: "G-script", passed: true, issues: [], executor: "hermes" };
  const pres: GateResult = { gate: "G-presentation", passed: true, score: 90, issues: [], executor: "x" };
  const all = combineGates([ok, pres], t, []);
  assert.equal(all.passed, true);
  assert.equal(all.score, 95);
  assert.equal(all.blocking, false);
  const tech: GateResult = { gate: "G-technical", passed: false, issues: ["a", "b"], executor: "w" };
  const failed = combineGates([ok, tech], t, []);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failedGates, ["G-technical"]);
  assert.equal(failed.score, 90);
  assert.equal(failed.blocking, false);
  const comp: GateResult = { gate: "G-compliance", passed: false, issues: ["z"], executor: "p" };
  assert.equal(combineGates([ok, comp], t, []).blocking, true);
  assert.equal(combineGates([], t).passed, false);
  assert.equal(combineGates([ok], { ...t, status: "retired" }).blocking, true);
});

test("combineGates does not pass until every publish gate has a result", () => {
  const t = explainer();
  const g = (gate: GateResult["gate"]): GateResult => ({ gate, passed: true, score: 90, issues: [], executor: "x" });
  const some = combineGates([g("G-script"), g("G-presentation")], t);
  assert.equal(some.passed, false);
  assert.deepEqual(some.missingGates, ["G-technical", "G-assets", "G-compliance", "G-claims"]);
  const noClaims = combineGates(PUBLISH_GATES.filter((x) => x !== "G-claims").map(g), t);
  assert.equal(noClaims.passed, false);
  assert.deepEqual(noClaims.missingGates, ["G-claims"]);
  const full = combineGates(PUBLISH_GATES.map(g), t);
  assert.equal(full.passed, true);
  assert.deepEqual(full.missingGates, []);
});

test("technicalGate flags a long shot and a late first cut on shorts", () => {
  const t = explainer();
  const base = good();
  assert.equal(technicalGate(base, t, "short").passed, true);
  const longShot = technicalGate({ ...base, cuts: [1, 2] }, t, "short");
  assert.ok(longShot.issues.some((i) => i.startsWith("A shot longer than allowed")));
  const late = technicalGate({ ...base, cuts: [t.pacing.hookByMs / 1000 + 1, 5, 9, 13, 17, 21, 25, 29, 33, 37] }, t, "short");
  assert.ok(late.issues.some((i) => i.includes("hook window")));
});

test("qcSummary is plain English", () => {
  const lines = qcSummary([
    { gate: "G-script", passed: true, issues: [], executor: "h" },
    { gate: "G-technical", passed: false, issues: ["Loudness is -20 LUFS"], executor: "w" },
  ]);
  assert.equal(lines[0], "Script: passed");
  assert.match(lines[1], /^Technical: needs attention\. Loudness is -20 LUFS/);
  assert.deepEqual(qcSummary([]), ["No checks have run yet."]);
});

test("storyboard gate: shots must be able to cover the estimated narration", () => {
  const t = explainer();
  const max = t.pacing.maxShotSeconds;
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ beatRole: t.beats[i % t.beats.length].role, seconds: 2 }));
  const narration = 45.2;
  const enough = Math.ceil((narration * 1.1 - 0.5) / max);
  assert.equal(storyboardGate(t, make(enough), narration).passed, true);
  const few = storyboardGate(t, make(Math.max(t.beats.length, enough - 1)).slice(0, enough - 1), narration);
  assert.match(few.issues.join(), /Add at least \d+ more shot/);
  // Unknown narration length keeps the old behaviour.
  assert.equal(storyboardGate(t, make(t.beats.length)).passed, true);
  assert.match(storyboardGate(t, make(40), 10).issues.join(), /Remove shots/);
});
