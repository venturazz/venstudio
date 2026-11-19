import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSkills, parseSkills, skillsFromChatReply } from "./hermes-skills.ts";

test("parseSkills accepts the documented array and wrapped shapes", () => {
  const raw = [
    { name: "write-script", description: "Writes a script", category: "video" },
    { name: "research", description: "Researches", category: "research" },
    { name: "", description: "no name" },
    { description: "missing name" },
    { name: "loose" },
  ];
  const parsed = parseSkills(raw);
  assert.deepEqual(parsed.map((s) => s.name), ["loose", "research", "write-script"]);
  assert.equal(parsed[0].category, "other");
  assert.deepEqual(parseSkills({ data: raw }).length, 3);
  assert.deepEqual(parseSkills({ skills: raw }).length, 3);
  assert.deepEqual(parseSkills("<html>"), []);
  assert.deepEqual(parseSkills(null), []);
  assert.deepEqual(groupSkills(parsed).map(([c, s]) => [c, s.length]), [["other", 1], ["research", 1], ["video", 1]]);
});

test("skillsFromChatReply finds the JSON list in a chat answer", () => {
  const reply =
    "Here are my skills:\n```json\n[{\"name\":\"write-script\",\"description\":\"Scripts\",\"category\":\"video\"}," +
    "{\"name\":\"research\"}]\n```\nLet me know!";
  assert.deepEqual(skillsFromChatReply(reply).map((s) => s.name), ["research", "write-script"]);
  assert.deepEqual(skillsFromChatReply('[{"name":"a"}] trailing'), [{ name: "a", description: "", category: "other" }]);
  assert.deepEqual(skillsFromChatReply("I have no skills installed."), []);
  assert.deepEqual(skillsFromChatReply("[not json]"), []);
});
