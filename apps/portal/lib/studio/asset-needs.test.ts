import test from "node:test";
import assert from "node:assert/strict";
import { ambienceNeed, dedupe, droppedCues, musicNeed, needsForRun, sfxNeeds } from "./asset-needs.ts";

const inv = (counts: Record<string, number> = {}) => ({ counts });
const board = [
  { seconds: 4, beatRole: "hook" },
  { seconds: 4, beatRole: "body" },
  { seconds: 4, beatRole: "payoff" },
];

test("a run that chose no music is not a need; a run that asked auto and found nothing is", () => {
  assert.equal(musicNeed({ bedChoice: "none", inventory: inv() }), null);
  const missing = musicNeed({ bedChoice: "auto", mood: "Mystery", inventory: inv() });
  assert.equal(missing?.tag, "mystery");
  assert.equal(musicNeed({ bedChoice: "auto", mood: "calm", inventory: inv({ calm: 1 }) }), null);
});

test("a cue whose tag is missing is a need, and a cue whose tag exists is not", () => {
  const needs = sfxNeeds({ shots: board, mode: "rich", inventory: inv() });
  assert.deepEqual(needs.map((n) => n.tag).sort(), ["impact", "whoosh"]);
  assert.deepEqual(sfxNeeds({ shots: board, mode: "rich", inventory: inv({ whoosh: 2 }) }).map((n) => n.tag), ["impact"]);
  assert.deepEqual(sfxNeeds({ shots: board, mode: "off", inventory: inv() }), []);
});

test("ambience is asked for by name, and silence is a decision", () => {
  assert.equal(ambienceNeed({ ambience: false, sceneTag: "rain", inventory: inv() }), null);
  assert.equal(ambienceNeed({ ambience: true, sceneTag: "Rain", inventory: inv() })?.tag, "rain");
  assert.equal(ambienceNeed({ ambience: true, sceneTag: "rain", inventory: inv({ rain: 1 }) }), null);
  assert.equal(ambienceNeed({ ambience: "city", inventory: inv() })?.tag, "city");
});

test("one video's needs are deduplicated, so a counter counts videos and not cues", () => {
  const needs = needsForRun({
    bedChoice: "auto",
    mood: "mystery",
    shots: [...board, { seconds: 4, beatRole: "payoff" }, { seconds: 4, beatRole: "payoff" }],
    mode: "rich",
    ambience: true,
    sceneTag: "rain",
    inventory: inv(),
  });
  assert.deepEqual(needs.map((n) => `${n.assetClass}/${n.tag}`), ["music/mystery", "sfx/whoosh", "sfx/impact", "ambience/rain"]);
  assert.deepEqual(dedupe([...needs, ...needs]).length, needs.length);
});

test("the mix says how many accents it had to drop", () => {
  assert.equal(droppedCues(board, "rich", []), 2);
  assert.equal(droppedCues(board, "rich", [{ id: "w", tags: ["whoosh"] }]), 1);
  assert.equal(droppedCues(board, "rich", [{ id: "w", tags: ["whoosh"] }, { id: "i", tags: ["impact"] }]), 0);
});
