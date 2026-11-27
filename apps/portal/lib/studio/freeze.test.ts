import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, payloadSha256, frozenRender, shortSha } from "./freeze.ts";

test("canonical JSON ignores key order and drops undefined, so the same payload hashes the same", () => {
  const a = { b: 1, a: [1, { z: 2, y: 3 }] };
  const b = { a: [1, { y: 3, z: 2 }], b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(payloadSha256(a), payloadSha256(b));
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test("a different story hashes differently: the freeze covers what was drawn", () => {
  const church = { shots: [{ seconds: 4, intent: { structure: "church", action: "build" } }] };
  const gate = { shots: [{ seconds: 4, intent: { parts: [{ kind: "walls", at: [0, 0, 0] }] } }] };
  assert.notEqual(payloadSha256(church), payloadSha256(gate));
  // One block of difference is enough — this is how a composed run stops being "close enough" to another.
  const moved = { shots: [{ seconds: 4, intent: { parts: [{ kind: "walls", at: [0, 1, 0] }] } }] };
  assert.notEqual(payloadSha256(gate), payloadSha256(moved));
});

test("the frozen record names the payload and the pack that draws it", () => {
  const f = frozenRender({ shots: [] }, { id: "voxel-build", version: "0.5.0" });
  assert.equal(f.pack, "voxel-build@0.5.0");
  assert.equal(f.short, shortSha(f.sha256));
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
  // A run without a pack freezes the payload alone rather than pretending to a pack it never had.
  assert.equal(frozenRender({ shots: [] }, null).pack, undefined);
});