// Research styles (one Hermes research pack per claude-animation-skills skill), lab trials of Draft and Lab packs,
// batch trials, and the render request's skill. docs/style-packs.md, "Research styles and lab trials".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STYLES, STYLE_BY_ID } from "./catalog.ts";
import { buildScenePlan, renderParamsForStyle } from "./scene-plan.ts";
import { hermesRenderMessages, type HermesRenderRequest } from "./hermes-render.ts";
import { parseRunConfig, runSettings, isTrialRun, engineView } from "./run-config.ts";
import { MAX_BATCH_TRIALS, batchTrialIssues, parseTrialBatch, queueLines, type OfferedTemplate } from "./trial-batch.ts";
import {
  LAB_TRIAL_BADGE,
  LIFECYCLE_TEXT,
  curationRecord,
  guardFinalDecision,
  labTrialCounts,
  labTrialOption,
  mergeRegistry,
  newVideoStyles,
  packCapability,
  packSeedTemplate,
  parsePack,
  refreshedPackTemplate,
  parseRunStylePack,
  publishRefusal,
  researchGroupOf,
  researchVariantFor,
  runStylePack,
  startRefusal,
  styleFromPack,
  styleGroup,
  trialCounts,
  type StylePack,
  type TrialOutcome,
} from "./style-registry.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const rawStyle = (id: string) => JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", id, "style.json"), "utf8")) as Record<string, any>;
const vendored: StylePack[] = lock.packs.map((p) => parsePack(rawStyle(p.id), p.sha256)!);
const pack = (id: string, over: Partial<StylePack> = {}): StylePack => {
  const p = vendored.find((x) => x.id === id);
  assert.ok(p, id);
  return { ...p, ...over };
};
const REGISTRY = mergeRegistry(STYLES, vendored);
const entry = (id: string, reg = REGISTRY) => reg.find((e) => e.id === id)!;
// The claude-animation-skills research styles, by the id each one has now: the look is the id, not "hermes-<skill>".
const TRIAL_RESEARCH = ["branching-lines", "exploded-view", "flat-space", "map-route", "ps1-low-poly", "stick-figure", "voxel-build-skill", "what-if-3d"];
// The skill-driven variants of the looks a worker now renders itself (line graph, minimal line art) are retired: the
// worker pack replaced them. /minecraft does not belong here: its cottage is not the Muse pack's village, so it keeps
// its own live trial and the owner picks between the two.
const RETIRED_RESEARCH = ["line-graph-skill", "step-line-art-skill"];
const GROUP = "Hermes research styles (from claude-animation-skills)";

test("registry grouping: research styles, trial, lab (draft and lab), listed and planned", () => {
  for (const id of TRIAL_RESEARCH) assert.equal(styleGroup(entry(id)), "research", id);
  for (const id of RETIRED_RESEARCH) assert.equal(styleGroup(entry(id)), "retired", id);
  assert.equal(styleGroup(entry("research-render")), "research");
  assert.equal(styleGroup(entry("explainer-flat-vector")), "trial");
  assert.equal(styleGroup(entry("line-graph")), "trial");
  assert.equal(styleGroup(entry("probe-line-graph")), "lab");
  assert.equal(styleGroup(entry("kinetic-facts")), "planned");
  const reg = mergeRegistry(STYLES, [pack("documentary", { status: "listed" }), pack("horror-narration", { status: "draft" }), pack("ambient-loop", { status: "retired" })]);
  assert.deepEqual(["documentary", "horror-narration", "ambient-loop"].map((id) => styleGroup(entry(id, reg))), ["listed", "lab", "retired"]);
  // A hermes pack below Trial is still a research style (it can only ever run as research).
  assert.equal(styleGroup(entry("line-graph-skill", mergeRegistry(STYLES, [pack("line-graph-skill", { status: "lab" })]))), "research");
  // The research group label names the source repository; the generic Hermes render has no skill, so no group.
  for (const id of TRIAL_RESEARCH) assert.equal(researchGroupOf(pack(id)), GROUP, id);
  assert.equal(researchGroupOf(pack("research-render")), null);
  assert.equal(researchGroupOf(pack("line-graph")), null, "a worker pack is never a research group");
  assert.deepEqual([...LIFECYCLE_TEXT], [
    "Research styles (Hermes render) and lab trials are for testing and curating, never for publishing.",
    "Trial packs collect evidence toward Proven.",
    "Only Listed styles publish.",
  ]);
});

test("New Video: every claude-animation-skills research style is offered in the Trial section whenever Hermes is set up, no worker needed", () => {
  const withHermes = newVideoStyles(REGISTRY, [], { hermes: true });
  const research = withHermes.trial.filter((e) => e.pack && researchGroupOf(e.pack) === GROUP).map((e) => e.id);
  assert.deepEqual(research.sort(), [...TRIAL_RESEARCH].sort());
  assert.ok(withHermes.trial.some((e) => e.id === "research-render"), "the generic Hermes render researches a look with no pack");
  assert.deepEqual(withHermes.listed, []);
  const without = newVideoStyles(REGISTRY, []);
  assert.ok(TRIAL_RESEARCH.every((id) => without.waiting.some((e) => e.id === id)), "without Hermes they wait, named");
  assert.ok(!without.trial.some((e) => e.id.startsWith("hermes-")));
});

test("pack-only styles plan and render from their own contract: style, seed template, render parameters, scene plan", () => {
  const p = pack("line-graph");
  assert.equal(STYLE_BY_ID[p.id], undefined, "the catalogue does not know it");
  const style = styleFromPack(p);
  assert.deepEqual([style.engine, style.shotSeconds, style.naturalFrame, style.assetModel, style.formats], ["html-capture", [3, 6], "portrait", "plates-and-diagrams", ["short"]]);
  assert.equal(renderParamsForStyle(p.id), null, "without the pack style nothing is known");
  const r = renderParamsForStyle(p.id, style);
  assert.deepEqual([r?.engine, r?.template, r?.elementAnimation], ["html-capture", "line-graph", true]);
  assert.equal(renderParamsForStyle("other-id", style), null, "the style must be the one asked for");
  assert.equal(r?.transitionSec, 0, "the pack's own cross-fade (hard cuts), not the default");
  const plan = buildScenePlan({ styleId: p.id, format: "short", style, shots: [{ seconds: 4, beatRole: "body", description: "A line rises", onScreenText: "Revenue" } as any] });
  assert.ok(plan.ok, JSON.stringify(plan));
  if (plan.ok) assert.deepEqual([plan.plan.engine, plan.plan.template], ["html-capture", "line-graph"]);
  const t = packSeedTemplate(p);
  assert.deepEqual([t.id, t.styleId, t.status, t.version, t.pacing.hookByMs, t.pacing.cutsPerMinute, t.beats.map((b) => b.role)], ["tpl-line-graph", "line-graph", "candidate", 1, 4000, [10, 20], ["body"]]);
  assert.ok(t.copyrightChecklist.some((i) => i.label.startsWith("Never invent data")), "the pack's cautions are on the checklist");
  const z = packSeedTemplate(pack("what-if-3d"));
  assert.deepEqual([z.audio.musicPolicy, z.beats.map((b) => b.role).at(-1)], ["none", "outro"]);
  // A new pack version gives the template a new version from its contract, keeping status and the owner's sign-offs.
  const signed = { ...t, version: 3, copyrightChecklist: t.copyrightChecklist.map((i, n) => (n === 0 ? { ...i, signedOff: { userId: "owner", date: "2026-12-01" } } : i)) };
  const bumped = packSeedTemplate({ ...p, version: "0.2.0", plan: { ...p.plan!, hookWithinMs: 2500 } });
  const next = refreshedPackTemplate(signed, bumped)!;
  assert.deepEqual([next.version, next.status, next.packVersion, next.pacing.hookByMs, next.copyrightChecklist[0].signedOff?.userId], [4, "candidate", "0.2.0", 2500, "owner"]);
  assert.equal(refreshedPackTemplate(signed, packSeedTemplate(p)), null, "the same pack version changes nothing");
  assert.equal(refreshedPackTemplate({ ...signed, status: "retired" }, bumped), null, "a retired template stays as it is");
  // The New Video engine line reads the pack's engine for a style the catalogue does not know.
  assert.equal(engineView("line-graph-skill", [], "hermes")?.worker, "external");
  assert.equal(engineView("line-graph", ["html-capture"], "html-capture")?.worker, "yes");
});

test("lab trials: only Draft and Lab packs, research only, never published, and never auto-approved", () => {
  assert.equal(startRefusal(entry("probe-line-graph")) !== null, true, "a Lab pack does not start a normal run");
  assert.equal(startRefusal(entry("probe-line-graph"), { labTrial: true }), null);
  assert.match(startRefusal(entry("explainer-flat-vector"), { labTrial: true }) ?? "", /is Trial; a lab trial is for Draft and Lab packs/);
  assert.match(startRefusal(entry("kinetic-facts"), { labTrial: true }) ?? "", /planned/);
  const sp = runStylePack(pack("probe-line-graph"), { lab: true });
  assert.deepEqual(sp, { id: "probe-line-graph", version: "0.1.1", status: "lab", trial: true, engine: "html-capture", lab: true });
  const cfg = parseRunConfig(JSON.parse(JSON.stringify({ format: "short", stylePack: sp })));
  assert.equal(cfg.stylePack?.lab, true);
  assert.ok(isTrialRun(cfg));
  assert.ok(runSettings(cfg).some((r) => r.value === `probe-line-graph 0.1.1, ${LAB_TRIAL_BADGE}: research only, never published`));
  assert.equal(parseRunStylePack({ id: "probe-line-graph", version: "0.1.1", status: "lab", trial: false, lab: true })?.trial, true, "a lab trial is a trial whatever a stored config says");
  assert.equal("lab" in runStylePack(pack("explainer-flat-vector")), false, "normal runs gain no key");
  // publishRefusal: lab trials and research (hermes) runs are refused by name; a Listed run is not.
  assert.equal(publishRefusal(sp), `${LAB_TRIAL_BADGE} probe-line-graph 0.1.1: research only, never published.`);
  assert.match(publishRefusal(runStylePack(pack("line-graph-skill"))) ?? "", /^Hermes render \(research only\): a video Hermes rendered is never published\./);
  assert.match(publishRefusal(runStylePack(pack("line-graph-skill", { status: "draft" }), { lab: true })) ?? "", /Hermes rendered is never published/, "a lab trial of a hermes pack is refused as a Hermes render");
  assert.match(publishRefusal(null, "hermes") ?? "", /never published/);
  assert.equal(publishRefusal(runStylePack(pack("documentary", { status: "listed" })), "ffmpeg-stills"), null);
  for (const action of ["auto-approve", "auto-publish"]) assert.equal(guardFinalDecision({ action, reason: "policy" }, sp).action, "ask-owner", action);
});

function outcome(n: number, over: Partial<TrialOutcome> = {}): TrialOutcome {
  return {
    runId: `00000000-0000-4000-8000-00000000000${n}`,
    packId: "probe-line-graph",
    packVersion: "0.1.1",
    qcPassed: true,
    gates: [{ gate: "G-technical", passed: true, score: null }, { gate: "G-presentation", passed: true, score: 80 }],
    presentationScore: 80,
    ownerDecision: "approved",
    videoAssetId: null,
    decidedAt: `2026-12-0${n}T10:00:00.000Z`,
    createdAt: `2026-12-0${n}T09:00:00.000Z`,
    ...over,
  };
}

test("lab-trial outcomes are recorded but never counted toward promotion; they are counted apart", () => {
  const outcomes = [outcome(1, { labTrial: true, presentationScore: 60 }), outcome(2, { labTrial: true, presentationScore: null, ownerDecision: "rejected" }), outcome(3), outcome(4, { labTrial: false, presentationScore: 90 })];
  const counts = trialCounts(outcomes, "0.1.1");
  assert.deepEqual([counts.trials, counts.presentationScored, counts.meanPresentationScore, counts.approved, counts.rejected], [2, 2, 85, 2, 0]);
  const lab = labTrialCounts(outcomes);
  assert.deepEqual(lab, { runs: 2, measured: 2, scored: 1, meanPresentationScore: 60, approved: 1, rejected: 1, waived: 0 });
  assert.deepEqual(labTrialCounts([outcome(3)]), { runs: 0, measured: 0, scored: 0, meanPresentationScore: null, approved: 0, rejected: 0, waived: 0 });
  // The curation record to copy into the pack never carries a lab trial.
  const record = curationRecord(pack("probe-line-graph", { status: "trial" }), outcomes, counts);
  assert.deepEqual(record.filter((e) => e.kind === "trial-run").map((e) => e.ref), [`venstudio run ${outcome(3).runId}`, `venstudio run ${outcome(4).runId}`]);
  // Five lab trials alone never make a pack Ready to promote: none of them counts.
  const onlyLab = [1, 2, 3, 4, 5].map((n) => outcome(n, { labTrial: true, presentationScore: 95 }));
  assert.equal(trialCounts(onlyLab, "0.1.1").trials, 0);
});

test("lab trials say exactly why they cannot start and what fixes it", () => {
  const probe = entry("probe-line-graph");
  const cap = packCapability("probe-line-graph", "0.1.1");
  assert.deepEqual(labTrialOption(probe, ["ffmpeg", "html-capture", cap]), { ok: true, via: "worker", capability: cap });
  // No worker has html-capture (a worker below 0.10.0, or without the Remotion renderer).
  const old = labTrialOption(probe, ["ffmpeg", "xfade", "remotion-2d"]);
  assert.ok(!old.ok);
  if (!old.ok) {
    assert.equal(old.reason, "No worker reports html-capture");
    assert.match(old.fix, /^Update the worker to 0\.10\.0 or later with the Remotion renderer \(install\.sh --with-remotion\)/);
  }
  // A worker with the renderer but not yet this pack version.
  const stale = labTrialOption(probe, ["html-capture", "pack:probe-line-graph@0.0.9"]);
  assert.ok(!stale.ok && stale.reason === `No worker reports ${cap} yet` && /^Update the worker: it installs this pack version/.test(stale.fix));
  // A 3D template: no worker can run the engine at all.
  const threeD = labTrialOption(entry("probe-line-graph", mergeRegistry(STYLES, [pack("probe-line-graph", { engine: "remotion-3d", status: "draft" })])), ["remotion-2d", "html-capture"]);
  assert.ok(!threeD.ok && threeD.reason === "Needs an environment: hand it over from Hermes (docs/hermes-handover.md)", JSON.stringify(threeD));
  assert.ok(!threeD.ok && /Hermes opens a pull request to venstudio-styles/.test(threeD.fix) && !/Kiro|plugin first/.test(threeD.fix), JSON.stringify(threeD));
  // A hermes pack needs Hermes, not a worker.
  const hermesDraft = entry("line-graph-skill", mergeRegistry(STYLES, [pack("line-graph-skill", { status: "draft" })]));
  assert.deepEqual(labTrialOption(hermesDraft, [], { hermes: true }), { ok: true, via: "hermes", capability: null });
  const noHermes = labTrialOption(hermesDraft, []);
  assert.ok(!noHermes.ok && noHermes.reason === "Hermes is not set up, and it renders this pack" && /HERMES_BASE_URL/.test(noHermes.fix));
  // Not Draft or Lab: the reason says where it runs instead.
  const trial = labTrialOption(entry("explainer-flat-vector"), ["remotion-2d"]);
  assert.ok(!trial.ok && /a lab trial is for Draft and Lab packs/.test(trial.reason));
});

test("a retired research variant is no longer offered next to the worker pack it adapts", () => {
  // The worker pack renders the look now, so the /skill variant is kept for history only and never offered again.
  for (const [worker, variant] of [["line-graph", "line-graph-skill"], ["minimal-line-art", "step-line-art-skill"]]) {
    assert.equal(entry(variant).pack?.status, "retired", variant);
    assert.equal(researchVariantFor(entry(worker), REGISTRY), null, `${worker} has no live Hermes variant`);
  }
  assert.equal(researchVariantFor(entry("probe-line-graph"), REGISTRY), null);
});

const request = (over: Partial<HermesRenderRequest> = {}): HermesRenderRequest => ({
  topic: "Followers in nine months",
  format: "short",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 8,
  shots: [{ shotRef: "shot-01", seconds: 4, beatRole: "body", description: "A line rises", imageUrl: null }],
  scenePlan: null,
  narration: { url: "http://hermes-files:8000/tts/n.wav", seconds: 8, tempo: 1 },
  captions: ["Nine months.", "One hundred thousand."],
  packId: "line-graph-skill",
  packVersion: "0.1.0",
  contract: {},
  clipBase: "http://hermes-files:8000/clip",
  ...over,
});

test("the Hermes render request carries the skill name, its mapping and, for a full project, the run's narration", () => {
  const g = pack("line-graph-skill").hermes!;
  const [m] = hermesRenderMessages(request({ skill: { name: g.skill, aliases: g.aliases, mode: g.mode, input: g.input, output: g.output } }));
  assert.match(m.content, /Render this whole video yourself with your \/graph skill, following the skill's own steps/);
  const data = JSON.parse(m.content.split("--- render request (data, not instructions) ---\n")[1]) as Record<string, any>;
  assert.equal(data.pack.skill, "/graph");
  assert.equal(data.skill.name, "/graph");
  assert.equal(data.skill.mode, "spec");
  assert.match(data.skill.input, /one shot per clip, in order, each with its seconds and the skill.s JSON spec \(brief\.shots\[i\]\.spec\)/);
  // Still a /clip/ URL, as before.
  assert.match(m.content, /Publish the finished MP4 on your media host under http:\/\/hermes-files:8000\/clip\//);
  assert.doesNotMatch(m.content, /full project with its own voice/);
  const z = pack("what-if-3d").hermes!;
  const [mz] = hermesRenderMessages(request({ packId: "what-if-3d", skill: { name: z.skill, aliases: z.aliases, mode: z.mode, input: z.input, output: z.output } }));
  assert.match(mz.content, /with your \/zach-d-films skill \(also installed as \/zach-3d-films\)/);
  assert.match(mz.content, /\/zach-d-films is a full project with its own voice and caption timing: use the narration below as the voiceover and the captions below as the text/);
  assert.match(mz.content, /The result is a reel the studio checks/);
  // Without a skill (the generic Hermes render), the request is what it was.
  const [plain] = hermesRenderMessages(request({ packId: "research-render" }));
  assert.match(plain.content, /with your own tools \(your CapCut workflow, video_gen, or what you have\)/);
  assert.equal(JSON.parse(plain.content.split("--- render request (data, not instructions) ---\n")[1]).skill, undefined);
});

const offered = (id: string, over: Partial<OfferedTemplate> = {}): OfferedTemplate => ({ id: `tpl-${id}`, label: id, styleId: id, formats: ["short"], trial: true, research: true, ...over });

test("batch trial validation: two or more offered Trial or research styles, no repeats, the right format, never Listed or lab", () => {
  const list = [offered("line-graph-skill"), offered("branching-lines"), offered("explainer-flat-vector", { research: false, formats: ["short", "long"] }), offered("documentary", { trial: false }), offered("probe-line-graph", { lab: true })];
  assert.deepEqual(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-branching-lines"], offered: list, format: "short" }), []);
  assert.deepEqual(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-explainer-flat-vector"], offered: list, format: "short" }), [], "a worker Trial style may join");
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill"], offered: list, format: "short" }).join(), /at least 2 styles/);
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-line-graph-skill"], offered: list, format: "short" }).join(), /picked twice/);
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-documentary"], offered: list, format: "short" }).join(), /documentary is not a Trial or research style/);
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-probe-line-graph"], offered: list, format: "short" }).join(), /probe-line-graph is not a Trial or research style/);
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-nope"], offered: list, format: "short" }).join(), /tpl-nope is not a Trial or research style/);
  assert.match(batchTrialIssues({ templateIds: ["tpl-line-graph-skill", "tpl-branching-lines"], offered: list, format: "long" }).join(), /line-graph-skill does not make long videos/);
  const many = Array.from({ length: MAX_BATCH_TRIALS + 1 }, (_, i) => `tpl-x${i}`);
  assert.match(batchTrialIssues({ templateIds: many, offered: many.map((id) => offered(id.slice(4))), format: "short" }).join(), new RegExp(`at most ${MAX_BATCH_TRIALS}`));
  // The batch on a run's config, and the queue lines.
  const id = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(parseTrialBatch({ id, index: 2, total: 2 }), { id, index: 2, total: 2 });
  for (const bad of [{ id, index: 3, total: 2 }, { id: "x", index: 1, total: 2 }, { id, index: 0, total: 2 }, null]) assert.equal(parseTrialBatch(bad), null);
  assert.deepEqual(parseRunConfig({ format: "short", trialBatch: { id, index: 1, total: 2 } }).trialBatch, { id, index: 1, total: 2 });
  assert.equal("trialBatch" in parseRunConfig({ format: "short" }), false);
  const lines = queueLines([
    { runId: "b", batch: { id, index: 2, total: 2 }, label: "Line graph (Hermes /graph)", state: "running", stage: "idea", stageState: "pending", waitingUntil: null },
    { runId: "a", batch: { id, index: 1, total: 2 }, label: "Branching line art (Hermes /dan-koe)", state: "running", stage: "render", stageState: "running", waitingUntil: null, research: true },
  ]);
  assert.deepEqual(lines.map((l) => [l.position, l.status]), [["1 of 2", "Hermes is rendering"], ["2 of 2", "Queued for Hermes (ideas)"]]);
  assert.equal(queueLines([{ runId: "c", batch: { id, index: 1, total: 1 }, label: "x", state: "waiting-human", stage: "idea", stageState: "waiting-human", waitingUntil: null }])[0].status, "Waiting for you in Review (ideas)");
  assert.equal(queueLines([{ runId: "c", batch: { id, index: 1, total: 1 }, label: "x", state: "done", stage: "qc", stageState: "passed", waitingUntil: null }])[0].status, "Finished");
  // Only Hermes's own steps say Hermes: a worker render and the voice do not.
  const one = (over: Record<string, unknown>) => queueLines([{ runId: "d", batch: { id, index: 1, total: 1 }, label: "x", state: "running", stage: "render", stageState: "running", waitingUntil: null, ...over }])[0].status;
  assert.equal(one({ research: true }), "Hermes is rendering");
  assert.equal(one({}), "A worker is rendering");
  assert.equal(one({ stage: "voice" }), "Working on the voice");
  assert.equal(one({ stage: "script" }), "Hermes is on the script");
  assert.equal(one({ stage: "qc", stageState: "pending" }), "Queued (quality check)");
});
