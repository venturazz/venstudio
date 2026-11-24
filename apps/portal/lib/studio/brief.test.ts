/**
 * The brief is the one shape every stage reads, so these tests are about the two things that can go wrong: a brief that
 * loses what the owner said, and a brief that keeps moving after the owner approved an idea.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { briefFromInput, briefParagraph, freezeBrief, isFrozen, parseBrief } from "./brief.ts";

test("a brief keeps the owner's words and normalises only what it must", () => {
  const b = briefFromInput({
    topic: "  a lesser known myth from Nias  ",
    durationSec: 44.6,
    language: "",
    mustInclude: "- the village name\n- one oral source",
    mustAvoid: ["gore"],
  });
  assert.equal(b.version, 1);
  assert.equal(b.topic, "a lesser known myth from Nias");
  assert.equal(b.durationSec, 45, "a length is whole seconds");
  assert.equal(b.language, "en", "a missing language falls back to English, as the prompts do");
  assert.deepEqual(b.mustInclude, ["the village name", "one oral source"], "a textarea's lines are a list");
  assert.deepEqual(b.mustAvoid, ["gore"]);
  assert.equal(b.angle, "", "no idea is approved yet");
  assert.equal(isFrozen(b), false);
});

test("freezing writes the approved idea in, once", () => {
  const draft = briefFromInput({ topic: "warung kopi", durationSec: 21, language: "id" });
  const frozen = freezeBrief(draft, { title: "Enam pagi", angle: "told from the grinder's point of view" }, "2026-11-24T10:00:00.000Z");
  assert.equal(frozen.frozenAt, "2026-11-24T10:00:00.000Z");
  assert.equal(frozen.frozenBy, "owner");
  assert.equal(frozen.title, "Enam pagi");
  assert.equal(frozen.angle, "told from the grinder's point of view");
  assert.equal(frozen.topic, "warung kopi", "freezing never rewrites the topic");

  // Approving again (a retried decision) must not move the brief a second time.
  const again = freezeBrief(frozen, { title: "Other", angle: "other" }, "2026-11-25T00:00:00.000Z");
  assert.equal(again.frozenAt, "2026-11-24T10:00:00.000Z");
  assert.equal(again.title, "Enam pagi");
  assert.equal(again.angle, "told from the grinder's point of view");
});

test("an auto approval says so, because nobody read it", () => {
  const frozen = freezeBrief(briefFromInput({ topic: "x", durationSec: 30, language: "en" }), { title: "T", angle: "A" }, "2026-11-24T10:00:00.000Z", "auto");
  assert.equal(frozen.frozenBy, "auto");
});

test("a run from before the brief was an object still reads back", () => {
  const b = parseBrief("a myth from Nias", { topicHint: "", durationSec: 600, language: "id" });
  if (!b) throw new Error("expected a brief built from topicHint");
  assert.equal(b.version, 0, "version 0 means it was reconstructed from topicHint");
  assert.equal(b.topic, "a myth from Nias");
  assert.equal(b.durationSec, 600, "the stored length is kept, not a default");
  assert.equal(b.frozenAt, undefined);

  const fromHint = parseBrief(null, { topicHint: "hint only", durationSec: 45, language: "en" });
  if (!fromHint) throw new Error("expected a brief built from the hint");
  assert.equal(fromHint.topic, "hint only");

  assert.equal(parseBrief(null, { topicHint: "  " }), null, "a run with no brief has no brief");
  assert.equal(parseBrief(undefined), null);
});

test("a stored object reads back as itself", () => {
  const original = freezeBrief(
    briefFromInput({ topic: "kopi", durationSec: 21, language: "id", audience: "commuters", mustInclude: "the price" }),
    { title: "Enam pagi", angle: "the grinder" },
    "2026-11-24T10:00:00.000Z",
  );
  const back = parseBrief(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(back, original);
});

test("an empty topic written by this code is still a brief, not a missing one", () => {
  const empty = briefFromInput({ topic: "", durationSec: 45, language: "en" });
  assert.equal(parseBrief(JSON.parse(JSON.stringify(empty)))?.topic, "");
});

test("the frozen brief is one paragraph the prompts can take", () => {
  const frozen = freezeBrief(
    briefFromInput({ topic: "warung kopi at dawn", durationSec: 21, language: "id", audience: "commuters", mustInclude: ["the price"], mustAvoid: ["talking heads"] }),
    { title: "Enam pagi", angle: "seen from the grinder" },
    "2026-11-24T10:00:00.000Z",
  );
  const p = briefParagraph(frozen);
  assert.match(p, /Enam pagi\./);
  assert.match(p, /seen from the grinder/);
  assert.match(p, /For commuters\./);
  assert.match(p, /Must include: the price\./);
  assert.match(p, /Must avoid: talking heads\./);
});