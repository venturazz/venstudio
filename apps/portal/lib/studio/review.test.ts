import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkName,
  decisionHint,
  decisionLabel,
  decisionOptions,
  decisionRefusal,
  describeGateIssues,
  parseQcFacts,
  qcFailureText,
  qcWaiver,
  reviewTitle,
  sortReviews,
  stageLabel,
  videoRevisionMessage,
  type QcFacts,
  type ReviewKind,
  type ReviewState,
} from "./review.ts";
import { NO_AUDIO_ISSUE, SILENT_AUDIO_ISSUE } from "./qc.ts";
import { presentationRefusal } from "./presentation.ts";
import { guardFinalDecision, publishRefusal, type RunStylePack } from "./style-registry.ts";
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

test("the revision hint on the finished video says where the note goes, and the message after sending says where it went", () => {
  for (const stage of ["render", "qc"]) {
    assert.equal(
      decisionHint("revise", "approval", stage, { hermesRender: true }),
      "Hermes will redo the video with your note. The narration will be recorded again only for a note about the voice itself (its accent, pronunciation, or a robotic or wrong voice).",
    );
    assert.equal(decisionHint("revise", "gate-failure", stage, { hermesRender: true, voiced: false }), "Hermes will redo the video with your note, its voice included.");
    assert.match(decisionHint("revise", "approval", stage, {}) ?? "", /^A note about missing or wrong sound renders the video again \(the mix\) with the same narration\. The narration will be recorded again only for/);
  }
  assert.equal(videoRevisionMessage("render", { hermesRender: true }), "Revision sent. Hermes will redo the video with your note.");
  assert.equal(videoRevisionMessage("render", { hermesRender: false }), "Revision sent. The video is rendered again with the same narration.");
  assert.equal(videoRevisionMessage("voice", { hermesRender: true }), "Revision sent. The narration will be recorded again with your note, then the video is made again.");
  assert.equal(videoRevisionMessage("script", { hermesRender: true }), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The final quality check: Approve when it passes, Approve anyway (owner, audited) when every failure may be waived

const SHOT = "A shot longer than allowed: 9.2 s, limit 6 s";
const HOOK = "The first cut comes at 4.1 s, after the 3 s hook window";
const LOUD = "Loudness is -20 LUFS, target is -14 plus or minus 2";
const TERMS = "kokoro: Confirm the commercial-use terms for kokoro in Settings before this is published";
const LICENCE = "Shot 3: no licence or permission note";
const tech: QcFacts = { failedGates: ["G-technical"], narrated: true };

test("decisionOptions on the final card: an approval offers Approve for any run, a waivable failure adds Approve anyway", () => {
  // A passing check is an approval card; trial, research and lab runs get the same choices (the guard only stops the
  // policy approving or publishing by itself).
  assert.deepEqual(decisionOptions("approval", { stage: "qc", trial: true }), ["approve", "revise", "reject"]);
  assert.deepEqual(decisionOptions("approval", { stage: "qc" }), ["approve", "revise", "reject"]);
  for (const issues of [[SHOT], [HOOK], [LOUD], [SHOT, HOOK, LOUD], ["Black frames for 1.5 s starting at 2 s"], ["Resolution is 720x1280, expected 1080x1920"]]) {
    assert.deepEqual(decisionOptions("gate-failure", { stage: "qc", issues, qc: tech }), ["retry", "override", "revise", "reject"], issues.join(" "));
  }
  // A card made before payload.qc: judged by its lines, and counted as narrated.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "qc", issues: [SHOT] }), ["retry", "override", "revise", "reject"]);
  // A voice problem the owner already let through on the voice card may be waived with the rest.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "qc", issues: ["The narration is 3 s longer than its estimate", SHOT], qc: { failedGates: ["G-voice", "G-technical"], narrated: true } }), ["retry", "override", "revise", "reject"]);
  // No issues at all: nothing to waive.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "qc", issues: [], qc: tech }), ["retry", "revise", "reject"]);
});

test("never waived on the final card: provider terms, provenance or copyright, and a silent or missing track on a narrated style", () => {
  const blocked: Array<[string[], QcFacts | null, string]> = [
    [[TERMS, SHOT], { failedGates: ["G-technical", "G-voice"], narrated: true }, "terms"],
    [[LICENCE], { failedGates: ["G-assets"], narrated: true }, "provenance"],
    [["Something the assets gate found"], { failedGates: ["G-assets"], narrated: true }, "provenance"],
    [[LICENCE, SHOT], null, "provenance"],
    [["The template copyright checklist is not signed off"], { failedGates: ["G-compliance"], narrated: true }, "provenance"],
    [[SILENT_AUDIO_ISSUE, SHOT], tech, "audio"],
    [[NO_AUDIO_ISSUE], tech, "audio"],
    [[SILENT_AUDIO_ISSUE], null, "audio"],
  ];
  for (const [issues, qc, block] of blocked) {
    const w = qcWaiver(issues, qc);
    assert.equal(w.waivable, false, issues.join(" "));
    assert.ok(w.blocks.includes(block as never), `${issues.join(" ")}: ${w.blocks.join(",")}`);
    assert.deepEqual(decisionOptions("gate-failure", { stage: "qc", issues, qc }), ["retry", "revise", "reject"]);
    assert.ok(decisionRefusal("gate-failure", "override", { stage: "qc", issues, qc, isOwner: true }), "the server refuses it too");
  }
  // A style without narration may be quiet: its missing track is a check the owner can waive.
  assert.equal(qcWaiver([NO_AUDIO_ISSUE], { failedGates: ["G-technical"], narrated: false }).waivable, true);
});

test("the server guard: Approve anyway on the final card is the owner's, a trial run needs the score first, other stages keep their rules", () => {
  const ctx = { stage: "qc", issues: [SHOT], qc: tech };
  assert.equal(decisionRefusal("gate-failure", "override", { ...ctx, isOwner: true }), null);
  assert.equal(decisionRefusal("gate-failure", "override", { ...ctx, isOwner: false }), "Only the owner can approve anyway");
  assert.equal(decisionRefusal("gate-failure", "override", ctx), "Only the owner can approve anyway");
  // Plain Approve is never on a failed card; it is on a passing one.
  assert.match(decisionRefusal("gate-failure", "approve", { ...ctx, isOwner: true }) ?? "", /Quality check did not pass the checks: that choice is not available here/);
  assert.equal(decisionRefusal("approval", "approve", { stage: "qc" }), null);
  // A trial run's final decision, Approve anyway included, waits for the owner's score; other runs may skip it.
  assert.match(presentationRefusal({ stage: "qc", trial: true, decision: "override", scored: false }) ?? "", /^This is a trial run: the owner scores the video/);
  assert.equal(presentationRefusal({ stage: "qc", trial: true, decision: "override", scored: true }), null);
  assert.equal(presentationRefusal({ stage: "qc", trial: false, decision: "override", scored: false }), null);
  // Non-final stages are unchanged: no Approve anyway on a render or assets failure.
  assert.deepEqual(decisionOptions("gate-failure", { stage: "render", issues: [SHOT] }), ["retry", "revise", "reject"]);
  assert.deepEqual(decisionOptions("gate-failure", { stage: "assets", issues: [LICENCE] }), ["retry", "revise", "reject"]);
  assert.ok(decisionRefusal("gate-failure", "override", { stage: "render", issues: [SHOT], isOwner: true }));
  assert.deepEqual(decisionOptions("gate-failure", { stage: "script", issues: ["Needs at least 3 hook variants"] }), ["retry", "revise", "reject"]);
});

test("trial, research and lab runs: the guard only stops automatic approval and publishing, never the owner's Approve", () => {
  const packs: RunStylePack[] = [
    { id: "explainer-flat-vector", version: "1.0.1", status: "trial", trial: true },
    { id: "hermes-graph", version: "0.2.0", status: "trial", trial: true, engine: "hermes" },
    { id: "probe-line-graph", version: "0.1.1", status: "lab", trial: true, lab: true },
    { id: "hermes-designed-explainer", version: "0.1.0", status: "trial", trial: true, designed: true },
  ];
  for (const p of packs) {
    assert.ok(publishRefusal(p), `${p.id} is never published`);
    assert.equal(guardFinalDecision({ action: "auto-publish", reason: "x" }, p).action, "ask-owner");
    assert.equal(guardFinalDecision({ action: "ask-owner", reason: "x" }, p).action, "ask-owner");
    // The owner's card is an approval card with Approve, whatever the pack.
    assert.deepEqual(decisionOptions("approval", { stage: "qc", trial: true }), ["approve", "revise", "reject"]);
  }
});

test("the final card's wording says why there is no plain Approve, and the hint lists the failed checks", () => {
  assert.deepEqual(qcWaiver([SHOT, HOOK, LOUD, SHOT], tech).checks, ["shot length", "hook window", "loudness"]);
  assert.equal(checkName(SILENT_AUDIO_ISSUE), "silent audio");
  assert.equal(checkName(TERMS), "provider terms");
  assert.equal(
    qcFailureText("gate-failure", "qc", { issues: [SHOT, HOOK], qc: tech, isOwner: true }),
    "The quality check failed: shot length, hook window. You can approve anyway; it is recorded.",
  );
  assert.equal(
    qcFailureText("gate-failure", "qc", { issues: [SHOT], qc: tech, isOwner: false, trial: true }),
    "The quality check failed: shot length. The owner can approve anyway; it is recorded. The owner's score is needed first, and the curation record marks the check as waived.",
  );
  assert.equal(
    qcFailureText("gate-failure", "qc", { issues: [HOOK], qc: tech, isOwner: true, trial: true }),
    "The quality check failed: hook window. You can approve anyway; it is recorded. Save your score first; the curation record marks the check as waived.",
  );
  assert.match(qcFailureText("gate-failure", "qc", { issues: [TERMS], qc: tech, isOwner: true }) ?? "", /^The quality check failed: provider terms\. Provider terms are not confirmed or were refused .*never waived: confirm them in Settings/);
  assert.match(qcFailureText("gate-failure", "qc", { issues: [LICENCE], qc: { failedGates: ["G-assets"], narrated: true } }) ?? "", /provenance or copyright problem .* is never waived: send a revision/);
  assert.match(qcFailureText("gate-failure", "qc", { issues: [SILENT_AUDIO_ISSUE], qc: tech, hermesRender: true }) ?? "", /silent or missing sound is never approved: send a revision about the sound, and Hermes redoes the video with your note\.$/);
  assert.match(qcFailureText("gate-failure", "qc", { issues: [SILENT_AUDIO_ISSUE], qc: tech }) ?? "", /the video is rendered again \(the mix\) with the same narration\.$/);
  assert.equal(qcFailureText("approval", "qc", { issues: [] }), null);
  assert.equal(qcFailureText("gate-failure", "render", { issues: [SHOT] }), null);
  assert.equal(decisionLabel("override", "gate-failure", "qc", { issues: [SHOT], qc: tech }), "Approve anyway");
  assert.equal(
    decisionHint("override", "gate-failure", "qc", { issues: [SHOT, LOUD], qc: tech }),
    "Owner only. Approves this video although these checks failed: shot length, loudness. Your decision is recorded in the audit log.",
  );
  assert.match(decisionHint("override", "gate-failure", "qc", { issues: [SHOT], qc: tech, trial: true }) ?? "", /Save your score first; the curation record marks the quality check as waived and it never counts as a technical pass\.$/);
  // The voice card keeps its own hint.
  assert.match(decisionHint("override", "gate-failure", "voice", {}) ?? "", /^Owner only\. Uses this narration as it is/);
});

test("parseQcFacts reads payload.qc and drops what it does not know", () => {
  assert.deepEqual(parseQcFacts({ failedGates: ["G-technical", "G-nope", 3], narrated: false }), { failedGates: ["G-technical"], narrated: false });
  assert.equal(parseQcFacts({ failedGates: ["G-technical"] }), null);
  assert.equal(parseQcFacts(null), null);
  assert.equal(parseQcFacts([]), null);
});

test("a failed Hermes-skill render offers Retry on Muse only when the run can move to Muse", async () => {
  const { decisionOptions, decisionLabel, decisionHint, decisionRefusal } = await import("./review.ts");
  assert.deepEqual(decisionOptions("stage-error", { stage: "render", museRender: true }), ["retry", "muse", "revise", "reject"]);
  assert.deepEqual(decisionOptions("stage-error", { stage: "render" }), ["retry", "revise", "reject"]);
  assert.deepEqual(decisionOptions("stage-error", { stage: "voice", museRender: true }), ["retry", "revise", "reject"]);
  assert.equal(decisionLabel("muse", "stage-error", "render"), "Retry on Muse");
  assert.match(decisionHint("muse", "stage-error", "render") ?? "", /Muse worker with the same skill/);
  assert.match(decisionRefusal("stage-error", "muse", { stage: "render" }) ?? "", /not available here/);
  assert.equal(decisionRefusal("stage-error", "muse", { stage: "render", museRender: true }), null);
});
