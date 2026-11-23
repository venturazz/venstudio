import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MUSE_QUEUE_GIVE_UP_MIN,
  museStageJson,
  executorsText,
  isMuseThinkStage,
  messagesText,
  museStageAnswer,
  museStagePayload,
  museStagePayloadIssues,
  museOverflowApplies,
  museRenderPayload,
  MUSE_RENDER_TIMEOUT_SEC,
  museStagePoll,
  museStageRefusals,
  museThinkingExecutors,
  parseStageExecutors,
  runsOnMuse,
} from "./muse-stage.ts";
import { buildRunConfig, parseRunConfig, runSettings } from "./run-config.ts";
import { MUSE_RESULT_SCHEMA, type MuseWorkerFacts } from "./muse-task.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const WORKER: MuseWorkerFacts = { id: "w1", name: "muse-1", status: "active", jobTypes: ["render-video", "agent-task"], version: "0.16.0", lastSeenAt: ago(5) };

test("executors: only known thinking stages set to muse are kept; nothing stored means Hermes", () => {
  assert.deepEqual(parseStageExecutors(undefined), {});
  assert.deepEqual(parseStageExecutors("muse"), {});
  assert.deepEqual(parseStageExecutors([]), {});
  assert.deepEqual(parseStageExecutors({ idea: "muse", script: "hermes", storyboard: "muse", voice: "muse", qc: "muse" }), { idea: "muse", storyboard: "muse" });
  assert.deepEqual(parseStageExecutors(museThinkingExecutors()), { idea: "muse", research: "muse", script: "muse", storyboard: "muse", "scene-spec": "muse", "skill-brief": "muse", render: "muse" });
  assert.equal(runsOnMuse({ idea: "muse" }, "idea"), true);
  assert.equal(runsOnMuse({ idea: "muse" }, "script"), false);
  assert.equal(runsOnMuse(undefined, "idea"), false);
  assert.equal(runsOnMuse({ idea: "muse" }, "storyboard"), false);
  assert.equal(runsOnMuse({ render: "muse" }, "render"), true);
  assert.equal(runsOnMuse({ render: "muse" }, "qc"), false);
  assert.equal(runsOnMuse({ storyboard: "muse" }, "storyboard"), true);
  assert.equal(isMuseThinkStage("storyboard"), true);
  assert.equal(isMuseThinkStage("voice"), false);
  assert.equal(executorsText(undefined), null);
  assert.equal(executorsText({}), null);
  assert.equal(executorsText(museThinkingExecutors()), "Muse does the idea, research, script, storyboard, scene-spec, skill-brief, render");
});

test("run config: Muse thinking is stored on the run and read back; a run without it reads as before", () => {
  const req = { format: "short" as const, language: "en", themeId: "", purposes: [], subtitles: [], brief: "x" };
  const plain = buildRunConfig(req, { category: null }, { styleId: "s" });
  if (!plain.ok) throw new Error(plain.error);
  assert.equal(plain.config.executors, undefined);
  const muse = buildRunConfig({ ...req, thinkOnMuse: true }, { category: null }, { styleId: "s" });
  if (!muse.ok) throw new Error(muse.error);
  assert.deepEqual(muse.config.executors, { idea: "muse", research: "muse", script: "muse", storyboard: "muse", "scene-spec": "muse", "skill-brief": "muse", render: "muse" });
  const back = parseRunConfig(JSON.parse(JSON.stringify(muse.config)));
  assert.deepEqual(back.executors, muse.config.executors);
  assert.equal(parseRunConfig({}).executors, undefined);
  assert.ok(runSettings(back).some((r) => r.label === "Muse" && /Muse does the idea/.test(r.value)));
  assert.ok(!runSettings(parseRunConfig({})).some((r) => r.label === "Muse"));
});

test("the task for a stage: the Hermes ask as PROMPT.md, the schema as SPEC.json, result.json as the one output", () => {
  const prompt = messagesText([
    { role: "system", content: "You are the director." },
    { role: "user", content: "Give 5 ideas.\n" },
  ]);
  assert.match(prompt, /## system\n\nYou are the director\./);
  assert.match(prompt, /## user\n\nGive 5 ideas\./);
  const p = museStagePayload({ stage: "idea", prompt, runId: "r1", project: "A topic" });
  assert.equal(p.mode, "hold");
  assert.equal(p.museStage, "idea");
  assert.equal(p.runId, "r1");
  assert.deepEqual(p.outputs, ["result.json"]);
  assert.equal(p.workOrderId, undefined);
  assert.ok((p.prompt as string).length <= 1500);
  assert.match(p.prompt as string, /PROMPT\.md/);
  assert.match(p.prompt as string, /FAILED\.json/);
  const files = p.context as Array<{ name: string; text: string }>;
  assert.deepEqual(files.map((f) => f.name), ["PROMPT.md", "SPEC.json"]);
  const spec = JSON.parse(files[1].text) as Record<string, unknown>;
  assert.equal(spec.kind, "result");
  assert.equal(spec.stage, "idea");
  assert.equal(spec.schema, MUSE_RESULT_SCHEMA.idea);
  assert.deepEqual(museStagePayloadIssues(p), []);
});

test("a very long ask is cut to fit the context limit instead of being refused", () => {
  const p = museStagePayload({ stage: "research", prompt: "x".repeat(400_000), runId: "r", project: "p" });
  assert.deepEqual(museStagePayloadIssues(p), []);
  const text = (p.context as Array<{ text: string }>)[0].text;
  assert.match(text, /\[cut: longer than this file may be\]/);
});

test("refusals: each reason is the thing to change", () => {
  assert.deepEqual(museStageRefusals({ portalFlag: true, workers: [WORKER], now: NOW }), []);
  assert.deepEqual(museStageRefusals({ portalFlag: false, workers: [WORKER], now: NOW }), ["Set MUSE_AGENT_TASKS=1 on the portal"]);
  assert.match(museStageRefusals({ portalFlag: true, workers: [], now: NOW })[0], /No Muse worker reports agent-task/);
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, jobTypes: ["render-video"] }], now: NOW })[0], /No Muse worker reports agent-task/);
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, status: "draining" }], now: NOW })[0], /No Muse worker reports agent-task/);
  // 0.15.0 takes thinking tasks but cannot return a rendered video; every Muse stage needs 0.16.0.
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, version: "0.15.0" }], now: NOW })[0], /Update the Muse worker to 0\.16\.0/);
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, version: null }], now: NOW })[0], /Update the Muse worker/);
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, lastSeenAt: ago(300) }], now: NOW })[0], /last 75 min/);
  // One current worker is enough, even when another is old or gone.
  assert.deepEqual(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, id: "old", version: "0.13.0", lastSeenAt: ago(900) }, WORKER], now: NOW }), []);
  assert.deepEqual(museStageRefusals({ portalFlag: false, workers: [], now: NOW }).length, 2);
});

test("the answer is read with the stage's own validator, and a bad one says what is wrong", () => {
  const ideas = JSON.stringify({ ideas: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, hook: "h", angle: "a", score: 70 + i })) });
  const ok = museStageAnswer("idea", ideas);
  assert.ok(ok.ok);
  assert.equal(museStageAnswer("idea", null).ok, false);
  const bad = museStageAnswer("idea", '{"ideas":[]}');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /idea answer was not usable/);
  const notJson = museStageAnswer("script", "here is your script");
  assert.match(notJson.ok ? "" : notJson.error, /not valid JSON/);
});

test("a waiting stage: working, queued, finished, failed with the agent's reason, or given up on", () => {
  const job = (status: string, extra: Partial<{ error: string | null; createdAt: Date }> = {}) => ({ status, error: null, createdAt: ago(5), ...extra });
  assert.deepEqual(museStagePoll(job("succeeded"), NOW), { kind: "read" });
  assert.deepEqual(museStagePoll(job("running"), NOW), { kind: "wait", text: "Muse is working on this step" });
  assert.deepEqual(museStagePoll(job("queued"), NOW), { kind: "wait", text: "Waiting for a Muse worker to take this step" });
  assert.deepEqual(museStagePoll(job("failed", { error: "The Muse agent could not finish: the image tool is down" }), NOW), {
    kind: "error",
    error: "The Muse agent's task failed: The Muse agent could not finish: the image tool is down",
  });
  assert.deepEqual(museStagePoll(job("failed"), NOW), { kind: "error", error: "The Muse agent's task failed" });
  assert.match((museStagePoll(job("cancelled"), NOW) as { error: string }).error, /cancelled/);
  assert.match((museStagePoll(null, NOW) as { error: string }).error, /no longer exists/);
  const stale = museStagePoll(job("queued", { createdAt: ago(MUSE_QUEUE_GIVE_UP_MIN + 1) }), NOW);
  assert.match((stale as { error: string }).error, /No Muse worker took this step within 90 min/);
  // A running task is never given up on here: the worker's own 40 min limit ends it.
  assert.equal(museStagePoll(job("running", { createdAt: ago(600) }), NOW).kind, "wait");
});

test("overflow: only a thinking stage that Hermes holds, and only when switched on", () => {
  const on = { overflowOn: true, executors: undefined };
  for (const stage of ["idea", "research", "script", "storyboard", "scene-spec", "skill-brief"]) assert.equal(museOverflowApplies({ ...on, stage }), true, stage);
  for (const stage of ["html-design", "preview", "assets", "voice", "render", "qc"]) assert.equal(museOverflowApplies({ ...on, stage }), false, stage);
  assert.equal(museOverflowApplies({ stage: "idea", executors: undefined, overflowOn: false }), false);
  // A stage the run already gave to Muse is not "overflow".
  assert.equal(museOverflowApplies({ stage: "idea", executors: { idea: "muse" }, overflowOn: true }), false);
  assert.equal(museOverflowApplies({ stage: "script", executors: { idea: "muse" }, overflowOn: true }), true);
});

test("a storyboard answer is read with the storyboard validator; an unknown provider is dropped, not refused", () => {
  const board = (provider?: string) =>
    JSON.stringify({ shots: [{ beatRole: "hook", seconds: 4, description: "A door opens", imagePrompt: "An open wooden door in warm light", ...(provider ? { provider } : {}) }] });
  const ok = museStageAnswer("storyboard", board());
  assert.ok(ok.ok);
  assert.equal(museStageAnswer("storyboard", '{"shots":[]}').ok, false);
  assert.match((museStageAnswer("storyboard", '{"nope":1}') as { error: string }).error, /storyboard answer was not usable/);
  const p = museStagePayload({ stage: "storyboard", prompt: "x", runId: "r", project: "p" });
  const spec = JSON.parse((p.context as Array<{ text: string }>)[1].text) as { schema: string; stage: string };
  assert.equal(spec.stage, "storyboard");
  assert.match(spec.schema, /"shots"/);
});

test("the parsed answer goes to the caller's own validator: a skill brief is not judged by the default text-brief rules", () => {
  assert.deepEqual(museStageJson('{"shots":[]}'), { ok: true, value: { shots: [] } });
  assert.match((museStageJson("not json") as { error: string }).error, /not valid JSON/);
  assert.match((museStageJson(null) as { error: string }).error, /no result\.json came back/);
  const p = museStagePayload({ stage: "skill-brief", prompt: "x", runId: "r", project: "p" });
  assert.equal((JSON.parse((p.context as Array<{ text: string }>)[1].text) as { stage: string }).stage, "skill-brief");
  assert.equal(isMuseThinkStage("skill-brief"), true);
  assert.equal(isMuseThinkStage("html-design"), false);
});

test("the render task: skill, brief, contract and spec as files, the narration as an input, video.mp4 as the one output", () => {
  const p = museRenderPayload({
    runId: "r1",
    project: "Rice",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 41.6,
    narration: { assetId: "aaaaaaaa-1111-4111-8111-000000000001", ext: "wav", seconds: 41.62 },
    captions: ["Rice feeds half the world."],
    script: "Rice feeds half the world.",
    skill: { name: "/stick-figure", aliases: [], mode: "project", input: "Record the voiceover with tts_kokoro.py.", output: "A finished reel." },
    brief: { format: "text", shots: [{ beat: "hook", seconds: 3 }], text: "Project brief." },
    contract: { pacing: { maxShotSeconds: 4 } },
    ownerNote: "Bigger captions",
  });
  assert.equal(p.mode, "hold");
  assert.equal(p.stage, "render");
  assert.equal(p.museRender, true);
  assert.deepEqual(p.outputs, ["video.mp4"]);
  assert.deepEqual(p.inputs, ["aaaaaaaa-1111-4111-8111-000000000001"]);
  assert.deepEqual(p.inputFiles, [{ assetId: "aaaaaaaa-1111-4111-8111-000000000001", name: "narration.wav" }]);
  assert.equal(p.timeoutSec, MUSE_RENDER_TIMEOUT_SEC);
  assert.ok((p.prompt as string).length <= 1500);
  const files = Object.fromEntries((p.context as Array<{ name: string; text: string }>).map((f) => [f.name, f.text]));
  assert.deepEqual(Object.keys(files), ["SKILL.md", "BRIEF.md", "CONTRACT.md", "SPEC.json"]);
  assert.match(files["SKILL.md"], /# Skill: \/stick-figure/);
  assert.match(files["SKILL.md"], /skip any voiceover or TTS step/);
  assert.match(files["BRIEF.md"], /Project brief\./);
  assert.match(files["BRIEF.md"], /Bigger captions/);
  assert.match(files["CONTRACT.md"], /maxShotSeconds/);
  const spec = JSON.parse(files["SPEC.json"]) as { files: Array<{ name: string; width: number; durationSec: number }>; narration: { file: string } };
  assert.deepEqual([spec.files[0].name, spec.files[0].width, spec.files[0].durationSec], ["video.mp4", 1080, 42]);
  assert.equal(spec.narration.file, "in/narration.wav");
  assert.deepEqual(museStagePayloadIssues(p), []);
});
