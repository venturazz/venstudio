import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaUrlBase } from "./media-url.ts";

test("one origin is enough: the portal adds the prefix for each kind", () => {
  const origins = "http://hermes-files:8000";
  assert.equal(mediaUrlBase("image", { origins }), "http://hermes-files:8000/img");
  assert.equal(mediaUrlBase("audio", { origins }), "http://hermes-files:8000/tts");
  assert.equal(mediaUrlBase("video", { origins }), "http://hermes-files:8000/clip");
  assert.equal(mediaUrlBase("image", { origins: "http://hermes-files:8000/" }), "http://hermes-files:8000/img");
});

test("only the first origin of the list is the media base", () => {
  assert.equal(mediaUrlBase("video", { origins: " http://a:8777 , http://b:9000" }), "http://a:8777/clip");
});

test("a per-kind override wins, and an origin with its own path is kept as is", () => {
  assert.equal(mediaUrlBase("image", { override: "http://x:1/pics/", origins: "http://hermes-files:8000" }), "http://x:1/pics");
  assert.equal(mediaUrlBase("audio", { override: "  ", origins: "http://hermes-files:8000" }), "http://hermes-files:8000/tts");
  assert.equal(mediaUrlBase("image", { origins: "http://hermes-files:8000/files" }), "http://hermes-files:8000/files");
});

test("nothing set, or not an http URL, gives no media base", () => {
  assert.equal(mediaUrlBase("image", {}), null);
  assert.equal(mediaUrlBase("image", { origins: "" }), null);
  assert.equal(mediaUrlBase("image", { origins: "hermes-files:8000" }), null);
  assert.equal(mediaUrlBase("image", { origins: "ftp://hermes-files/x" }), null);
  assert.equal(mediaUrlBase("image", { override: "not a url" }), null);
});
