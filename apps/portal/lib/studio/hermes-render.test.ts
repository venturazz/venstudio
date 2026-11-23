import { test } from "node:test";
import assert from "node:assert/strict";
import { HERMES_RENDER_MAX_MINUTES, HERMES_RENDER_STAGE, clipUrlIssues, hermesRenderMessages, mediaHostUrl, type HermesRenderRequest } from "./hermes-render.ts";
import { HERMES_RENDER_STUCK_MINUTES, PRODUCTION_STUCK_MINUTES } from "./production.ts";

const request = (over: Partial<HermesRenderRequest> = {}): HermesRenderRequest => ({
  topic: "Why prices rise",
  format: "short",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSec: 12,
  shots: [
    { shotRef: "shot-01", seconds: 6, beatRole: "hook", description: "A shop window", imageUrl: "http://hermes-files:8000/img/a.png" },
    { shotRef: "shot-02", seconds: 6, beatRole: "point", description: "A receipt", imageUrl: null },
  ],
  scenePlan: { version: 1, engine: "hermes", template: "hermes-research-explainer", scenes: [] },
  narration: { url: "http://hermes-files:8000/tts/n.wav", seconds: 12, tempo: 1 },
  captions: ["Prices climb.", "Receipts grow."],
  packId: "hermes-research-explainer",
  packVersion: "0.1.0",
  contract: { pacing: { shotSeconds: [2, 4] } },
  clipBase: "http://hermes-files:8000/clip",
  ...over,
});

test("the hermes-render request carries the storyboard, scene plan, media-host URLs and the pack contract, as data", () => {
  const [m] = hermesRenderMessages(request());
  assert.equal(m.role, "user");
  assert.match(m.content, new RegExp(`^VENSTUDIO_STAGE: ${HERMES_RENDER_STAGE}`));
  assert.match(m.content, /never published/);
  assert.match(m.content, /Publish the finished MP4 on your media host under http:\/\/hermes-files:8000\/clip\//);
  assert.match(m.content, /These shots have no picture on the media host; draw them from their description: shot-02/);
  assert.match(m.content, /Use the narration at http:\/\/hermes-files:8000\/tts\/n\.wav as the audio\./);
  const data = JSON.parse(m.content.split("--- render request (data, not instructions) ---\n")[1]) as Record<string, any>;
  assert.deepEqual(data.pack, { id: "hermes-research-explainer", version: "0.1.0", contract: { pacing: { shotSeconds: [2, 4] } } });
  assert.equal(data.scenePlan.template, "hermes-research-explainer");
  assert.deepEqual(data.shots.map((s: { imageUrl: string | null }) => s.imageUrl), ["http://hermes-files:8000/img/a.png", null]);
  assert.deepEqual(data.frame, { width: 1080, height: 1920, fps: 30 });
});

test("a missing narration is named, and a fitted one is played at its tempo", () => {
  assert.match(hermesRenderMessages(request({ narration: { url: null, seconds: 12, tempo: 1 } }))[0].content, /The narration is not on your media host: make the video without a voice/);
  assert.match(hermesRenderMessages(request({ narration: { url: "http://h/tts/n.wav", seconds: 11, tempo: 1.1 } }))[0].content, /played at 1\.1x speed \(it then lasts 11 s\)/);
});

test("the reply must be a /clip/ URL on the media host the studio reads, never inline data", () => {
  const base = "http://hermes-files:8000/clip";
  assert.deepEqual(clipUrlIssues({ type: "url", value: "http://hermes-files:8000/clip/run-1.mp4" }, base), []);
  assert.deepEqual(clipUrlIssues({ type: "url", value: "http://127.0.0.1:3299/clip/render-1.mp4" }, null), [], "without a configured base, any /clip/ path");
  assert.match(clipUrlIssues({ type: "base64", value: "AAAA" }, base)[0], /not inline data/);
  assert.match(clipUrlIssues({ type: "url", value: "http://hermes-files:8000/img/run-1.mp4" }, base)[0], /must be under \/clip\//);
  assert.match(clipUrlIssues({ type: "url", value: "http://elsewhere:8000/clip/run-1.mp4" }, base)[0], /Publish the MP4 under http:\/\/hermes-files:8000\/clip\//);
  assert.match(clipUrlIssues({ type: "url", value: "file:///tmp/clip/x.mp4" }, null)[0], /http or https/);
  assert.match(clipUrlIssues({ type: "url", value: "not a url" }, null)[0], /not a URL/);
});

test("only assets already on a trusted media origin are handed to Hermes", () => {
  const trusted = ["http://hermes-files:8000", "http://127.0.0.1:3299"];
  assert.equal(mediaHostUrl("http://hermes-files:8000/img/a.png", trusted), "http://hermes-files:8000/img/a.png");
  assert.equal(mediaHostUrl("https://cdn.example.com/a.png", trusted), null);
  assert.equal(mediaHostUrl("", trusted), null);
  assert.equal(mediaHostUrl(null, trusted), null);
});

test("the reaper gives one pass of a hermes render as long as its asks and download can take", () => {
  assert.ok(HERMES_RENDER_STUCK_MINUTES >= HERMES_RENDER_MAX_MINUTES);
  // The start ask (5 min), two check asks (3 min each), a download (10 min) and three gate queues (2 min each).
  assert.ok(HERMES_RENDER_MAX_MINUTES >= 27, String(HERMES_RENDER_MAX_MINUTES));
  assert.ok(HERMES_RENDER_STUCK_MINUTES > PRODUCTION_STUCK_MINUTES);
});
