import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESENTATION_PASS } from "./qc.ts";
import {
  ADVISORY_FRAMES,
  PRESENTATION_RUBRIC,
  advisoryMessages,
  ownerPresentationGate,
  parseAdvisory,
  parseRubric,
  presentationScoreOf,
  readAdvisory,
  readRubric,
  rubricField,
  rubricText,
  type Rubric,
} from "./presentation.ts";

const all = (n: 1 | 2 | 3 | 4 | 5): Rubric => ({ hook: n, pacing: n, legibility: n, polish: n, audio: n });

test("the rubric is hook, pacing, legibility, visual polish and audio, each a form field", () => {
  assert.deepEqual(PRESENTATION_RUBRIC.map((r) => r.label), ["Hook", "Pacing", "Legibility", "Visual polish", "Audio"]);
  assert.equal(rubricField("polish"), "rubric-polish");
});

test("stars map to 0-100: 1 star is 0, 5 stars is 100, the mean in between, rounded", () => {
  assert.equal(presentationScoreOf(all(1)), 0);
  assert.equal(presentationScoreOf(all(5)), 100);
  assert.equal(presentationScoreOf(all(3)), 50);
  assert.equal(presentationScoreOf(all(4)), 75);
  assert.equal(presentationScoreOf({ hook: 5, pacing: 4, legibility: 4, polish: 4, audio: 4 }), 80);
  assert.equal(presentationScoreOf({ hook: 5, pacing: 5, legibility: 4, polish: 4, audio: 2 }), 75);
  assert.equal(presentationScoreOf({ hook: 5, pacing: 4, legibility: 4, polish: 4, audio: 3 }), 75);
});

test("the owner's gate passes at PRESENTATION_PASS, names the executor and keeps the rating as a note", () => {
  assert.equal(PRESENTATION_PASS, 75);
  const pass = ownerPresentationGate(all(4));
  assert.deepEqual([pass.gate, pass.passed, pass.score, pass.executor], ["G-presentation", true, 75, "owner"]);
  assert.deepEqual(pass.notes, ["Owner rating: hook 4, pacing 4, legibility 4, visual polish 4, audio 4"]);
  const fail = ownerPresentationGate({ ...all(4), audio: 1 });
  assert.equal(fail.passed, false);
  assert.match(fail.issues.join(" "), /Presentation score 60 is below 75/);
  assert.equal(ownerPresentationGate(all(4), 80).passed, false, "a pack's own minimum can be stricter");
});

test("parseRubric needs every line, whole stars from 1 to 5, from a form or JSON", () => {
  const form = new Map([["hook", "5"], ["pacing", "4"], ["legibility", "3"], ["polish", "2"], ["audio", "1"]]);
  const ok = parseRubric((id) => form.get(id));
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value, { hook: 5, pacing: 4, legibility: 3, polish: 2, audio: 1 });
  const missing = parseRubric((id) => (id === "audio" ? "" : "4"));
  assert.ok(!missing.ok);
  assert.match(!missing.ok ? missing.issues[0] : "", /missing: Audio/);
  for (const bad of ["0", "6", "4.5", "x", null, undefined]) assert.equal(parseRubric(() => bad).ok, false, String(bad));
  assert.equal(parseRubric((id) => (all(3) as Record<string, number>)[id]).ok, true);
  assert.deepEqual(readRubric({ hook: 5, pacing: 5, legibility: 5, polish: 5, audio: 4, extra: 1 }), { hook: 5, pacing: 5, legibility: 5, polish: 5, audio: 4 });
  assert.equal(readRubric({ hook: 5 }), null);
  assert.equal(rubricText({ hook: 2, audio: 5 }), "hook 2, audio 5");
});

test("the Hermes advisory: the prompt carries the contract and the frame times; the score is computed, never trusted", () => {
  const m = advisoryMessages({ topic: "Why prices rise", format: "short", durationSec: 24.2, packId: "probe-line-graph", contract: { pacing: { shotSeconds: [2, 4] } }, frames: [{ atSec: 2 }, { atSec: 6 }] });
  assert.equal(m.length, 1);
  assert.match(m[0].content, /^VENSTUDIO_STAGE: presentation-advisory/);
  assert.match(m[0].content, /Style pack: probe-line-graph/);
  assert.match(m[0].content, /"shotSeconds":\[2,4\]/);
  assert.match(m[0].content, /Stills at 2 s, 6 s/);
  assert.match(m[0].content, /advisory: the owner decides/);
  assert.equal(ADVISORY_FRAMES, 6);
  const r = parseAdvisory({ rubric: { hook: 4, pacing: 4, legibility: 5, polish: 3, audio: 4 }, notes: "  Big   text, fine. ", score: 100 });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.value, { rubric: { hook: 4, pacing: 4, legibility: 5, polish: 3, audio: 4 }, notes: "Big text, fine.", score: 75 });
  assert.equal(parseAdvisory({ rubric: { hook: 9 } }).ok, false);
  assert.equal(parseAdvisory("75").ok, false);
  assert.deepEqual(readAdvisory({ score: 75, rubric: { hook: 4, pacing: 9 }, notes: "n", frames: 6, at: "t" }), { score: 75, rubric: { hook: 4 }, notes: "n", frames: 6, at: "t" });
  assert.equal(readAdvisory({ score: 101 }), null);
  assert.equal(readAdvisory(null), null);
});
