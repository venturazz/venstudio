import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { knownMaterials } from "../server/voxel-known.ts";
import { checkLine, sketchOf, sketchText, voxelise } from "./voxel.ts";

// The pack's real compiler, imported at runtime so TypeScript does not try to type a browser module: the whole point of
// this test is that the portal's reading and the page's reading are the same one.
const PACK = path.resolve(import.meta.dirname, "../../../../styles/packs/voxel-build/render/world.js");
const MAP = path.resolve(import.meta.dirname, "../../../../styles/packs/voxel-build/render/assets/vendor/blockmap.json");
const world = (await import(new URL(`file://${PACK}`).href)) as {
  compileParts: (parts: unknown, opts?: { known?: Set<string> }) => { nodes: unknown[]; notes: string[]; size: number[] };
};
const known = knownMaterials("voxel-build") ?? new Set<string>();
const mapNames = new Set(Object.keys(JSON.parse(readFileSync(MAP, "utf8")) as Record<string, unknown>));

const GATE = [
  { kind: "walls", at: [1, 0, 0], size: [11, 7, 3], material: "mcl_core:stonebrick", openings: [{ at: [4, 0], w: 2, h: 4 }] },
  { kind: "roof", at: [0, 7, 0], size: [13, 3], style: "gable", rise: 3, material: "mcl_core:wood" },
  { kind: "cylinder", at: [0, 0, 0], radius: 2, height: 12, material: "mcl_core:cobble" },
];

const PLANE = [
  { kind: "box", at: [-1, 4, -6], size: [3, 3, 10], material: "mcl_core:brick_block" },
  { kind: "box", at: [-10, 5, -1], size: [21, 1, 4], material: "mcl_core:snowblock" },
  { kind: "box", at: [-4, 6, -8], size: [9, 1, 2], material: "mcl_core:snowblock" },
  { kind: "box", at: [-4, 0, -1], size: [2, 2, 2], material: "mcl_core:obsidian" },
  { kind: "box", at: [3, 0, -1], size: [2, 2, 2], material: "mcl_core:obsidian" },
];

test("the portal's compiler and the pack's compiler build the same thing", () => {
  for (const [name, parts] of [["gate", GATE], ["plane", PLANE], ["with the kit's own names", PLANE.slice(0, 1)]] as const) {
    const a = voxelise(parts, known);
    const b = world.compileParts(parts, { known });
    assert.equal(a.blocks, b.nodes.length, `${name}: block count`);
    assert.deepEqual(a.size, b.size, `${name}: bounds the camera frames`);
    assert.deepEqual(a.notes, b.notes, `${name}: the decisions each had to make alone`);
    // Node for node, in the same order: overwriting a cell means the later part wins in both.
    assert.deepEqual(a.nodes.map((n) => [n[0], n[1], n[2], n[3]]), (b.nodes as number[][]).map((n) => [n[0], n[1], n[2], n[3]]), `${name}: nodes`);
  }
});

test("a material the pack does not have is a note in both, never a silent swap", () => {
  const parts = [{ kind: "box", at: [0, 0, 0], size: [2, 2, 2], material: "mcl_core:iron" }];
  const a = voxelise(parts, known);
  const b = world.compileParts(parts, { known });
  assert.deepEqual(a.notes, b.notes);
  assert.deepEqual(a.nodes.map((n) => n[3]), b.nodes.map((n) => (n as string[])[3]));
  assert.match(a.notes[0] ?? "", /is not a block this pack has/);
});

test("symmetry is counted, not guessed: a mirrored build is equal on both sides", () => {
  const symmetric = sketchOf(PLANE, known).check;
  assert.equal(symmetric.symmetry.x[0], symmetric.symmetry.x[1], "the wings reach the same distance on both sides");
  // Nose and tail are not mirrored on this plane, and the check says so instead of pretending it is a defect of the render.
  assert.notEqual(symmetric.symmetry.z[0], symmetric.symmetry.z[1]);
  assert.match(checkLine(symmetric), /asymmetric z/);
  const lopsided = sketchOf([{ kind: "box", at: [0, 0, 0], size: [8, 1, 1], material: "mcl_core:wood" }], known).check;
  assert.notDeepEqual(lopsided.symmetry.x[0], lopsided.symmetry.x[1]);
  assert.match(checkLine(lopsided), /asymmetric x/);
});

test("the ground gap says whether it stands or floats", () => {
  assert.equal(sketchOf(PLANE, known).check.groundGap, 0, "the wheels reach the ground");
  assert.equal(sketchOf([{ kind: "box", at: [0, 4, 0], size: [2, 2, 2], material: "mcl_core:wood" }], known).check.groundGap, 4);
  assert.match(checkLine(sketchOf([{ kind: "box", at: [0, 4, 0], size: [2, 2, 2], material: "mcl_core:wood" }], known).check), /floats 4 above the ground/);
});

test("the drawings show the shape, and nothing is cropped away", () => {
  const s = sketchOf(PLANE, known);
  assert.ok(s.top.length >= 4 && s.top.length <= 22, "rows stay within the character budget");
  assert.ok(s.top.join("").includes("#"));
  // A monoplane from above is one long row of wing: the widest line must be wider than the fuselage.
  const widest = Math.max(...s.top.map((r) => r.split("").filter((ch) => ch === "#").length));
  assert.ok(widest >= 15, `the wing spans the drawing (widest row ${widest})`);
  // Height is drawn upwards: the lowest row of the side view is the ground row and has blocks in it.
  assert.match(s.side[s.side.length - 1] ?? "", /#/, "the last side row is the ground, and the wheels are on it");
  assert.match(sketchText(s), /seen from above/);
  assert.match(sketchText(s), /seen from the side/);
});

test("a build wider than the character budget is sampled, never cut at the edge", () => {
  const wide = [{ kind: "box", at: [-30, 0, 0], size: [61, 1, 1], material: "mcl_core:wood" }];
  const s = sketchOf(wide, known);
  assert.ok(s.top[0]!.length <= 44, "columns stay within the budget");
  assert.ok(s.top[0]!.startsWith("#") && s.top[0]!.endsWith("#"), "both ends of the span are still drawn");
});

test("nothing built is said out loud, not drawn as an empty frame", () => {
  const s = sketchOf([{ kind: "box", at: [0, -4, 0], size: [2, 2, 2], material: "mcl_core:wood" }], known);
  assert.equal(s.check.blocks, 0);
  assert.match(s.check.notes.join(" "), /nothing was built/);
});