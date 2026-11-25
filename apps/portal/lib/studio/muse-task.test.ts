// Muse agent tasks (docs/muse-agent-tasks.md): the owner's test payload, why the button is disabled, result.json
// through the stage validators, the timeline text and the picture fallback's context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIdeas, validateResearch, validateScript } from "./director.ts";
import { validateHtmlDesign } from "./html-design.ts";
import { validateSkillBrief } from "./skill-brief.ts";
import {
  MUSE_CONTEXT_LIMITS,
  MUSE_HONEST_NOTE,
  MUSE_REASON_FLAG_OFF,
  MUSE_REASON_NO_WORKER,
  MUSE_RESULT_SCHEMA,
  MUSE_RESULT_STAGES,
  MUSE_TEST_LABEL,
  clipText,
  contextIssues,
  contractMarkdown,
  durationText,
  museTaskWorkers,
  museTestDisabledReasons,
  museTestPayload,
  museTimeline,
  museTimelineText,
  pictureFallbackContext,
  planMarkdown,
  validateMuseResult,
  validateMuseTestResult,
  type MuseJobFacts,
} from "./muse-task.ts";

const MUSE = { id: "w1", name: "Nyx", status: "active", jobTypes: ["echo", "agent-task"] };
const PLAIN = { id: "w2", name: "VPS", status: "active", jobTypes: ["echo", "render-video"] };

test("the picture test: hold mode, CONTRACT.md and SPEC.json for test-frame.png 720x1280, nothing in production waits on it", () => {
  const p = museTestPayload("picture");
  assert.equal(p.mode, "hold");
  assert.deepEqual(p.inputs, []);
  assert.equal(p.runId, "test", "not a run id: settleOrderJob ignores it");
  assert.ok(!("workOrderId" in p));
  assert.deepEqual(p.outputs, ["test-frame.png"]);
  assert.equal(p.timeoutSec, 2400);
  const context = p.context as Array<{ name: string; text: string }>;
  assert.deepEqual(context.map((c) => c.name), ["CONTRACT.md", "SPEC.json"]);
  assert.deepEqual(contextIssues(context), []);
  const spec = JSON.parse(context[1].text) as { kind: string; files: Array<{ name: string; format: string; width: number; height: number }>; content: string };
  assert.deepEqual(spec.files, [{ name: "test-frame.png", format: "png", width: 720, height: 1280 }]);
  assert.equal(spec.content, "A plain test card with the text VenStudio test");
  assert.ok(context[0].text.includes('"VenStudio test"'));
  assert.ok((p.prompt as string).length <= 1500);
  assert.match(p.deliverable as string, /^test-frame\.png: a 720x1280 PNG, a plain test card with the text VenStudio test$/);
});

test("the JSON test asks for out/result.json with the tiny schema and no picture", () => {
  const p = museTestPayload("json");
  assert.deepEqual(p.outputs, ["result.json"]);
  assert.equal(p.stage, "test");
  const spec = JSON.parse((p.context as Array<{ text: string }>)[1].text) as Record<string, unknown>;
  assert.equal(spec.kind, "result");
  assert.equal(spec.schema, MUSE_RESULT_SCHEMA.test);
  assert.match(p.prompt as string, /Do not make a picture/);
  assert.equal(MUSE_TEST_LABEL.picture, "Send a test task to Muse");
  assert.equal(MUSE_TEST_LABEL.json, "Test a JSON result");
});

test("disabled reasons: the exact thing to change, the portal flag and the worker's flag", () => {
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: MUSE, anyWorker: true }), []);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: false, worker: MUSE, anyWorker: true }), ["Set MUSE_AGENT_TASKS=1 on the portal"]);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, anyWorker: false }), ["Set VENSTUDIO_AGENT_TASKS=1 in the hold cron line on Muse"]);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: false, anyWorker: false }), [MUSE_REASON_FLAG_OFF, MUSE_REASON_NO_WORKER]);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: PLAIN, anyWorker: true }), [MUSE_REASON_NO_WORKER]);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, status: "draining" }, anyWorker: true }), [MUSE_REASON_NO_WORKER]);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, version: "0.14.0" }, anyWorker: true }), []);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, version: "0.14.2" }, anyWorker: true }), []);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, version: "0.13.0" }, anyWorker: true }), [
    "Update this worker to 0.14.0 or later (it runs v0.13.0); older workers write no context files",
  ]);
  assert.match(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, version: null }, anyWorker: true })[0], /unknown version/);
  assert.deepEqual(museTaskWorkers([MUSE, PLAIN, { ...MUSE, id: "w3", status: "revoked" }]).map((w) => w.id), ["w1"]);
  // A worker that stopped claiming hours ago keeps its stored job types but cannot take the test.
  const now = new Date("2026-11-23T12:00:00Z");
  const seen = (min: number) => new Date(now.getTime() - min * 60_000);
  assert.deepEqual(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, lastSeenAt: seen(60) }, anyWorker: true, now }), []);
  assert.match(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, lastSeenAt: seen(300) }, anyWorker: true, now })[0], /not contacted the portal for over 75 min/);
  assert.match(museTestDisabledReasons({ portalFlag: true, worker: { ...MUSE, lastSeenAt: null }, anyWorker: true, now })[0], /not contacted the portal/);
  assert.match(MUSE_HONEST_NOTE, /venstudio-inbox hook/);
  assert.match(MUSE_HONEST_NOTE, /Waking takes minutes/);
  assert.match(MUSE_HONEST_NOTE, /40 min/);
});

test("the test result: the exact text and files that are really in the folder", () => {
  const folder = ["TASK.md", "CONTRACT.md", "SPEC.json"];
  assert.deepEqual(validateMuseTestResult({ text: "VenStudio test", filesRead: ["TASK.md", "SPEC.json"] }, folder), { ok: true, value: { text: "VenStudio test", filesRead: ["TASK.md", "SPEC.json"] } });
  const bad = validateMuseTestResult({ text: "hello", filesRead: ["~/workspace/plan.md"] }, folder);
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.issues, ['text must be exactly "VenStudio test"', 'filesRead names "~/workspace/plan.md", which is not in the folder (TASK.md, CONTRACT.md, SPEC.json)']);
  assert.match((validateMuseResult("test", "{oops", { folder }) as { issues: string[] }).issues[0], /^result\.json is not valid JSON: /);
  assert.equal(validateMuseResult("test", JSON.stringify({ text: "VenStudio test", filesRead: ["TASK.md"] }), { folder }).ok, true);
  assert.match((validateMuseResult("test", JSON.stringify({ pad: "x".repeat(256 * 1024) })) as { issues: string[] }).issues[0], /larger than 262144 bytes/);
});

test("result.json goes through the same validator as Hermes's answer for that stage", () => {
  const ideas = { ideas: Array.from({ length: 5 }, (_, i) => ({ title: `Idea ${i}`, hook: "h", angle: "a", score: 50 })) };
  const research = { notes: [{ claim: "c", sourceUrl: "https://example.org/x", sourced: true, summary: "s" }] };
  const script = { hooks: ["a", "b", "c"], chosenHook: 1, script: "The script." };
  for (const [stage, value, direct] of [
    ["idea", ideas, validateIdeas(ideas)],
    ["research", research, validateResearch(research)],
    ["script", script, validateScript(script)],
    ["idea", { ideas: [] }, validateIdeas({ ideas: [] })],
    ["research", { notes: [{ claim: "c", sourced: true, summary: "s" }] }, validateResearch({ notes: [{ claim: "c", sourced: true, summary: "s" }] })],
    ["script", { hooks: ["a"], chosenHook: 4, script: "" }, validateScript({ hooks: ["a"], chosenHook: 4, script: "" })],
  ] as const) {
    assert.deepEqual(validateMuseResult(stage, JSON.stringify(value)), direct, `${stage} ${JSON.stringify(value).slice(0, 40)}`);
  }
  const brief = { shots: [{ beat: "hook", seconds: 3, description: "d" }], text: "draw a line" };
  assert.deepEqual(validateMuseResult("skill-brief", JSON.stringify(brief)), validateSkillBrief(brief, null));
  assert.deepEqual(validateMuseResult("scene-spec", JSON.stringify({ scenes: [] })), { ok: false, issues: ["A scene spec is checked against the run's style contract, which this check was not given"] });
  assert.deepEqual([...MUSE_RESULT_STAGES], ["test", "idea", "research", "script", "storyboard", "scene-spec", "skill-brief", "html-design"]);
});

test("html-design: the page files from out/ take the place of html and files, then validateHtmlDesign checks the whole", () => {
  const page = [
    { path: "index.html", text: "<!doctype html><script src=\"scene.js\"></script>" },
    { path: "scene.js", text: "window.VENSTUDIO = { init(p) { return p; }, renderFrame() {} };" },
  ];
  const answer = { note: "A calm page", scenes: [{ beat: "hook", seconds: 3, caption: "Hi" }] };
  const viaMuse = validateMuseResult("html-design", JSON.stringify(answer), { page: { vendored: [] } }, page);
  const direct = validateHtmlDesign({ ...answer, html: page[0].text, files: [page[1]] }, { vendored: [] });
  assert.deepEqual(viaMuse, direct);
  // A page that calls the network is refused exactly as Hermes's would be.
  const net = [{ path: "index.html", text: '<!doctype html><script>fetch("https://x.example/a")</script>' }];
  const refused = validateMuseResult("html-design", JSON.stringify(answer), { page: { vendored: [] } }, net);
  assert.deepEqual(refused, validateHtmlDesign({ ...answer, html: net[0].text }, { vendored: [] }));
  assert.equal(refused.ok, false);
  // Without page files, result.json may carry html itself (Hermes's own shape).
  assert.equal(validateMuseResult("html-design", JSON.stringify({ ...answer }), { page: { vendored: [] } }).ok, false);
});

const T0 = new Date("2026-11-23T10:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

test("the timeline: queued, claimed, TASK.md written, DONE seen, uploaded, finished, and the wake latency", () => {
  const running: MuseJobFacts = {
    status: "running",
    createdAt: T0,
    startedAt: at(4),
    finishedAt: null,
    result: null,
    events: [
      { message: "Job created (agent-task)", createdAt: T0 },
      { message: "Claimed by Nyx (attempt 1)", createdAt: at(4) },
      { message: "TASK.md written (2 context files, 0 inputs); waiting for the Muse agent to create out/DONE", createdAt: at(5) },
    ],
  };
  assert.deepEqual(museTimelineText(running), [
    "Queued: 2026-11-23T10:00:00Z",
    "Claimed by the Muse worker: +4 s",
    "TASK.md written in the inbox: +5 s",
    "DONE seen (the agent finished): waiting",
    "Files uploaded: waiting",
    "Finished: waiting",
    "Wake latency (claimed to DONE): not yet",
  ]);
  const done: MuseJobFacts = {
    ...running,
    status: "succeeded",
    finishedAt: at(200),
    events: [...running.events, { message: "DONE seen after 190 s; checking and uploading out/", createdAt: at(195) }, { message: "Uploaded agent-test-frame.png (0.01 MB)", createdAt: at(198) }],
    result: { startedAt: at(4).toISOString(), taskWrittenAt: at(5).toISOString(), doneAt: at(194).toISOString(), uploadedAt: at(197).toISOString(), wakeSec: 190 },
  };
  assert.deepEqual(museTimelineText(done), [
    "Queued: 2026-11-23T10:00:00Z",
    "Claimed by the Muse worker: +4 s",
    "TASK.md written in the inbox: +5 s (worker clock)",
    "DONE seen (the agent finished): +3 min 14 s (worker clock)",
    "Files uploaded: +3 min 17 s (worker clock)",
    "Finished: +3 min 20 s",
    "Wake latency (claimed to DONE): 3 min 10 s",
  ]);
  // Before the worker's result is in, the latency comes from the portal's events.
  assert.equal(museTimeline({ ...done, status: "running", result: null }).wakeSec, 191);
  const failed = museTimelineText({ ...running, status: "failed", finishedAt: at(2405), error: "The Muse agent did not create out/DONE within 40 min" });
  assert.deepEqual(failed.slice(3), [
    "DONE seen (the agent finished): did not happen",
    "Files uploaded: did not happen",
    "Failed: +40 min 5 s",
    "Wake latency (claimed to DONE): not yet",
    "Error: The Muse agent did not create out/DONE within 40 min",
  ]);
  assert.equal(durationText(59.6), "1 min");
  assert.equal(durationText(125), "2 min 5 s");
});

test("picture fallback context: PLAN.md with this shot marked, CONTRACT.md, SPEC.json; within the worker's limits", () => {
  const plan = planMarkdown({
    topic: "Roman roads",
    styleId: "documentary",
    script: "Romans built roads.",
    shots: [
      { beatRole: "hook", seconds: 3, description: "A road", imagePrompt: "Old road at dawn" },
      { beatRole: "body", seconds: 4, description: "Builders" },
    ],
    shotRef: "s02",
    shotIndex: 1,
  });
  assert.ok(plan.includes("Romans built roads.") && plan.includes("1. [hook, 3 s] A road") && plan.includes("   Picture: Old road at dawn") && plan.includes("2. [body, 4 s] <- THIS SHOT Builders"));
  assert.ok(planMarkdown({ topic: "", styleId: "", script: null, shots: null, shotRef: "s1", shotIndex: null }).includes("(no approved shot list yet)"));
  const contract = contractMarkdown({ styleId: "documentary", packId: "documentary", contract: { pacing: { minShotSec: 2 } } });
  assert.ok(contract.includes('"minShotSec": 2'));
  assert.match(contractMarkdown({ styleId: "x", contract: null }), /No pack contract/);
  const c = pictureFallbackContext({ shotRef: "s02", prompt: "Builders laying stones", format: "short", width: 1080, height: 1920, plan, contract });
  assert.deepEqual(c.context.map((f) => f.name), ["PLAN.md", "CONTRACT.md", "SPEC.json"]);
  assert.deepEqual(c.outputs, ["s02.png"]);
  assert.deepEqual(contextIssues(c.context), []);
  const spec = JSON.parse(c.context[2].text) as { files: unknown[]; picture: string };
  assert.deepEqual(spec.files, [{ name: "s02.png", format: "png", width: 1080, height: 1920 }]);
  assert.equal(spec.picture, "Builders laying stones");
  // A huge plan is cut to fit, never refused by the worker.
  const huge = pictureFallbackContext({ shotRef: "s1", prompt: "p", format: "long", width: 1920, height: 1080, plan: "word ".repeat(100_000), contract: "c ".repeat(100_000) });
  assert.deepEqual(contextIssues(huge.context), []);
  assert.ok(huge.context[0].text.endsWith("[cut: longer than this file may be]\n"));
  assert.equal(clipText("short", 100), "short");
  assert.ok(new TextEncoder().encode(clipText("é".repeat(1000), 100)).length <= 100);
  assert.deepEqual(contextIssues([{ name: "TASK.md", text: "x" }]), ["TASK.md: not a plain .md, .json or .txt name"]);
  assert.equal(MUSE_CONTEXT_LIMITS.totalBytes, 200 * 1024);
});
