import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LAB_REVISIONS,
  blendFingerprints,
  candidateFromDraft,
  draftFromFingerprint,
  evidenceFrom,
  fingerprint,
  nextRevision,
  originalityGuard,
  scoreTrial,
  withEvidence,
  type AnalysisInput,
  type DraftOptions,
} from "./template-lab.ts";
import type { GateResult } from "./qc.ts";

const TITLE = "Secret Pasta Empire Documentary";
const CHANNEL = "ChefMaster9000";
const FILE = "pasta-empire-final-v3.mp4";

function analysis(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    video: { durationSec: 50, width: 1080, height: 1920, fps: 30 },
    cuts: [1.3, 4.1, 9.7, 13.2, 18.9, 22.4, 27.7, 31.1, 36.3, 41.9, 46.1],
    shots: { count: 12, avgSeconds: 4.17, medianSeconds: 3.6, shortestSeconds: 1.3, longestSeconds: 5.8 },
    hook: { firstCutSeconds: 1.3 },
    pacing: { cutsPerMinute: 13.2 },
    loudnessLufs: -15.2,
    ...over,
  };
}
const opts: DraftOptions = { sampleSha256: "ab".repeat(32), analyzedAt: "2025-06-01T00:00:00Z", label: "Fast food explainer", idSuffix: "x1" };
const sampleMeta = { title: TITLE, channel: CHANNEL, fileName: FILE };

test("fingerprint holds numbers derived from the analysis", () => {
  const fp = fingerprint(analysis());
  assert.equal(fp.samples, 1);
  assert.equal(fp.firstCutSeconds, 1.3);
  assert.equal(fp.cutsPerMinute, 13.2);
  assert.equal(fp.aspect, 0.563);
  assert.equal(fp.durationSec, 50);
  assert.equal(fp.loudnessLufs, -15.2);
  assert.ok(fp.shotSeconds.p10 <= fp.shotSeconds.p50 && fp.shotSeconds.p50 <= fp.shotSeconds.p90);
  assert.ok(fp.shotSeconds.p90 > 4 && fp.shotSeconds.p90 < 6);
  assert.ok(Math.abs(fp.segmentCutShare.reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.equal(fp.segmentCutShare[0], 0.273);
  const none = fingerprint(analysis({ cuts: [], hook: { firstCutSeconds: null } }));
  assert.deepEqual(none.segmentCutShare, [0, 0, 0, 0, 0]);
  assert.equal(none.firstCutSeconds, 50);
});

test("draft is a draft with clamped pacing and no sample text", () => {
  const draft = draftFromFingerprint(fingerprint(analysis()), "explainer-flat-vector", opts);
  assert.equal(draft.status, "draft");
  assert.equal(draft.derivedFrom?.sampleSha256, opts.sampleSha256);
  assert.ok(draft.pacing.maxShotSeconds >= 1 && draft.pacing.maxShotSeconds <= 20);
  assert.ok(draft.pacing.hookByMs >= 500 && draft.pacing.hookByMs <= 5000);
  assert.equal(draft.pacing.hookByMs, 1300);
  const json = JSON.stringify(draft);
  for (const s of [TITLE, CHANNEL, FILE, "pasta", "ChefMaster"]) assert.equal(json.includes(s), false, s);
  const extreme = draftFromFingerprint({ ...fingerprint(analysis()), shotSeconds: { p10: 40, p50: 60, p90: 90 }, firstCutSeconds: 0.01 }, "explainer-flat-vector", opts);
  assert.equal(extreme.pacing.maxShotSeconds, 20);
  assert.equal(extreme.pacing.hookByMs, 500);
  assert.throws(() => draftFromFingerprint(fingerprint(analysis()), "nope", opts));
});

test("originality guard rejects sample names and unblended copies", () => {
  const fp = fingerprint(analysis());
  const draft = draftFromFingerprint(fp, "explainer-flat-vector", opts);
  assert.deepEqual(originalityGuard(draft, { ...sampleMeta, fingerprint: fp }), []);
  assert.match(originalityGuard({ ...draft, label: `Like ${TITLE}` }, sampleMeta).join(), /title/);
  assert.match(originalityGuard({ ...draft, label: `${CHANNEL.toLowerCase()} style` }, sampleMeta).join(), /channel/);
  const copy = { ...draft, pacing: { maxShotSeconds: fp.shotSeconds.p90, hookByMs: fp.firstCutSeconds * 1000, cutsPerMinute: [fp.cutsPerMinute, fp.cutsPerMinute] as [number, number] } };
  copy.beats = copy.beats.map((b) => ({ ...b, maxShotSeconds: fp.shotSeconds.p90 }));
  assert.match(originalityGuard(copy, { ...sampleMeta, fingerprint: fp }).join(), /Too close to one sample/);
});

test("blending uses medians and fewer than three samples keeps the draft", () => {
  const a = fingerprint(analysis());
  const b = fingerprint(analysis({ hook: { firstCutSeconds: 2.1 }, pacing: { cutsPerMinute: 10 }, cuts: [2.1, 8, 15, 22, 30, 40] }));
  const c = fingerprint(analysis({ hook: { firstCutSeconds: 3.3 }, cuts: [3.3, 12, 20, 33, 45] }));
  const blend = blendFingerprints([a, b, c]);
  assert.equal(blend.samples, 3);
  assert.equal(blend.firstCutSeconds, 2.1);
  assert.throws(() => blendFingerprints([]));
  const two = draftFromFingerprint(blendFingerprints([a, b]), "explainer-flat-vector", opts);
  const r2 = candidateFromDraft(two, sampleMeta);
  assert.equal(r2.template.status, "draft");
  assert.match(r2.issues.join(), /at least 3 samples/);
  const three = draftFromFingerprint(blend, "explainer-flat-vector", opts);
  const r3 = candidateFromDraft(three, sampleMeta);
  assert.deepEqual(r3.issues, []);
  assert.equal(r3.template.status, "candidate");
  assert.equal(three.status, "draft");
  const named = candidateFromDraft({ ...three, label: TITLE }, sampleMeta);
  assert.equal(named.template.status, "draft");
});

const fail = (gate: GateResult["gate"], issue: string, score?: number): GateResult => ({ gate, passed: false, issues: [issue], executor: "x", ...(score !== undefined ? { score } : {}) });
const pass = (gate: GateResult["gate"], score?: number): GateResult => ({ gate, passed: true, issues: [], executor: "x", ...(score !== undefined ? { score } : {}) });

test("scoreTrial and evidence", () => {
  const s1 = scoreTrial([pass("G-technical"), pass("G-presentation", 90), pass("G-assets")]);
  assert.deepEqual(s1, { passedTechnical: true, presentationScore: 90, assetFailed: false, complianceFailed: false });
  const s2 = scoreTrial([fail("G-technical", "x"), fail("G-presentation", "y", 70), fail("G-assets", "z"), fail("G-compliance", "w")]);
  assert.deepEqual(s2, { passedTechnical: false, presentationScore: 70, assetFailed: true, complianceFailed: true });
  const e = evidenceFrom([s1, s2], 1);
  assert.deepEqual(e, { trials: 2, passRate: 0.5, meanPresentationScore: 80, assetFailures: 1, complianceFailures: 1, claims: 1 });
  assert.equal(evidenceFrom([], 0).passRate, 0);
  const t = draftFromFingerprint(fingerprint(analysis()), "explainer-flat-vector", opts);
  assert.equal(withEvidence(t, [s1], 0).evidence.trials, 1);
  assert.equal(t.evidence.trials, 0);
});

test("nextRevision shortens shots, tightens the hook, widens the safe area, within clamps", () => {
  const t = draftFromFingerprint(fingerprint(analysis()), "explainer-flat-vector", opts);
  const r = nextRevision(t, [[fail("G-technical", "A shot longer than allowed: 9 s"), fail("G-presentation", "Presentation score 60 is below 75", 60)]]);
  assert.ok("template" in r);
  if (!("template" in r)) return;
  assert.ok(r.template.pacing.maxShotSeconds < t.pacing.maxShotSeconds);
  assert.equal(r.template.labRevisions, 1);
  assert.equal(t.labRevisions, 0);
  assert.equal(r.changed.length, 1);
  const cap = nextRevision(t, [[fail("G-presentation", "caption text cut off", 60)]]);
  assert.ok("template" in cap && cap.template.captions.safeAreaPct === 10);
  const hook = nextRevision(t, [[fail("G-technical", "The first cut comes at 4 s")]]);
  assert.ok("template" in hook && hook.template.pacing.hookByMs < t.pacing.hookByMs);
});

test("nextRevision stops at the cap, when passing, or when nothing is safe", () => {
  const t = draftFromFingerprint(fingerprint(analysis()), "explainer-flat-vector", opts);
  const failing = [[fail("G-technical", "A shot longer than allowed")]];
  assert.ok("stop" in nextRevision({ ...t, labRevisions: MAX_LAB_REVISIONS }, failing));
  assert.ok("stop" in nextRevision(t, [[pass("G-technical")]]));
  assert.ok("stop" in nextRevision(t, []));
  assert.ok("stop" in nextRevision(t, [[fail("G-script", "odd")]]));
});

test("repeated revisions stay inside the clamps and end at the cap", () => {
  let t = draftFromFingerprint(fingerprint(analysis()), "explainer-flat-vector", opts);
  const trial = [[fail("G-technical", "A shot longer than allowed. The first cut comes late"), fail("G-presentation", "caption text", 50)]];
  let steps = 0;
  for (;;) {
    const r = nextRevision(t, trial);
    if ("stop" in r) break;
    t = r.template;
    steps++;
    assert.ok(t.pacing.maxShotSeconds >= 1 && t.pacing.hookByMs >= 500 && t.captions.safeAreaPct <= 20);
    assert.ok(steps <= MAX_LAB_REVISIONS);
  }
  assert.equal(steps, MAX_LAB_REVISIONS);
  assert.equal(t.labRevisions, MAX_LAB_REVISIONS);
});
