/**
 * Renders every vendored stills pack's fixture (styles/packs/<id>/fixtures/payload.json) through the real worker
 * render-video handler, measures it with qc-video, and checks it against the pack's fixtures/expect.json and the
 * portal's technical gate with that style's template. The Remotion pack's fixture is venstudio's golden, rendered by
 * remotion-render.test.ts from the project assembled out of the vendored pack (see .github/workflows/ci.yml).
 *
 * Skipped without ffmpeg (CI installs it before the worker tests). VENSTUDIO_PACKS_OUT=<dir> keeps the videos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlers, makeWavPcm16, type JobContext } from "./venstudio-worker.ts";
import { technicalReportFor } from "../portal/lib/studio/qc-result.ts";
import { seedTemplates } from "../portal/lib/studio/templates.ts";

const STYLES = new URL("../../styles/", import.meta.url);
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const lock = JSON.parse(readFileSync(new URL("lock.json", STYLES), "utf8")) as { packs: Array<{ id: string; engine: string }> };
const stills = lock.packs.filter((p) => p.engine === "ffmpeg-stills").map((p) => p.id);

/** Placeholder asset ids ("asset-shot-01") to the UUIDs the worker requires, everywhere the payload names them. */
function withUuids(payload: Record<string, unknown>): { payload: Record<string, unknown>; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const uuid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `5e1f0000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
    return ids.get(id) as string;
  };
  const p = structuredClone(payload) as Record<string, unknown> & { shots: Array<Record<string, unknown>>; inputs: string[] };
  p.shots = p.shots.map((s) => ({ ...s, assetId: uuid(String(s.assetId)) }));
  p.narrationAssetId = uuid(String(p.narrationAssetId));
  p.inputs = p.inputs.map(uuid);
  return { payload: p, ids };
}

function sine(seconds: number, rate = 24000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 196 * i) / rate) * 0.3 * 32767), true);
  return makeWavPcm16(rate, 1, pcm);
}

function ctxFor(workDir: string, home: string, type: string, payload: Record<string, unknown>, files: Map<string, string>, kept: Map<string, string>): JobContext {
  return {
    job: { id: `eeeeeeee-6666-4666-8666-${type === "qc-video" ? "000000000002" : "000000000001"}`, type: type as JobContext["job"]["type"], payload, capability: "ffmpeg", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home,
    signal: new AbortController().signal,
    progress: () => {},
    download: async (assetId, dest) => {
      const src = files.get(assetId);
      if (!src) throw new Error(`no such input ${assetId}`);
      await copyFile(src, dest);
      return { bytes: (await readFile(dest)).length, sha256: "" };
    },
    upload: async (name, file) => {
      const keep = path.join(home, `uploaded-${name}`);
      await copyFile(file, keep);
      kept.set(name, keep);
      return { bytes: (await readFile(keep)).length, sha256: "" };
    },
  };
}

test("the vendored stills packs are the six migrated styles", () => {
  assert.deepEqual(stills, ["ambient-loop", "documentary", "horror-narration", "mystery-narration", "story-read-aloud", "travel-documentary"]);
});

for (const id of stills) {
  test(`stills pack ${id}: its fixture renders and passes the technical gate`, { skip: hasFfmpeg ? false : "ffmpeg is not installed", timeout: 10 * 60_000 }, async (t) => {
    const raw = JSON.parse(readFileSync(new URL(`packs/${id}/fixtures/payload.json`, STYLES), "utf8")) as Record<string, unknown>;
    const expect = JSON.parse(readFileSync(new URL(`packs/${id}/fixtures/expect.json`, STYLES), "utf8")) as { format: "short" | "long"; width: number; height: number; fps: number; durationSec: number; durationToleranceSec: number };
    const { payload } = withUuids(raw);
    const home = await mkdtemp(path.join(os.tmpdir(), `vs-pack-${id}-`));
    t.after(() => rm(home, { recursive: true, force: true }));
    const files = new Map<string, string>();
    const colors = ["0x264653", "0x2a9d8f", "0xe9c46a", "0xf4a261", "0xe76f51"];
    for (const [i, s] of (payload.shots as Array<{ assetId: string }>).entries()) {
      const f = path.join(home, `shot-${i}.png`);
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${colors[i % colors.length]}:s=540x960,drawgrid=w=60:h=60:t=3:c=white@0.5`, "-frames:v", "1", f]);
      files.set(s.assetId, f);
    }
    const narration = path.join(home, "narration.wav");
    await writeFile(narration, sine(Number(payload.narrationSec)));
    files.set(String(payload.narrationAssetId), narration);

    const kept = new Map<string, string>();
    const work = path.join(home, "work", "render");
    await mkdir(work, { recursive: true });
    const result = await handlers["render-video"](ctxFor(work, home, "render-video", payload, files, kept));
    assert.equal(result.width, expect.width);
    assert.equal(result.height, expect.height);
    assert.equal(result.fps, expect.fps);
    assert.ok(Math.abs(Number(result.durationSec) - expect.durationSec) <= expect.durationToleranceSec, `duration ${String(result.durationSec)}, expected ${expect.durationSec}`);
    const video = kept.get("video.mp4") as string;
    assert.ok(video, "video.mp4 was uploaded");

    const qcFiles = new Map([["dddddddd-7777-4777-8777-000000000001", video]]);
    const qcWork = path.join(home, "work", "qc");
    await mkdir(qcWork, { recursive: true });
    const qc = await handlers["qc-video"](ctxFor(qcWork, home, "qc-video", { inputs: ["dddddddd-7777-4777-8777-000000000001"] }, qcFiles, kept));
    const template = seedTemplates().find((x) => x.styleId === id) ?? null;
    const report = technicalReportFor({ status: "succeeded", result: qc }, template, expect.format, `tpl-${id}`, result.sceneStarts);
    assert.deepEqual(report.gate.issues, [], `${id}: G-technical`);
    assert.equal(report.gate.passed, true);

    const out = process.env.VENSTUDIO_PACKS_OUT;
    if (out) {
      await mkdir(out, { recursive: true });
      await copyFile(video, path.join(out, `${id}.mp4`));
    }
  });
}
