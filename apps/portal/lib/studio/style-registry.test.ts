import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENGINES, STYLES, STYLE_BY_ID } from "./catalog.ts";
import { ELEMENT_KINDS } from "./director.ts";
import { seedTemplates, signOff, type Template } from "./templates.ts";
import { renderParamsForStyle } from "./scene-plan.ts";
import { PUBLISH_GATES } from "./qc.ts";
import { MOTION_TOKENS } from "./render-engine.ts";
import { parseRunConfig, isTrialRun, runSettings } from "./run-config.ts";
import { packWaitNote, renderJobCapability } from "./render-gate.ts";
import { ownerPresentationGate, parseRubric, presentationRefusal } from "./presentation.ts";
import {
  HERMES_RENDER_LABEL,
  PACK_CAPABILITY_RE,
  availabilityOf,
  curationRecord,
  mergeRegistry,
  newVideoStyles,
  ownerDecisionOf,
  packCapability,
  packPromotionIssues,
  parsePack,
  guardFinalDecision,
  parseRunStylePack,
  publishRefusal,
  qcPartOf,
  runStylePack,
  startRefusal,
  trialCounts,
  type StylePack,
  type TrialOutcome,
  labTrialCounts,
} from "./style-registry.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const rawStyle = (id: string) => JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", id, "style.json"), "utf8")) as Record<string, any>;
const vendored: StylePack[] = lock.packs.map((p) => parsePack(rawStyle(p.id), p.sha256)!);

const STILLS = ["documentary-stills", "mystery-narration", "horror-story", "ambient-loop", "travel-documentary", "story-read-aloud"];
const PACK_IDS = ["explainer-flat-vector", ...STILLS];

function pack(id: string, over: Partial<StylePack> = {}): StylePack {
  const base = vendored.find((p) => p.id === id);
  assert.ok(base, id);
  return { ...base, ...over };
}

const RESEARCH_SKILLS = ["breakdown", "dan-koe", "graph", "kurzgesagt", "low-poly", "map-route", "minecraft", "minimalistic-graphics", "stick-figure", "zach-d-films"];
const RESEARCH_IDS = RESEARCH_SKILLS.map((s) => `hermes-${s}`);

test("the vendored packs: the explainer and the six stills styles (Trial 1.0.1), the html-capture probe (Lab), the two claude-animation-skills adaptations (Trial 0.1.2), the Hermes research pack and one Hermes research pack per claude-animation-skills skill (Trial)", () => {
  assert.deepEqual(vendored.map((p) => p.id).sort(), [...PACK_IDS, "hermes-research-explainer", "probe-line-graph", "animated-line-graph", "minimal-line-art", "hermes-designed-explainer", "three-low-poly", ...RESEARCH_IDS].sort());
  const command = pack("three-low-poly");
  assert.deepEqual([command.status, command.engine, command.minWorkerVersion, command.composition, command.environment?.id, command.workflow?.recipe], ["draft", "command", "0.12.0", null, "three-svg", "image-sequence"]);
  const designed = pack("hermes-designed-explainer");
  assert.deepEqual([designed.status, designed.engine, designed.minWorkerVersion, designed.drawsCaptions, designed.workflow?.recipe], ["trial", "html-capture", "0.11.0", false, "html-design"]);
  assert.ok(designed.design && designed.design.palette.length >= 2 && designed.design.brief.length > 0, "the design brief is read");
  for (const id of ["animated-line-graph", "minimal-line-art"]) {
    const a = pack(id);
    assert.deepEqual([a.status, a.version, a.engine, a.minWorkerVersion, a.composition], ["trial", "0.1.2", "html-capture", "0.10.0", null], id);
    assert.ok(a.curation.some((c) => c.kind === "ci-render" && c.result === "pass" && c.ref.includes("actions/runs/44981421800")), `${id} cites the venstudio CI render`);
    assert.ok(a.provenance.some((s) => s.type === "repo" && s.ref.includes("artemnovitckii/claude-animation-skills@86f70106c9ae") && s.licence.startsWith("MIT")), id);
  }
  assert.deepEqual([pack("animated-line-graph").drawsCaptions, pack("minimal-line-art").drawsCaptions], [false, true]);
  const probe = pack("probe-line-graph");
  assert.deepEqual([probe.status, probe.engine, probe.minWorkerVersion, probe.composition, probe.drawsCaptions], ["lab", "html-capture", "0.10.0", null, false]);
  const hermes = pack("hermes-research-explainer");
  assert.deepEqual([hermes.status, hermes.engine, hermes.composition, hermes.drawsCaptions, hermes.hermes], ["trial", "hermes", null, null, null]);
  for (const skill of RESEARCH_SKILLS) {
    const r = pack(`hermes-${skill}`);
    assert.deepEqual([r.status, r.engine, r.hermes?.skill, r.hermes?.mode], ["trial", "hermes", `/${skill}`, skill === "stick-figure" || skill === "zach-d-films" ? "project" : "spec"], skill);
    assert.ok(r.provenance.some((s) => s.type === "skill" && s.ref.includes("artemnovitckii/claude-animation-skills@86f70106c9ae") && s.licence.startsWith("MIT")), skill);
  }
  assert.deepEqual(pack("hermes-zach-d-films").hermes?.aliases, ["/zach-3d-films"]);
  for (const p of vendored.filter((x) => PACK_IDS.includes(x.id))) {
    assert.equal(p.status, "trial", p.id);
    assert.equal(p.version, "1.0.1", p.id);
    assert.equal(p.minWorkerVersion, "0.9.0", p.id);
  }
  assert.equal(pack("explainer-flat-vector").engine, "remotion-2d");
  assert.equal(pack("explainer-flat-vector").composition, "flat-vector-explainer");
  for (const id of STILLS) assert.equal(pack(id).engine, "ffmpeg-stills", id);
  for (const id of STILLS) assert.equal(pack(id).composition, null, id);
});

test("each pack carries the parameters the portal used before packs, so migrating changed no behaviour", () => {
  const templates = seedTemplates();
  // The Hermes research pack (Phase 2) has its catalogue entry and seed template too, so the same check holds.
  for (const id of [...PACK_IDS, "hermes-research-explainer"]) {
    const raw = rawStyle(id);
    const s = STYLE_BY_ID[id];
    const t = templates.find((x) => x.styleId === id)!;
    const r = renderParamsForStyle(id)!;
    const c = raw.contract;
    assert.equal(raw.name, s.label, id);
    assert.equal(raw.description, s.description, id);
    assert.equal(raw.family, s.family, id);
    assert.deepEqual(raw.formats.supported, s.formats, id);
    assert.equal(raw.formats.naturalFrame, r.naturalFrame, id);
    assert.equal(raw.renderer.engine, s.engine, id);
    assert.deepEqual(c.pacing.shotSeconds, s.shotSeconds, id);
    assert.equal(c.pacing.hookWithinMs, t.pacing.hookByMs, id);
    assert.deepEqual(c.pacing.cutsPerMinute, t.pacing.cutsPerMinute, id);
    assert.equal(c.pacing.transitionSec, r.transitionSec, id);
    assert.equal(c.onScreen.elementAnimation, r.elementAnimation, id);
    assert.deepEqual({ required: c.captions.required, safeAreaPct: c.captions.safeAreaPct }, t.captions, id);
    assert.deepEqual(c.audio, { narrated: t.audio.narrated, targetLufs: t.audio.targetLufs, maxTruePeakDb: t.audio.maxTruePeakDb, musicPolicy: t.audio.musicPolicy }, id);
    assert.equal(c.assets.model, r.assetModel, id);
    assert.deepEqual(c.assets.kinds, s.assetKinds, id);
    assert.deepEqual({ allowedSources: c.assets.allowedSources, forbidKinds: c.assets.forbidKinds }, t.assetPolicy, id);
    assert.equal(raw.portal.qc.minPresentationScore, t.qc.minPresentationScore, id);
    assert.deepEqual(raw.portal.qc.gates, PUBLISH_GATES, id);
    assert.deepEqual(raw.portal.themes, s.themes, id);
    assert.deepEqual(raw.portal.keywords, s.keywords, id);
    assert.deepEqual(raw.portal.cautions, s.cautions, id);
    assert.deepEqual(raw.portal.sources, s.sources, id);
    assert.ok(c.onScreen.motionTokens.every((m: string) => (MOTION_TOKENS as readonly string[]).includes(m)), id);
    assert.ok(c.onScreen.elements.every((k: string) => ([...ELEMENT_KINDS] as string[]).includes(k)), id);
  }
});

test("the validator's vocabularies are the portal's", async () => {
  const v = (await import(pathToFileURL(path.join(STYLES_DIR, "tools/validate.mjs")).href)) as Record<string, string[]>;
  assert.deepEqual(v.ENGINES, Object.keys(ENGINES));
  assert.deepEqual(v.MOTION_TOKENS, [...MOTION_TOKENS]);
  assert.deepEqual(v.ELEMENT_KINDS, ([...ELEMENT_KINDS] as string[]));
  // Every gate the qc_reports table allows (migration 0007), the publish gates among them.
  assert.deepEqual([...v.QC_GATES].sort(), ["G-assets", "G-claims", "G-compliance", "G-presentation", "G-script", "G-storyboard", "G-technical", "G-voice"]);
  for (const g of PUBLISH_GATES) assert.ok(v.QC_GATES.includes(g), g);
});

test("mergeRegistry: packs override their catalogue entry; the other catalogue styles are planned; unknown packs follow", () => {
  const extra = pack("documentary-stills", { id: "brand-new-look", name: "Brand new look" });
  const reg = mergeRegistry(STYLES, [...vendored, extra]);
  assert.equal(reg.length, STYLES.length + 6 + RESEARCH_IDS.length);
  assert.deepEqual(reg.slice(0, STYLES.length).map((e) => e.id), STYLES.map((s) => s.id), "catalogue order is kept");
  // Packs the catalogue does not know follow, by id: the html-capture probe is one of them.
  assert.deepEqual(reg.slice(STYLES.length).map((e) => e.id), ["animated-line-graph", "brand-new-look", "hermes-designed-explainer", ...RESEARCH_IDS, "minimal-line-art", "probe-line-graph", "three-low-poly"].sort());
  // Their style comes from the pack's own contract, so they plan and render like a catalogue style (never as stills).
  const graph = reg.find((e) => e.id === "animated-line-graph")!;
  assert.equal(graph.catalogued, false);
  assert.deepEqual([graph.style?.engine, graph.style?.shotSeconds, graph.style?.assetModel, graph.style?.naturalFrame], ["html-capture", [3, 6], "plates-and-diagrams", "portrait"]);
  assert.equal(reg.find((e) => e.id === "explainer-flat-vector")?.catalogued, true);
  const planned = reg.filter((e) => e.status === "planned").map((e) => e.id);
  assert.equal(planned.length, 13);
  assert.ok(planned.includes("kinetic-facts") && planned.includes("blender-3d") && planned.includes("ai-character-sketch"));
  for (const e of reg.filter((x) => x.status === "planned")) assert.equal(e.pack, null);
  const explainer = reg.find((e) => e.id === "explainer-flat-vector")!;
  assert.equal(explainer.status, "trial");
  assert.equal(explainer.pack?.version, "1.0.1");
  assert.equal(explainer.style?.id, "explainer-flat-vector", "the catalogue entry stays for keywords and cautions");
  const renamed = mergeRegistry(STYLES, [pack("horror-story", { name: "Horror, curated" })]).find((e) => e.id === "horror-story")!;
  assert.equal(renamed.label, "Horror, curated", "the pack's name wins");
});

test("New Video: Listed packs a worker reports; Trial packs in their own list; planned, draft, lab, proven and retired never", () => {
  const caps = ["echo", "ffmpeg", "xfade", "remotion-2d", packCapability("explainer-flat-vector", "1.0.1"), packCapability("documentary-stills", "1.0.1"), packCapability("horror-story", "1.0.1"), packCapability("mystery-narration", "1.0.1")];
  const packs = [
    pack("explainer-flat-vector"),
    pack("documentary-stills", { status: "listed" }),
    pack("horror-story", { status: "proven" }),
    pack("mystery-narration", { status: "draft" }),
    pack("ambient-loop", { status: "listed" }),
    pack("travel-documentary", { status: "retired" }),
    pack("story-read-aloud", { status: "lab" }),
  ];
  const offer = newVideoStyles(mergeRegistry(STYLES, packs), caps);
  assert.deepEqual(offer.listed.map((e) => e.id), ["documentary-stills"]);
  assert.deepEqual(offer.trial.map((e) => e.id), ["explainer-flat-vector"]);
  assert.deepEqual(offer.waiting.map((e) => e.id), ["ambient-loop"], "Listed, but no worker reports its pack");
  // Worker availability is per pack version: a worker with the renderer but an older pack does not count.
  const older = newVideoStyles(mergeRegistry(STYLES, [pack("explainer-flat-vector", { version: "1.1.0" })]), caps);
  assert.deepEqual(older.trial, []);
  assert.deepEqual(older.waiting.map((e) => e.id), ["explainer-flat-vector"]);
  // No worker at all: nothing is selectable, the Trial packs wait.
  const none = newVideoStyles(mergeRegistry(STYLES, vendored), []);
  assert.equal(none.listed.length + none.trial.length, 0);
  // Ten worker packs (the explainer, six stills, the two html-capture adaptations, the html-design pack) plus the eleven
  // Hermes research packs, which wait for Hermes (not a worker). The Lab probe never shows.
  assert.equal(none.waiting.length, 10 + 1 + RESEARCH_IDS.length);
  assert.ok(!none.waiting.some((e) => e.id === "probe-line-graph"));
  const avail = availabilityOf(mergeRegistry(STYLES, vendored).find((e) => e.id === "travel-documentary")!, ["ffmpeg"]);
  assert.deepEqual(avail, { renderer: true, pack: false, capability: "pack:travel-documentary@1.0.1" });
});

test("startRefusal: only Listed and Trial packs start a run", () => {
  const reg = mergeRegistry(STYLES, [pack("explainer-flat-vector"), pack("horror-story", { status: "listed" }), pack("ambient-loop", { status: "lab" })]);
  const at = (id: string) => reg.find((e) => e.id === id);
  assert.equal(startRefusal(at("explainer-flat-vector")), null);
  assert.equal(startRefusal(at("horror-story")), null);
  assert.match(startRefusal(at("ambient-loop")) ?? "", /is Lab; only Listed and Trial/);
  assert.match(startRefusal(at("kinetic-facts")) ?? "", /planned, not a style pack yet/);
  assert.match(startRefusal(undefined) ?? "", /Unknown style/);
});

test("a run started with a Trial pack is marked trial in its config, additively, and old configs read as before", () => {
  const sp = runStylePack(pack("explainer-flat-vector"));
  assert.deepEqual(sp, { id: "explainer-flat-vector", version: "1.0.1", status: "trial", trial: true, engine: "remotion-2d" });
  assert.equal(runStylePack(pack("documentary-stills", { status: "listed" })).trial, false);
  const stored = JSON.parse(JSON.stringify({ format: "short", styleId: "explainer-flat-vector", stylePack: sp }));
  const cfg = parseRunConfig(stored);
  assert.deepEqual(cfg.stylePack, sp);
  assert.ok(isTrialRun(cfg));
  assert.ok(runSettings(cfg).some((r) => r.label === "Style pack" && r.value === "explainer-flat-vector 1.0.1, Trial: research only, not for publishing"));
  const old = parseRunConfig({ format: "short", styleId: "kinetic-facts" });
  assert.equal("stylePack" in old, false, "configs from before packs gain no key");
  assert.equal(isTrialRun(old), false);
  assert.equal(parseRunStylePack({ id: "x", version: "1", status: "trial" }), null);
  assert.equal(parseRunStylePack({ id: "ab", version: "1.0.0", status: "beta" }), null);
});

test("renders of a pack are queued under its versioned capability, and wait with a note until a worker reports it", () => {
  const sp = { id: "explainer-flat-vector", version: "1.0.1" };
  assert.equal(renderJobCapability("remotion-2d", 0.5, sp), "pack:explainer-flat-vector@1.0.1");
  assert.equal(renderJobCapability("ffmpeg-stills", 0.5, { id: "documentary-stills", version: "1.0.1" }), "pack:documentary-stills@1.0.1");
  // Without a pack (runs from before packs): the engine routing as before.
  assert.equal(renderJobCapability("ffmpeg-stills", 0.5), "xfade");
  assert.equal(renderJobCapability("remotion-2d", 0.5, null), "remotion-2d");
  assert.ok(PACK_CAPABILITY_RE.test(packCapability("explainer-flat-vector", "1.0.0")));
  assert.ok(!PACK_CAPABILITY_RE.test("pack:../x@1.0.0") && !PACK_CAPABILITY_RE.test("pack:abc@latest"));
  assert.equal(packWaitNote(sp, undefined), null, "no worker reports anything yet: the job waits like any render");
  assert.equal(packWaitNote(null, ["ffmpeg"]), null);
  assert.equal(packWaitNote(sp, ["remotion-2d", "pack:explainer-flat-vector@1.0.1"]), null);
  assert.match(packWaitNote(sp, ["remotion-2d", "pack:explainer-flat-vector@0.9.0"]) ?? "", /^Waiting for a worker with the style pack explainer-flat-vector 1\.0\.1 \("pack:explainer-flat-vector@1\.0\.1"\)\..*signed updates/);
});

function outcome(n: number, over: Partial<TrialOutcome> = {}): TrialOutcome {
  return {
    runId: `00000000-0000-4000-8000-00000000000${n}`,
    packId: "explainer-flat-vector",
    packVersion: "1.0.1",
    qcPassed: true,
    gates: [{ gate: "G-technical", passed: true, score: null }, { gate: "G-presentation", passed: true, score: 85 }],
    presentationScore: 85,
    ownerDecision: "approved",
    videoAssetId: `10000000-0000-4000-8000-00000000000${n}`,
    decidedAt: `2026-12-0${n}T10:00:00.000Z`,
    createdAt: `2026-12-0${n}T09:00:00.000Z`,
    ...over,
  };
}

function signedTemplate(): Template {
  let t = seedTemplates().find((x) => x.styleId === "explainer-flat-vector")!;
  for (const item of t.copyrightChecklist) t = signOff(t, item.id, "owner", new Date("2026-12-01"));
  return t;
}

test("trial outcomes: QC part and the owner's decision", () => {
  assert.deepEqual(qcPartOf([{ gate: "G-technical", passed: false, score: null }, { gate: "G-presentation", passed: true, score: 91 }]), { qcPassed: false, presentationScore: 91 });
  assert.deepEqual(qcPartOf([]), { qcPassed: null, presentationScore: null });
  assert.equal(ownerDecisionOf("approved", false), "approved");
  assert.equal(ownerDecisionOf("rejected", false), "rejected");
  assert.equal(ownerDecisionOf("revision", false), "revised");
  assert.equal(ownerDecisionOf("open", true), "auto-approved");
  assert.equal(ownerDecisionOf(null, false), null);
});

test("curation counts against the promotion rule: 5 trials, 100% technical pass, presentation 80, no failures, owner checklist", () => {
  const p = pack("explainer-flat-vector");
  const five = [1, 2, 3, 4, 5].map((n) => outcome(n));
  const counts = trialCounts(five, "1.0.1");
  assert.equal(counts.trials, 5);
  assert.equal(counts.passRate, 1);
  assert.equal(counts.meanPresentationScore, 85);
  assert.equal(counts.approved, 5);
  assert.deepEqual(packPromotionIssues(p, signedTemplate(), counts), []);

  // Each part of the rule blocks on its own.
  assert.ok(packPromotionIssues(p, signedTemplate(), trialCounts(five.slice(0, 4), "1.0.1")).some((i) => /at least 5 trial runs \(has 4\)/.test(i)));
  const oneFail = [...five.slice(0, 4), outcome(5, { qcPassed: false, gates: [{ gate: "G-technical", passed: false, score: null }] })];
  assert.ok(packPromotionIssues(p, signedTemplate(), trialCounts(oneFail, "1.0.1")).some((i) => /pass rate is 80 percent/.test(i)));
  const unscored = [...five.slice(0, 4), outcome(5, { presentationScore: null })];
  const u = trialCounts(unscored, "1.0.1");
  assert.equal(u.meanPresentationScore, 85, "a missing score is not averaged in as 0");
  assert.ok(packPromotionIssues(p, signedTemplate(), u).some((i) => /1 of 5 trial run\(s\) have no presentation score yet/.test(i)));
  const low = five.map((o) => ({ ...o, presentationScore: 70 }));
  assert.ok(packPromotionIssues(p, signedTemplate(), trialCounts(low, "1.0.1")).some((i) => /presentation score must be at least 80 \(is 70\)/.test(i)));
  const assetFail = [...five.slice(0, 4), outcome(5, { gates: [{ gate: "G-technical", passed: true, score: null }, { gate: "G-assets", passed: false, score: null }] })];
  assert.ok(packPromotionIssues(p, signedTemplate(), trialCounts(assetFail, "1.0.1")).some((i) => /failed the assets gate/.test(i)));
  const compliance = [...five.slice(0, 4), outcome(5, { gates: [{ gate: "G-technical", passed: true, score: null }, { gate: "G-compliance", passed: false, score: null }] })];
  assert.ok(packPromotionIssues(p, signedTemplate(), trialCounts(compliance, "1.0.1")).some((i) => /failed the compliance gate/.test(i)));
  const unsigned = seedTemplates().find((x) => x.styleId === "explainer-flat-vector")!;
  assert.ok(packPromotionIssues(p, unsigned, counts).some((i) => /checklist not signed off/.test(i)));
  assert.ok(packPromotionIssues(p, null, counts).some((i) => /checklist is empty/.test(i)));
  // Only this version counts; runs whose QC has not run yet do not count.
  assert.equal(trialCounts([...five, outcome(6, { packVersion: "0.9.0" }), outcome(7, { qcPassed: null })], "1.0.1").trials, 5);
  // A pack that is not in Trial is not promoted from the portal's record.
  assert.match(packPromotionIssues(pack("explainer-flat-vector", { status: "listed" }), signedTemplate(), counts)[0], /Only a Trial pack/);
});

test("the curation record to copy: one trial-run entry per measured run and a qc summary, valid for the styles validator", async () => {
  const p = pack("explainer-flat-vector");
  const five = [3, 1, 2, 5, 4].map((n) => outcome(n));
  const record = curationRecord(p, five, trialCounts(five, "1.0.1"));
  assert.equal(record.length, 6);
  assert.deepEqual(record.slice(0, 5).map((e) => e.date), ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]);
  assert.ok(record.slice(0, 5).every((e) => e.kind === "trial-run" && e.result === "pass" && /owner decision: approved/.test(e.notes)));
  assert.equal(record[5].kind, "qc");
  assert.match(record[5].notes, /5 trials, 100% technical pass, mean presentation 85/);
  assert.ok(!record.some((e) => e.kind === "owner-review"), "the owner writes their own review entry");
  // Pasted into style.json with the owner's review, the pack validates as proven.
  const v = (await import(pathToFileURL(path.join(STYLES_DIR, "tools/validate.mjs")).href)) as { validateStyle: (s: unknown) => string[] };
  const raw = rawStyle("explainer-flat-vector");
  const proven = { ...raw, status: "proven", curation: [...raw.curation, ...record, { date: "2026-12-06", kind: "owner-review", ref: "venstudio-styles PR", result: "approved", notes: "" }] };
  assert.deepEqual(v.validateStyle(proven), []);
});

test("parsePack refuses what the portal cannot use instead of half-showing it", () => {
  const raw = rawStyle("documentary-stills");
  assert.ok(parsePack(raw, "x"));
  assert.equal(parsePack({ ...raw, format: 2 }, "x"), null);
  assert.equal(parsePack({ ...raw, status: "beta" }, "x"), null);
  assert.equal(parsePack({ ...raw, renderer: { ...raw.renderer, engine: "after-effects" } }, "x"), null);
  assert.equal(parsePack({ ...raw, version: "1.0" }, "x"), null);
  assert.equal(parsePack(null, "x"), null);
});

test("Hermes render is research only: never above Trial, always a trial run, only in the Trial section once Hermes is set up, never published", () => {
  const raw = rawStyle("hermes-research-explainer");
  assert.ok(parsePack(raw, "x"));
  for (const status of ["proven", "listed"]) assert.equal(parsePack({ ...raw, status }, "x"), null, `a hermes pack at ${status} is left out, not shown`);
  const hermes = pack("hermes-research-explainer");
  const caps = ["ffmpeg", "xfade", packCapability("explainer-flat-vector", "1.0.1")];
  const reg = mergeRegistry(STYLES, [pack("explainer-flat-vector"), hermes]);
  // Without Hermes configured it waits; with Hermes it is offered in the Trial section only. No worker report needed.
  assert.deepEqual(newVideoStyles(reg, caps).waiting.map((e) => e.id), ["hermes-research-explainer"]);
  const offer = newVideoStyles(reg, caps, { hermes: true });
  assert.deepEqual(offer.trial.map((e) => e.id), ["explainer-flat-vector", "hermes-research-explainer"]);
  assert.deepEqual(offer.listed, []);
  // Even a registry entry that claims Listed (only possible by bypassing parsePack) stays out of the main list.
  const forced = newVideoStyles(mergeRegistry(STYLES, [{ ...hermes, status: "listed" }]), [], { hermes: true });
  assert.deepEqual([forced.listed.length, forced.trial.map((e) => e.id)], [0, ["hermes-research-explainer"]]);
  assert.equal(HERMES_RENDER_LABEL, "Hermes render (research only)");
  // A run of it is a trial whatever the pack or a stored config says.
  assert.equal(runStylePack({ ...hermes, status: "listed" }).trial, true);
  assert.equal(parseRunStylePack({ id: hermes.id, version: hermes.version, status: "listed", trial: false, engine: "hermes" })?.trial, true);
  // Publishing refuses trials and anything Hermes rendered; a normal Listed run is not refused.
  assert.match(publishRefusal(runStylePack(hermes)) ?? "", /Hermes render \(research only\): a video Hermes rendered is never published/);
  assert.match(publishRefusal(null, "hermes") ?? "", /never published/);
  assert.match(publishRefusal(runStylePack(pack("explainer-flat-vector"))) ?? "", /research only, not for publishing/);
  assert.equal(publishRefusal(runStylePack(pack("documentary-stills", { status: "listed" })), "ffmpeg-stills"), null);
  assert.equal(publishRefusal(null, null), null);
  assert.equal(startRefusal(reg.find((e) => e.id === "hermes-research-explainer")), null, "a Trial hermes pack starts a run");
  assert.deepEqual(availabilityOf(reg.find((e) => e.id === "hermes-research-explainer")!, ["hermes"]), { renderer: false, pack: false, capability: null }, "a worker can never make it available");
});

test("promotion becomes reachable: five owner-scored trials at 80+ with technical passes and a signed checklist are Ready to promote", async () => {
  const p = pack("explainer-flat-vector");
  const rubric = (stars: number[]) => {
    const r = parseRubric((id) => stars[["hook", "pacing", "legibility", "polish", "audio"].indexOf(id)]);
    assert.ok(r.ok);
    return r.value;
  };
  // What the Review card stores (G-presentation from the owner's stars) is what the curation log reads back.
  const ratings = [[5, 4, 5, 4, 5], [4, 4, 5, 5, 4], [5, 5, 4, 4, 4], [4, 5, 5, 4, 5], [5, 4, 4, 5, 5]];
  const outcomes: TrialOutcome[] = ratings.map((stars, i) => {
    const g = ownerPresentationGate(rubric(stars));
    assert.ok(g.passed && (g.score ?? 0) >= 80, `rating ${i}: ${g.score}`);
    const gates = [
      { gate: "G-technical" as const, passed: true, score: 100 },
      { gate: "G-assets" as const, passed: true, score: 100 },
      { gate: "G-presentation" as const, passed: g.passed, score: g.score ?? null },
    ];
    return {
      runId: `00000000-0000-4000-8000-00000000000${i}`,
      packId: p.id,
      packVersion: p.version,
      ...qcPartOf(gates),
      gates,
      ownerDecision: "approved",
      videoAssetId: null,
      decidedAt: `2026-11-2${i}T10:00:00.000Z`,
      createdAt: `2026-11-2${i}T09:00:00.000Z`,
      ownerRubric: rubric(stars),
      hermesAdvisory: { score: 40, rubric: {}, notes: "advisory", frames: 6, at: "" },
      renderer: "remotion-2d",
    };
  });
  const counts = trialCounts(outcomes, p.version);
  assert.equal(counts.presentationScored, 5);
  assert.ok(counts.meanPresentationScore >= 80, String(counts.meanPresentationScore));
  assert.deepEqual(packPromotionIssues(p, signedTemplate(), counts), [], "Ready to promote");
  // Hermes's advisory (40 here) never counts: the mean is the owner's.
  assert.equal(Math.round(counts.meanPresentationScore), Math.round(outcomes.reduce((a, o) => a + (o.presentationScore ?? 0), 0) / 5));
  const record = curationRecord(p, outcomes, counts);
  assert.equal(record.filter((e) => e.kind === "trial-run").length, 5);
  assert.match(record[0].notes, /presentation \d+ \(owner: hook 5, pacing 4, legibility 5, visual polish 4, audio 5\)/);
  assert.match(record[0].notes, /Hermes advisory 40 \(not counted\)/);
  // The record pastes into a valid pack (the validator accepts every entry).
  const v = (await import(pathToFileURL(path.join(STYLES_DIR, "tools/validate.mjs")).href)) as { validateStyle: (s: unknown, o?: unknown) => string[] };
  const raw = rawStyle(p.id);
  assert.deepEqual(v.validateStyle({ ...raw, curation: [...raw.curation, ...record] }, { dirName: p.id }), []);
  // One unscored trial blocks it again, and is not averaged in as 0.
  const unscored = [...outcomes.slice(0, 4), { ...outcomes[4], gates: outcomes[4].gates.filter((g) => g.gate !== "G-presentation"), presentationScore: null }];
  const c2 = trialCounts(unscored, p.version);
  assert.ok(c2.meanPresentationScore >= 80);
  assert.match(packPromotionIssues(p, signedTemplate(), c2).join("\n"), /1 of 5 trial run\(s\) have no presentation score yet/);
  // On the Review card a trial cannot be decided before the score; other runs may skip it.
  assert.match(presentationRefusal({ stage: "qc", trial: true, decision: "approve", scored: false }) ?? "", /trial run: the owner scores the video/);
  assert.equal(presentationRefusal({ stage: "qc", trial: true, decision: "approve", scored: true }), null);
  assert.equal(presentationRefusal({ stage: "qc", trial: false, decision: "approve", scored: false }), null);
  assert.equal(presentationRefusal({ stage: "qc", trial: true, decision: "retry", scored: false }), null);
  assert.equal(presentationRefusal({ stage: "render", trial: true, decision: "approve", scored: false }), null);
});

test("the publishing guard: the autonomy policy never approves or publishes a trial or a Hermes render by itself", () => {
  const trial = runStylePack(pack("explainer-flat-vector"));
  const hermes = runStylePack(pack("hermes-research-explainer"));
  const listed = runStylePack(pack("documentary-stills", { status: "listed" }));
  for (const action of ["auto-approve", "auto-publish"]) {
    const d = { action, reason: "Policy allows it" };
    assert.equal(guardFinalDecision(d, trial).action, "ask-owner", action);
    assert.match(guardFinalDecision(d, hermes).reason, /Hermes rendered is never published\. The owner scores the video and decides/);
    assert.equal(guardFinalDecision(d, null, "hermes").action, "ask-owner");
    assert.equal(guardFinalDecision(d, listed).action, action, "a Listed run keeps the policy's decision");
    assert.equal(guardFinalDecision(d, null).action, action);
  }
  for (const action of ["ask-owner", "revise", "block"]) assert.equal(guardFinalDecision({ action, reason: "r" }, hermes).action, action);
});

test("a quality check the owner waived (Approve anyway) is recorded as waived and never counts as a technical pass", () => {
  const p = pack("explainer-flat-vector");
  const five = [1, 2, 3, 4, 5].map((n) => outcome(n));
  const failedTech = [{ gate: "G-technical" as const, passed: false, score: null }, { gate: "G-presentation" as const, passed: true, score: 85 }];
  const waived = outcome(5, { qcPassed: false, gates: failedTech, qcWaived: true, waivedIssues: ["A shot longer than allowed: 9.2 s, limit 6 s"] });
  const withWaived = [...five.slice(0, 4), waived];
  const counts = trialCounts(withWaived, "1.0.1");
  assert.equal(counts.trials, 5);
  assert.equal(counts.waived, 1);
  assert.equal(counts.approved, 5, "the owner's approval is still the owner's decision");
  assert.equal(counts.passRate, 0.8);
  const issues = packPromotionIssues(p, signedTemplate(), counts);
  assert.ok(issues.some((i) => /pass rate is 80 percent/.test(i)), issues.join(" | "));
  assert.ok(issues.some((i) => i === "1 of 5 trial run(s) were approved with the quality check waived; a waived check never counts as a technical pass"), issues.join(" | "));
  // Even a stored gate that says passed is not a pass once the owner waived the check.
  const odd = trialCounts([...five.slice(0, 4), outcome(5, { qcWaived: true })], "1.0.1");
  assert.equal(odd.passRate, 0.8);
  assert.equal(trialCounts(five, "1.0.1").waived, 0);
  // The curation record says so, with the issues.
  const record = curationRecord(p, withWaived, counts);
  const entry = record.find((e) => e.ref.includes(waived.runId))!;
  assert.equal(entry.result, "fail");
  assert.match(entry.notes, /quality check waived by the owner \(A shot longer than allowed: 9\.2 s, limit 6 s\)/);
  assert.doesNotMatch(entry.notes, /G-technical passed/);
  assert.match(record[record.length - 1].notes, /5 trials, 80% technical pass \(1 waived by the owner\)/);
  // Lab trials count their waivers apart.
  const lab = labTrialCounts([outcome(6, { labTrial: true, qcWaived: true, qcPassed: false, gates: failedTech })]);
  assert.equal(lab.waived, 1);
});
