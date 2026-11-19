import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addGateIssues,
  asUuid,
  assetsSettled,
  captionLines,
  countOrders,
  failedOrdersMessage,
  finalReason,
  onlyTermsIssues,
  ORDER_MAX_ATTEMPTS,
  ORDER_STUCK_MINUTES,
  ORDER_WORST_CASE_SEC,
  orderStaleAction,
  parseOrderSpec,
  productionDecision,
  productionStageAction,
  productionSummary,
  PRODUCTION_STUCK_MINUTES,
  renderLicenseText,
  retryStageFor,
} from "./production.ts";
import { providerTermsIssues } from "./asset-plan.ts";

test("the stuck limit for an order exceeds its worst case", () => {
  assert.ok(ORDER_STUCK_MINUTES * 60 > ORDER_WORST_CASE_SEC);
});

test("parseOrderSpec keeps good fields and defaults the rest", () => {
  assert.deepEqual(parseOrderSpec({ prompt: "a cat", seconds: 3, beatRole: "hook", note: "bluer" }), { prompt: "a cat", seconds: 3, beatRole: "hook", note: "bluer" });
  assert.deepEqual(parseOrderSpec(null), { prompt: "", seconds: 4, beatRole: "body", note: "" });
  assert.equal(parseOrderSpec({ beatRole: "nonsense", seconds: -2 }).beatRole, "body");
  assert.equal(parseOrderSpec({ seconds: -2 }).seconds, 4);
});

test("orderStaleAction requeues lost orders, then fails them, and leaves job waits alone", () => {
  const base = { state: "running", attempts: 1, hasJob: false, idleMinutes: ORDER_STUCK_MINUTES + 1 };
  assert.equal(orderStaleAction(base), "requeue");
  assert.equal(orderStaleAction({ ...base, attempts: ORDER_MAX_ATTEMPTS }), "fail");
  assert.equal(orderStaleAction({ ...base, idleMinutes: 5 }), "keep");
  assert.equal(orderStaleAction({ ...base, hasJob: true }), "keep");
  assert.equal(orderStaleAction({ ...base, state: "pending" }), "keep");
  assert.equal(orderStaleAction({ ...base, state: "done" }), "keep");
});

test("countOrders and assetsSettled", () => {
  const c = countOrders(["pending", "running", "done", "done", "failed", "cancelled"]);
  assert.deepEqual(c, { pending: 1, running: 1, done: 2, failed: 1 });
  assert.equal(assetsSettled(c), false);
  assert.equal(assetsSettled(countOrders(["done", "failed"])), true);
  assert.equal(assetsSettled(countOrders([])), true);
});

test("productionStageAction for the assets stage", () => {
  const none = { pending: 0, running: 0, done: 0, failed: 0 };
  assert.deepEqual(productionStageAction({ stage: "assets", idleMinutes: 99, jobStatus: null, orders: { ...none, running: 1 } }), { action: "none" });
  assert.deepEqual(productionStageAction({ stage: "assets", idleMinutes: 5, jobStatus: null, orders: { ...none, done: 3 } }), { action: "finalize" });
  assert.deepEqual(productionStageAction({ stage: "assets", idleMinutes: 0, jobStatus: null, orders: { ...none, done: 3 } }), { action: "none" });
  assert.deepEqual(productionStageAction({ stage: "assets", idleMinutes: 5, jobStatus: null, orders: { ...none, pending: 2 } }), { action: "none" });
  assert.deepEqual(productionStageAction({ stage: "assets", idleMinutes: ORDER_STUCK_MINUTES + 1, jobStatus: null, orders: { ...none, pending: 2 } }), { action: "resume" });
});

test("productionStageAction for voice, render and qc", () => {
  assert.deepEqual(productionStageAction({ stage: "voice", idleMinutes: 3, jobStatus: null }), { action: "none" });
  assert.equal(productionStageAction({ stage: "voice", idleMinutes: PRODUCTION_STUCK_MINUTES + 1, jobStatus: null }).action, "fail");
  assert.deepEqual(productionStageAction({ stage: "render", idleMinutes: 500, jobStatus: "running" }), { action: "none" });
  assert.deepEqual(productionStageAction({ stage: "render", idleMinutes: 500, jobStatus: "queued" }), { action: "none" });
  assert.deepEqual(productionStageAction({ stage: "render", idleMinutes: 1, jobStatus: "succeeded" }), { action: "complete" });
  const failed = productionStageAction({ stage: "qc", idleMinutes: 1, jobStatus: "failed", jobError: "ffprobe missing" });
  assert.equal(failed.action, "fail");
  assert.match(failed.action === "fail" ? failed.reason : "", /quality check failed: ffprobe missing/i);
  assert.equal(productionStageAction({ stage: "render", idleMinutes: 1, jobStatus: "cancelled" }).action, "fail");
  assert.equal(productionStageAction({ stage: "render", idleMinutes: 5, jobStatus: null }).action, "none");
  assert.equal(productionStageAction({ stage: "render", idleMinutes: PRODUCTION_STUCK_MINUTES + 1, jobStatus: null }).action, "fail");
});

test("productionDecision never revises or auto-publishes", () => {
  assert.equal(productionDecision({ action: "revise", reason: "G-assets failed" }).action, "ask-owner");
  assert.equal(productionDecision({ action: "auto-publish", reason: "x" }).action, "ask-owner");
  assert.deepEqual(productionDecision({ action: "auto-approve", reason: "ok" }), { action: "auto-approve", reason: "ok" });
  assert.deepEqual(productionDecision({ action: "block", reason: "retired" }), { action: "block", reason: "retired" });
  assert.deepEqual(productionDecision({ action: "ask-owner", reason: "r" }), { action: "ask-owner", reason: "r" });
});

test("retryStageFor re-renders after a failed quality gate only", () => {
  assert.equal(retryStageFor("qc", "gate-failure"), "render");
  assert.equal(retryStageFor("qc", "stage-error"), "qc");
  assert.equal(retryStageFor("assets", "gate-failure"), "assets");
  assert.equal(retryStageFor("voice", "stage-error"), "voice");
});

test("finalReason says presentation is the owner's call", () => {
  const t = finalReason("G-presentation has not run yet", ["G-presentation", "G-compliance", "G-claims"]);
  assert.match(t, /presentation/);
  assert.match(t, /your call/);
  assert.equal(finalReason("ok", []), "ok");
});

test("addGateIssues fails the gate and keeps the original issues", () => {
  const g = { gate: "G-assets" as const, passed: true, issues: [], executor: "x" };
  assert.equal(addGateIssues(g, []), g);
  const r = addGateIssues(g, ["Confirm the commercial-use terms for cloudflare in Settings"]);
  assert.equal(r.passed, false);
  assert.equal(r.issues.length, 1);
  assert.equal(r.gate, "G-assets");
});

test("onlyTermsIssues recognises the provider terms messages from asset-plan", () => {
  const unknown = providerTermsIssues([{ title: "a", provider: "cloudflare", kind: "image" }], []);
  const no = providerTermsIssues([{ title: "a", provider: "agnes", kind: "image" }], [{ name: "agnes", kind: "image", commercialOk: "no" }]);
  assert.equal(onlyTermsIssues(unknown), true);
  assert.equal(onlyTermsIssues(no), true);
  assert.equal(onlyTermsIssues([...unknown, "shot-01: no licence or permission note"]), false);
  assert.equal(onlyTermsIssues([]), false);
});

test("failedOrdersMessage names each shot and stays short", () => {
  assert.equal(failedOrdersMessage([{ shotRef: "shot-02", error: "Hermes returned a file path" }]), "shot-02: Hermes returned a file path");
  const long = failedOrdersMessage(Array.from({ length: 30 }, (_, i) => ({ shotRef: `shot-${i}`, error: "x".repeat(50) })));
  assert.ok(long.length <= 500);
  assert.match(long, /\.\.\.$/);
  assert.equal(failedOrdersMessage([]), "An asset could not be made");
  assert.match(failedOrdersMessage([{ shotRef: "s", error: " " }]), /no reason given/);
});

test("renderLicenseText lists the inputs and is capped", () => {
  const t = renderLicenseText([{ title: "shot-01", provider: "cloudflare", license: "AI generated" }]);
  assert.match(t, /shot-01 \(cloudflare\): AI generated/);
  assert.ok(renderLicenseText(Array.from({ length: 200 }, () => ({ title: "t", provider: "p", license: "l".repeat(50) }))).length <= 1800);
});

test("captionLines cuts the script into short lines", () => {
  const lines = captionLines("One short sentence. Another short sentence here. " + "word ".repeat(100));
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => l.length <= 90));
  assert.deepEqual(captionLines(""), []);
});

test("asUuid accepts only uuids", () => {
  assert.equal(asUuid("0b3b1f4e-5b0c-4a63-9a61-0f0f0f0f0f0f"), "0b3b1f4e-5b0c-4a63-9a61-0f0f0f0f0f0f");
  assert.equal(asUuid("nope"), null);
  assert.equal(asUuid(5), null);
});

test("productionSummary describes each stage", () => {
  assert.equal(productionSummary("assets", { done: 3, providers: ["cloudflare", "agnes"] }), "3 images ready from cloudflare, agnes");
  assert.equal(productionSummary("assets", { done: 1 }), "1 image ready");
  assert.equal(productionSummary("voice", { provider: "kokoro", narrationSec: 44.6 }), "Narration by kokoro, 45 seconds");
  assert.equal(productionSummary("render", { durationSec: 45 }), "Video rendered, 45 seconds");
  assert.equal(productionSummary("qc", null), "Quality check finished");
});
