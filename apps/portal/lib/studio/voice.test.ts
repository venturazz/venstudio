import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkScript, estimateNarrationSec, kokoroVoiceFor, needsBackup } from "./voice.ts";

test("chunkScript breaks on sentences and respects the limit", () => {
  const text = "First sentence here. Second one is a bit longer than the first! Third? Yes.";
  const chunks = chunkScript(text, 40);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 40, c);
  assert.equal(chunks.join(" "), text);
});

test("chunkScript splits a very long sentence and never loses words", () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const chunks = chunkScript(long, 50);
  for (const c of chunks) assert.ok(c.length <= 50);
  assert.equal(chunks.join(" "), long);
  const blob = "x".repeat(130);
  assert.equal(chunkScript(blob, 50).join(""), blob);
  assert.deepEqual(chunkScript("   ", 50), []);
});

test("estimateNarrationSec uses 150 words per minute by default", () => {
  assert.equal(estimateNarrationSec(Array(150).fill("a").join(" ")), 60);
  assert.equal(estimateNarrationSec(Array(75).fill("a").join(" "), 150), 30);
  assert.equal(estimateNarrationSec(""), 0);
});

test("needsBackup follows the catalog tts field", () => {
  assert.equal(needsBackup("en"), false);
  assert.equal(needsBackup("es"), false);
  assert.equal(needsBackup("id"), true);
  assert.equal(needsBackup("ko"), true);
  assert.equal(needsBackup("xx"), true);
});

test("kokoroVoiceFor marks only English as verified", () => {
  assert.deepEqual(kokoroVoiceFor("en"), { voice: "af_heart", verified: true });
  assert.equal(kokoroVoiceFor("fr")?.verified, false);
  assert.equal(kokoroVoiceFor("de"), null);
  assert.equal(kokoroVoiceFor("en", "am_adam")?.voice, "am_adam");
  assert.equal(kokoroVoiceFor("es", "am_adam")?.voice, "ef_dora");
});
