/**
 * Worker 0.7.0: payload.captionStyle and payload.audio, the long-job limits, and the chunked stills graph.
 *
 * The pure half runs anywhere. The ffmpeg half (skipped without ffmpeg) renders a short mix and measures it: the
 * integrated loudness lands near the target, and the looped bed is still playing after the narration stops.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_MIX_FILTERS,
  NonRetryableError,
  RENDER_LIMITS,
  STILLS_GRAPH_LIMITS,
  audioInputsFrom,
  audioMixFilter,
  audioSfxAssets,
  buildMuxArgs,
  buildRemotionProps,
  buildRenderArgs,
  buildStillsChunkArgs,
  captionLineChars,
  detectCapabilities,
  ffmpegHasFilter,
  handlers,
  makeWavPcm16,
  narrationFilter,
  parseAudioPlan,
  parseCaptionStyle,
  parseLoudness,
  parseRenderSpec,
  planStillsChunks,
  renderInputsOf,
  runFfmpeg,
  stillsConcatList,
  stillsChunkFile,
  type JobContext,
  type RenderSpec,
} from "./venstudio-worker.ts";
import { captionLayout } from "../render-remotion/src/props.ts";
import { RENDER_LIMITS as PORTAL_RENDER_LIMITS } from "../portal/lib/studio/render-limits.ts";
import { fixtureUuid, fixtureWithUuids, fixtureWithoutMix } from "./testdata/fixture.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const canMix = hasFfmpeg && AUDIO_MIX_FILTERS.every((f) => ffmpegHasFilter(f));
const BED = fixtureUuid("asset-bed");
const FONT = fixtureUuid("asset-font");

const golden060 = JSON.parse(readFileSync(new URL("./testdata/fixture-args-0.6.0.golden.json", import.meta.url), "utf8")) as {
  payload: Record<string, unknown>;
  stillsWithFont: unknown;
  stillsNoDrawtext: unknown;
  remotionMux: unknown;
  remotionProps: unknown;
};

const IMAGES = ["in/shot-0.png", "in/shot-1.png", "in/shot-2.png", "in/shot-3.png", "in/shot-4.png"];

test("a payload without captionStyle and audio renders with 0.6.0's arguments, byte for byte, on both engines", () => {
  // testdata/fixture-args-0.6.0.golden.json was captured from the 0.6.0 worker (git 266c911) on the golden fixture.
  const variants: Array<[string, Record<string, unknown>]> = [
    ["no fields", golden060.payload],
    ["null fields", { ...golden060.payload, captionStyle: null, audio: null }],
  ];
  for (const [label, payload] of variants) {
    const stills = parseRenderSpec({ ...payload, engine: "ffmpeg-stills" });
    assert.equal(stills.audio, undefined, label);
    assert.equal(stills.captionStyle, undefined, label);
    assert.deepEqual(buildRenderArgs(stills, { images: IMAGES, narration: "in/n.wav", output: "video.part.mp4", font: "in/f.ttf" }, { drawtext: true }), golden060.stillsWithFont, label);
    assert.deepEqual(buildRenderArgs(stills, { images: IMAGES, narration: "in/n.wav", output: "video.part.mp4" }, { drawtext: false }), golden060.stillsNoDrawtext, label);
    const spec = parseRenderSpec(payload);
    assert.deepEqual(buildMuxArgs(spec, "remotion.part.mp4", "in/n.wav", "video.part.mp4"), golden060.remotionMux, label);
    assert.deepEqual(buildRemotionProps(spec, { images: IMAGES, font: "f.ttf" }), golden060.remotionProps, label);
    assert.equal(planStillsChunks(stills), null, `${label}: a job 0.6.0 accepted is one graph`);
  }
});

test("the golden fixture's captionStyle and audio parse to the portal's numbers", () => {
  const spec = parseRenderSpec(fixtureWithUuids());
  assert.deepEqual(spec.captionStyle, {
    fontAssetId: FONT, fontSizePx: 78, minFontSizePx: 64, maxFontSizePx: 78, lineSpacingPx: 26, outlinePx: 7, shadowPx: 5,
    marginXPx: 51, marginBottomPx: 154, maxWidthPx: 978, narrowFace: false, safeAreaPct: 8,
  });
  assert.deepEqual(spec.audio, {
    master: { targetLufs: -14, maxTruePeakDb: -1 },
    bed: { assetId: BED, sourceLufs: -20, gainDb: 3.5, duck: { threshold: 0.02, ratio: 4, attackMs: 15, releaseMs: 350, makeup: 1 }, cover: "loop" },
    ambient: { color: "brown", bandHz: [90, 3200], gainDb: -26 },
    sfx: [],
  });
  assert.equal(spec.fontAssetId, FONT);
  // The worker downloads what it mixes and burns: the bed and the font are inputs.
  assert.ok(renderInputsOf(spec).includes(BED) && renderInputsOf(spec).includes(FONT));
});

test("bad captionStyle and audio fail as NonRetryable, naming the field", () => {
  const p = () => fixtureWithUuids() as Record<string, any>;
  const refuse = (mutate: (x: Record<string, any>) => void, re: RegExp) => {
    const x = p();
    mutate(x);
    assert.throws(() => parseRenderSpec(x), (e: Error) => e instanceof NonRetryableError && re.test(e.message), String(re));
  };
  refuse((x) => (x.captionStyle.fontSizePx = Number.NaN), /fontSizePx must be a number/);
  refuse((x) => (x.captionStyle.fontSizePx = "78"), /fontSizePx must be a number/);
  refuse((x) => (x.captionStyle.fontSizePx = 900), /fontSizePx/);
  refuse((x) => (x.captionStyle.fontSizePx = 90), /outside its own range/);
  refuse((x) => (x.captionStyle.outlinePx = 39), /outline swallows/);
  refuse((x) => (x.captionStyle.marginXPx = 600), /marginXPx/);
  refuse((x) => (x.captionStyle.maxWidthPx = 1080), /does not fit a 1080 px frame/);
  refuse((x) => (x.captionStyle.marginBottomPx = 961), /marginBottomPx/);
  const small = { fontAssetId: null, fontSizePx: 80, minFontSizePx: 80, maxFontSizePx: 80, lineSpacingPx: 100, outlinePx: 4, shadowPx: 3, marginXPx: 20, marginBottomPx: 180, maxWidthPx: 600, narrowFace: false, safeAreaPct: 8 };
  assert.throws(() => parseCaptionStyle(small, { width: 640, height: 360, inputs: [] }), /two lines of 80 px text do not fit above a 180 px bottom margin/);
  refuse((x) => (x.captionStyle.narrowFace = "yes"), /narrowFace/);
  refuse((x) => (x.captionStyle.fontAssetId = "asset-font"), /fontAssetId is not an asset id/);
  refuse((x) => (x.captionStyle.fontAssetId = "f1f70000-0000-4000-8000-0000000000aa"), /caption font is not listed in inputs/);
  refuse((x) => (x.fontAssetId = x.inputs[0]), /names font .* but the payload names/);
  refuse((x) => (x.captionStyle = []), /captionStyle: must be an object/);

  refuse((x) => (x.audio = "loud"), /audio: must be an object/);
  refuse((x) => delete x.audio.master, /master is missing/);
  refuse((x) => (x.audio.master.targetLufs = -16), /master.targetLufs is -16, but the payload targets -14/);
  refuse((x) => (x.audio.master.maxTruePeakDb = 3), /maxTruePeakDb/);
  refuse((x) => (x.audio.bed.cover = "stretch"), /cover must be "loop" or "trim"/);
  refuse((x) => (x.audio.bed.assetId = "asset-bed"), /bed.assetId is not an asset id/);
  refuse((x) => (x.audio.bed.assetId = "f1f70000-0000-4000-8000-0000000000bb"), /bed.assetId is not listed in inputs/);
  refuse((x) => (x.audio.bed.duck.ratio = 0.5), /duck.ratio/);
  refuse((x) => (x.audio.bed.duck.threshold = Infinity), /duck.threshold/);
  refuse((x) => (x.audio.bed.gainDb = 40), /bed.gainDb/);
  refuse((x) => delete x.audio.bed.duck, /bed.duck is missing/);
  refuse((x) => (x.audio.ambient.color = "purple"), /ambient.color must be one of brown, pink, white/);
  refuse((x) => (x.audio.ambient.bandHz = [3200, 90]), /bandHz/);
  refuse((x) => (x.audio.ambient.bandHz = [90]), /bandHz/);
  refuse((x) => (x.audio.ambient.gainDb = 6), /ambient.gainDb/);
  refuse((x) => (x.audio.sfx = "pop"), /sfx must be a list/);
  refuse((x) => (x.audio.sfx = [{ atSec: 30, assetId: x.inputs[5] }]), /sfx\[0\].atSec/);
  refuse((x) => (x.audio.sfx = [{ atSec: 3, assetId: "f1f70000-0000-4000-8000-0000000000cc" }]), /accent 1 is not listed in inputs/);
  refuse((x) => (x.audio.sfx = Array.from({ length: 121 }, () => ({ atSec: 1, assetId: x.inputs[5] }))), /121 accents; the limit is 120/);
  // bed null and ambient null are the plan saying "none", not bad data.
  const none = p();
  none.audio.bed = null;
  none.audio.ambient = null;
  assert.deepEqual(parseRenderSpec(none).audio, { master: { targetLufs: -14, maxTruePeakDb: -1 }, bed: null, ambient: null, sfx: [] });
  assert.equal(parseAudioPlan({ master: { targetLufs: -14, maxTruePeakDb: -1 } }, { durationSec: 5, targetLufs: -14, inputs: [] }).sfx.length, 0);
  assert.throws(() => parseCaptionStyle(null, { width: 1080, height: 1920, inputs: [] }), NonRetryableError);
});

test("the mix is one chain in the spec's order: voice, bed looped then trimmed and ducked by the voice, ambience, master", () => {
  const spec = parseRenderSpec(fixtureWithUuids());
  const graph = audioMixFilter(spec, audioInputsFrom(spec, 1));
  assert.deepEqual(graph.split(";"), [
    "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=24,atrim=duration=24,asplit=2[voice][duckkey]",
    "[2:a]aresample=48000,aformat=channel_layouts=stereo,aloop=loop=-1:size=1152000,atrim=duration=24,loudnorm=I=-20:TP=-1.5:LRA=11,aresample=48000,volume=3.5dB[bedlevel]",
    "[bedlevel][duckkey]sidechaincompress=threshold=0.02:ratio=4:attack=15:release=350:makeup=1[bed]",
    "anoisesrc=color=brown:sample_rate=48000:amplitude=1:seed=1:duration=24,highpass=f=90,lowpass=f=3200,volume=-26dB,aformat=channel_layouts=stereo[ambient]",
    "[voice][bed][ambient]amix=inputs=3:duration=first:dropout_transition=0,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo,atrim=duration=24[a]",
  ]);
  // The voice part is the 0.6.0 narration chain, so loudness and tempo behave as before.
  assert.ok(graph.startsWith(narrationFilter(spec, 1).replace(/\[a\]$/, "")));
});

test("loop vs trim, bed null, ambience null, accents, and a fitted tempo", () => {
  const base = parseRenderSpec(fixtureWithUuids());
  const audio = base.audio as NonNullable<RenderSpec["audio"]>;
  const withAudio = (a: Partial<NonNullable<RenderSpec["audio"]>>, over: Partial<RenderSpec> = {}): RenderSpec => ({ ...base, ...over, audio: { ...audio, ...a } });

  const trim = withAudio({ bed: { ...(audio.bed as NonNullable<typeof audio.bed>), cover: "trim" } });
  const trimGraph = audioMixFilter(trim, audioInputsFrom(trim, 1));
  assert.ok(trimGraph.includes("[2:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=24,apad=whole_dur=24,loudnorm=I=-20"));
  assert.ok(!trimGraph.includes("aloop"), "a bed long enough is trimmed, not looped");
  const loopGraph = audioMixFilter(base, audioInputsFrom(base, 1));
  assert.ok(loopGraph.indexOf("aloop=") < loopGraph.indexOf("atrim=duration=24,loudnorm=I=-20"), "aloop first, then atrim");

  const noBed = withAudio({ bed: null });
  assert.deepEqual(audioInputsFrom(noBed, 5), { narration: 5, bed: null, sfx: [] });
  const nb = audioMixFilter(noBed, audioInputsFrom(noBed, 5)).split(";");
  assert.equal(nb.length, 3, "voice, ambience, master");
  assert.ok(nb[0].endsWith("atrim=duration=24[voice]"), "no key for a duck when there is no bed");
  assert.ok(!nb.join(";").includes("sidechaincompress"));
  assert.ok(nb[2].startsWith("[voice][ambient]amix=inputs=2:"));
  // A spec that has a bed must be given the file: refusing beats mixing the wrong input.
  assert.throws(() => audioMixFilter(base, { narration: 1, bed: null, sfx: [] }), /no bed file/);

  const bare = withAudio({ bed: null, ambient: null });
  assert.deepEqual(audioMixFilter(bare, audioInputsFrom(bare, 1)).split(";"), [
    "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=24,atrim=duration=24[voice]",
    "[voice]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo,atrim=duration=24[a]",
  ]);

  const pop = "f1f70000-0000-4000-8000-0000000000d1";
  const whoosh = "f1f70000-0000-4000-8000-0000000000d2";
  const fx = withAudio({ sfx: [{ atSec: 1.5, assetId: pop }, { atSec: 9, assetId: whoosh }, { atSec: 15.25, assetId: pop }] });
  assert.deepEqual(audioSfxAssets(fx), [pop, whoosh]);
  assert.deepEqual(audioInputsFrom(fx, 1), { narration: 1, bed: 2, sfx: [3, 4] });
  const fg = audioMixFilter(fx, audioInputsFrom(fx, 1)).split(";");
  assert.ok(fg.includes("[3:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[fxsrc0_0][fxsrc0_1]"));
  assert.ok(fg.includes("[fxsrc0_0]adelay=1500|1500,apad=whole_dur=24,atrim=duration=24[fx0]"));
  assert.ok(fg.includes("[fxsrc0_1]adelay=15250|15250,apad=whole_dur=24,atrim=duration=24[fx1]"));
  assert.ok(fg.includes("[4:a]aresample=48000,aformat=channel_layouts=stereo[fxsrc1_0]"));
  assert.ok(fg.includes("[fx0][fx1][fx2]amix=inputs=3:duration=first:dropout_transition=0,volume=3[sfx]"));
  assert.ok(fg[fg.length - 1].startsWith("[voice][bed][ambient][sfx]amix=inputs=4:"));

  const fitted = withAudio({}, { narrationTempo: 1.05 });
  assert.ok(audioMixFilter(fitted, audioInputsFrom(fitted, 1)).startsWith("[1:a]atempo=1.05,loudnorm=I=-14"));
});

test("both engines take the mix: stills adds the bed after the narration, Remotion's mux after its video", () => {
  const spec = parseRenderSpec({ ...fixtureWithUuids(), engine: "ffmpeg-stills" });
  const plan = buildRenderArgs(spec, { images: IMAGES, narration: "in/n.wav", bed: "in/bed.wav", sfx: [], output: "video.part.mp4" }, { drawtext: false });
  const a = plan.args;
  assert.deepEqual(a.slice(a.indexOf("in/n.wav") - 1, a.indexOf("in/n.wav") + 3), ["-i", "in/n.wav", "-i", "in/bed.wav"]);
  const graph = a[a.indexOf("-filter_complex") + 1];
  assert.ok(graph.endsWith(audioMixFilter(spec, audioInputsFrom(spec, 5))));
  assert.ok(graph.includes("[6:a]aresample=48000"), "the bed is input 6, after five pictures and the narration");
  assert.throws(() => buildRenderArgs(spec, { images: IMAGES, narration: "in/n.wav", output: "o.mp4" }, { drawtext: false }), /no bed file/);

  const remotion = parseRenderSpec(fixtureWithUuids());
  const mux = buildMuxArgs(remotion, "remotion.part.mp4", "in/n.wav", "video.part.mp4", { bed: "in/bed.wav" });
  assert.deepEqual(mux.slice(4, 10), ["-i", "remotion.part.mp4", "-i", "in/n.wav", "-i", "in/bed.wav"]);
  assert.equal(mux[mux.indexOf("-filter_complex") + 1], audioMixFilter(remotion, audioInputsFrom(remotion, 1)));
  assert.ok(mux.join(" ").includes("-map 0:v:0 -map [a] -t 24 -c:v copy -c:a aac -b:a 160k -ar 48000 -movflags +faststart"));
  assert.throws(() => buildMuxArgs(remotion, "m.mp4", "n.wav", "o.mp4"), /no bed file/);
});

test("captions follow captionStyle on both engines; without it they keep today's look", () => {
  const spec = parseRenderSpec({ ...fixtureWithUuids(), engine: "ffmpeg-stills" });
  const plan = buildRenderArgs(spec, { images: IMAGES, narration: "in/n.wav", bed: "in/bed.wav", sfx: [], output: "o.mp4", font: "in/f.ttf" }, { drawtext: true });
  const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
  assert.ok(
    graph.includes(
      "[vc]drawtext=fontfile=in/f.ttf:textfile=cap0.txt:fontcolor=white:fontsize=78:borderw=7:bordercolor=black:" +
        "shadowcolor=black@0.6:shadowx=5:shadowy=5:line_spacing=26:x='max(51,(w-text_w)/2)':y=h-154-text_h:enable='between(t,0,3.38)'",
    ),
  );
  // 978 px of line at 78 px: 22 characters a line, so the longest caption wraps into two lines that fit.
  assert.equal(captionLineChars(spec), 22);
  assert.deepEqual(plan.captionFiles[1], { file: "cap1.txt", text: "The furnace reaches\n1400 degrees." });
  assert.equal(captionLineChars({ ...spec, captionStyle: { ...(spec.captionStyle as NonNullable<RenderSpec["captionStyle"]>), narrowFace: true } }), 27);
  assert.equal(captionLineChars({ width: 1080, height: 1920, captionStyle: undefined }), 32, "0.6.0's wrap width");

  const props = buildRemotionProps(parseRenderSpec(fixtureWithUuids()), { images: IMAGES, font: "f.ttf" });
  assert.equal(props.captionStyle?.fontSizePx, 78);
  assert.deepEqual(captionLayout(props.captionStyle, 1080, 1920), {
    boxed: false, fontSize: 78, lineHeight: (78 + 26) / 78, maxWidth: 978, paddingBottom: 154, strokeWidth: 14, textShadow: "5px 5px 0 rgba(0, 0, 0, 0.6)",
  });
  // No style: the dark card the template always drew.
  const old = captionLayout(undefined, 1080, 1920);
  assert.equal(old.boxed, true);
  assert.ok(Math.abs(old.fontSize - 45.36) < 1e-9 && old.maxWidth === 1080 * 0.86 && Math.abs(old.paddingBottom - 134.4) < 1e-9);
});

test("the worker's limits are the portal's, and they come from the catalogue: 600 shots, 1200 captions", () => {
  assert.deepEqual(RENDER_LIMITS, PORTAL_RENDER_LIMITS);
  assert.equal(RENDER_LIMITS.maxShots, 600);
  assert.equal(RENDER_LIMITS.maxCaptions, 1200);
});

/** A stills spec of n shots of `seconds`, at a small frame so the arithmetic is the point. */
function longSpec(n: number, seconds: number, transitionSec: number, captionsPerShot = 1): RenderSpec {
  const ids = Array.from({ length: n }, (_, i) => `aaaaaaaa-1111-4111-8111-${String(i + 1).padStart(12, "0")}`);
  const narr = "aaaaaaaa-1111-4111-8111-0000000ff0ff";
  const fade = n > 1 ? transitionSec : 0;
  const total = n * seconds - (n - 1) * fade;
  const captions = Array.from({ length: n * captionsPerShot }, (_, i) => {
    const len = total / (n * captionsPerShot);
    return { start: Math.round(i * len * 1000) / 1000, end: Math.round((i + 1) * len * 1000) / 1000, text: `Line ${i + 1} of the narration` };
  });
  return parseRenderSpec({
    width: 1920, height: 1080, fps: 30, engine: "ffmpeg-stills", transitionSec: fade,
    shots: ids.map((assetId, i) => ({ shotRef: `shot-${i + 1}`, assetId, seconds, motion: ["zoom-in", "pan-left", "zoom-out", "pan-right"][i % 4] })),
    narrationAssetId: narr, narrationSec: total, durationSec: Math.round(total * 1000) / 1000, captions, targetLufs: -14, inputs: [...ids, narr],
  });
}

test("a 600-shot, 20-minute job is planned in pieces of at most 60 inputs whose frames add up to the whole", () => {
  for (const fade of [0, 0.5]) {
    const spec = longSpec(600, 2 + fade, fade, 2);
    assert.ok(Math.abs(spec.durationSec - 1200) < 1, `${spec.durationSec}`);
    const chunks = planStillsChunks(spec) as NonNullable<ReturnType<typeof planStillsChunks>>;
    assert.ok(chunks && chunks.length >= 10, `fade ${fade}: ${chunks?.length} pieces`);
    const images = spec.shots.map((s) => `in/${s.assetId}.png`);
    let frame = 0;
    chunks.forEach((c, k) => {
      assert.equal(c.startFrame, frame, `piece ${k} starts where the one before ended`);
      frame += c.frames;
      assert.equal(c.first, k === 0 ? 0 : chunks[k - 1].last + 1, "every shot is in exactly one piece");
      assert.equal(c.head, fade > 0 && k > 0);
      assert.equal(c.trimLast, fade > 0 && k < chunks.length - 1);
      const plan = buildStillsChunkArgs(spec, c, { images, font: "in/f.ttf" }, { drawtext: true }, stillsChunkFile(k));
      const inputs = plan.args.filter((a) => a === "-i").length;
      assert.ok(inputs <= STILLS_GRAPH_LIMITS.shots, `piece ${k} opens ${inputs} inputs`);
      const graph = plan.args[plan.args.indexOf("-filter_complex") + 1];
      // Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN); stay well under it.
      assert.ok(graph.length < 100_000, `piece ${k} graph is ${graph.length} bytes`);
      assert.ok(plan.captionFiles.length <= STILLS_GRAPH_LIMITS.captions);
      assert.equal(plan.args[plan.args.indexOf("-frames:v") + 1], String(c.frames));
      assert.ok(plan.args.includes("-an"), "pieces are picture only; the soundtrack is mixed once, over the whole");
    });
    assert.equal(frame, Math.round(spec.durationSec * 30), `fade ${fade}: the pieces fill the whole timeline`);
  }
  assert.equal(stillsConcatList(2), "file 'chunk-000.mp4'\nfile 'chunk-001.mp4'\n");
});

test("pieces with fades cut one shot's zoompan in two, so the join shows the single graph's frames", () => {
  const spec = longSpec(4, 2.5, 0.5);
  const chunks = planStillsChunks(spec, { shots: 3, captions: 300 }) as NonNullable<ReturnType<typeof planStillsChunks>>;
  assert.deepEqual(chunks.map((c) => [c.first, c.last, c.startFrame, c.frames, c.head, c.trimLast]), [
    [0, 1, 0, 120, false, true],
    [2, 3, 120, 135, true, false],
  ]);
  const images = spec.shots.map((_, i) => `in/${i}.png`);
  const first = buildStillsChunkArgs(spec, chunks[0], { images }, { drawtext: false }, "a.mp4");
  const g1 = first.args[first.args.indexOf("-filter_complex") + 1];
  // Shot 2 (index 1) is zoompanned over its full 75 frames (+3 pad) and stops where its fade into shot 3 begins.
  assert.ok(g1.includes(":d=78:s=1920x1080:fps=30,format=yuv420p,trim=end_frame=60[v1]"), g1);
  assert.ok(g1.includes("[v0][v1]xfade=transition=fade:duration=0.5:offset=2[v]"));
  const second = buildStillsChunkArgs(spec, chunks[1], { images }, { drawtext: false }, "b.mp4");
  assert.deepEqual(second.args.filter((_, i, a) => a[i - 1] === "-i"), ["in/1.png", "in/2.png", "in/3.png"]);
  const g2 = second.args[second.args.indexOf("-filter_complex") + 1];
  assert.ok(g2.includes(":d=78:s=1920x1080:fps=30,format=yuv420p,trim=start_frame=60,setpts=PTS-STARTPTS[h]"), g2);
  // The fade into shot 3 is transition 2 of the whole video (slideup), at the start of the piece.
  assert.ok(g2.includes("[h][v2]xfade=transition=slideup:duration=0.5:offset=0[x2]"), g2);
  assert.ok(g2.includes("[x2][v3]xfade=transition=fade:duration=0.5:offset=2[v]"), g2);
  // A piece's captions run on the piece's own clock.
  const withCaps = longSpec(4, 2.5, 0.5);
  const cs = buildStillsChunkArgs(withCaps, chunks[1], { images, font: "f.ttf" }, { drawtext: true }, "b.mp4");
  // The piece runs from 4 s: caption 2 (2.125-4.25 s) is still on for its first 0.25 s, then captions 3 and 4.
  assert.deepEqual(cs.captionFiles.map((f) => f.file), ["cap1.txt", "cap2.txt", "cap3.txt"]);
  const g3 = cs.args[cs.args.indexOf("-filter_complex") + 1];
  assert.ok(g3.includes("enable='between(t,0,0.25)'") && g3.includes("enable='between(t,0.25,2.38)'"), g3);
});

test("a piece is cut shorter when its shots carry too many captions", () => {
  const spec = longSpec(70, 3, 0, 10);
  const chunks = planStillsChunks(spec) as NonNullable<ReturnType<typeof planStillsChunks>>;
  for (const c of chunks) assert.ok(c.last - c.first + 1 <= 30, `piece of ${c.last - c.first + 1} shots with 10 captions each`);
  assert.throws(() => planStillsChunks(longSpec(2, 3, 0, 400), { shots: 60, captions: 300 }), /carries more than 300 captions/);
});

test("audio-mix and caption-style are reported only by a worker with ffmpeg, audio-mix only with every filter of the chain", async (t) => {
  const prev = process.env.FFMPEG_PATH;
  t.after(() => {
    if (prev === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prev;
  });
  process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
  const none = await detectCapabilities();
  assert.ok(!none.includes("audio-mix") && !none.includes("caption-style"), none.join(","));
  if (prev === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = prev;
  if (hasFfmpeg) {
    const caps = await detectCapabilities();
    assert.equal(caps.includes("audio-mix"), canMix);
    assert.ok(caps.includes("caption-style"));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg: render and measure

function wavOf(seconds: number, parts: Array<{ from: number; to: number; hz: number; amp: number }>, rate = 48000): Uint8Array {
  const n = Math.round(seconds * rate);
  const pcm = new Uint8Array(n * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const p of parts) if (t >= p.from && t < p.to) v += Math.sin(2 * Math.PI * p.hz * t) * p.amp;
    dv.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true);
  }
  return makeWavPcm16(rate, 1, pcm);
}

/** RMS level (dB) of one band of a file's audio from `from` to `to` seconds, from astats' overall section. */
function bandRmsDb(file: string, from: number, to: number, hz: number): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", `atrim=start=${from}:end=${to},bandpass=f=${hz}:width_type=q:w=8,astats=metadata=0`, "-f", "null", "-"], { encoding: "utf8" });
  const all = [...r.stderr.matchAll(/RMS level dB:\s+(-?\d+(?:\.\d+)?|-inf)/g)];
  const v = Number(all[all.length - 1]?.[1]);
  return Number.isFinite(v) ? v : -200;
}

const A1 = "eeeeeeee-1111-4111-8111-000000000001";
const A2 = "eeeeeeee-1111-4111-8111-000000000002";
const NARR = "eeeeeeee-1111-4111-8111-0000000000ff";
const BED_ID = "eeeeeeee-1111-4111-8111-0000000000be";

function mixCtx(workDir: string, payload: Record<string, unknown>, files: Map<string, string>, kept: Map<string, string>): JobContext {
  return {
    job: { id: "eeeeeeee-2222-4222-8222-000000000001", type: "render-video", payload, capability: "ffmpeg", attempt: 1, leaseExpiresAt: "", heartbeatIntervalSeconds: 30 },
    workDir,
    home: workDir,
    signal: new AbortController().signal,
    progress: () => {},
    download: async (assetId, dest) => {
      const src = files.get(assetId);
      if (!src) throw new Error(`no such input ${assetId}`);
      await copyFile(src, dest);
      return { bytes: (await readFile(dest)).length, sha256: "" };
    },
    upload: async (name, file) => {
      const keep = path.join(path.dirname(workDir), `${path.basename(workDir)}-${name}`);
      await copyFile(file, keep);
      kept.set(name, keep);
      return { bytes: (await readFile(keep)).length, sha256: "" };
    },
  };
}

test("a real mix: loudness near the target, and the looped bed keeps playing after the narration stops", { skip: !canMix && "needs ffmpeg with the audio-mix filters", timeout: 180_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "vs-mix-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const files = new Map<string, string>();
  for (const [id, color] of [[A1, "0x8ecae6"], [A2, "0xffb703"]] as const) {
    const f = path.join(home, `${id}.png`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x320`, "-frames:v", "1", f]);
    files.set(id, f);
  }
  // Speech-like level for 4 s at 300 Hz, then 4 s of silence: the tail is where a bed that ran out would show.
  const narration = path.join(home, "narration.wav");
  await writeFile(narration, wavOf(8, [{ from: 0, to: 4, hz: 300, amp: 0.4 }]));
  files.set(NARR, narration);
  // A 2.5 s bed at 880 Hz: shorter than the cut, so it has to loop.
  const bed = path.join(home, "bed.wav");
  await writeFile(bed, wavOf(2.5, [{ from: 0, to: 2.5, hz: 880, amp: 0.3 }]));
  files.set(BED_ID, bed);
  const payloadFor = (withBed: boolean): Record<string, unknown> => ({
    format: "custom", width: 320, height: 320, fps: 15, engine: "ffmpeg-stills",
    shots: [{ shotRef: "s1", assetId: A1, seconds: 4, motion: "zoom-in" }, { shotRef: "s2", assetId: A2, seconds: 4, motion: "pan-left" }],
    narrationAssetId: NARR, narrationSec: 8, durationSec: 8, captions: [], targetLufs: -14,
    inputs: [A1, A2, NARR, ...(withBed ? [BED_ID] : [])],
    audio: {
      master: { targetLufs: -14, maxTruePeakDb: -1 },
      bed: withBed ? { assetId: BED_ID, sourceLufs: -20, gainDb: 3.5, duck: { threshold: 0.02, ratio: 4, attackMs: 15, releaseMs: 350, makeup: 1 }, cover: "loop" } : null,
      ambient: { color: "brown", bandHz: [90, 3200], gainDb: -26 },
      sfx: [],
    },
  });
  const kept = new Map<string, string>();
  const results: Record<string, { file: string; result: Record<string, unknown> }> = {};
  for (const withBed of [true, false]) {
    const work = path.join(home, withBed ? "bed" : "nobed");
    await mkdir(work, { recursive: true });
    const result = await handlers["render-video"](mixCtx(work, payloadFor(withBed), files, kept));
    results[withBed ? "bed" : "nobed"] = { file: kept.get("video.mp4") as string, result };
  }
  const withBed = results.bed;
  assert.deepEqual(withBed.result.audioMix, { bed: { assetId: BED_ID, cover: "loop" }, ambient: true, sfx: 0, targetLufs: -14 });
  assert.ok(Math.abs((withBed.result.durationSec as number) - 8) < 0.2, `duration ${String(withBed.result.durationSec)}`);
  const loud = parseLoudness(spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", withBed.file, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr);
  assert.ok(loud !== null && Math.abs(loud - -14) <= 2, `integrated loudness ${String(loud)} LUFS, target -14`);
  // The bed (880 Hz) after the narration ends, and in the last second, against the same band without a bed.
  const tailBed = bandRmsDb(withBed.file, 5, 7.8, 880);
  const lastBed = bandRmsDb(withBed.file, 7, 7.9, 880);
  const tailNone = bandRmsDb(results.nobed.file, 5, 7.8, 880);
  console.log(`mix: ${loud} LUFS; 880 Hz after the narration ${tailBed} dB (last second ${lastBed} dB), without a bed ${tailNone} dB`);
  assert.ok(tailBed > -40, `the bed is audible after the narration: ${tailBed} dB`);
  assert.ok(lastBed > -40, `the looped bed is still there in the last second: ${lastBed} dB`);
  assert.ok(tailBed - tailNone >= 12, `the 880 Hz band is the bed, not the ambience: ${tailBed} vs ${tailNone} dB`);
  // Under the narration the bed is ducked: quieter in the 880 Hz band than after the narration stops.
  const underVoice = bandRmsDb(withBed.file, 1, 3.5, 880);
  assert.ok(underVoice < tailBed - 3, `the bed ducks under the voice: ${underVoice} vs ${tailBed} dB`);
});

test("a stills job in pieces joins to the same length, frames and picture as one graph", { skip: !hasFfmpeg && "ffmpeg is not installed", timeout: 180_000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vs-chunks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const colors = ["red", "blue", "green", "yellow", "purple"];
  const ids = colors.map((_, i) => `aaaaaaaa-1111-4111-8111-${String(i + 1).padStart(12, "0")}`);
  await mkdir(path.join(dir, "in"));
  for (const [i, c] of colors.entries()) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:s=320x320,drawgrid=w=40:h=40:t=2:c=white`, "-frames:v", "1", path.join(dir, "in", `${i}.png`)]);
  }
  const narr = "aaaaaaaa-1111-4111-8111-0000000000ff";
  await writeFile(path.join(dir, "in", "n.wav"), wavOf(8, [{ from: 0, to: 8, hz: 300, amp: 0.3 }]));
  const spec = parseRenderSpec({
    width: 320, height: 320, fps: 15, engine: "ffmpeg-stills", transitionSec: 0.5,
    shots: ids.map((assetId, i) => ({ shotRef: `s${i}`, assetId, seconds: 2, motion: ["zoom-in", "pan-left", "zoom-out", "pan-right", "zoom-in"][i] })),
    narrationAssetId: narr, narrationSec: 8, durationSec: 8, captions: [], targetLufs: -14, inputs: [...ids, narr],
  });
  const images = ids.map((_, i) => `in/${i}.png`);
  const single = buildRenderArgs(spec, { images, narration: "in/n.wav", output: "single.mp4" }, { drawtext: false });
  await runFfmpeg(single.args, 8, () => {}, new AbortController().signal, dir);
  // Three inputs a piece: two shots and the tail of the shot before.
  const chunks = planStillsChunks(spec, { shots: 3, captions: 300 }) as NonNullable<ReturnType<typeof planStillsChunks>>;
  assert.equal(chunks.length, 3);
  for (const [k, c] of chunks.entries()) await runFfmpeg(buildStillsChunkArgs(spec, c, { images }, { drawtext: false }, stillsChunkFile(k)).args, c.frames / 15, () => {}, new AbortController().signal, dir);
  await writeFile(path.join(dir, "chunks.txt"), stillsConcatList(chunks.length));
  await runFfmpeg(buildMuxArgs(spec, "chunks.txt", "in/n.wav", "joined.mp4", { concat: true }), 8, () => {}, new AbortController().signal, dir);
  const frames = (f: string) =>
    Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path.join(dir, f)], { encoding: "utf8" }).trim());
  assert.equal(frames("joined.mp4"), frames("single.mp4"));
  assert.equal(frames("joined.mp4"), 120);
  const psnr = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", path.join(dir, "joined.mp4"), "-i", path.join(dir, "single.mp4"), "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const raw = /average:(\d+(?:\.\d+)?|inf)/.exec(psnr)?.[1] ?? "0";
  const avg = raw === "inf" ? Infinity : Number(raw);
  console.log(`pieces vs one graph: PSNR average ${avg} dB`);
  assert.ok(avg === Infinity || avg >= 30, `the joined picture is the single graph's (PSNR ${avg} dB)`);
});
