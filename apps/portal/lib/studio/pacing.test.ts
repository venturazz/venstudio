import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffMs,
  busyDelayMs,
  classifyReplyFailure,
  classifyStatus,
  clockUtc,
  gateConcurrency,
  giveUpMessage,
  HERMES_WAIT_GIVE_UP_MS,
  looksRateLimited,
  MAX_RETRY_AFTER_MS,
  MIN_WAIT_MS,
  orderFailureCause,
  parseRetryAfter,
  pauseMessage,
  readTime,
  systemicPause,
  waitExpired,
  waitingText,
} from "./pacing.ts";

const NOW = Date.UTC(2026, 10, 21, 14, 0, 0);

test("parseRetryAfter reads delay seconds", () => {
  assert.equal(parseRetryAfter("5", NOW), 5000);
  assert.equal(parseRetryAfter(" 1.5 ", NOW), 1500);
  assert.equal(parseRetryAfter("0", NOW), 0);
});

test("parseRetryAfter reads an HTTP date and clamps the past to zero", () => {
  assert.equal(parseRetryAfter("Sat, 21 Nov 2026 14:02:00 GMT", NOW), 120_000);
  assert.equal(parseRetryAfter("Sat, 21 Nov 2026 13:00:00 GMT", NOW), 0);
});

test("parseRetryAfter returns null for missing or unreadable values", () => {
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter(undefined, NOW), null);
  assert.equal(parseRetryAfter("", NOW), null);
  assert.equal(parseRetryAfter("soon", NOW), null);
  assert.equal(parseRetryAfter("-3", NOW), null);
  assert.equal(parseRetryAfter("12abc", NOW), null);
});

test("backoffMs doubles per consecutive rate limit and stops at the cap", () => {
  assert.equal(backoffMs(1), BACKOFF_BASE_MS);
  assert.equal(backoffMs(2), BACKOFF_BASE_MS * 2);
  assert.equal(backoffMs(3), BACKOFF_BASE_MS * 4);
  assert.equal(backoffMs(50), BACKOFF_CAP_MS);
  assert.equal(backoffMs(0), BACKOFF_BASE_MS);
  assert.equal(backoffMs(Number.NaN), BACKOFF_BASE_MS);
  assert.equal(backoffMs(3, 1000, 2500), 2500);
});

test("busyDelayMs prefers Retry-After, bounded on both sides", () => {
  assert.equal(busyDelayMs(2000, 5), 2000);
  assert.equal(busyDelayMs(0, 1), MIN_WAIT_MS);
  assert.equal(busyDelayMs(24 * 3_600_000, 1), MAX_RETRY_AFTER_MS);
  assert.equal(busyDelayMs(null, 2), BACKOFF_BASE_MS * 2);
});

test("classifyStatus sorts statuses into busy, auth, client and server", () => {
  assert.equal(classifyStatus(200), null);
  assert.equal(classifyStatus(429), "busy");
  assert.equal(classifyStatus(503), "busy");
  assert.equal(classifyStatus(401), "auth");
  assert.equal(classifyStatus(403), "auth");
  assert.equal(classifyStatus(400), "client");
  assert.equal(classifyStatus(404), "client");
  assert.equal(classifyStatus(422), "client");
  assert.equal(classifyStatus(408), "server");
  assert.equal(classifyStatus(500), "server");
  assert.equal(classifyStatus(502), "server");
});

test("looksRateLimited spots rate-limit text in short replies only", () => {
  assert.equal(looksRateLimited("All providers are rate limited, try again later"), true);
  assert.equal(looksRateLimited('{"status":"error","error":"upstream returned 429"}'), true);
  assert.equal(looksRateLimited("Too Many Requests"), true);
  assert.equal(looksRateLimited("The model is overloaded"), true);
  assert.equal(looksRateLimited("Fake provider chain is down"), false);
  assert.equal(looksRateLimited(""), false);
  assert.equal(looksRateLimited(`rate limit ${"x".repeat(3000)}`), false);
  assert.equal(classifyReplyFailure("rate-limited by provider"), "busy");
  assert.equal(classifyReplyFailure("not json"), "content");
});

test("orderFailureCause keeps one systemic cause and ignores model-specific client errors", () => {
  assert.equal(orderFailureCause(["auth", "auth", "client", "auth"]), "auth");
  assert.equal(orderFailureCause(["unreachable", "unreachable"]), "unreachable");
  assert.equal(orderFailureCause(["unreachable", "server"]), "unreachable");
  assert.equal(orderFailureCause(["content", "auth"]), "content");
  assert.equal(orderFailureCause(["client"]), "client");
  assert.equal(orderFailureCause([]), "content");
});

test("systemicPause pauses only when the first shots fail with the same systemic cause", () => {
  assert.deepEqual(systemicPause(["auth", "auth"]), { pause: true, cause: "auth" });
  assert.deepEqual(systemicPause(["unreachable", "unreachable", "ok"]), { pause: true, cause: "unreachable" });
  assert.deepEqual(systemicPause(["auth"]), { pause: false });
  assert.deepEqual(systemicPause(["ok", "auth", "auth"]), { pause: false });
  assert.deepEqual(systemicPause(["auth", "unreachable"]), { pause: false });
  assert.deepEqual(systemicPause(["content", "content"]), { pause: false });
  assert.deepEqual(systemicPause(["client", "client"]), { pause: false });
  assert.deepEqual(systemicPause(["server", "server", "server"], 3), { pause: true, cause: "server" });
});

test("pauseMessage names the cause, says nothing failed and fits the limit", () => {
  const msg = pauseMessage("auth", 2, `Hermes rejected the key (HTTP 401). ${"x".repeat(800)}`);
  assert.ok(msg.startsWith("Paused after the first 2 shots failed the same way: Hermes rejected the key"));
  assert.ok(msg.includes("press Retry"));
  assert.ok(msg.length <= 500);
  assert.ok(msg.endsWith("..."));
  assert.ok(!pauseMessage("unreachable", 2, "").includes("Last error"));
});

test("waitingText shows the next try as HH:MM UTC with a plain countdown", () => {
  const until = NOW + 3 * 60_000;
  assert.equal(clockUtc(until), "14:03");
  assert.equal(waitingText(until, NOW), "Waiting for Hermes (rate limited), next try at 14:03 UTC, in about 3 min");
  assert.equal(waitingText(NOW + 20_000, NOW), "Waiting for Hermes (rate limited), next try at 14:00 UTC, in under a minute");
  assert.match(waitingText(NOW - 1, NOW), /any moment now$/);
  assert.match(waitingText(until, NOW, "queue"), /^Waiting for Hermes \(busy with other studio work\)/);
});

test("waitExpired gives up only after the cap, and never without a start time", () => {
  assert.equal(waitExpired(new Date(NOW - HERMES_WAIT_GIVE_UP_MS - 1).toISOString(), NOW), true);
  assert.equal(waitExpired(new Date(NOW - 60_000).toISOString(), NOW), false);
  assert.equal(waitExpired(undefined, NOW), false);
  assert.equal(waitExpired("garbage", NOW), false);
  assert.equal(readTime(NOW), NOW);
  assert.equal(readTime(new Date(NOW)), NOW);
  assert.match(giveUpMessage(), /more than 3 hours/);
});

test("gateConcurrency defaults to 1 and bounds an override", () => {
  assert.equal(gateConcurrency(undefined), 1);
  assert.equal(gateConcurrency(""), 1);
  assert.equal(gateConcurrency("0"), 1);
  assert.equal(gateConcurrency("abc"), 1);
  assert.equal(gateConcurrency("3"), 3);
  assert.equal(gateConcurrency("99"), 8);
});
