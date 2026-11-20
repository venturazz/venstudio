import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGNES_CLIP_SECONDS,
  audioIssues,
  capcutAudioIssues,
  clipSecondsIssues,
  decodeInlineSource,
  imageIssues,
  parseAudioReply,
  parseImageReply,
  parseVideoReply,
  sniffAudio,
  sniffImage,
  sniffVideo,
  videoIssues,
} from "./image-result.ts";
import { makeWav } from "./wav.ts";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (len 4), SOF0
  const b = new Uint8Array(30);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8], 0);
  new DataView(b.buffer).setUint16(13, h);
  new DataView(b.buffer).setUint16(15, w);
  return b;
}
function webpLossy(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")], 0);
  new DataView(b.buffer).setUint16(26, w, true);
  new DataView(b.buffer).setUint16(28, h, true);
  return b;
}
function webpX(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X")], 0);
  b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = (w - 1) >> 16;
  b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = (h - 1) >> 16;
  return b;
}

// ---------------------------------------------------------------- video

/** MP4: an `ftyp` box at offset 4, then a brand. */
function mp4(brand = "isom", size = 4096): Uint8Array {
  const b = new Uint8Array(Math.max(size, 16));
  b.set([0, 0, 0, 0x18], 0);
  b.set([...Buffer.from("ftyp")], 4);
  b.set([...Buffer.from(brand)], 8);
  return b;
}
/** WebM/Matroska: the EBML magic. */
function webm(size = 4096): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return b;
}

test("sniffVideo identifies mp4, quicktime and webm by magic bytes", () => {
  assert.equal(sniffVideo(mp4())?.mime, "video/mp4");
  // The same box with the `qt  ` brand is a .mov file.
  assert.equal(sniffVideo(mp4("qt  "))?.mime, "video/quicktime");
  assert.equal(sniffVideo(webm())?.mime, "video/webm");
  assert.equal(sniffVideo(png(512, 512)), null);
  assert.equal(sniffVideo(new Uint8Array(0)), null);
});

test("videoIssues rejects anything that is not a video", () => {
  assert.deepEqual(videoIssues(null), ["The file is not an MP4, WebM or MOV video"]);
  assert.deepEqual(videoIssues(sniffVideo(mp4())), []);
  assert.deepEqual(videoIssues(sniffVideo(mp4("isom", 400))), ["The video file is almost empty"]);
});

test("a clip must fit the provider window, which is shorter than the video", () => {
  // Agnes returns 4-12s clips while a short is 15-60s, so one request is one shot
  // and the render joins the clips. A 30s request would be silently truncated.
  assert.deepEqual(clipSecondsIssues(AGNES_CLIP_SECONDS[0]), []);
  assert.deepEqual(clipSecondsIssues(AGNES_CLIP_SECONDS[1]), []);
  assert.match(clipSecondsIssues(3)[0] ?? "", /at least 4/);
  assert.match(clipSecondsIssues(13)[0] ?? "", /at most 12/);
  assert.match(clipSecondsIssues(30)[0] ?? "", /at most 12/);
});

test("parseVideoReply reads the JSON contract, including which backend rendered", () => {
  const r = parseVideoReply(
    'done\n```json\n{"status":"ok","provider":"agnes","source":"agnes","model":"agnes-video-2.5-flash","video":{"type":"url","value":"https://x.test/a.mp4","mimeType":"video/mp4"}}\n```',
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.source, { type: "url", value: "https://x.test/a.mp4", mimeType: "video/mp4" });
    assert.equal(r.provider, "agnes");
    assert.equal(r.backend, "agnes");
  }
});

test("parseVideoReply never accepts a path, and surfaces a reported error", () => {
  const pathReply = parseVideoReply(JSON.stringify({ status: "ok", video: { type: "path", value: "/opt/data/cache/generated/video/a.mp4" } }));
  assert.equal(pathReply.ok, false);
  const err = parseVideoReply('{"status":"error","error":"queue full"}');
  assert.equal(err.ok, false);
  if (!err.ok) assert.match(err.issues[0] ?? "", /queue full/);
});

test("parseVideoReply takes a loose url when the model ignores the schema", () => {
  const loose = parseVideoReply("Here: https://x.test/b.mp4 enjoy");
  assert.equal(loose.ok, true);
  if (loose.ok) assert.equal(loose.source.value, "https://x.test/b.mp4");
});

test("parseAudioReply reads the JSON contract", () => {
  const r = parseImageReply('Here you go\n```json\n{"status":"ok","provider":"Cloudflare","model":"flux","image":{"type":"url","value":"https://x.test/a.png","mimeType":"image/png"}}\n```');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.source, { type: "url", value: "https://x.test/a.png", mimeType: "image/png" });
    assert.equal(r.provider, "Cloudflare");
    assert.equal(r.model, "flux");
  }
});

test("parseImageReply accepts base64 and data-uri objects", () => {
  const data = b64(Array.from(png(512, 512)));
  const a = parseImageReply(JSON.stringify({ status: "ok", image: { type: "base64", value: data } }));
  assert.equal(a.ok && a.source.type, "base64");
  const d = parseImageReply(JSON.stringify({ image: { type: "data-uri", value: `data:image/png;base64,${data}` } }));
  assert.equal(d.ok && d.source.mimeType, "image/png");
  assert.equal(d.ok && d.source.value, data);
});

test("parseImageReply falls back to markdown link, bare URL and data URI", () => {
  const md = parseImageReply("Done: ![shot](https://cdn.test/i/1.webp)");
  assert.equal(md.ok && md.source.value, "https://cdn.test/i/1.webp");
  const bare = parseImageReply("The image is at https://cdn.test/i/2.jpg.");
  assert.equal(bare.ok && bare.source.value, "https://cdn.test/i/2.jpg");
  const data = b64(Array.from(png(512, 512)));
  const uri = parseImageReply(`here: data:image/png;base64,${data} enjoy`);
  assert.equal(uri.ok && uri.source.type, "data-uri");
});

test("parseImageReply turns a path into an issue naming the fix", () => {
  const j = parseImageReply('{"status":"ok","image":{"type":"path","value":"/tmp/out.png"}}');
  assert.equal(j.ok, false);
  assert.match(!j.ok ? j.issues[0] : "", /https URL or base64/);
  const prose = parseImageReply("Saved to /home/hermes/out/shot.png");
  assert.equal(prose.ok, false);
  assert.match(!prose.ok ? prose.issues[0] : "", /https URL or base64/);
});

test("parseImageReply reports errors and empty replies", () => {
  const e = parseImageReply('{"status":"error","error":"quota exceeded"}');
  assert.equal(e.ok, false);
  assert.match(!e.ok ? e.issues[0] : "", /quota exceeded/);
  assert.equal(parseImageReply("I could not do that").ok, false);
  assert.equal(parseImageReply("").ok, false);
});

test("parseAudioReply uses the audio field", () => {
  const r = parseAudioReply('{"status":"ok","provider":"capcut","audio":{"type":"url","value":"https://x.test/a.wav"}}');
  assert.equal(r.ok && r.provider, "capcut");
  assert.equal(parseAudioReply('{"image":{"type":"url","value":"https://x.test/a.png"}}').ok, false);
});

test("decodeInlineSource decodes base64 and skips urls", () => {
  const r = parseImageReply(JSON.stringify({ image: { type: "base64", value: b64(Array.from(png(600, 700))) } }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(sniffImage(decodeInlineSource(r.source)!)?.width, 600);
  assert.equal(decodeInlineSource({ type: "url", value: "https://x.test/a.png", mimeType: "" }), null);
});

test("sniffImage reads png, jpeg and webp headers", () => {
  assert.deepEqual(sniffImage(png(1080, 1920)), { mime: "image/png", width: 1080, height: 1920, bytes: 33 });
  assert.deepEqual(sniffImage(jpeg(800, 600)), { mime: "image/jpeg", width: 800, height: 600, bytes: 30 });
  assert.deepEqual(sniffImage(webpLossy(640, 480)), { mime: "image/webp", width: 640, height: 480, bytes: 40 });
  const x = sniffImage(webpX(1920, 1080));
  assert.equal(x?.width, 1920);
  assert.equal(x?.height, 1080);
  assert.equal(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])), null);
});

test("imageIssues checks size and bytes", () => {
  assert.deepEqual(imageIssues(sniffImage(png(1080, 1920)), "short"), []);
  assert.match(imageIssues(sniffImage(png(300, 2000)), "short")[0], /at least 480/);
  assert.match(imageIssues(null, "long")[0], /not a PNG/);
  assert.match(imageIssues({ mime: "image/png", width: 1000, height: 1000, bytes: 30 * 1048576 }, "long")[0], /limit/);
});

test("sniffAudio and audioIssues", () => {
  const wav = makeWav({ sampleRate: 24000, channels: 1, pcm: new Uint8Array(4000) });
  assert.equal(sniffAudio(wav)?.mime, "audio/wav");
  assert.equal(sniffAudio(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))?.mime, "audio/mpeg");
  assert.equal(sniffAudio(new Uint8Array([0xff, 0xfb, 0x90, 0]))?.mime, "audio/mpeg");
  assert.equal(sniffAudio(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0]))?.mime, "audio/ogg");
  assert.equal(sniffAudio(new Uint8Array([1, 2, 3, 4])), null);
  assert.deepEqual(audioIssues(sniffAudio(wav)), []);
  assert.match(audioIssues(null)[0], /not a WAV/);
  assert.match(audioIssues({ mime: "audio/wav", bytes: 10 })[0], /almost empty/);
});

test("capcutAudioIssues refuses Ogg and asks for WAV or MP3", () => {
  const ogg = new Uint8Array(2000);
  ogg.set([0x4f, 0x67, 0x67, 0x53]);
  const issues = capcutAudioIssues(sniffAudio(ogg));
  assert.equal(issues.length, 1);
  assert.match(issues[0], /WAV or MP3/);
  const wav = new Uint8Array(2000);
  wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.deepEqual(capcutAudioIssues(sniffAudio(wav)), []);
  assert.ok(capcutAudioIssues(null).length > 0);
});

test("parseImageReply keeps the backend Hermes really used apart from the provider", () => {
  const r = parseImageReply('{"status":"ok","provider":"9router","source":"canva","model":"canva-default","image":{"type":"url","value":"http://hermes-files:8000/canva_1.png","mimeType":"image/png"}}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.provider, "9router");
    assert.equal(r.backend, "canva");
  }
});

test("parseImageReply leaves backend empty when Hermes does not name one", () => {
  const r = parseImageReply('{"status":"ok","provider":"cloudflare","image":{"type":"url","value":"http://hermes-files:8000/a.png","mimeType":"image/png"}}');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.backend, "");
});
