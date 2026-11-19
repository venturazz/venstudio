import { test } from "node:test";
import assert from "node:assert/strict";
import { afterClaim, autoAssign, decideNext, effectiveLevel, type AutonomyLevel, type ChannelInfo, type WorkerInfo } from "./autonomy.ts";
import type { CombinedQc } from "./qc.ts";
import { demote, promote, seedTemplates, signOff, type Template } from "./templates.ts";

function proven(): Template {
  let t = seedTemplates()[0];
  for (const i of t.copyrightChecklist) t = signOff(t, i.id, "o", new Date());
  t.evidence = { trials: 5, passRate: 1, meanPresentationScore: 85, assetFailures: 0, complianceFailures: 0, claims: 0 };
  const p = promote(t, new Date(), "o");
  assert.ok(p.ok);
  return p.ok ? p.template : t;
}
const candidate = (): Template => seedTemplates()[0];
const pass = (score = 90): CombinedQc => ({ passed: true, missingGates: [], score, failedGates: [], blocking: false });

test("decision table for passing QC: level x paused x template x spot check", () => {
  const rows: Array<[AutonomyLevel, boolean, "proven" | "candidate", number, string]> = [
    [0, false, "proven", 0, "ask-owner"],
    [1, false, "proven", 0, "ask-owner"],
    [2, false, "proven", 0, "ask-owner"],
    [3, false, "proven", 0, "auto-publish"],
    [3, false, "proven", 3, "auto-publish"],
    [3, false, "proven", 4, "ask-owner"],
    [3, true, "proven", 0, "ask-owner"],
    [3, false, "candidate", 0, "ask-owner"],
    [3, true, "candidate", 0, "ask-owner"],
    [2, true, "candidate", 0, "ask-owner"],
  ];
  for (const [level, paused, tpl, since, expected] of rows) {
    const d = decideNext({ level, paused, template: tpl === "proven" ? proven() : candidate(), qc: pass(), videosSincePublishSpotCheck: since });
    assert.equal(d.action, expected, `${level}/${paused}/${tpl}/${since}: ${d.reason}`);
  }
});

test("level 3 needs a score of 85", () => {
  assert.equal(decideNext({ level: 3, paused: false, template: proven(), qc: pass(85), videosSincePublishSpotCheck: 0 }).action, "auto-publish");
  const low = decideNext({ level: 3, paused: false, template: proven(), qc: pass(84), videosSincePublishSpotCheck: 0 });
  assert.equal(low.action, "ask-owner");
  assert.match(low.reason, /84/);
});

test("every fifth video is held, counting from the last owner review", () => {
  const actions: string[] = [];
  let since = 0;
  for (let n = 1; n <= 10; n++) {
    const d = decideNext({ level: 3, paused: false, template: proven(), qc: pass(), videosSincePublishSpotCheck: since });
    actions.push(d.action);
    since = d.action === "auto-publish" ? since + 1 : 0;
  }
  assert.deepEqual(actions, ["auto-publish", "auto-publish", "auto-publish", "auto-publish", "ask-owner", "auto-publish", "auto-publish", "auto-publish", "auto-publish", "ask-owner"]);
});

test("stage results auto-approve above level 0", () => {
  const args = { paused: false, template: proven(), qc: pass(), videosSincePublishSpotCheck: 0, point: "stage" as const };
  assert.equal(decideNext({ ...args, level: 0 }).action, "ask-owner");
  assert.equal(decideNext({ ...args, level: 1 }).action, "auto-approve");
});

test("level 1 asks the owner to approve ideas, other stages auto-approve", () => {
  const args = { paused: false, template: proven(), qc: pass(), videosSincePublishSpotCheck: 0, point: "stage" as const };
  assert.equal(decideNext({ ...args, level: 1, stage: "idea" }).action, "ask-owner");
  assert.equal(decideNext({ ...args, level: 1, stage: "script" }).action, "auto-approve");
  assert.equal(decideNext({ ...args, level: 2, stage: "idea" }).action, "auto-approve");
  assert.equal(decideNext({ ...args, level: 3, paused: true, stage: "idea" }).action, "ask-owner");
});

test("a missing required gate goes to the owner, never to publish", () => {
  const qc: CombinedQc = { passed: false, missingGates: ["G-claims"], score: 95, failedGates: [], blocking: false };
  const d = decideNext({ level: 3, paused: false, template: proven(), qc, videosSincePublishSpotCheck: 0 });
  assert.equal(d.action, "ask-owner");
  assert.match(d.reason, /G-claims/);
});

test("failing gates revise twice, then ask the owner", () => {
  const qc: CombinedQc = { passed: false, missingGates: [], score: 60, failedGates: ["G-technical"], blocking: false };
  const base = { level: 3 as const, paused: false, template: proven(), qc, videosSincePublishSpotCheck: 0 };
  assert.equal(decideNext({ ...base, attempts: 0 }).action, "revise");
  assert.equal(decideNext({ ...base, attempts: 1 }).action, "revise");
  assert.equal(decideNext({ ...base, attempts: 2 }).action, "ask-owner");
  assert.equal(decideNext({ ...base, level: 0, attempts: 0 }).action, "ask-owner");
});

test("assets and compliance failures get one revision and never auto-publish", () => {
  for (const gate of ["G-assets", "G-compliance"] as const) {
    const qc: CombinedQc = { passed: false, missingGates: [], score: 70, failedGates: [gate], blocking: true };
    const base = { level: 3 as const, paused: false, template: proven(), qc, videosSincePublishSpotCheck: 0 };
    assert.equal(decideNext({ ...base, attempts: 0 }).action, "revise");
    assert.equal(decideNext({ ...base, attempts: 1 }).action, "ask-owner");
  }
});

test("a claim blocks, and a retired template blocks", () => {
  const qc: CombinedQc = { passed: false, missingGates: [], score: 50, failedGates: ["G-claims"], blocking: true };
  assert.equal(decideNext({ level: 3, paused: false, template: proven(), qc, videosSincePublishSpotCheck: 0 }).action, "block");
  const retired = { ...proven(), status: "retired" as const };
  assert.equal(decideNext({ level: 3, paused: false, template: retired, qc: pass(), videosSincePublishSpotCheck: 0 }).action, "block");
});

test("effectiveLevel never raises and a demoted template drops to level 1", () => {
  assert.equal(effectiveLevel(3, false, proven()), 3);
  assert.equal(effectiveLevel(3, true, proven()), 1);
  assert.equal(effectiveLevel(0, true, proven()), 0);
  assert.equal(effectiveLevel(3, false, demote(proven(), "claim")), 1);
});

test("afterClaim pauses, demotes and blocks on a claim", () => {
  assert.deepEqual(afterClaim("clear"), []);
  assert.deepEqual(afterClaim("unknown"), []);
  for (const s of ["claim", "restricted", "strike"] as const) {
    assert.deepEqual(afterClaim(s).map((a) => a.action).sort(), ["block-publish", "demote-template", "pause-channel-autonomy"]);
  }
});

const now = new Date("2025-06-01T12:00:00Z");
const worker = (id: string, minutesAgo: number | null, running: number, caps: string[] = ["ffmpeg"]): WorkerInfo => ({
  id, lastSeenAt: minutesAgo === null ? null : new Date(now.getTime() - minutesAgo * 60_000), running, capabilities: caps,
});

test("autoAssign prefers the home worker, then an idle capable worker", () => {
  const channels: ChannelInfo[] = [{ id: "c1", homeWorkerId: "w-home" }, { id: "c2", homeWorkerId: null }];
  const workers = [worker("w-b", 1, 0), worker("w-home", 1, 2), worker("w-a", 1, 0)];
  const home = autoAssign({ channelId: "c1", channels, workers, requiredCapabilities: ["ffmpeg"], now });
  assert.equal(home.workerId, "w-home");
  assert.equal(home.via, "home");
  const idle = autoAssign({ channelId: "c2", channels, workers, requiredCapabilities: ["ffmpeg"], now });
  assert.equal(idle.workerId, "w-a");
  assert.equal(idle.via, "idle");
});

test("autoAssign skips offline and incapable workers and never invents a mapping", () => {
  const channels: ChannelInfo[] = [{ id: "c1", homeWorkerId: "w-home" }];
  const before = JSON.stringify(channels);
  const workers = [worker("w-home", 200, 0), worker("w-nocap", 1, 0, ["remotion-2d"]), worker("w-never", null, 0)];
  const r = autoAssign({ channelId: "c1", channels, workers, requiredCapabilities: ["ffmpeg"], now });
  assert.equal(r.workerId, null);
  assert.equal(JSON.stringify(channels), before);
  assert.equal(autoAssign({ channelId: "c1", channels, workers: [...workers, worker("w-ok", 10, 0)], requiredCapabilities: ["ffmpeg"], now }).workerId, "w-ok");
  assert.equal(Object.keys(r).includes("category"), false);
});
