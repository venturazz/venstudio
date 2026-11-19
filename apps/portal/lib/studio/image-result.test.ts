import { test } from "node:test";
import assert from "node:assert/strict";
import { audioIssues, decodeInlineSource, imageIssues, parseAudioReply, parseImageReply, sniffAudio, sniffImage } from "./image-result.ts";
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

test("parseImageReply reads the JSON contract", () => {
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
