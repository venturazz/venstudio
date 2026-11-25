import { test } from "node:test";
import assert from "node:assert/strict";
import { hermesRenderMessages, type HermesRenderRequest } from "./hermes-render.ts";
import {
  HERMES_RENDER_CHECK_STAGE,
  RENDER_BAD_FETCHES,
  RENDER_BUDGET_PROJECT_MIN,
  RENDER_BUDGET_SPEC_MIN,
  RENDER_CHECK_GRACE_MS,
  applyCheckReply,
  applyStartReply,
  newRenderJob,
  parseRenderReply,
  readRenderJob,
  renderBudgetMinutes,
  renderCheckMessages,
  renderClock,
  renderFetchFailed,
  renderFileName,
  renderingWait,
  renderOverdueText,
  renderPollEveryMs,
  renderPollStep,
  type RenderJob,
} from "./hermes-render-job.ts";
import { isRenderingWait, readRenderingWait, renderingText, stageWaitText } from "./pacing.ts";

const RUN = "3f2b9c1e-0000-4000-8000-00000000abcd";
const BASE = "http://hermes-files:8000/clip";
const TRUSTED = ["http://hermes-files:8000", "http://127.0.0.1:3299"];
const T0 = Date.parse("2026-11-23T18:00:00Z");
const MIN = 60_000;

const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  ...newRenderJob({ file: renderFileName(RUN, 1, "a1b2c3"), base: BASE, attempt: 1, skill: "/stick-figure", budgetMin: 240, nowMs: T0 }),
  askedAt: new Date(T0).toISOString(),
  ...over,
});

const request = (over: Partial<HermesRenderRequest> = {}): HermesRenderRequest => ({
  topic: "Why rice",
  format: "short",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 40,
  shots: [{ shotRef: "shot-01", seconds: 4, beatRole: "hook", description: "A bowl", imageUrl: null }],
  scenePlan: null,
  narration: { url: "http://hermes-files:8000/tts/n.wav", seconds: 40, tempo: 1 },
  captions: ["Rice."],
  packId: "stick-figure",
  packVersion: "0.2.0",
  contract: {},
  skill: { name: "/stick-figure", aliases: [], mode: "project", input: "Use the run's narration.", output: "A reel." },
  clipBase: BASE,
  ...over,
});

test("the render file name is unique per run, attempt and random part, and safe on the media host", () => {
  assert.equal(renderFileName(RUN, 1, "a1b2c3"), `vs-${RUN}-1-a1b2c3.mp4`);
  assert.equal(renderFileName(RUN, 2, "a1b2c3"), `vs-${RUN}-2-a1b2c3.mp4`, "Retry is a new stage attempt, so a new name");
  assert.notEqual(renderFileName(RUN, 1, "ffff00"), renderFileName(RUN, 1, "a1b2c3"));
  assert.equal(renderFileName("../etc/Passwd", 0, "A/B"), "vs-etcpasswd-1-ab.mp4");
  assert.equal(job().url, `${BASE}/vs-${RUN}-1-a1b2c3.mp4`);
});

test("the start request names the exact file, where it is served, and asks for an answer as soon as the render has started", () => {
  const file = renderFileName(RUN, 1, "a1b2c3");
  const url = `${BASE}/${file}`;
  const [m] = hermesRenderMessages(request({ output: { file, url } }));
  assert.match(m.content, /^VENSTUDIO_STAGE: hermes-render\n/);
  assert.ok(m.content.includes(`Save the finished MP4 as exactly ${file} in your generated videos folder (cache/generated/videos), which your media host serves at ${url}.`));
  assert.match(m.content, /answer as soon as it has started: do not wait for it to finish/);
  assert.match(m.content, /It will never ask you to start this video again/);
  assert.ok(m.content.includes(`{"status":"started","file":"${file}"`));
  assert.ok(m.content.includes(`{"status":"done","file":"${file}","url":"${url}"`));
  assert.match(m.content, /\{"status":"error","note":"<why>"\}/);
  // The one-turn contract is gone from this request.
  assert.doesNotMatch(m.content, /reply with its URL/);
  assert.doesNotMatch(m.content, /"status":"ok"/);
  // The skill and the data are as before.
  assert.match(m.content, /with your \/stick-figure skill/);
  assert.equal(JSON.parse(m.content.split("--- render request (data, not instructions) ---\n")[1]).pack.id, "stick-figure");
  // A skill that voices itself is asked to name its voice backend in the start answer.
  const [v] = hermesRenderMessages(request({ output: { file, url }, voice: "skill", script: "Rice.", brief: { skill: "/stick-figure", format: "text", shots: [], text: "b" } }));
  assert.match(v.content, /"status":"started".*"voice":\{"provider":"<the voice tool>"/);
  // Without an output the request is the one-turn one from before (pinned in fixtures/prompts).
  assert.match(hermesRenderMessages(request())[0].content, /Publish the finished MP4 on your media host under http:\/\/hermes-files:8000\/clip\/ and reply with its URL\./);
});

test("the start answer: started, done with the URL, an old one-turn answer, another file name, and anything unreadable", () => {
  const exp = { file: job().file, url: job().url };
  const started = parseRenderReply(`{"status":"started","file":"${exp.file}","note":"rendering scene 1 of 12","provider":"capcut","source":"capcut"}`, exp, BASE, TRUSTED);
  assert.deepEqual([started.status, started.file, started.url, started.note, started.backend], ["started", exp.file, exp.url, "rendering scene 1 of 12", "capcut"]);
  const done = parseRenderReply(`Here it is: {"status":"done","url":"${exp.url}","model":"m1"}`, exp, BASE, TRUSTED);
  assert.deepEqual([done.status, done.url, done.model], ["done", exp.url, "m1"]);
  // The answer Hermes gave before render jobs (a quick skill that finished in the turn) is taken as done, with its URL.
  const old = parseRenderReply('{"status":"ok","video":{"type":"url","value":"http://hermes-files:8000/clip/graph-1.mp4","mimeType":"video/mp4"},"provider":"capcut","source":"capcut"}', exp, BASE, TRUSTED);
  assert.deepEqual([old.status, old.file, old.url], ["done", "graph-1.mp4", "http://hermes-files:8000/clip/graph-1.mp4"]);
  // Another name on the same media host is accepted and recorded.
  const other = parseRenderReply('{"status":"started","file":"stick_20261123_1800.mp4"}', exp, BASE, TRUSTED);
  assert.deepEqual([other.file, other.url], ["stick_20261123_1800.mp4", `${BASE}/stick_20261123_1800.mp4`]);
  // A URL that is not under /clip/ on a trusted media host is not taken: the studio keeps reading the named file.
  for (const bad of ["https://evil.example/clip/x.mp4", "http://hermes-files:8000/img/x.mp4", "file:///opt/data/cache/generated/videos/x.mp4"]) {
    const r = parseRenderReply(`{"status":"done","url":"${bad}"}`, exp, null, TRUSTED);
    assert.equal(r.url, exp.url, bad);
    assert.match(r.note, /the studio reads/, bad);
  }
  assert.equal(parseRenderReply('{"status":"started","file":"../../canva_tokens/x.json"}', exp, BASE, TRUSTED).url, exp.url);
  // An older Hermes: a plain answer with the clip's link, or the path in its own videos folder.
  const linked = parseRenderReply("Done! Here it is: http://hermes-files:8000/clip/stick-7.mp4 (16 s)", exp, BASE, TRUSTED);
  assert.deepEqual([linked.status, linked.file, linked.url], ["done", "stick-7.mp4", "http://hermes-files:8000/clip/stick-7.mp4"]);
  const pathed = parseRenderReply('{"status":"done","file":"/opt/data/cache/generated/videos/reel_20261123.mp4"}', exp, BASE, TRUSTED);
  assert.deepEqual([pathed.status, pathed.url], ["done", `${BASE}/reel_20261123.mp4`]);
  const typed = parseRenderReply('{"status":"ok","video":{"type":"path","value":"/opt/data/cache/generated/videos/x_1.mp4"}}', exp, BASE, TRUSTED);
  assert.equal(typed.url, `${BASE}/x_1.mp4`);
  assert.equal(parseRenderReply('{"status":"done","file":"/opt/data/cache/canva_tokens/t.json"}', exp, BASE, TRUSTED).url, exp.url, "only the videos folder");
  assert.equal(parseRenderReply("Done: https://evil.example/clip/x.mp4", exp, BASE, TRUSTED).status, "unclear", "a link elsewhere is not taken");
  // Never a failure (so never asked again): an unreadable answer is "unclear", and the file is waited for.
  const prose = parseRenderReply("Sure, I'm rendering it now with /stick-figure!", exp, BASE, TRUSTED);
  assert.deepEqual([prose.status, prose.url], ["unclear", exp.url]);
  assert.match(prose.note, /not JSON/);
  assert.equal(parseRenderReply('{"status":"rendering"}', exp, BASE, TRUSTED).status, "started");
  assert.equal(parseRenderReply('{"status":"error","error":"the skill is not installed"}', exp, BASE, TRUSTED).note, "the skill is not installed");
  assert.deepEqual(parseRenderReply('{"status":"started","voice":{"provider":"kokoro-tool","source":"kokoro"}}', exp, BASE, TRUSTED).voice, { provider: "kokoro-tool", backend: "kokoro", model: "" });
  // Applied to the job: done takes the file at once, started waits.
  assert.equal(applyStartReply(job(), done).doneReported, true);
  assert.equal(applyStartReply(job(), started).doneReported, false);
  assert.equal(applyStartReply(job(), other).url, `${BASE}/stick_20261123_1800.mp4`);
});

test("poll: missing, then the file appears, then it is taken once its size is stable", () => {
  let j = job();
  let s = renderPollStep(j, { kind: "missing" }, T0 + 1 * MIN);
  assert.equal(s.action, "wait");
  assert.equal(s.action === "wait" && s.untilMs, T0 + 2 * MIN, "every minute at first");
  j = s.job;
  s = renderPollStep(j, { kind: "present", size: 1_000_000 }, T0 + 2 * MIN);
  assert.equal(s.action, "wait", "first sight: it may still be written");
  j = s.job;
  assert.equal(j.lastSize, 1_000_000);
  s = renderPollStep(j, { kind: "present", size: 3_000_000 }, T0 + 3 * MIN);
  assert.equal(s.action, "wait", "still growing");
  j = s.job;
  s = renderPollStep(j, { kind: "present", size: 3_000_000 }, T0 + 4 * MIN);
  assert.equal(s.action, "fetch", "same size twice: complete");
  assert.equal(s.job.polls, 4);
  // A host that gives no size: taken after the download says it is stable (the server passes bytes.length).
  assert.equal(renderPollStep(job(), { kind: "present", size: null }, T0 + MIN).action, "wait");
  // Hermes said done: taken at the first look.
  assert.equal(renderPollStep({ ...job(), doneReported: true }, { kind: "present", size: 10 }, T0 + MIN).action, "fetch");
  // A media host that cannot be reached is waited through, within the budget.
  const e = renderPollStep(job(), { kind: "error", message: "The file host hermes-files:8000 refused or dropped the connection" }, T0 + MIN);
  assert.equal(e.action, "wait");
  assert.match(e.job.lastIssue, /refused/);
});

test("poll: no re-ask while Hermes renders, however long, inside the budget; the interval backs off to 3 minutes", () => {
  let j = job();
  let t = T0;
  for (let i = 0; i < 70; i++) {
    const s = renderPollStep(j, { kind: "missing" }, t);
    assert.equal(s.action, "wait", `poll ${i + 1}`);
    if (s.action !== "wait") break;
    j = s.job;
    t = s.untilMs;
  }
  assert.ok(t - T0 < 240 * MIN, "70 polls fit in the 4-hour budget");
  assert.deepEqual([renderPollEveryMs(0), renderPollEveryMs(9), renderPollEveryMs(10), renderPollEveryMs(20), renderPollEveryMs(500)], [MIN, MIN, 2 * MIN, 3 * MIN, 3 * MIN]);
  assert.equal(renderPollEveryMs(0, 0.1), 6_000, "the test-only scale shortens it in CI");
});

test("poll: past the budget, one check ask; then a clear stage error, and Retry gets a new file name", () => {
  const late = T0 + 241 * MIN;
  const s = renderPollStep(job(), { kind: "missing" }, late);
  assert.equal(s.action, "check");
  // Hermes says it is still rendering: the stage fails, nothing is restarted.
  const still = parseRenderReply('{"status":"started","note":"scene 9 of 12"}', { file: job().file, url: job().url }, BASE, TRUSTED);
  const checked = applyCheckReply(s.job, still, late);
  const f = renderPollStep(checked, { kind: "missing" }, late + 1000);
  assert.equal(f.action, "fail");
  assert.equal(
    f.action === "fail" ? f.reason : "",
    `Hermes did not produce ${job().file} within 240 min; Hermes says it is still rendering it (scene 9 of 12). Nothing was restarted. Retry starts a new render with a new file name; Cancel stops the run.`,
  );
  // Hermes says done: the next look takes the file without waiting for a second size.
  const done = applyCheckReply(s.job, parseRenderReply('{"status":"done"}', { file: job().file, url: job().url }, BASE, TRUSTED), late);
  assert.equal(renderPollStep(done, { kind: "present", size: 5_000_000 }, late + 1000).action, "fetch");
  // The check could not be asked (Hermes busy): asked again on the next look, until the grace time, then a failure.
  assert.equal(renderPollStep(job(), { kind: "missing" }, T0 + 240 * MIN + RENDER_CHECK_GRACE_MS - 1000).action, "check");
  const gone = renderPollStep(job(), { kind: "missing" }, T0 + 240 * MIN + RENDER_CHECK_GRACE_MS + 1000);
  assert.equal(gone.action, "fail");
  assert.match(gone.action === "fail" ? gone.reason : "", /Hermes could not be asked whether it is still rendering/);
  assert.match(renderOverdueText({ ...job(), checkAskedAt: new Date(late).toISOString(), checkReply: null }), /Hermes did not answer when asked/);
  assert.match(renderOverdueText({ ...job(), checkAskedAt: new Date(late).toISOString(), checkReply: { ...still, status: "missing", note: "" } }), /Hermes says it has no such render\./);
  // A file still growing past the budget is waited for until the grace time.
  assert.equal(renderPollStep({ ...job(), lastSize: 10 }, { kind: "present", size: 20 }, late).action, "wait");
  assert.equal(renderPollStep({ ...job(), lastSize: 10 }, { kind: "present", size: 20 }, T0 + 240 * MIN + RENDER_CHECK_GRACE_MS + 1000).action, "fail");
});

test("a complete file that is not a video is looked at again, and fails after a few in a row", () => {
  let j: RenderJob = { ...job(), lastSize: 100 };
  for (let i = 1; i < RENDER_BAD_FETCHES; i++) {
    const s = renderFetchFailed(j, "The file is not an MP4, WebM or MOV video", T0 + i * MIN);
    assert.equal(s.action, "wait");
    j = s.job;
    assert.equal(j.lastSize, null, "the size is compared afresh");
  }
  const f = renderFetchFailed(j, "The file is not an MP4, WebM or MOV video", T0 + 9 * MIN);
  assert.equal(f.action, "fail");
  assert.match(f.action === "fail" ? f.reason : "", /is not a usable video: The file is not an MP4/);
});

test("render budgets per pack: the pack's own, else 120 min for a quick skill and 240 min for a full project", () => {
  assert.equal(renderBudgetMinutes({ mode: "spec" }), RENDER_BUDGET_SPEC_MIN);
  assert.equal(RENDER_BUDGET_SPEC_MIN, 120);
  assert.equal(renderBudgetMinutes({ mode: "project" }), RENDER_BUDGET_PROJECT_MIN);
  assert.equal(RENDER_BUDGET_PROJECT_MIN, 240);
  assert.equal(renderBudgetMinutes({ mode: "project", renderMinutes: 360 }), 360);
  assert.equal(renderBudgetMinutes({ mode: "spec", renderMinutes: 1 }), 10);
  assert.equal(renderBudgetMinutes({ mode: "spec", renderMinutes: 99999 }), 720);
  assert.equal(renderBudgetMinutes(null), 120, "the generic Hermes render");
});

test("the stored job reads back; anything else is no job (a render from before render jobs starts once with the new flow)", () => {
  const j = applyStartReply(job(), parseRenderReply('{"status":"started","source":"capcut"}', { file: job().file, url: job().url }, BASE, TRUSTED));
  const back = readRenderJob(JSON.parse(JSON.stringify(j)));
  assert.deepEqual(back, j);
  assert.equal(readRenderJob(undefined), null);
  assert.equal(readRenderJob({ file: "x.mp4" }), null);
  assert.equal(readRenderJob({ ...j, file: "../x.mp4" }), null);
  assert.equal(readRenderJob({ ...j, askedAt: null })?.askedAt, null, "not asked yet (Hermes was busy): the start ask is sent with the same file");
  assert.deepEqual(renderClock(j, T0 + 30 * MIN), { elapsedMinutes: 30, budgetMinutes: 240 });
  assert.equal(renderClock({ slowStreak: 3 }, T0), null);
});

test("the check ask is tiny, names the file, and says not to start it again", () => {
  const [m] = renderCheckMessages(job(), { voice: true, why: "overdue" });
  assert.match(m.content, new RegExp(`^VENSTUDIO_STAGE: ${HERMES_RENDER_CHECK_STAGE}\\n`));
  assert.ok(m.content.includes(`save it as ${job().file} (served at ${job().url}). Do not start it again`));
  assert.match(m.content, /At 18:00 UTC the studio asked you to render a video with your \/stick-figure skill/);
  assert.match(m.content, /"voice":\{"provider"/);
  assert.ok(m.content.length < 1200, String(m.content.length));
  assert.doesNotMatch(renderCheckMessages(job(), { voice: false })[0].content, /"voice"/);
});

test("the status line says Hermes is rendering, since when, and that nothing is restarted", () => {
  const wait = renderingWait(job(), MIN);
  assert.equal(isRenderingWait(wait), true);
  assert.equal(isRenderingWait({ reason: "slow", afterMs: 1800000 }), false);
  assert.deepEqual(readRenderingWait(wait), { skill: "/stick-figure", startedAtMs: T0, everyMs: MIN });
  const line = stageWaitText(wait, T0 + 13 * MIN, T0 + 12 * MIN);
  assert.equal(line, "Hermes is rendering with /stick-figure (started 18:00 UTC, 12 min ago). The studio checks for the finished file every minute; nothing is restarted.");
  assert.doesNotMatch(line, /busy or slow/);
  assert.equal(renderingText({ skill: "", startedAtMs: T0, everyMs: 3 * MIN }, T0 + 10_000), "Hermes is rendering (started 18:00 UTC, just now). The studio checks for the finished file every 3 min; nothing is restarted.");
  // Every other wait reads as before.
  assert.match(stageWaitText({ reason: "slow", afterMs: 30 * MIN }, T0 + MIN, T0), /^Hermes is busy or slow \(it answered nothing in 30 min\)/);
});
