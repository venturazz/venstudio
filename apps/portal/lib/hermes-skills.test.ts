import { test } from "node:test";
import assert from "node:assert/strict";
import { groupSkills, parseSkills } from "./hermes-skills.ts";

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
