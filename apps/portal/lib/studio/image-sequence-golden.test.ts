/**
 * The image-sequence workflow is today's pipeline, byte for byte: the director prompts (idea, research, script,
 * storyboard, classify), the work orders and the image prompt of a storyboard, and the Hermes render request of a run
 * that renders from a storyboard and its pictures. The golden file was written by this same input against the code
 * before workflows existed (commit b4d8db1); any change to these bytes fails here.
 *
 * Regenerate with `GOLDEN_WRITE=1 node --test apps/portal/lib/studio/image-sequence-golden.test.ts` only after an
 * intended change to the image-sequence prompts, and say in the commit why they moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { imageSequenceSample } from "./image-sequence-sample.ts";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/prompts/image-sequence-prompts.json", import.meta.url));

test("image-sequence prompts, work orders and the storyboard Hermes render request are unchanged by workflows", () => {
  const now = JSON.parse(JSON.stringify(imageSequenceSample()));
  if (process.env.GOLDEN_WRITE === "1") {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(now, golden);
});
