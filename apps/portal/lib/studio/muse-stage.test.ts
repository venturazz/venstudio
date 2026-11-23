import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MUSE_QUEUE_GIVE_UP_MIN,
  executorsText,
  isMuseThinkStage,
  messagesText,
  museStageAnswer,
  museStagePayload,
  museStagePayloadIssues,
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
const WORKER: MuseWorkerFacts = { id: "w1", name: "muse-1", status: "active", jobTypes: ["render-video", "agent-task"], version: "0.15.0", lastSeenAt: ago(5) };

test("executors: only known thinking stages set to muse are kept; nothing stored means Hermes", () => {
  assert.deepEqual(parseStageExecutors(undefined), {});
  assert.deepEqual(parseStageExecutors("muse"), {});
  assert.deepEqual(parseStageExecutors([]), {});
  assert.deepEqual(parseStageExecutors({ idea: "muse", script: "hermes", storyboard: "muse", render: "muse" }), { idea: "muse" });
  assert.deepEqual(parseStageExecutors(museThinkingExecutors()), { idea: "muse", research: "muse", script: "muse" });
  assert.equal(runsOnMuse({ idea: "muse" }, "idea"), true);
  assert.equal(runsOnMuse({ idea: "muse" }, "script"), false);
  assert.equal(runsOnMuse(undefined, "idea"), false);
  assert.equal(runsOnMuse({ idea: "muse" }, "storyboard"), false);
  assert.equal(isMuseThinkStage("storyboard"), false);
  assert.equal(executorsText(undefined), null);
  assert.equal(executorsText({}), null);
  assert.equal(executorsText(museThinkingExecutors()), "Muse does the idea, research, script");
});

test("run config: Muse thinking is stored on the run and read back; a run without it reads as before", () => {
  const req = { format: "short" as const, language: "en", themeId: "", purposes: [], subtitles: [], brief: "x" };
  const plain = buildRunConfig(req, { category: null }, { styleId: "s" });
  assert.ok(plain.ok);
  assert.equal(plain.config.executors, undefined);
  const muse = buildRunConfig({ ...req, thinkOnMuse: true }, { category: null }, { styleId: "s" });
  assert.ok(muse.ok);
  assert.deepEqual(muse.config.executors, { idea: "muse", research: "muse", script: "muse" });
  const back = parseRunConfig(JSON.parse(JSON.stringify(muse.config)));
  assert.deepEqual(back.executors, muse.config.executors);
  assert.equal(parseRunConfig({}).executors, undefined);
  assert.ok(runSettings(back).some((r) => r.label === "Thinking" && /Muse does the idea/.test(r.value)));
  assert.ok(!runSettings(parseRunConfig({})).some((r) => r.label === "Thinking"));
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
  // 0.14.0 takes tasks but cannot report steps or failures; a Muse stage needs both.
  assert.match(museStageRefusals({ portalFlag: true, workers: [{ ...WORKER, version: "0.14.0" }], now: NOW })[0], /Update the Muse worker to 0\.15\.0/);
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
