import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failureFromStatus,
  findHealth,
  isProven,
  isQuarantined,
  proofOf,
  proofText,
  providerLabel,
  QUARANTINE_MS,
  shortProviderError,
  shouldQuarantine,
  type EndpointHealth,
} from "./endpoint-health.ts";
import { allKokoroQuarantined, pickProvenImageModel, pickRouterVoiceWithHealth, planVoice, routerImageTestOrder } from "./router-media.ts";

const NOW = Date.UTC(2026, 10, 21, 14, 0, 0);
const m = (id: string, ownedBy = "", kind = "") => ({ id, ownedBy, kind });

function h(model: string, kind: "image" | "tts", over: Partial<EndpointHealth> = {}): EndpointHealth {
  const base: EndpointHealth = {
    endpoint: "9router",
    model,
    kind,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureClass: null,
    lastError: "",
    quarantinedAt: null,
    successes: 0,
    failures: 0,
  };
  return { ...base, ...over };
}

test("only client errors quarantine; busy, server and auth do not", () => {
  assert.equal(shouldQuarantine("client"), true);
  for (const c of ["busy", "server", "auth", "unreachable", "content"] as const) assert.equal(shouldQuarantine(c), false);
  assert.equal(failureFromStatus(400), "client");
  assert.equal(failureFromStatus(429), "busy");
  assert.equal(failureFromStatus(500), "server");
  assert.equal(failureFromStatus(null), "unreachable");
});

test("proofOf: listed until a success, set aside after a 4xx, and the quarantine ends after its window", () => {
  assert.equal(proofOf(undefined, NOW), "listed");
  assert.equal(proofOf(h("a", "image", { lastSuccessAt: NOW - 1000 }), NOW), "proven");
  const aside = h("a", "image", { lastSuccessAt: NOW - 5000, quarantinedAt: NOW - 1000, failureClass: "client" });
  assert.equal(proofOf(aside, NOW), "quarantined");
  assert.equal(isProven(aside, NOW), false);
  assert.equal(isQuarantined(aside, NOW + QUARANTINE_MS), false);
  assert.equal(proofOf(aside, NOW + QUARANTINE_MS), "proven");
  assert.equal(proofText("listed"), "listed, not proven yet");
  assert.equal(findHealth([aside], "9router", "a", "tts"), undefined);
});

test("pickProvenImageModel never picks a model that is only listed", () => {
  const models = [m("cf/@cf/flux-2", "cf"), m("fake-img/flux-lite", "fake-img")];
  assert.equal(pickProvenImageModel(models, [], [], new Set(), NOW), null);
  const health = [h("fake-img/flux-lite", "image", { lastSuccessAt: NOW - 60_000 })];
  assert.equal(pickProvenImageModel(models, health, [], new Set(), NOW)?.id, "fake-img/flux-lite");
});

test("pickProvenImageModel skips set-aside models and ones that failed earlier in the stage", () => {
  const models = [m("a/one", "a"), m("b/two", "b")];
  const health = [
    h("a/one", "image", { lastSuccessAt: NOW - 10_000, quarantinedAt: NOW - 1000, failureClass: "client" }),
    h("b/two", "image", { lastSuccessAt: NOW - 20_000 }),
  ];
  assert.equal(pickProvenImageModel(models, health, [], new Set(), NOW)?.id, "b/two");
  assert.equal(pickProvenImageModel(models, health, [], new Set(["b/two"]), NOW), null);
});

test("pickProvenImageModel follows the provider order hint, then the newest success", () => {
  const models = [m("a/one", "a"), m("b/two", "b"), m("c/three", "c")];
  const health = [
    h("a/one", "image", { lastSuccessAt: NOW - 30_000 }),
    h("b/two", "image", { lastSuccessAt: NOW - 1_000 }),
    h("c/three", "image", { lastSuccessAt: NOW - 20_000 }),
  ];
  assert.equal(pickProvenImageModel(models, health, ["c"], new Set(), NOW)?.id, "c/three");
  assert.equal(pickProvenImageModel(models, health, [], new Set(), NOW)?.id, "b/two");
  assert.equal(pickProvenImageModel([m("v/clip", "v", "video")], [h("v/clip", "image", { lastSuccessAt: NOW })], [], new Set(), NOW), null);
});

test("routerImageTestOrder tries proven, then untried plain, then combos, then set-aside models", () => {
  const models = [m("combo-x", "combo"), m("bad/model", "bad"), m("good/model", "good"), m("old/model", "old")];
  const health = [h("good/model", "image", { lastSuccessAt: NOW - 1000 }), h("old/model", "image", { quarantinedAt: NOW - 1000, failureClass: "client" })];
  assert.deepEqual(routerImageTestOrder(models, health, NOW, 5).map((x) => x.id), ["good/model", "bad/model", "combo-x", "old/model"]);
  assert.deepEqual(routerImageTestOrder(models, [], NOW).map((x) => x.id), ["bad/model", "good/model", "old/model"]);
});

test("pickRouterVoiceWithHealth keeps the listed Kokoro path, prefers proven voices and skips set-aside ones", () => {
  const list = [m("kokoro/af_heart"), m("kokoro/af_bella"), m("edge-tts/en-US-AriaNeural")];
  assert.equal(pickRouterVoiceWithHealth(list, "en", undefined, [], NOW)?.id, "kokoro/af_heart");
  const bellaProven = [h("kokoro/af_bella", "tts", { lastSuccessAt: NOW - 1000 })];
  assert.equal(pickRouterVoiceWithHealth(list, "en", undefined, bellaProven, NOW)?.id, "kokoro/af_bella");
  const heartAside = [h("kokoro/af_heart", "tts", { quarantinedAt: NOW - 1000, failureClass: "client" })];
  assert.equal(pickRouterVoiceWithHealth(list, "en", undefined, heartAside, NOW)?.id, "kokoro/af_bella");
  assert.equal(pickRouterVoiceWithHealth(list, "en", "af_heart", bellaProven, NOW)?.id, "kokoro/af_heart");
  const allAside = [heartAside[0], h("kokoro/af_bella", "tts", { quarantinedAt: NOW - 1000, failureClass: "client" })];
  assert.equal(pickRouterVoiceWithHealth(list, "en", undefined, allAside, NOW), null);
  assert.equal(allKokoroQuarantined(list, allAside, NOW), true);
  assert.equal(allKokoroQuarantined(list, heartAside, NOW), false);
});

test("planVoice with health says why 9router was skipped when every Kokoro voice is set aside", () => {
  const list = [m("kokoro/af_heart")];
  const base = { languageCode: "en", overrideConfigured: false, router: { configured: true, models: list }, hermesConfigured: true, backupOn: true };
  assert.equal(planVoice({ ...base, health: [], nowMs: NOW }).attempts[0].engine, "router");
  const plan = planVoice({ ...base, health: [h("kokoro/af_heart", "tts", { quarantinedAt: NOW - 1000, failureClass: "client" })], nowMs: NOW });
  assert.equal(plan.attempts[0].engine, "hermes-kokoro");
  assert.ok(plan.skipped.some((s) => s.includes("set aside")));
  assert.equal(planVoice(base).attempts[0].engine, "router");
});

test("shortProviderError turns the nested Cloudflare body into one line", () => {
  const inner = JSON.stringify({ errors: [{ message: "AiError: AiError: prompt is required (fdbccbd5-1d2e-4c3b-9a8f-0123456789ab)", code: 3030 }], success: false });
  const body = JSON.stringify({ error: { message: `[400]: ${inner}` } });
  assert.equal(shortProviderError(400, body, "cf"), "Cloudflare: prompt is required (code 3030)");
  assert.equal(shortProviderError(400, body, ""), "Cloudflare: prompt is required (code 3030)");
  assert.equal(shortProviderError(400, body, "cloudflare-ai"), "Cloudflare: prompt is required (code 3030)");
});

test("shortProviderError handles plain messages, bare text and long bodies", () => {
  assert.equal(shortProviderError(400, JSON.stringify({ error: { message: "Invalid model format" } }), "openai"), "Openai: Invalid model format");
  assert.equal(shortProviderError(400, JSON.stringify({ error: "bad size" }), "fake-img"), "Fake-img: bad size");
  assert.equal(shortProviderError(500, "upstream exploded", "x"), "X: upstream exploded");
  assert.equal(shortProviderError(502, "", "x"), "X answered HTTP 502");
  const long = shortProviderError(400, JSON.stringify({ error: { message: "y".repeat(600) } }), "x");
  assert.ok(long.length <= 200 && long.endsWith("..."));
  assert.equal(providerLabel("CF"), "Cloudflare");
  assert.equal(providerLabel(""), "9router");
});
