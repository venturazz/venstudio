import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionOptions, describeGateIssues, reviewTitle, sortReviews, stageLabel, type ReviewKind, type ReviewState } from "./review.ts";
import type { GateResult } from "./qc.ts";

const item = (id: string, kind: ReviewKind, state: ReviewState, createdAt: string) => ({ id, kind, state, createdAt });

test("sortReviews puts open problems first, then approvals and ideas, oldest first", () => {
  const sorted = sortReviews([
    item("idea-old", "idea", "open", "2026-01-01T00:00:00Z"),
    item("done-new", "idea", "approved", "2026-01-05T00:00:00Z"),
    item("err-new", "stage-error", "open", "2026-01-04T00:00:00Z"),
    item("appr", "approval", "open", "2026-01-02T00:00:00Z"),
    item("gate-old", "gate-failure", "open", "2026-01-03T00:00:00Z"),
    item("done-old", "idea", "rejected", "2026-01-02T00:00:00Z"),
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ["gate-old", "err-new", "appr", "idea-old", "done-new", "done-old"]);
});

test("sortReviews does not mutate its input and accepts Date values", () => {
  const input = [item("b", "idea", "open", "2026-01-02T00:00:00Z"), item("a", "idea", "open", "2026-01-01T00:00:00Z")];
  const copy = [...input];
  sortReviews(input);
  assert.deepEqual(input, copy);
  const d = sortReviews([{ kind: "idea" as const, state: "open" as const, createdAt: new Date("2026-02-01") }, { kind: "idea" as const, state: "open" as const, createdAt: new Date("2026-01-01") }]);
  assert.equal((d[0].createdAt as Date).getUTCMonth(), 0);
});

test("decisionOptions per kind", () => {
  assert.deepEqual(decisionOptions("idea"), ["approve", "revise", "reject"]);
  assert.deepEqual(decisionOptions("approval"), ["approve", "revise", "reject"]);
  assert.deepEqual([...decisionOptions("stage-error")].sort(), ["retry", "reject", "revise"].sort());
  assert.ok(!decisionOptions("stage-error").includes("approve"));
  assert.ok(!decisionOptions("gate-failure").includes("approve"));
});

test("titles and stage labels are plain language", () => {
  assert.equal(stageLabel("storyboard"), "Storyboard");
  assert.equal(stageLabel("custom"), "custom");
  assert.equal(reviewTitle("idea", "idea"), "Pick an idea");
  assert.equal(reviewTitle("approval", "script"), "Approve the script");
  assert.equal(reviewTitle("gate-failure", "script"), "Script did not pass the checks");
  assert.equal(reviewTitle("stage-error", "research"), "Research stopped with an error");
});

test("describeGateIssues wraps qcSummary", () => {
  const results: GateResult[] = [{ gate: "G-script", passed: false, issues: ["Needs at least 3 hook variants"], executor: "hermes" }];
  const lines = describeGateIssues(results);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Script: needs attention/);
  assert.deepEqual(describeGateIssues([]), ["No checks have run yet."]);
});
