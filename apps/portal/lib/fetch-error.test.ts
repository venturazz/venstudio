import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFetchError, explainFetchFailure, isInternalHost } from "./fetch-error.ts";

const HERMES = { name: "Hermes", internal: "http://<hermes container name>:8642" };
const ROUTER = { name: "9router", internal: "http://<9router container name>:20128" };
const INTERNAL_URL = "http://hermes-9h8uxekbmieshvnsqhkrtlsq:8642/v1/chat/completions";
const PUBLIC_URL = "https://hermes.example.com/v1/chat/completions";
// 14:05 UTC
const AT = Date.UTC(2026, 10, 22, 14, 5, 0);

const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
const abortTimeout = (phase?: "connect" | "response") => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError", ...(phase ? { phase } : {}) });

test("classifyFetchError tells a connect failure from a late answer", () => {
  assert.equal(classifyFetchError(fetchFailed("UND_ERR_CONNECT_TIMEOUT")), "connect-timeout");
  assert.equal(classifyFetchError(fetchFailed("ETIMEDOUT")), "connect-timeout");
  assert.equal(classifyFetchError(fetchFailed("UND_ERR_HEADERS_TIMEOUT")), "response-timeout");
  assert.equal(classifyFetchError(fetchFailed("UND_ERR_BODY_TIMEOUT")), "response-timeout");
  assert.equal(classifyFetchError(fetchFailed("ECONNREFUSED")), "refused");
  assert.equal(classifyFetchError(fetchFailed("ENOTFOUND")), "dns");
  assert.equal(classifyFetchError(fetchFailed("EAI_AGAIN")), "dns");
  assert.equal(classifyFetchError(fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID")), "tls");
  // A bare AbortSignal timeout cannot say where it stopped, unless the transport marked the phase.
  assert.equal(classifyFetchError(abortTimeout()), "timeout");
  assert.equal(classifyFetchError(Object.assign(new Error("aborted"), { name: "AbortError" })), "timeout");
  assert.equal(classifyFetchError(abortTimeout("response")), "response-timeout");
  assert.equal(classifyFetchError(abortTimeout("connect")), "connect-timeout");
  // The transport in hermes-transport.ts sets the code on the error itself too.
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { name: "TimeoutError", phase: "response", cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })), "response-timeout");
  assert.equal(classifyFetchError(new Error("something else")), "other");
  assert.equal(classifyFetchError(null), "other");
});

test("isInternalHost: container names and private addresses are internal, public domains are not", () => {
  assert.equal(isInternalHost("hermes-9h8uxekbmieshvnsqhkrtlsq:8642"), true);
  assert.equal(isInternalHost(INTERNAL_URL), true);
  assert.equal(isInternalHost("localhost"), true);
  assert.equal(isInternalHost("http://127.0.0.1:3299"), true);
  assert.equal(isInternalHost("10.0.1.7:8642"), true);
  assert.equal(isInternalHost("http://[::1]:8642/v1"), true);
  assert.equal(isInternalHost(PUBLIC_URL), false);
  assert.equal(isInternalHost("9router.example.com"), false);
  assert.equal(isInternalHost("http://8.8.8.8:20128"), false);
});

test("a late answer on the owner's internal Hermes says busy or long, never can't reach", () => {
  const e = explainFetchFailure(abortTimeout("response"), INTERNAL_URL, HERMES, 600_000, { retryAt: AT });
  assert.equal(e.kind, "response-timeout");
  assert.equal(e.error, "Hermes accepted the request but hadn't finished after 10 min");
  assert.equal(e.hint, "It may be busy (another chat or render) or the step is long. The studio will try again at 14:05 UTC.");
  assert.doesNotMatch(`${e.error} ${e.hint}`, /can't reach|internal address|firewall|Cloudflare/);
  // Without a retry time (a one-off call) the text names none.
  const once = explainFetchFailure(fetchFailed("UND_ERR_HEADERS_TIMEOUT"), INTERNAL_URL, HERMES, 60_000);
  assert.equal(once.hint, "It may be busy (another chat or render) or the step is long.");
  assert.equal(once.error, "Hermes accepted the request but hadn't finished after 1 min");
});

test("a late answer is slow on a public domain too: the address hint is only for connect failures", () => {
  const e = explainFetchFailure(fetchFailed("UND_ERR_BODY_TIMEOUT"), PUBLIC_URL, HERMES, 240_000);
  assert.match(e.error, /^Hermes accepted the request but hadn't finished after 4 min$/);
  assert.doesNotMatch(e.hint, /internal address/);
});

test("a connect failure to a public domain keeps the internal address hint; to an internal name it does not", () => {
  const pub = explainFetchFailure(fetchFailed("UND_ERR_CONNECT_TIMEOUT"), PUBLIC_URL, HERMES, 180_000);
  assert.equal(pub.kind, "connect-timeout");
  assert.match(pub.error, /^Could not connect to hermes\.example\.com in time$/);
  assert.match(pub.hint, /can't reach that address\. If Hermes runs on the same server, use its internal address instead of the public domain \(http:\/\/<hermes container name>:8642/);
  const int = explainFetchFailure(fetchFailed("UND_ERR_CONNECT_TIMEOUT"), INTERNAL_URL, HERMES, 180_000);
  assert.doesNotMatch(int.hint, /internal address instead|public domain|Cloudflare/);
  assert.match(int.hint, /That is an internal address, so check that Hermes is running and that both apps share the Docker network/);
});

test("refused and DNS failures keep their plain reasons", () => {
  const refused = explainFetchFailure(fetchFailed("ECONNREFUSED"), INTERNAL_URL, HERMES, 180_000);
  assert.equal(refused.error, "hermes-9h8uxekbmieshvnsqhkrtlsq:8642 refused the connection");
  assert.match(refused.hint, /isn't listening on that address and port/);
  const dns = explainFetchFailure(fetchFailed("ENOTFOUND"), INTERNAL_URL, HERMES, 180_000);
  assert.equal(dns.error, "The name hermes-9h8uxekbmieshvnsqhkrtlsq:8642 doesn't resolve");
  assert.match(dns.hint, /share a Docker network/);
});

test("9router (fetch, phase unknown): an internal address says busy or stopped; a public one names both causes", () => {
  const int = explainFetchFailure(abortTimeout(), "http://127.0.0.1:3297/v1/models", ROUTER, 60_000);
  assert.equal(int.error, "No answer from 127.0.0.1:3297 within 1 min");
  assert.equal(int.hint, "9router may be busy or slow, or stopped. The address is already internal, so the address is not the problem.");
  const pub = explainFetchFailure(abortTimeout(), "https://9router.example.com/v1/models", ROUTER, 60_000);
  assert.match(pub.hint, /^9router may be busy or slow, or the portal container can't reach that address\. If 9router runs on the same server, use its internal address/);
  const short = explainFetchFailure(abortTimeout(), "http://127.0.0.1:3297/v1/models", ROUTER, 15_000);
  assert.equal(short.error, "No answer from 127.0.0.1:3297 within 15 s");
});
