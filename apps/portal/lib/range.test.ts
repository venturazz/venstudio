import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "./range.ts";
import { normalizeGatewayBase } from "./gateway-url.ts";

test("parseRange handles the forms browsers send", () => {
  assert.equal(parseRange(null, 1000), null);
  assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=0-1", 1000), { start: 0, end: 1 });
  assert.deepEqual(parseRange("bytes=500-2000", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.equal(parseRange("bytes=1000-", 1000), "invalid");
  assert.equal(parseRange("bytes=5-1", 1000), "invalid");
  assert.equal(parseRange("bytes=0-1,5-9", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
});

test("9router base URL works with or without /v1", () => {
  assert.equal(normalizeGatewayBase("https://9r.example.com/v1"), "https://9r.example.com");
  assert.equal(normalizeGatewayBase("https://9r.example.com/v1/"), "https://9r.example.com");
  assert.equal(normalizeGatewayBase("http://host.docker.internal:20128"), "http://host.docker.internal:20128");
  assert.equal(normalizeGatewayBase(" https://9r.example.com/ "), "https://9r.example.com");
});
