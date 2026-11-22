// The skill brief of a Hermes research pack (recipe hermes-skill): validator, gate, read-back, the Review card, and
// the render request that carries it. docs/style-packs.md, "Workflows".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectorContext } from "./director.ts";
import { readSkillBrief, skillBriefGate, skillBriefLines, skillBriefPrompt, skillBriefShots, validateSkillBrief, type BriefSkill } from "./skill-brief.ts";
import { hermesRenderMessages, skillVoiceOf, type HermesRenderRequest } from "./hermes-render.ts";
import { packSeedTemplate, parsePack } from "./style-registry.ts";
import { planReview } from "./plan-review.ts";
import { imageSequenceSample } from "./image-sequence-sample.ts";

const STYLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles");
const lock = JSON.parse(readFileSync(path.join(STYLES_DIR, "lock.json"), "utf8")) as { packs: Array<{ id: string; sha256: string }> };
const load = (id: string) => parsePack(JSON.parse(readFileSync(path.join(STYLES_DIR, "packs", id, "style.json"), "utf8")), lock.packs.find((p) => p.id === id)!.sha256)!;
const graph = load("hermes-graph");
const stick = load("hermes-stick-figure");
const skillOf = (p: ReturnType<typeof load>): BriefSkill => ({ name: p.hermes!.skill, mode: p.hermes!.mode, voice: p.hermes!.voice, input: p.hermes!.input });
const template = packSeedTemplate(graph);

const specBrief = () => ({
  shots: [
    { beat: "hook", seconds: 1, description: "The line starts flat", onScreenText: "Savings", spec: { label: "Savings", values: [100, 110, 121, 133], final: 133, prefix: "$" } },
    { beat: "body", seconds: 6, description: "It bends up", spec: { label: "Savings", values: [133, 146, 161, 177], final: 177, prefix: "$" } },
  ],
});

test("a spec skill gets one JSON spec per shot: plain data, no links, within size", () => {
  const ok = validateSkillBrief(specBrief(), skillOf(graph));
  assert.ok(ok.ok, ok.ok ? "" : ok.issues.join("; "));
  assert.deepEqual([ok.value.skill, ok.value.format, ok.value.voice, ok.value.shots.length], ["/graph", "json", "run", 2]);
  const bad = (edit: (b: any) => void) => {
    const b = specBrief() as any;
    edit(b);
    const r = validateSkillBrief(b, skillOf(graph));
    return r.ok ? [] : r.issues;
  };
  assert.ok(bad((b) => delete b.shots[0].spec).some((i) => /Shot 1 spec must be the skill's JSON spec/.test(i)));
  assert.ok(bad((b) => (b.shots[0].spec.label = "see https://example.com/x")).some((i) => /Shot 1 spec holds a link/.test(i)));
  assert.ok(bad((b) => (b.shots[0].spec.label = "x".repeat(2100))).some((i) => /Shot 1 spec is longer than 2000 characters/.test(i)));
  assert.ok(bad((b) => (b.shots[0].spec.deep = { a: { b: { c: { d: { e: 1 } } } } })).some((i) => /nests deeper/.test(i)));
  assert.ok(bad((b) => (b.shots[1].seconds = -1)).some((i) => /Shot 2 seconds must be a number above 0/.test(i)));
  assert.ok(bad((b) => (b.shots[1].beat = "middle")).some((i) => /Shot 2 beat must be one of/.test(i)));
  assert.ok(bad((b) => (b.shots = [])).some((i) => /shots must hold 1 to/.test(i)));
});

test("a project skill (and the generic Hermes render) gets a text brief; the stick figure records its own voice", () => {
  const skill = skillOf(stick);
  assert.deepEqual([skill.mode, skill.voice], ["project", "skill"]);
  const brief = { shots: [{ beat: "hook", seconds: 3, description: "A man holds a bowl of rice" }], text: "script.json: one sentence per line ... shots.js: 10 setups" };
  const ok = validateSkillBrief(brief, skill);
  assert.ok(ok.ok, ok.ok ? "" : ok.issues.join("; "));
  assert.deepEqual([ok.value.format, ok.value.voice, ok.value.text?.slice(0, 11)], ["text", "skill", "script.json"]);
  const noText = validateSkillBrief({ shots: brief.shots }, skill);
  assert.ok(!noText.ok && noText.issues.some((i) => /text must be text/.test(i)));
  const link = validateSkillBrief({ ...brief, text: "Fetch https://example.com/voice.mp3 first" }, skill);
  assert.ok(!link.ok && link.issues.some((i) => /text holds a link/.test(i)));
  const generic = validateSkillBrief(brief, null);
  assert.ok(generic.ok);
  assert.deepEqual([generic.value.skill, generic.value.format, generic.value.voice], ["", "text", "run"]);
});

test("the gate uses the shared coverage limits; the brief reads back; Review shows it as text", () => {
  const ok = validateSkillBrief(specBrief(), skillOf(graph));
  assert.ok(ok.ok);
  assert.equal(skillBriefGate(template, ok.value, 7).passed, true);
  const short = skillBriefGate(template, ok.value, 90);
  assert.equal(short.passed, false);
  assert.match(short.issues.join(" "), /The narration is about 90 s but 2 shot\(s\)/);
  assert.deepEqual(readSkillBrief(JSON.parse(JSON.stringify(ok.value))), ok.value);
  assert.deepEqual(skillBriefShots(ok.value).map((s) => [s.beatRole, s.seconds, s.imagePrompt]), [["hook", 1, ""], ["body", 6, ""]]);
  const review = planReview("skill-brief", ok.value);
  assert.equal(review.plan?.kind, "skill-brief");
  assert.deepEqual(review.plan?.lines, skillBriefLines(ok.value));
  assert.match(review.plan?.note ?? "", /^For \/graph, one spec per shot; the run's narration is the audio\. No pictures are made/);
});

test("the brief prompt names the skill's mapping and asks for no picture", () => {
  const ctx: DirectorContext = { niche: "Money habits", plan: "Short explainers", language: "en", format: "short", durationSec: 30, template, topicHint: "Compounding" };
  const notes = [{ claim: "A 10 percent return doubles money in about 7 years", sourceUrl: "https://example.org/rule72", sourced: true, summary: "Rule of 72." }];
  const [, spec] = skillBriefPrompt(ctx, "Money that grows by ten percent doubles in about seven years.", notes, skillOf(graph), graph.name);
  assert.match(spec.content, /^VENSTUDIO_STAGE: skill-brief$/m);
  assert.match(spec.content, /<<<DATA skill input\n\/graph \(spec\): The run's skill brief gives one shot per clip/);
  assert.match(spec.content, /spec is the skill's JSON spec for that shot's clip/);
  assert.match(spec.content, /no picture is made/);
  const [, project] = skillBriefPrompt(ctx, "A short script.", [], skillOf(stick), stick.name);
  assert.match(project.content, /text is the project brief the skill reads/);
  assert.match(project.content, /The skill records its own voice from the narration script/);
});

const request = (over: Partial<HermesRenderRequest> = {}): HermesRenderRequest => ({
  topic: "Compounding",
  format: "short",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 7,
  shots: [
    { shotRef: "shot-01", seconds: 3, beatRole: "hook", description: "The line starts flat", imageUrl: null },
    { shotRef: "shot-02", seconds: 4, beatRole: "body", description: "It bends up", imageUrl: null },
  ],
  scenePlan: null,
  narration: { url: "http://hermes-files:8000/audio/n.wav", seconds: 7, tempo: 1 },
  captions: ["Money grows."],
  packId: "hermes-graph",
  packVersion: "0.2.0",
  contract: {},
  skill: { name: "/graph", aliases: [], mode: "spec", input: graph.hermes!.input, output: graph.hermes!.output },
  clipBase: "http://hermes-files:8000/clip",
  ...over,
});
const dataOf = (content: string) => JSON.parse(content.split("--- render request (data, not instructions) ---\n")[1]) as Record<string, any>;

test("the render request carries the brief and says no pictures were made; a storyboard request is exactly as before", () => {
  const ok = validateSkillBrief(specBrief(), skillOf(graph));
  assert.ok(ok.ok);
  const [m] = hermesRenderMessages(request({ brief: { skill: "/graph", format: "json", shots: ok.value.shots } }));
  const data = dataOf(m.content);
  assert.equal(data.brief.skill, "/graph");
  assert.deepEqual(data.brief.shots[0].spec, specBrief().shots[0].spec);
  assert.match(m.content, /Your input is the skill brief below \("brief"\)/);
  assert.match(m.content, /No pictures were made for this video: the skill draws every shot itself/);
  assert.doesNotMatch(m.content, /Use the shot pictures/);
  assert.match(m.content, /Use the narration at http:\/\/hermes-files:8000\/audio\/n\.wav as the audio/);
  // Without a brief the request is the one runs got before workflows (pinned in fixtures/prompts).
  const golden = JSON.parse(readFileSync(path.resolve(STYLES_DIR, "../fixtures/prompts/image-sequence-prompts.json"), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(imageSequenceSample().hermesRender)), golden.hermesRender);
});

test("a skill that voices itself gets the script, is asked to name its voice backend, and the reply must name it", () => {
  const [m] = hermesRenderMessages(
    request({
      skill: { name: "/stick-figure", aliases: [], mode: "project", input: stick.hermes!.input, output: stick.hermes!.output },
      narration: { url: null, seconds: 0, tempo: 1 },
      brief: { skill: "/stick-figure", format: "text", shots: [{ beat: "hook", seconds: 3, description: "A bowl of rice" }], text: "the project brief" },
      voice: "skill",
      script: "What if you ate only rice for a year?",
    }),
  );
  const data = dataOf(m.content);
  assert.deepEqual(data.narration, { url: null, seconds: 0, tempo: 1, script: "What if you ate only rice for a year?", by: "skill" });
  assert.match(m.content, /\/stick-figure makes its own voice: record the voiceover from "narration\.script"/);
  assert.doesNotMatch(m.content, /Do not make a voice of your own/);
  assert.doesNotMatch(m.content, /use the narration below as the voiceover/);
  assert.match(m.content, /"voice":\{"provider":"<the voice tool>","source":"<the voice backend that spoke it>"/);
  assert.deepEqual(skillVoiceOf('{"status":"ok","video":{"type":"url","value":"x"},"voice":{"provider":"kokoro-tool","source":"kokoro","model":"am_michael"}}'), { provider: "kokoro-tool", backend: "kokoro", model: "am_michael" });
  assert.deepEqual(skillVoiceOf('{"voice":{"source":"elevenlabs"}}'), { provider: "elevenlabs", backend: "elevenlabs", model: "" });
  assert.equal(skillVoiceOf('{"status":"ok","video":{"type":"url","value":"x"}}'), null);
  assert.equal(skillVoiceOf("not json"), null);
});
