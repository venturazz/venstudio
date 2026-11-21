import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES } from "./catalog.ts";
import { clone, demote, isAutonomyEligible, promote, promotionIssues, seedTemplates, signOff, type Template } from "./templates.ts";

function readyCandidate(): Template {
  let t = clone(seedTemplates()[0]);
  for (const item of t.copyrightChecklist) t = signOff(t, item.id, "owner-1", new Date("2025-01-01T00:00:00Z"));
  t.evidence = { trials: 5, passRate: 1, meanPresentationScore: 82, assetFailures: 0, complianceFailures: 0, claims: 0 };
  return t;
}

test("seed covers every style once, all candidates, ids unique", () => {
  const seeds = seedTemplates();
  assert.equal(seeds.length, STYLES.length);
  assert.deepEqual(seeds.map((t) => t.styleId).sort(), STYLES.map((s) => s.id).sort());
  assert.equal(new Set(seeds.map((t) => t.id)).size, seeds.length);
  for (const t of seeds) {
    assert.equal(t.status, "candidate");
    assert.equal(t.version, 1);
    assert.equal(t.id, `tpl-${t.styleId}`);
    assert.equal(t.derivedFrom, null);
    assert.ok(t.copyrightChecklist.length >= 5);
    assert.ok(t.copyrightChecklist.every((i) => i.signedOff === null));
    assert.equal(t.audio.targetLufs, -14);
    assert.ok(t.beats.length >= 1);
    assert.equal(isAutonomyEligible(t), false);
  }
});

test("seed beats and pacing follow the style", () => {
  const seeds = seedTemplates();
  const explainer = seeds.find((t) => t.styleId === "explainer-flat-vector");
  assert.deepEqual(explainer?.beats.map((b) => b.role), ["hook", "setup", "body", "payoff", "cta"]);
  assert.equal(explainer?.audio.narrated, true);
  assert.equal(explainer?.pacing.maxShotSeconds, 4);
  // the range that brackets the reference's measured 23.8 cuts a minute
  assert.deepEqual(explainer?.pacing.cutsPerMinute, [15, 30]);
  const ambient = seeds.find((t) => t.family === "ambient");
  assert.deepEqual(ambient?.beats.map((b) => b.role), ["body"]);
  assert.equal(ambient?.captions.required, false);
  const cautionStyle = STYLES.find((s) => s.cautions.length > 0);
  const tpl = seeds.find((t) => t.styleId === cautionStyle?.id);
  assert.ok(tpl?.copyrightChecklist.some((i) => i.label === cautionStyle?.cautions[0]));
});

test("promotionIssues lists each missing requirement", () => {
  const t = seedTemplates()[0];
  const issues = promotionIssues(t).join("\n");
  assert.match(issues, /at least 5 trial/);
  assert.match(issues, /technical gate/);
  assert.match(issues, /presentation score/);
  assert.match(issues, /not signed off/);
  const bad = readyCandidate();
  bad.evidence = { trials: 5, passRate: 1, meanPresentationScore: 82, assetFailures: 1, complianceFailures: 2, claims: 1 };
  const bi = promotionIssues(bad).join("\n");
  assert.match(bi, /assets gate/);
  assert.match(bi, /compliance gate/);
  assert.match(bi, /open copyright claim/);
  assert.deepEqual(promotionIssues(readyCandidate()), []);
});

test("promote refuses with issues and accepts a ready candidate", () => {
  const refused = promote(seedTemplates()[0], new Date(), "owner-1");
  assert.equal(refused.ok, false);
  const ok = promote(readyCandidate(), new Date("2025-02-01T00:00:00Z"), "owner-1");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.template.status, "proven");
    assert.deepEqual(ok.template.promoted, { userId: "owner-1", date: "2025-02-01T00:00:00.000Z" });
    assert.equal(isAutonomyEligible(ok.template), true);
  }
  assert.equal(promote(readyCandidate(), new Date(), " ").ok, false);
});

test("a draft or proven template cannot be promoted", () => {
  const d = readyCandidate();
  d.status = "draft";
  assert.match(promotionIssues(d)[0], /Only a candidate/);
});

test("promote and demote do not mutate their input", () => {
  const t = readyCandidate();
  const before = JSON.stringify(t);
  const p = promote(t, new Date(), "owner-1");
  assert.equal(JSON.stringify(t), before);
  assert.equal(p.ok && p.template !== t, true);
  const proven = p.ok ? p.template : t;
  const provenBefore = JSON.stringify(proven);
  const d = demote(proven, "claim");
  assert.equal(JSON.stringify(proven), provenBefore);
  assert.equal(d.status, "candidate");
  assert.equal(d.demotionReason, "claim");
  assert.equal(d.promoted, null);
  assert.ok(d.copyrightChecklist.every((i) => i.signedOff === null));
  assert.equal(isAutonomyEligible(d), false);
});

test("a proven template with an unsigned item is not autonomy eligible", () => {
  const p = promote(readyCandidate(), new Date(), "owner-1");
  assert.ok(p.ok);
  if (!p.ok) return;
  const t = clone(p.template);
  t.copyrightChecklist[0].signedOff = null;
  assert.equal(isAutonomyEligible(t), false);
});
