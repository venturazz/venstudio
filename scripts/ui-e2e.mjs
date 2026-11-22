// Browser end-to-end: drives the real UI the way a user would, then runs the real worker.
// Saves desktop and mobile screenshots to .e2e-ui/screenshots.
//
// Needs: portal running at APP_URL against an EMPTY database, SETUP_TOKEN set on it, ffmpeg, Playwright Chromium.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { totp } from "../apps/portal/lib/crypto/totp.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.env.APP_URL ?? "http://localhost:3200";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "ui-setup-token";
const OUT = path.join(ROOT, ".e2e-ui");
const SHOTS = path.join(OUT, "screenshots");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const EMAIL = "owner@venstudio.test";
const PASSWORD = "correct horse battery staple";

// Fake Hermes API server (same shapes as the real /v1/capabilities and /v1/skills).
const { createServer } = await import("node:http");
const HERMES_KEY = process.env.HERMES_API_KEY ?? "test-hermes-key";
const HERMES_PORT = Number(process.env.FAKE_HERMES_PORT ?? 3299);
const ROUTER_PORT = Number(process.env.FAKE_ROUTER_PORT ?? 3297);

// Generators for fake media. No dependencies: PNG through node:zlib, WAV as raw PCM16.
import { deflateSync } from "node:zlib";
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** A valid RGB PNG with a diagonal gradient. 540x960 passes the portal minimum size check. */
export function makePng(width = 540, height = 960, seed = 0) {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = (40 + seed * 50 + (x * 120) / width) & 255;
      raw[at + 1] = (60 + (y * 140) / height) & 255;
      raw[at + 2] = (150 + seed * 20 + ((x + y) * 50) / (width + height)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A mono 16-bit PCM WAV with a quiet sine wave (peak 0.3, so it never clips). */
export function makeWav(seconds, sampleRate = 24000, hz = 220) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.3 * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
// Fake director replies. Every prompt starts with a `VENSTUDIO_STAGE: <stage>` line; retries append more messages, so the
// marker is read from the first user message. A topic hint containing BREAK-JSON makes the idea stage answer with text
// that is not JSON, to prove the failure path. The script and storyboard are sized from numbers in the prompt itself,
// so they satisfy the script and storyboard gates for whichever template is used.
/** The run a prompt belongs to, by its owner brief (each e2e run has its own): the DATA block's first 60 characters. */
function briefTag(text) {
  return (/<<<DATA owner brief\n([\s\S]*?)\nDATA owner brief>>>/.exec(text)?.[1] ?? "").trim().slice(0, 60) || "(no brief)";
}
/** Beats, shot limit, hook and the least shot count a storyboard-like prompt states (storyboard, scene spec, skill brief). */
function planNumbers(first) {
  const roles = [...(/Beats in order: (.*)/.exec(first)?.[1] ?? "hook (x), body (x)").matchAll(/(\w+) \(/g)].map((m) => m[1]);
  const maxShot = Number(/Maximum shot length: ([\d.]+) seconds/.exec(first)?.[1] ?? 3);
  const hookMs = Number(/within (\d+) ms/.exec(first)?.[1] ?? 3000);
  const least = Number(/use at least (\d+) (?:shots|scenes)/.exec(first)?.[1] ?? 0);
  const count = Math.max(roles.length, least + 1, 3);
  const beat = (i) => roles[Math.floor((i * roles.length) / count)] ?? "body";
  const seconds = (i) => Math.min(maxShot, 3, i === 0 ? hookMs / 1000 : 3);
  return { count, beat, seconds };
}
function directorReply(messages) {
  const first = textOf(messages.find((m) => m.role === "user")?.content);
  const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
  if (stage === "selftest") return '{"ok":true,"sum":5}';
  // Template Lab (Phase 3): notes on one source, then a draft pack spec. The source is only named in a DATA block;
  // the fake never looks it up, and the portal must not either.
  if (stage === "lab-source") {
    fakeStats.labSourceAsks++;
    const src = /<<<DATA source\n([\s\S]*?)\nDATA source>>>/.exec(first)?.[1] ?? "";
    const type = /^type: (\w[\w-]*)/m.exec(src)?.[1] ?? "";
    if (/youtube/i.test(src)) {
      fakeStats.labYoutubeAsks++;
      fakeStats.labYoutubePrompt = first;
    }
    return JSON.stringify({
      pacing: "Short shots, a cut every two to three seconds",
      transitions: "Hard cuts, no wipes",
      textLayout: "One large number near the top, a small plain label above it",
      motion: "A line draws itself while the number counts up",
      hookStructure: "The number starts moving within the first second",
      audioFeel: "Calm narration, quiet bed",
      summary: `Fake notes on a ${type} source: one number, one line, calm pace.`,
      numbers: { shotSeconds: [2, 4], cutsPerMinute: [15, 25], hookWithinMs: 900 },
      ...(type === "repo" ? { licence: "MIT", techniques: ["HTML page captured frame by frame", "Paused timeline seeked per frame"] } : {}),
    });
  }
  if (stage === "lab-synthesis") {
    fakeStats.labSynthesisAsks++;
    const revised = /<<<DATA owner revision note\n([\s\S]*?)\nDATA owner revision note>>>/.exec(first)?.[1];
    return JSON.stringify({
      packId: "e2e-calm-count-up",
      name: `E2E calm count-up${revised ? " (revised)" : ""}`,
      description: "One line draws itself while one number counts up; a plain label, calm narration.",
      family: "motion-graphics",
      formats: { supported: ["short"], naturalFrame: "portrait" },
      renderer: "remotion-2d",
      contract: {
        pacing: { shotSeconds: [9, 12], hookWithinMs: 5000, cutsPerMinute: [5, 6], transitionSec: 0 },
        onScreen: { elements: ["heading", "counter", "bar"], motionTokens: ["draw", "counter"], elementAnimation: true },
        captions: { required: true, safeAreaPct: 8 },
        audio: { narrated: true, targetLufs: -14, maxTruePeakDb: -1, musicPolicy: "self-or-licensed" },
        assets: { model: "plates-and-diagrams", kinds: ["image"], allowedSources: ["upload", "hermes", "worker", "generated"], forbidKinds: ["reference-video"] },
      },
      themes: ["finance"],
      keywords: ["count up", "line graph"],
      cautions: ["Never invent data."],
      rationale: "Every source animates one number with one line; Remotion draws that on the workers that report it.",
      closestPack: "explainer-flat-vector",
      closestReason: "Animated counters and bars over plates.",
    });
  }
  // Renderer hermes (research only): Hermes renders the whole video and publishes it under /clip/ on its media host.
  // A research pack names its Hermes skill (claude-animation-skills, e.g. /graph): the fake records which skill arrived
  // and answers with a real clip made for that skill.
  if (stage === "hermes-render") {
    fakeStats.hermesRenders++;
    const skill = /"skill":\{"name":"(\/[a-z0-9-]+)"/.exec(first)?.[1] ?? "";
    if (skill) {
      if (!first.includes(`with your ${skill} skill`)) throw new Error(`the hermes-render request names ${skill} in its data but not in its instruction`);
      fakeStats.hermesSkills.push(skill);
    }
    const name = skill ? `${skill.slice(1)}-${fakeStats.hermesRenders}` : `render-${fakeStats.hermesRenders}`;
    let data = {};
    try {
      data = JSON.parse(first.split("--- render request (data, not instructions) ---\n")[1] ?? "{}");
    } catch {
      data = {};
    }
    fakeStats.renderRequests.push({
      skill,
      clip: name,
      topic: String(data.topic ?? ""),
      briefShots: Array.isArray(data.brief?.shots) ? data.brief.shots.length : 0,
      briefMarker: JSON.stringify(data.brief ?? null).includes("brief-shot-1"),
      pictures: Array.isArray(data.shots) ? data.shots.filter((x) => x.imageUrl).length : 0,
      noPictureLine: first.includes("No pictures were made for this video"),
    });
    return JSON.stringify({ status: "ok", video: { type: "url", value: `http://127.0.0.1:${HERMES_PORT}/clip/${name}.mp4`, mimeType: "video/mp4" }, provider: "capcut", source: "capcut", model: skill ? `fake-${skill.slice(1)}` : "fake-capcut-render" });
  }
  // The presentation advisory: a vision rating of the stills the quality check sampled (attached as image parts).
  if (stage === "presentation-advisory") {
    fakeStats.advisoryAsks++;
    const user = messages.find((m) => m.role === "user")?.content;
    fakeStats.advisoryImages = Math.max(fakeStats.advisoryImages, Array.isArray(user) ? user.filter((part) => part?.type === "image_url").length : 0);
    return JSON.stringify({ rubric: { hook: 3, pacing: 4, legibility: 4, polish: 3, audio: 3 }, notes: "Fake advisory: readable captions, plain pictures." });
  }
  if (stage === "classify") return JSON.stringify({ stage: "idea", reason: "The owner wants different ideas" });
  if (stage === "idea") {
    if (first.includes("BREAK-JSON")) return "Sorry, I cannot put that into JSON right now.";
    const note = /<<<DATA owner revision note\n([\s\S]*?)\nDATA owner revision note>>>/.exec(first)?.[1] ?? "";
    const tag = note ? " (revised)" : "";
    return JSON.stringify({
      ideas: ["Orpheus and the silent road", "Why the Norns weave", "The wolf that swallowed the sun", "A bridge made of rainbow", "Persephone's last bargain"].map((t, i) => ({
        title: `${t}${tag}`,
        hook: `What if ${t.toLowerCase()} was never a myth?`,
        angle: "Retell it as a short mystery",
        score: 90 - i * 5,
      })),
    });
  }
  if (stage === "research") {
    // A scene-spec run asks for real numbers with sources: the fake gives one sourced series and one note without a link.
    if (first.includes("This video is drawn from data")) {
      fakeStats.researchDataAsks++;
      return JSON.stringify({
        notes: [
          { claim: "Installed solar capacity was 40 GW in 2010 and 1,200 GW in 2023", sourceUrl: "https://example.org/solar-capacity", sourced: true, summary: "Series in GW: 40 (2010), 140 (2014), 500 (2019), 1,200 (2023)." },
          { claim: "Panels got much cheaper", sourceUrl: "", sourced: false, summary: "Costs fell sharply over the decade." },
        ],
      });
    }
    return JSON.stringify({
      notes: [1, 2, 3].map((n) => ({ claim: `Marker claim number ${n} about old tales`, sourceUrl: "", sourced: false, summary: `Plain background fact ${n} for the writer` })),
    });
  }
  if (stage === "script") {
    const target = Number(/about (\d+) words/.exec(first)?.[1] ?? 112);
    const opening = "Here is a strange true tale.";
    const filler = "Long ago a traveller crossed the hills and listened closely to every voice along the winding road before the night fell.";
    const words = [];
    while (words.length < target) words.push(...filler.split(" "));
    const body = words.slice(0, Math.max(0, target - opening.split(" ").length)).join(" ");
    return JSON.stringify({ hooks: ["Here is a strange true tale.", "Nobody tells this part.", "You were told the wrong ending."], chosenHook: 0, script: `${opening} ${body}.` });
  }
  if (stage === "script-fit") {
    // Fit the script to the pictures: as many words as the prompt asks for, so the fitted script passes its check.
    fakeStats.scriptFitAsks++;
    const target = Number(/to about (\d+) words/.exec(first)?.[1] ?? 60);
    const filler = "A traveller crossed the hills and listened to every voice along the road before the night fell.".split(" ");
    const words = [];
    while (words.length < target) words.push(...filler);
    return JSON.stringify({ script: `Here is a strange true tale. ${words.slice(0, Math.max(1, target - 6)).join(" ")}.` });
  }
  if (stage === "storyboard") {
    const tag = briefTag(first);
    fakeStats.storyboardAsksByBrief[tag] = (fakeStats.storyboardAsksByBrief[tag] ?? 0) + 1;
    const roles = [...(/Beats in order: (.*)/.exec(first)?.[1] ?? "hook (x), body (x)").matchAll(/(\w+) \(/g)].map((m) => m[1]);
    const maxShot = Number(/Maximum shot length: ([\d.]+) seconds/.exec(first)?.[1] ?? 3);
    const hookMs = Number(/within (\d+) ms/.exec(first)?.[1] ?? 3000);
    // The storyboard gate needs enough shots to cover the narration; the prompt states the least number.
    const minShots = Number(/use at least (\d+) shots/.exec(first)?.[1] ?? 0);
    const count = Math.max(roles.length, minShots);
    return JSON.stringify({
      shots: Array.from({ length: count }, (_, i) => roles[Math.floor((i * roles.length) / count)]).map((role, i) => ({
        beatRole: role,
        seconds: Math.min(maxShot, 3, i === 0 ? hookMs / 1000 : 3),
        description: `A calm scene for the ${role} beat`,
        imagePrompt: `Flat illustration of an old stone road at dusk, ${role} moment [brief: ${briefTag(first)}]`,
        // Per-shot backend preference: agnes is in the fake capability scan, midjourney is not and must be dropped.
        ...(i === 0 ? { provider: "agnes", needs: "text-layout" } : i === 1 ? { provider: "midjourney" } : {}),
      })),
    });
  }

  // Phase 4 stages. Image variants are chosen by the shot number named in the prompt (`for shot shot-NN`):
  //   shot-01 first answers with a file path (the portal must feed that back and Hermes then sends base64),
  //   shot-02 answers with an error for its first three asks (one whole attempt), so the second attempt runs,
  //   shot-03 answers with a download link on this fake server, every other shot with base64.
  // Hermes answers like the live 9router plugin: `provider` is the plugin (9router), `source` the backend that made the
  // file. Most shots come from canva (listed in CI's HERMES_IMAGE_PROVIDER_ORDER, so stored as "canva"); shot-03 comes
  // from cloudflare-9router, which is not listed and is stored as "unlisted-cloudflare-9router". Neither is confirmed
  // yet, so the provider-terms flow runs. Nothing may be stored under the plugin name (unlisted-9router).
  // Scene spec (recipe scene-spec): scenes sized like the storyboard, drawing only what the prompt says the style allows,
  // and every number from note 1 (which has a source). No picture is asked for.
  if (stage === "scene-spec") {
    fakeStats.sceneSpecAsks++;
    const allowed = (/On-screen elements this style allows: ([^.]*)\./.exec(first)?.[1] ?? "heading").split(", ");
    const tokens = (/Motion tokens this style allows: ([^.]*)\./.exec(first)?.[1] ?? "").split(", ").filter((t) => t && t !== "none");
    const { count, beat, seconds } = planNumbers(first);
    const pick = (want) => (tokens.includes(want) ? [want] : tokens.slice(0, 1));
    const element = (i) => {
      if (i % 3 === 1 && allowed.includes("bar")) return [{ kind: "bar", text: "GW", series: [40, 140, 500, 1200], labels: ["2010", "2014", "2019", "2023"], source: 1 }, pick("draw")];
      if (i % 3 === 2 && allowed.includes("counter")) return [{ kind: "counter", text: "GW in 2023", value: 1200, source: 1 }, pick("counter")];
      return [{ kind: allowed.includes("heading") ? "heading" : allowed[0], text: "Solar capacity" }, pick("dim")];
    };
    return JSON.stringify({
      scenes: Array.from({ length: count }, (_, i) => {
        const [el, tk] = element(i);
        return { seconds: seconds(i), beat: beat(i), elements: [el], tokens: tk, caption: `Part ${i + 1} of the narration about solar power.` };
      }),
    });
  }
  // Skill brief (recipe hermes-skill): a spec per shot for a spec skill, a text brief for a project skill.
  if (stage === "skill-brief") {
    fakeStats.skillBriefAsks++;
    const { count, beat, seconds } = planNumbers(first);
    const spec = first.includes("spec is the skill's JSON spec");
    return JSON.stringify({
      shots: Array.from({ length: count }, (_, i) => ({
        beat: beat(i),
        seconds: seconds(i),
        description: `Shot ${i + 1}: the line climbs a little more`,
        ...(spec ? { spec: { label: "Savings", values: [100, 110 + i, 121 + i], final: 121 + i, prefix: "$", e2eBrief: `brief-shot-${i + 1}` } } : {}),
      })),
      ...(spec ? {} : { text: "E2E project brief: voiceover from the script, one setup per shot." }),
    });
  }
  if (stage === "providers") {
    return JSON.stringify({ providers: ["cloudflare", "agnes", "canva", "qwen", "minimax", "sensenova"].map((name) => ({ name, note: "fake" })) });
  }
  if (stage === "image") {
    const shot = /for shot ([\w-]+)/.exec(first)?.[1] ?? "test";
    const seed = Number(/(\d+)$/.exec(shot)?.[1] ?? 0);
    const asks = (fakeStats.imageAsks[shot] = (fakeStats.imageAsks[shot] ?? 0) + 1);
    // Which run asked: the storyboard put its brief in every image description. A run without a storyboard never asks.
    const askedFor = /\[brief: ([^\]]*)\]/.exec(first)?.[1] ?? "(untagged)";
    fakeStats.imageAsksByBrief[askedFor] = (fakeStats.imageAsksByBrief[askedFor] ?? 0) + 1;
    if (/For this shot use agnes first/.test(first)) fakeStats.shotPreferenceAsks++;
    if (/For this shot use midjourney/.test(first)) fakeStats.droppedPreferenceAsks++;
    const ok = (image, source = "canva") => JSON.stringify({ status: "ok", provider: "9router", source, model: "fake-flux", image });
    if (shot === "shot-01" && messages.length <= 2) {
      fakeStats.pathAnswers++;
      return ok({ type: "path", value: "/tmp/hermes/out.png", mimeType: "image/png" });
    }
    if (shot === "shot-02" && asks <= 3) {
      fakeStats.errorAnswers++;
      return JSON.stringify({ status: "error", provider: "9router", error: "Fake provider chain is down" });
    }
    if (shot === "shot-04") {
      // Hermes never makes this one, so the studio falls through to the 9router image model.
      fakeStats.hermesImageRefusals++;
      return JSON.stringify({ status: "error", provider: "9router", error: "Fake Hermes has no image for this shot" });
    }
    if (shot === "shot-03") {
      fakeStats.urlAnswers++;
      return ok({ type: "url", value: `http://127.0.0.1:${HERMES_PORT}/fake-image/${seed}.png`, mimeType: "image/png" }, "cloudflare-9router");
    }
    return ok({ type: "base64", value: makePng(540, 960, seed).toString("base64"), mimeType: "image/png" });
  }
  if (stage === "capabilities") {
    fakeStats.capabilityScans++;
    return JSON.stringify({
      skills: [
        { name: "clip-animator", description: "Turns a still picture into a short moving clip", category: "video", stages: ["video-clips"] },
        { name: "voice-bridge", description: "Speaks text with a chosen voice engine", category: "audio", stages: ["voice"] },
        { name: "pic-forge", description: "Makes pictures from a prompt", category: "image", stages: ["image"] },
      ],
      imageProviders: ["cloudflare", "agnes"],
      voiceEngines: ["kokoro", "capcut"],
      notes: "fake capability report",
    });
  }
  if (stage === "tts-kokoro") {
    fakeStats.hermesKokoroCalls++;
    return JSON.stringify({ status: "ok", provider: "kokoro", source: "kokoro", model: "fake-hermes-kokoro", audio: { type: "base64", value: makeWav(3).toString("base64"), mimeType: "audio/wav" } });
  }
  if (stage === "tts-capcut") {
    return JSON.stringify({ status: "ok", provider: "capcut", source: "capcut", model: "fake-capcut", audio: { type: "base64", value: makeWav(3).toString("base64"), mimeType: "audio/wav" } });
  }
  if (stage === "cc0") {
    return JSON.stringify({
      url: "https://upload.wikimedia.org/wikipedia/commons/fake-cc0.png",
      title: "Fake CC0 road",
      licence: "CC0 1.0 Public Domain Dedication",
      licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    });
  }
  return "{}";
}
// The newest first user message per stage marker (idea, research, script, storyboard ...), so the UI test can check
// what the New video form carried into the director prompts.
const lastPrompt = {};
/** Text of a chat message's content: a string, or the text parts of OpenAI-style content parts (vision turns). */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  return "";
}

// The clip the fake Hermes "renders": a real H.264/AAC MP4, made once with ffmpeg, served under /clip/ like the media host.
const FAKE_CLIP = path.join(OUT, "fake-hermes-clip.mp4");
let fakeClip = null;
const skillClips = new Map();
/** A real clip per research skill (a different hue each), so every skill's render is its own file. */
function fakeClipFor(name) {
  const skill = /^([a-z0-9-]+?)-\d+$/.exec(name)?.[1] ?? "render";
  if (skill === "render") return fakeClipBytes();
  if (skillClips.has(skill)) return skillClips.get(skill);
  const file = path.join(OUT, `fake-hermes-${skill}.mp4`);
  const hue = (skillClips.size + 1) * 70;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=16", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16", "-shortest", "-vf", `hue=h=${hue}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", file], { timeout: 120_000 });
  skillClips.set(skill, readFileSync(file));
  return skillClips.get(skill);
}
function fakeClipBytes() {
  if (fakeClip) return fakeClip;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=16", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=16", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", FAKE_CLIP], { timeout: 120_000 });
  fakeClip = readFileSync(FAKE_CLIP);
  return fakeClip;
}

const fakeStats = { hermesSkills: [], labSourceAsks: 0, labYoutubeAsks: 0, labYoutubePrompt: "", labSynthesisAsks: 0, youtubeHits: 0, hermesRenders: 0, clipDownloads: 0, advisoryAsks: 0, advisoryImages: 0, scriptFitAsks: 0, imageAsks: {}, pathAnswers: 0, errorAnswers: 0, urlAnswers: 0, routerSpeechCalls: 0, routerImageCalls: 0, routerBadImageCalls: 0, hermesImageRefusals: 0, hermesKokoroCalls: 0, capabilityScans: 0, hermes429: 0, shotPreferenceAsks: 0, droppedPreferenceAsks: 0, imageAsksByBrief: {}, storyboardAsksByBrief: {}, researchDataAsks: 0, sceneSpecAsks: 0, skillBriefAsks: 0, renderRequests: [] };
// The first image asks get HTTP 429 with a short Retry-After, like a busy Hermes. The shots must wait and then finish,
// not fail, and the wait must not use up their attempts.
const HERMES_429_BURST = 3;
const HERMES_RETRY_AFTER_SEC = 2;
// The fake 9router lists this image model first and refuses every request for it with the Cloudflare 400 the owner saw.
const ROUTER_BAD_IMAGE_MODEL = "cf/@cf/fake-flux-2";
function cloudflarePromptRequired() {
  const inner = JSON.stringify({ errors: [{ message: "AiError: AiError: prompt is required (fdbccbd5-0000-4000-8000-000000000000)", code: 3030 }], success: false });
  return { error: { message: `[400]: ${inner}` } };
}
const fakeHermes = createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // Tripwire: nothing may ever ask this server for a YouTube page (a study's link is only ever named to Hermes).
  if (/youtube|youtu\.be/i.test(`${req.headers.host ?? ""}${req.url ?? ""}`)) {
    fakeStats.youtubeHits++;
    console.error(`FAKE HERMES: a request for YouTube reached it: ${req.method} ${req.headers.host}${req.url}`);
    res.writeHead(599);
    return res.end("the e2e forbids any request to YouTube");
  }
  // The fake image link is public, like a real image host. It answers before the key check.
  const link = /^\/fake-image\/(\d+)\.png$/.exec(req.url ?? "");
  if (link) {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(makePng(540, 960, Number(link[1])));
  }
  // The media host's /clip/ folder, public like the image link.
  const clip = /^\/clip\/([a-z0-9-]+-\d+)\.mp4$/.exec(req.url ?? "");
  if (clip) {
    fakeStats.clipDownloads++;
    const body = fakeClipFor(clip[1]);
    res.writeHead(200, { "content-type": "video/mp4", "content-length": String(body.length) });
    return res.end(body);
  }
  if (req.headers.authorization !== `Bearer ${HERMES_KEY}`) return json(401, { error: { code: "gateway_auth_failed" } });
  if (req.url === "/v1/capabilities") {
    return json(200, {
      object: "hermes.api_server.capabilities",
      platform: "hermes-agent",
      features: { chat_completions: true, run_submission: true, run_events_sse: true, run_stop: true },
    });
  }
  if (req.url === "/v1/skills") {
    return json(200, [
      { name: "write-story-script", description: "Writes a short story script", category: "video" },
      { name: "consistent-character-image", description: "Image workflow with a fixed character", category: "image" },
      { name: "deep-research", description: "Researches a topic with sources", category: "research" },
    ]);
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let messages = [];
      try {
        messages = JSON.parse(raw).messages ?? [];
      } catch {
        return json(400, { error: "bad json" });
      }
      const first = textOf(messages.find((m) => m.role === "user")?.content);
      const stage = /^VENSTUDIO_STAGE: ([\w-]+)/m.exec(first)?.[1] ?? "";
      if (stage) lastPrompt[stage] = first;
      if (stage === "image" && fakeStats.hermes429 < HERMES_429_BURST) {
        fakeStats.hermes429++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(HERMES_RETRY_AFTER_SEC) });
        return res.end(JSON.stringify({ error: { message: "Rate limit reached for the image provider", type: "rate_limit" } }));
      }
      const content = directorReply(messages);
      json(200, { id: "chatcmpl-fake", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    });
    return;
  }
  json(404, { error: "not found" });
});
await new Promise((r) => fakeHermes.listen(HERMES_PORT, "127.0.0.1", r));

// Fake 9router. In "hang" mode it accepts connections and never answers, like an unroutable address, so the pages-stay-fast
// check is meaningful. In "ok" mode it lists models and speaks 0.46 s per word: about 130 words a minute, like the owner's
// Kokoro voice, so every narration is about 15 percent longer than the portal's 150 words-a-minute estimate. That must
// be a note on the voice card, not a failure. routerTts "error" makes only the speech endpoint fail, to prove the fallback to Hermes.
const router = { mode: "hang", tts: "ok" };
const FAKE_SECONDS_PER_WORD = 0.46;
const routerSockets = new Set();
const ROUTER_KEY = process.env.NINEROUTER_API_KEY ?? "";
const fakeRouter = createServer((req, res) => {
  if (router.mode === "hang") return; // never answer
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (ROUTER_KEY && req.headers.authorization !== `Bearer ${ROUTER_KEY}`) return json(401, { error: "bad key" });
  const list = (data) => json(200, { object: "list", data });
  const url = (req.url ?? "").split("?")[0];
  if (req.method === "GET") {
    if (url === "/api/health") return json(200, { ok: true });
    if (url === "/v1/models") return list([{ id: "fake/chat-small", owned_by: "fake" }, { id: "fake/chat-large", owned_by: "fake" }]);
    if (url === "/v1/models/image") return list([{ id: ROUTER_BAD_IMAGE_MODEL, owned_by: "cf" }, { id: "fake-img/flux-lite", owned_by: "fake-img" }]);
    if (url === "/v1/models/tts") {
      return list([
        { id: "kokoro/af_heart", owned_by: "kokoro" },
        { id: "kokoro/af_bella", owned_by: "kokoro" },
        { id: "edge-tts/en-US-AriaNeural", owned_by: "edge-tts" },
      ]);
    }
    if (url === "/v1/models/web") return list([{ id: "fake-search/web", owned_by: "fake-search", kind: "webSearch" }]);
    if (url === "/v1/models/stt") return list([{ id: "fake-stt/small", owned_by: "fake-stt" }]);
    res.writeHead(404);
    return res.end("not found");
  }
  if (req.method === "POST" && (url === "/v1/audio/speech" || url === "/v1/images/generations")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "bad json" });
      }
      if (url === "/v1/images/generations") {
        if (body.model === ROUTER_BAD_IMAGE_MODEL) {
          fakeStats.routerBadImageCalls++;
          return json(400, cloudflarePromptRequired());
        }
        fakeStats.routerImageCalls++;
        return json(200, { created: 1, data: [{ b64_json: makePng(540, 960, 7).toString("base64") }] });
      }
      if (router.tts === "error") return json(500, { error: "fake speech failure" });
      fakeStats.routerSpeechCalls++;
      const words = String(body.input ?? "").split(/\s+/).filter(Boolean).length;
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(makeWav(Math.max(0.5, words * FAKE_SECONDS_PER_WORD)));
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
fakeRouter.on("connection", (sock) => {
  routerSockets.add(sock);
  sock.on("close", () => routerSockets.delete(sock));
});
await new Promise((r) => fakeRouter.listen(ROUTER_PORT, "127.0.0.1", r));

const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await desktop.newPage();
page.setDefaultTimeout(20_000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

async function shot(name, p = page) {
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
function step(msg) {
  console.log(`== ${msg}`);
}
/**
 * One value from the UI database (psql -tA), or null when the script has no database access. Throws when the query
 * fails, so an assertion that needs the database does not pass by accident.
 */
function dbValue(sql) {
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return execFileSync("psql", [dbUrl, "-X", "-tA", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** Runs a statement quietly (no command tag), stopping on the first error; returns its rows like dbValue, or null without a database. */
function dbExec(sql) {
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  if (!dbUrl) return null;
  return execFileSync("psql", [dbUrl, "-X", "-qtA", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function runWorker(args) {
  return execFileSync("bash", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/**
 * Prints what the production pipeline looks like when a wait gives up: the run, its stages, jobs, work orders, review
 * items, QC reports, the workers and the worker log tail. Uses psql when UI_DB or DATABASE_URL is set, and always
 * prints the run page text as a fallback. Never throws.
 */
async function dumpPipeline(p, runHref, why) {
  console.error(`\n---- pipeline diagnostics: ${why} ----`);
  const runId = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(runHref ?? "")?.[1] ?? null;
  const dbUrl = process.env.UI_DB ?? process.env.DATABASE_URL;
  const psql = (title, sql) => {
    try {
      const out = execFileSync("psql", [dbUrl, "-X", "-A", "-F", " | ", "-P", "footer=off", "-c", sql], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
      console.error(`## ${title}\n${out.trim() || "(no rows)"}`);
    } catch (err) {
      console.error(`## ${title}: query failed: ${String(err.stderr || err.message).slice(0, 300)}`);
    }
  };
  if (dbUrl && runId) {
    psql("run", `SELECT id, state, autonomy_level, topic, kind FROM pipeline_runs WHERE id = '${runId}'`);
    psql("stages", `SELECT stage, state, attempt, left(coalesce(error, ''), 300) AS error, left((output - 'result')::text, 400) AS output FROM pipeline_stages WHERE run_id = '${runId}' ORDER BY coalesce(started_at, finished_at, now()), attempt`);
    psql("jobs of this run, and the latest render and qc jobs", `SELECT type, status, attempts || '/' || max_attempts AS tries, priority, capability, worker_id, preferred_worker_id, run_after <= now() AS runnable, progress, left(coalesce(message, ''), 120) AS message, left(coalesce(error, ''), 400) AS error FROM jobs WHERE payload->>'runId' = '${runId}' OR type IN ('render-video', 'qc-video') ORDER BY created_at DESC LIMIT 10`);
    psql("job events of the latest render and qc jobs", `SELECT j.type, e.level, left(e.message, 200) AS message FROM job_events e JOIN jobs j ON j.id = e.job_id WHERE j.payload->>'runId' = '${runId}' AND j.type IN ('render-video', 'qc-video') ORDER BY e.id DESC LIMIT 20`);
    psql("work orders", `SELECT shot_ref, executor, state, attempts, job_id, asset_id IS NOT NULL AS has_asset, to_jsonb(w)->>'not_before' AS not_before, left(coalesce(to_jsonb(w)->>'wait_reason', ''), 120) AS wait_reason, left(coalesce(to_jsonb(w)->>'error', ''), 200) AS error FROM work_orders w WHERE run_id = '${runId}' ORDER BY shot_ref`);
    psql("speech rates (newest)", `SELECT voice_key, language, words, round(seconds::numeric, 2) AS seconds, round(wpm::numeric, 1) AS wpm, source, run_id = '${runId}' AS this_run FROM voice_speech_rates ORDER BY created_at DESC LIMIT 8`);
    psql("hermes gate", `SELECT * FROM hermes_gate`);
    psql("endpoint health", `SELECT endpoint, model, kind, last_success_at IS NOT NULL AS worked, failure_class, quarantined_at IS NOT NULL AS set_aside, successes, failures, left(last_error, 160) AS last_error FROM endpoint_health ORDER BY updated_at DESC LIMIT 20`);
    psql("review items", `SELECT stage, kind, state, left(payload::text, 300) AS payload FROM review_items WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("qc reports", `SELECT gate, passed, score, executor, left(details::text, 300) AS details FROM qc_reports WHERE run_id = '${runId}' ORDER BY created_at`);
    psql("workers", `SELECT name, status, mode, capabilities, job_types, last_claim_at FROM workers`);
  } else {
    console.error("## no database access (UI_DB and DATABASE_URL unset or no run id); the run page below is the only source");
  }
  console.error(`## fake counters\n${JSON.stringify(fakeStats)}`);
  try {
    await p.goto(`${APP}${runHref}`);
    console.error(`## run page text\n${((await p.locator("body").innerText()) || "").slice(0, 3000)}`);
  } catch (err) {
    console.error(`## run page text: unavailable (${String(err.message).slice(0, 200)})`);
  }
  try {
    const log = readFileSync(path.join(OUT, "worker", "logs", "worker.log"), "utf8").trimEnd().split("\n");
    console.error(`## worker log tail\n${log.slice(-60).join("\n")}`);
  } catch (err) {
    console.error(`## worker log: unavailable (${err.message})`);
  }
  console.error("---- end of pipeline diagnostics ----\n");
}

try {
  step("first-time setup");
  await page.goto(`${APP}/`);
  await page.waitForURL(/\/setup$/);
  await shot("01-setup-desktop");
  await page.fill("#token", "wrong-token");
  await page.fill("#name", "Ven Owner");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.getByText("Setup token is incorrect.").waitFor();
  await page.fill("#token", SETUP_TOKEN);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/settings\?welcome=1/);

  step("turn on two-factor");
  await page.getByRole("button", { name: "Turn on two-factor" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent()).trim();
  await page.fill("#totp-code", totp(secret));
  await page.getByRole("button", { name: "Confirm and turn on" }).click();
  await page.getByText("Two-factor is on.").first().waitFor();
  await shot("02-settings-desktop");

  step("sign out, sign in with password + code");
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/login$/);
  await page.fill("#email", EMAIL);
  await page.fill("#password", "wrong password here");
  await page.click("button[type=submit]");
  await page.getByText("Email or password is incorrect.").waitFor();
  await shot("03-login-desktop");
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/login\/verify$/);
  // Wait for a fresh 30 s window so the code differs from the one used at setup (replay protection).
  const nowStep = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((nowStep + 1) * 30_000 - Date.now() + 500);
  await page.fill("#code", totp(secret));
  await page.click("button[type=submit]");
  await page.waitForURL(`${APP}/`);

  step("create a channel");
  await page.goto(`${APP}/channels/new`);
  await page.fill("#name", "Myth Stories");
  await page.fill("#handle", "@mythstories");
  await page.fill("#niche", "Greek and Norse myths, retold");
  await page.fill("#plan", "Retell one myth per video as a short mystery. Two videos a week. No gore.");
  await page.selectOption("#format", "animated-story");
  await page.fill("#googleAccount", "studio.one@example.com");
  await page.selectOption("#status", "active");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.waitForURL(/\/channels\/[0-9a-f-]{36}$/);
  await page.goto(`${APP}/channels`);
  await page.getByText("Myth Stories").waitFor();
  await shot("04-channels-desktop");

  step("enroll a worker from the Workers page");
  await page.goto(`${APP}/workers`);
  await page.fill("#label", "CI Worker");
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.getByRole("button", { name: "Create enrollment code" }).click();
  await page.getByText("Code created.").waitFor();
  await shot("05-enroll-desktop");
  const message = (await page.locator("pre").nth(0).textContent()).trim();
  if (!/sha256sum install\.sh/.test(message) || !/run\.sh hold/.test(message)) throw new Error(`setup message incomplete: ${message}`);
  const servedSha = (await import("node:crypto")).createHash("sha256")
    .update(await (await fetch(`${APP}/install/install.sh`)).text()).digest("hex");
  if (!message.includes(servedSha)) throw new Error("setup message sha256 doesn't match the served install.sh");
  const command = (await page.locator("pre").nth(1).textContent()).trim();
  const code = /--code (VS-[A-Z0-9-]+)/.exec(command)?.[1];
  if (!code) throw new Error(`no code in command: ${command}`);
  runWorker([
    "-c",
    // --with-remotion: the production below uses explainer-flat-vector, a remotion-2d style, and an engine no worker
    // can run fails at planning. This also installs Remotion the way a Muse VM does, from the portal.
    `cd ${OUT} && curl -fsSL ${APP}/install/install.sh -o install.sh && bash install.sh --portal ${APP} --code ${code} --name "CI Worker" --mode tick --home ${OUT}/worker --with-remotion`,
  ]);
  await page.goto(`${APP}/workers`);
  await page.getByText("CI Worker").first().waitFor();

  step("worker updates: the owner switches the update mode on the Workers page");
  const updatesCard = page.getByTestId("worker-updates");
  const modeNow = updatesCard.getByTestId("update-mode-current");
  await modeNow.filter({ hasText: "Now: Automatic" }).waitFor();
  await page.locator("#update-mode-approve").check();
  await page.getByRole("button", { name: "Save update mode" }).click();
  await modeNow.filter({ hasText: "Now: Approve each update" }).waitFor();
  await shot("05b-worker-updates-desktop");
  await page.locator("#update-mode-auto").check();
  await page.getByRole("button", { name: "Save update mode" }).click();
  await modeNow.filter({ hasText: "Now: Automatic" }).waitFor();

  step("queue an echo job and a smoke test from the Jobs page");
  for (const [type, label] of [
    ["echo", "Echo (connectivity test)"],
    ["smoke-test", "Render smoke test"],
  ]) {
    await page.goto(`${APP}/jobs`);
    await page.selectOption("#type", type);
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.getByRole("button", { name: "Queue job" }).click();
    await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: label }).waitFor();
  }
  runWorker([`${OUT}/worker/run.sh`, "tick"]);

  step("results show in the UI");
  await page.goto(`${APP}/jobs?status=succeeded`);
  const done = page.getByRole("link").filter({ hasText: "Render smoke test" });
  await done.first().click();
  await page.getByText("Done").first().waitFor();
  await page.locator("video").waitFor();
  const result = await page.locator("pre").first().textContent();
  if (!/"realtimeFactor"/.test(result) || !/"seconds": 5/.test(result)) throw new Error(`unexpected result: ${result}`);
  await shot("06-job-desktop");

  step("video supports range requests (needed for streaming and iPhone playback)");
  const videoSrc = await page.locator("video").getAttribute("src");
  const ranged = await page.request.get(`${APP}${videoSrc}`, { headers: { range: "bytes=0-99" } });
  if (ranged.status() !== 206) throw new Error(`range request returned ${ranged.status()}, expected 206`);
  if ((await ranged.body()).length !== 100) throw new Error("range request returned the wrong number of bytes");
  if (!/^bytes 0-99\/\d+$/.test(ranged.headers()["content-range"] ?? "")) throw new Error("bad content-range header");

  step("pages stay fast while 9router is unreachable");
  for (const url of ["/", "/settings", "/jobs", "/workers"]) {
    const t0 = Date.now();
    await page.goto(`${APP}${url}`, { waitUntil: "commit" });
    const ms = Date.now() - t0;
    console.log(`   ${url} first byte in ${ms} ms`);
    if (ms > 2500) throw new Error(`${url} took ${ms} ms to start rendering`);
  }
  await page.goto(`${APP}/settings`);
  // The fake 9router hangs. The page stops waiting after about 3 s (so "load" fires) and shows "Checking"; the card then
  // refreshes itself, and the check ends through its 60 s timeout, so "Unreachable" can take about a minute.
  await page.getByText("Unreachable").waitFor({ timeout: 90_000 });
  await page.getByText("internal address").first().waitFor();
  await page.getByText("Server health").waitFor();

  step("9router comes back: check again, then scan the studio capabilities");
  router.mode = "ok";
  await page.goto(`${APP}/settings`);
  await page.getByRole("button", { name: "Check again" }).last().click();
  await page.getByText(/^\d+ models$/).waitFor({ timeout: 30_000 });
  const capCard = page.locator("ul.gap-3 > li");
  const stageItem = (p, label) => p.locator("ul.gap-3 > li").filter({ has: p.getByRole("heading", { name: label, exact: true }) });
  // A scan that the page started in the background while 9router hung may still be running. Press Scan now until the
  // new answer is shown (each press waits for the running scan, then the next one sees the working 9router).
  let scanned = false;
  for (let i = 0; i < 4 && !scanned; i++) {
    await page.goto(`${APP}/settings`);
    await page.getByRole("button", { name: "Scan now" }).click();
    scanned = await stageItem(page, "Voice")
      .getByText("kokoro/af_heart")
      .first()
      .waitFor({ timeout: 90_000 })
      .then(() => true, () => false);
  }
  if (!scanned) throw new Error("the capabilities scan never listed the 9router voice");
  if ((await capCard.count()) < 5) throw new Error("the capabilities card shows too few stages");
  if (!(await stageItem(page, "Voice").innerText()).includes("via 9router")) throw new Error("the voice stage does not show a 9router executor");
  if (!(await stageItem(page, "Images").innerText()).includes("via Hermes")) throw new Error("the image stage does not show a Hermes executor");
  const videoText = await stageItem(page, "Video clips").innerText();
  if (!videoText.includes("Found, not used yet")) throw new Error(`video clips should be found but not used yet, saw: ${videoText.replace(/\s+/g, " ")}`);
  if (fakeStats.capabilityScans < 1) throw new Error("the fake Hermes never answered the capabilities stage");
  // The page reads only the stored scan: starting to render must stay fast with the snapshot present.
  for (const url of ["/settings", "/"]) {
    const t0 = Date.now();
    await page.goto(`${APP}${url}`, { waitUntil: "commit" });
    const ms = Date.now() - t0;
    console.log(`   ${url} first byte in ${ms} ms after the scan`);
    if (ms > 2500) throw new Error(`${url} took ${ms} ms to start rendering after the capabilities scan`);
  }
  await page.goto(`${APP}/settings`);
  await shot("06c-settings-capabilities-desktop");

  step("settings: the capability card says the 9router models are listed, not proven");
  const imagesCard = await stageItem(page, "Images").innerText();
  if (!/listed, not proven yet/i.test(imagesCard)) throw new Error(`the image stage should show 9router models as listed, not proven: ${imagesCard.replace(/\s+/g, " ")}`);

  step("settings: Test 9router image sets the refusing model aside and proves the working one");
  await page.goto(`${APP}/settings`);
  await page.getByText("none is proven by a real call yet").first().waitFor();
  await page.getByRole("button", { name: "Test 9router image" }).click();
  // The raw 9router JSON is shortened to the provider's own message.
  await page.getByText("Cloudflare: prompt is required (code 3030)").first().waitFor({ timeout: 60_000 });
  await page.getByText("fake-img/flux-lite: worked").first().waitFor({ timeout: 60_000 });
  if (fakeStats.routerBadImageCalls !== 1) throw new Error(`the refusing 9router model was asked ${fakeStats.routerBadImageCalls} times, expected 1`);
  await page.goto(`${APP}/settings`);
  const routerHealth = page.getByTestId("router-image-health");
  await routerHealth.locator('[data-proof="quarantined"]', { hasText: ROUTER_BAD_IMAGE_MODEL }).waitFor();
  await routerHealth.locator('[data-proof="proven"]', { hasText: "fake-img/flux-lite" }).waitFor();
  const imagesProven = await stageItem(page, "Images").innerText();
  if (!imagesProven.includes("set aside after a request error") || !imagesProven.includes("proven by a real call")) {
    throw new Error(`the image stage should show one model set aside and one proven: ${imagesProven.replace(/\s+/g, " ")}`);
  }
  const routerImageCallsBeforeRun = fakeStats.routerImageCalls;

  step("Hermes connection shows features and skills");
  await page.getByText("3 skills").first().waitFor({ timeout: 20_000 });
  await page.getByText("Background runs").waitFor();
  await page.locator("summary", { hasText: "video" }).click();
  await page.getByText("write-story-script", { exact: true }).waitFor();
  await shot("06b-settings-gateway-down");
  await page.goto(`${APP}/`);
  await shot("07-overview-desktop");

  step("studio: the Studio page leads with New video; the old planner is gone");
  await page.goto(`${APP}/studio`);
  const studioNav = page.getByRole("navigation", { name: "Studio" });
  await studioNav.getByRole("link", { name: "New video", exact: true }).waitFor();
  for (const name of ["Runs", "Styles", "Lab", "Templates", "Test render"]) await studioNav.getByRole("link", { name, exact: true }).waitFor();
  if ((await page.getByText("New production", { exact: true }).count()) !== 0) throw new Error("/studio still offers New production");
  if ((await page.getByText(/Planning only/).count()) !== 0) throw new Error("/studio still says Planning only");
  // Old links keep working: the run list moved to /studio.
  await page.goto(`${APP}/studio/runs`);
  await page.waitForURL(`${APP}/studio`);
  await shot("13-studio-desktop");

  step("studio: queue a test render from Test render, let the worker run it, see the video");
  await page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "Test render", exact: true }).click();
  await page.waitForURL(/\/studio\/test-render$/);
  await page.selectOption("#test-style", "documentary-stills");
  await page.selectOption("#test-format", "short");
  await page.getByRole("button", { name: "Queue test render", exact: true }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  runWorker([`${OUT}/worker/run.sh`, "tick"]);
  await page.goto(page.url());
  await page.getByText("Test render (placeholder cards)").first().waitFor();
  await page.getByText("Done").first().waitFor({ timeout: 30_000 });
  await page.locator("video").first().waitFor();
  await shot("13b-test-render-desktop");
  await page.goto(`${APP}/studio/test-render`);
  await page.getByTestId("saved-production").filter({ hasText: "Test render: Narrated documentary with stills" }).first().waitFor();

  step("assets: upload a reference video with its licence");
  const refPath = path.join(OUT, "reference.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=30",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:d=3:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=7",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", refPath,
  ]);
  await page.goto(`${APP}/assets`);
  await page.setInputFiles("input[name=file]", refPath);
  await page.fill("input[name=title]", "Test reference");
  await page.selectOption("select[name=kind]", "reference-video");
  await page.fill("input[name=license]", "Own test clip, study only");
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText("Saved Test reference.").waitFor();

  step("assets: upload a music track, marked as music for video beds");
  const musicPath = path.join(OUT, "music-bed.wav");
  // Two chords, 6 s: short, so a render has to loop it under the narration.
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=262:duration=6", "-f", "lavfi", "-i", "sine=frequency=330:duration=6",
    "-filter_complex", "[0:a][1:a]amix=inputs=2,volume=0.6[a]", "-map", "[a]", "-ar", "44100", musicPath,
  ]);
  await page.goto(`${APP}/assets`);
  await page.setInputFiles("input[name=file]", musicPath);
  await page.fill("input[name=title]", "Test music bed");
  await page.selectOption("select[name=kind]", "audio");
  await page.fill("input[name=license]", "Own composition for tests, all rights");
  await page.fill("input[name=originUrl]", "https://example.com/venstudio-test-music");
  await page.getByLabel("This is a music track for video beds").check();
  await page.getByRole("button", { name: "Upload" }).click();
  await page.getByText("Saved Test music bed.").waitFor();
  await page.locator("li", { hasText: "Test music bed" }).getByText("music", { exact: true }).waitFor();

  step("assets: analyze the reference, run the worker, see the cuts");
  await page.locator("li", { hasText: "Test reference" }).getByRole("button", { name: "Analyze" }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/);
  runWorker([`${OUT}/worker/run.sh`, "tick"]);
  await page.goto(`${APP}/assets`);
  await page.locator("li", { hasText: "Test reference" }).getByText("2 cuts").waitFor({ timeout: 20_000 });
  await shot("14-assets-desktop");
  for (const url of ["/assets", "/studio"]) {
    await page.goto(`${APP}${url}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) throw new Error(`${url} overflows horizontally on desktop`);
  }

  step("save a worker output to Assets");
  await page.goto(`${APP}/jobs?status=succeeded`);
  await page.getByRole("link").filter({ hasText: "Render smoke test" }).first().click();
  await page.getByRole("button", { name: "Save to Assets" }).first().click();
  await page.waitForURL(/\/assets$/);
  await page.getByText("smoke-test: smoke-test.mp4").waitFor();

  step("templates: every style is a candidate, nothing is proven");
  await page.goto(`${APP}/studio/templates`);
  await page.getByText("Candidate: not yet proven").first().waitFor();
  if ((await page.getByText("Proven", { exact: true }).count()) !== 0) throw new Error("a template shows as Proven before any trial");
  if ((await page.getByText("Allowed", { exact: true }).count()) !== 0) throw new Error("a template is allowed to run without the owner");
  await shot("16-templates-desktop");

  step("mobile screenshots");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    storageState: await desktop.storageState(),
  });
  const m = await mobile.newPage();
  // The 12-settings-mobile screenshot from an earlier run is 1940 px wide at 2x scale (970 CSS px), so /settings
  // already overflowed at 390 px before this change (the signed-in device user agent string). It is screenshotted
  // but not asserted. The other pages were 780 px wide (fit) in those screenshots; templates is new and asserted.
  const NO_OVERFLOW_CHECK = new Set(["/settings"]);
  for (const [name, url] of [
    ["08-overview-mobile", "/"],
    ["09-channels-mobile", "/channels"],
    ["10-workers-mobile", "/workers"],
    ["11-jobs-mobile", "/jobs"],
    ["12-settings-mobile", "/settings"],
    ["13-studio-mobile", "/studio"],
    ["13c-new-video-mobile", "/studio/new"],
    ["13d-test-render-mobile", "/studio/test-render"],
    ["14-assets-mobile", "/assets"],
    ["15-styles-mobile", "/studio/styles"],
    ["16-templates-mobile", "/studio/templates"],
  ]) {
    await m.goto(`${APP}${url}`);
    await m.waitForLoadState("networkidle");
    await shot(name, m);
    if (NO_OVERFLOW_CHECK.has(url)) continue;
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(`mobile layout overflows horizontally on ${url}`);
  }

  step("mobile: the capabilities card fits in 390 px");
  await m.goto(`${APP}/settings`);
  await m.waitForLoadState("networkidle");
  await m.locator("ul.gap-3 > li").first().waitFor();
  const wide = await m.evaluate(() => {
    const list = document.querySelector("ul.gap-3");
    const card = list?.closest("section") ?? list?.parentElement;
    if (!list || !card) return "the capabilities card was not found";
    for (const el of [card, ...card.querySelectorAll("*")]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) return `${el.tagName.toLowerCase()} ends at ${Math.round(r.right)} px`;
    }
    return "";
  });
  if (wide) throw new Error(`the capabilities card overflows at 390 px: ${wide}`);
  await m.locator("ul.gap-3").first().scrollIntoViewIfNeeded();
  await shot("16-capabilities-mobile", m);

  step("director: Test Hermes JSON passes against the fake Hermes");
  await page.goto(`${APP}/studio/test-render`);
  await page.getByRole("button", { name: "Test Hermes JSON" }).click();
  await page.getByText("Hermes returned valid JSON").waitFor();

  // Waits until the fake Hermes has seen a prompt for a stage that passes the check.
  async function waitPrompt(stage, ok, what, ms = 30_000) {
    const end = Date.now() + ms;
    while (!(lastPrompt[stage] && ok(lastPrompt[stage]))) {
      if (Date.now() > end) throw new Error(`the ${stage} prompt never carried ${what}. Last ${stage} prompt:\n${String(lastPrompt[stage] ?? "(none)").slice(0, 3000)}`);
      await page.waitForTimeout(500);
    }
    return lastPrompt[stage];
  }
  const dataBlock = (prompt, label) => new RegExp(`<<<DATA ${label}\\n([\\s\\S]*?)\\nDATA ${label}>>>`).exec(prompt)?.[1] ?? "";

  step("director: start a video from /studio with a style, purposes, theme, language and subtitles");
  const STUDIO_BRIEF = "A myth about the wolf that swallows the sun, told as a mystery";
  await page.goto(`${APP}/studio`);
  await page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "New video", exact: true }).click();
  await page.waitForURL(/\/studio\/new$/);
  await page.selectOption("#channelId", { label: "Myth Stories" });
  // The channel's plan and autonomy are shown, read only.
  const channelContext = await page.getByTestId("channel-context").innerText();
  if (!channelContext.includes("Retell one myth per video") || !/Level \d/.test(channelContext)) throw new Error(`the channel context is incomplete: ${channelContext.replace(/\s+/g, " ")}`);
  await page.fill("#brief", STUDIO_BRIEF);
  await page.getByRole("button", { name: "Suggest from brief", exact: true }).click();
  await page.getByTestId("style-suggestions").waitFor();
  // Style packs: every pack is in Trial, so the main list is empty and the research-only section offers them, once the
  // worker reports the pack. Planned catalogue styles are never options.
  const trialSection = page.getByTestId("trial-styles");
  await trialSection.getByRole("heading", { name: "Trial styles (research only, not for publishing)", exact: true }).waitFor();
  await trialSection.getByTestId("trial-style-explainer-flat-vector").getByText("Trial style", { exact: true }).waitFor();
  // The Hermes research pack is rendered by the portal, so it is offered here (only here) once Hermes is set up.
  await trialSection.getByTestId("trial-style-hermes-research-explainer").getByTestId("hermes-render-label").getByText("Hermes render (research only)", { exact: true }).waitFor();
  await page.getByTestId("no-listed-styles").waitFor();
  const styleOptions = await page.locator("#templateId option").evaluateAll((os) => os.map((o) => o.value));
  for (const planned of ["tpl-kinetic-facts", "tpl-math-explainer", "tpl-blender-3d", "tpl-ai-character-sketch"]) {
    if (styleOptions.includes(planned)) throw new Error(`New Video offers the planned style ${planned}: ${styleOptions.join(", ")}`);
  }
  if (!styleOptions.includes("tpl-explainer-flat-vector")) throw new Error(`New Video does not offer the trial pack: ${styleOptions.join(", ")}`);
  const trialGroup = await page.locator("#templateId optgroup").evaluateAll((gs) => gs.map((g) => g.label));
  if (!trialGroup.includes("Trial styles (research only, not for publishing)")) throw new Error(`no trial group in the style list: ${trialGroup.join(", ")}`);
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.getByTestId("trial-style-note").waitFor();
  await page.selectOption("#format", "short");
  const engineInfo = await page.getByTestId("engine-info").innerText();
  if (!engineInfo.includes("Muse: runs well") || !engineInfo.includes("A worker reports remotion-2d")) throw new Error(`the engine line is wrong: ${engineInfo.replace(/\s+/g, " ")}`);
  await page.selectOption("#themeId", "myth");
  await page.getByRole("checkbox", { name: /^Affiliate links/ }).check();
  await page.getByRole("checkbox", { name: /^Series \(recurring episodes\)/ }).check();
  await page.selectOption("#language", "en");
  await page.getByTestId("kokoro-flag").getByText("Kokoro voice", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "Spanish", exact: true }).check();
  // Selects keep their values while the form works (no React form reset).
  if ((await page.inputValue("#templateId")) !== "tpl-explainer-flat-vector" || (await page.inputValue("#themeId")) !== "myth") throw new Error("a select lost its value");
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();
  if ((await page.inputValue("#channelId")) === "" || (await page.inputValue("#language")) !== "en") throw new Error("the form was reset after the run started");
  const startedHref = await page.getByTestId("run-started-link").getAttribute("href");
  if (!startedHref) throw new Error("no link to the started run");

  step("director: the run config and the idea prompt carry the form's choices");
  const ideaAsk = await waitPrompt("idea", (t) => t.includes(STUDIO_BRIEF), "the brief");
  const purposeData = dataBlock(ideaAsk, "video purpose");
  for (const want of ["Purpose: Affiliate links (affiliate)", "Purpose: Series (recurring episodes) (series)", "Planning step: Series bible"]) {
    if (!purposeData.includes(want)) throw new Error(`the idea prompt's purpose block misses "${want}": ${purposeData.slice(0, 800)}`);
  }
  if (!dataBlock(ideaAsk, "theme").includes("Theme: Myth and folklore (myth)")) throw new Error("the idea prompt has no theme block for myth");
  if (!dataBlock(ideaAsk, "subtitle languages").includes("Spanish (es)")) throw new Error("the idea prompt has no Spanish subtitles");
  if (!ideaAsk.includes("language code en")) throw new Error("the idea prompt does not name the narration language");
  if (!/one episode of a recurring series/.test(ideaAsk)) throw new Error("the idea prompt does not steer the series purpose");
  await page.goto(`${APP}${startedHref}`);
  // The section is collapsed; open it like the owner would, so innerText includes the list.
  await page.getByTestId("run-settings").locator("summary").click();
  await page.getByTestId("run-settings").locator("dl").waitFor();
  const settingsText = await page.getByTestId("run-settings").innerText();
  for (const want of ["Affiliate links, Series (recurring episodes)", "Myth and folklore, chosen for this video", "Spanish", "English (Kokoro voice)", STUDIO_BRIEF, "explainer-flat-vector 1.0.1, Trial: research only, not for publishing"]) {
    if (!settingsText.includes(want)) throw new Error(`the run settings miss "${want}": ${settingsText.replace(/\s+/g, " ")}`);
  }
  // A run started with a Trial pack carries the badge, and its config records the pack (additive).
  await page.getByTestId("trial-badge").getByText("Trial style: research only, not for publishing", { exact: true }).waitFor();
  const startedId = startedHref.split("/").pop();
  const storedPack = dbValue(`SELECT config->'stylePack'->>'id' || '@' || (config->'stylePack'->>'version') || ':' || (config->'stylePack'->>'trial') FROM pipeline_runs WHERE id = '${startedId}'`);
  if (storedPack !== null && storedPack !== "explainer-flat-vector@1.0.1:true") throw new Error(`the run config does not mark the trial pack: ${storedPack}`);
  // The run's stage list is fixed at start (config.workflow, additive): an image-sequence run keeps the original eight.
  const storedFlow = dbValue(`SELECT (config->'workflow'->>'recipe') || ' ' || (config->'workflow'->'stages')::text FROM pipeline_runs WHERE id = '${startedId}'`);
  if (storedFlow !== null && storedFlow !== 'image-sequence ["idea", "research", "script", "storyboard", "assets", "voice", "render", "qc"]') throw new Error(`the image-sequence run stored the workflow "${storedFlow}"`);
  if (!settingsText.includes("Image sequence: Idea → Research → Script → Storyboard → Assets → Voice → Video → Quality check")) throw new Error(`the run settings do not name the workflow: ${settingsText.replace(/\s+/g, " ")}`);
  await page.locator('[data-testid="run-workflow"][data-recipe="image-sequence"]').getByTestId("workflow-step-assets").waitFor();
  await page.goto(`${APP}/studio`);
  await page.getByTestId("studio-runs").getByRole("link").filter({ hasText: "Myth Stories" }).first().waitFor();

  // Polls a page until a locator shows. The server works in the background after the click returns.
  async function waitShown(p, url, locator, what, ms = 45_000) {
    const end = Date.now() + ms;
    for (;;) {
      await p.goto(`${APP}${url}`);
      if (await locator(p).first().isVisible().catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what} on ${url}`);
      await p.waitForTimeout(1500);
    }
  }
  async function assertTapTargets(p, locators) {
    for (const [label, loc] of locators) {
      const box = await loc.first().boundingBox();
      if (!box) throw new Error(`${label} is not visible`);
      if (box.height < 44) throw new Error(`${label} is ${box.height}px tall, under 44px`);
    }
  }
  /** Rates every rubric line on a quality-check card, saves the score and waits for the card to show it. */
  async function scoreVideo(card, stars, shown) {
    const labels = { hook: "Hook", pacing: "Pacing", legibility: "Legibility", polish: "Visual polish", audio: "Audio" };
    for (const [id, n] of Object.entries(stars)) await card.getByTestId(`rubric-${id}`).getByRole("radio", { name: `${labels[id]}: ${n} of 5`, exact: true }).check();
    await card.getByTestId("presentation-score").getByRole("button", { name: /^(Save|Update) score$/ }).click();
    await card.getByTestId("presentation-value").getByText(shown, { exact: true }).waitFor({ timeout: 20_000 });
  }
  async function assertNoOverflow(p, url) {
    const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (wide) throw new Error(`mobile layout overflows horizontally on ${url}`);
  }

  step("director: the Review inbox works at 390 px");
  await waitShown(m, "/review", (p) => p.getByRole("button", { name: "Approve this idea" }), "the idea review item");
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review");
  await assertTapTargets(m, [
    ["Approve this idea", m.getByRole("button", { name: "Approve this idea" })],
    ["revision note", m.getByLabel("What should change?")],
    ["Send revision", m.getByRole("button", { name: "Send revision" })],
    ["Reject", m.getByRole("button", { name: "Reject" })],
  ]);
  await m.getByTestId("review-card").filter({ has: m.getByRole("button", { name: "Approve this idea" }) }).first().getByTestId("trial-badge").waitFor();
  await shot("17-review-mobile", m);
  const runHref = await m.getByRole("link", { name: "Open run" }).first().getAttribute("href");
  if (!runHref) throw new Error("review card has no link to its run");

  step("director: request a revision with a note and see a new attempt");
  await m.getByLabel("What should change?").first().fill("Only Norse myths, please");
  await m.getByRole("button", { name: "Send revision" }).first().click();
  await waitShown(m, "/review", (p) => p.getByText("(revised)"), "the revised ideas");
  await m.goto(`${APP}${runHref}`);
  await m.getByText("attempt 2").first().waitFor();

  step("production: approve the idea and reach the assets review (thumbnails, provider terms notice)");
  await m.goto(`${APP}/review`);
  await m.getByRole("button", { name: "Approve this idea" }).first().click();
  let sawHermesWait = false;
  {
    // The storyboard may ask for approval at this autonomy level, or pass on its own. Either way the assets review follows.
    // Hermes answers the first image asks with 429, so the assets stage waits a few seconds on the way.
    const end = Date.now() + 150_000;
    for (;;) {
      await m.goto(`${APP}/review`);
      if (!sawHermesWait) sawHermesWait = await m.getByTestId("hermes-waiting").first().isVisible().catch(() => false);
      if (await m.getByTestId("asset-grid").first().isVisible().catch(() => false)) break;
      if (await m.locator('[data-kind="stage-error"]').first().isVisible().catch(() => false)) {
        await dumpPipeline(m, runHref, "a stage error appeared while the assets were being made");
        throw new Error(`a stage error appeared instead of the assets review: ${(await m.locator('[data-kind="stage-error"]').first().innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
      }
      if (!sawHermesWait) {
        await page.goto(`${APP}${runHref}`);
        sawHermesWait = await page.getByTestId("hermes-wait").isVisible().catch(() => false);
      }
      const board = m.locator('[data-testid="review-card"]', { hasText: "Approve the storyboard" });
      if (await board.first().isVisible().catch(() => false)) await board.first().getByRole("button", { name: "Approve", exact: true }).click();
      if (Date.now() > end) {
        await dumpPipeline(m, runHref, "the assets review never appeared");
        throw new Error("timed out waiting for the assets review");
      }
      await m.waitForTimeout(sawHermesWait ? 2000 : 700);
    }
  }
  // The 429 burst was served and the shots still finished (no stage error, the grid is there). The wait itself lasts
  // only a few seconds here, so seeing it on a page is logged, not required.
  if (fakeStats.hermes429 !== HERMES_429_BURST) throw new Error(`the fake Hermes answered 429 ${fakeStats.hermes429} times, expected ${HERMES_429_BURST}`);
  console.log(`   Hermes 429 burst of ${HERMES_429_BURST} absorbed; waiting status ${sawHermesWait ? "was" : "was not"} caught on a page`);
  // A storyboard provider Hermes never reported must never reach the image prompt. Whether agnes was kept depends on
  // the capability scan having run before the storyboard, so that part is logged, not asserted.
  if (fakeStats.droppedPreferenceAsks !== 0) throw new Error("the storyboard's unknown provider (midjourney) reached the image prompt");
  console.log(`   per-shot preference: agnes asked first ${fakeStats.shotPreferenceAsks} time(s) (0 means no scan had run before the storyboard)`);
  await m.waitForLoadState("networkidle");
  const grid = m.getByTestId("asset-grid").first();
  const thumbs = grid.locator("img");
  if ((await thumbs.count()) < 3) throw new Error(`expected at least 3 thumbnails, got ${await thumbs.count()}`);
  await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-grid"] img')].every((i) => i.complete && i.naturalWidth > 0));
  await m.getByTestId("provider-terms-notice").first().waitFor();
  const gridText = (await grid.textContent()) ?? "";
  if (!gridText.includes("canva via 9router")) throw new Error(`the image grid does not name the backend and plugin (canva via 9router): ${gridText.slice(0, 300)}`);
  if (!gridText.includes("unlisted-cloudflare-9router")) throw new Error("the image grid does not name the unlisted backend of shot-03 (unlisted-cloudflare-9router)");
  if (gridText.includes("unlisted-9router")) throw new Error("an image is credited to the plugin (unlisted-9router) instead of its backend");
  await assertNoOverflow(m, "/review (assets)");
  // The card names the exact asset_providers rows that block it, each with the owner's choices right there.
  const assetsGateCard = () => m.locator('[data-testid="review-card"][data-stage="assets"][data-kind="gate-failure"]').first();
  const blockingRow = (card, name) => card.locator(`[data-testid="blocking-provider"][data-provider="${name}"]`);
  const blockingNames = (card) => card.locator('[data-testid="blocking-provider"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-provider")}:${e.getAttribute("data-kind")}`));
  // Images the run asked for (Hermes per shot, and 9router). The Settings test image is shot "test" and is not counted.
  const productionImageCalls = () => Object.entries(fakeStats.imageAsks).filter(([k]) => k.startsWith("shot-")).reduce((n, [, v]) => n + v, 0) + fakeStats.routerImageCalls;
  const ttsCalls = () => fakeStats.routerSpeechCalls + fakeStats.hermesKokoroCalls;
  {
    const names = await blockingNames(assetsGateCard());
    for (const want of ["canva:image", "unlisted-cloudflare-9router:image", "fake-img:image"]) {
      if (!names.includes(want)) throw new Error(`the assets card does not list the blocking provider ${want}; it lists: ${names.join(", ")}`);
    }
    if (names.some((n) => n.startsWith("unlisted-9router:"))) throw new Error("the assets card lists the plugin row unlisted-9router");
    // Terms are the only issue and no shot failed, so the card offers the re-check and no Retry.
    if ((await assetsGateCard().getByRole("button", { name: /Retry/ }).count()) !== 0) throw new Error("the terms-only assets card still offers Retry");
  }
  await assertTapTargets(m, [
    ["Check the terms again", assetsGateCard().getByRole("button", { name: "Check the terms again", exact: true })],
    ["Commercial use OK (canva)", blockingRow(assetsGateCard(), "canva").getByRole("button", { name: "Commercial use OK", exact: true })],
    ["Not for commercial use (canva)", blockingRow(assetsGateCard(), "canva").getByRole("button", { name: "Not for commercial use", exact: true })],
    ["note (canva)", blockingRow(assetsGateCard(), "canva").getByLabel("Note for canva", { exact: true })],
    ["Confirm the terms in Settings", assetsGateCard().getByRole("link", { name: "Confirm the terms in Settings", exact: true })],
  ]);
  await shot("20-review-assets-mobile", m);
  await page.goto(`${APP}/review`);
  await page.getByTestId("asset-grid").first().waitFor();
  await shot("20-review-assets-desktop");
  if (fakeStats.pathAnswers < 1) throw new Error("the path answer variant never ran");
  if (fakeStats.errorAnswers < 3) throw new Error("the failing image variant never ran its first attempt");
  if (fakeStats.urlAnswers < 1) throw new Error("the download link variant never ran");
  // shot-04 is refused by Hermes every time, so 9router made it: it was asked, and the grid names its provider.
  if (fakeStats.hermesImageRefusals < 1) throw new Error("the Hermes image refusal variant never ran");
  if (fakeStats.routerImageCalls < 1) throw new Error("9router was never asked for an image after Hermes refused");
  if (!(await grid.textContent()).includes("fake-img")) throw new Error("the image grid does not show the 9router image provider (fake-img)");
  if (fakeStats.routerImageCalls <= routerImageCallsBeforeRun) throw new Error("the run never used the proven 9router image model");
  if (fakeStats.routerBadImageCalls !== 1) throw new Error(`the set-aside 9router model was used again by the run (${fakeStats.routerBadImageCalls} calls)`);
  const assetsRunHref = await m.getByRole("link", { name: "Open run" }).first().getAttribute("href");

  step("review: the owner confirms canva on the assets card; the card is checked again without making images");
  const imagesBeforeTerms = productionImageCalls();
  {
    const card = assetsGateCard();
    const oldId = await card.getAttribute("data-review-id");
    await blockingRow(card, "canva").getByRole("button", { name: "Commercial use OK", exact: true }).click();
    // The server action saves, re-checks the card and returns the new page: the old card goes away in place.
    await m.locator(`[data-testid="review-card"][data-review-id="${oldId}"]`).waitFor({ state: "detached", timeout: 30_000 });
    await m.goto(`${APP}/review`);
    const next = assetsGateCard();
    try {
      await next.waitFor({ timeout: 20_000 });
    } catch (err) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "no assets card after confirming canva on the card");
      throw err;
    }
    if ((await next.getAttribute("data-review-id")) === oldId) throw new Error("the assets card was not checked again after canva was confirmed on it");
    const names = await blockingNames(next);
    if (names.includes("canva:image")) throw new Error(`canva still blocks after it was confirmed on the card: ${names.join(", ")}`);
    if (!names.includes("unlisted-cloudflare-9router:image") || !names.includes("fake-img:image")) throw new Error(`the checked card lost a row that still blocks: ${names.join(", ")}`);
    await next.getByTestId("rechecked").waitFor();
    if (productionImageCalls() !== imagesBeforeTerms) throw new Error(`confirming terms made new images (${imagesBeforeTerms} -> ${productionImageCalls()} image calls)`);
    await assertNoOverflow(m, "/review (assets checked again)");
    await shot("20b-review-assets-rechecked-mobile", m);
  }

  // The owner confirms a provider in Settings. Nothing else can set this.
  async function confirmProvider(name) {
    await page.goto(`${APP}/settings`);
    const select = page.getByLabel(`Commercial use for ${name}`, { exact: true }).first();
    await select.waitFor();
    await select.selectOption("yes");
    await select.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
    for (let i = 0; i < 15; i++) {
      await page.goto(`${APP}/settings`);
      if ((await page.getByLabel(`Commercial use for ${name}`, { exact: true }).first().inputValue()) === "yes") return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`the terms for ${name} were not saved`);
  }

  step("settings: the owner confirms the image provider terms, Kokoro is healthy, Test Hermes image works");
  // Asset providers lists each backend, never the plugin in front of them.
  await page.goto(`${APP}/settings`);
  for (const name of ["canva", "unlisted-cloudflare-9router"]) {
    if ((await page.locator(`[data-testid="provider-row"][data-provider="${name}"]`).count()) !== 1) {
      const rows = await page.locator('[data-testid="provider-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")));
      throw new Error(`Asset providers has no row for the backend ${name}; rows: ${rows.join(", ")}`);
    }
  }
  if ((await page.locator('[data-testid="provider-row"][data-provider="unlisted-9router"]').count()) !== 0) {
    throw new Error("Asset providers has a row for the plugin unlisted-9router; images must be credited to their backend");
  }
  // canva was confirmed on the Review card: Settings shows the same row as confirmed.
  if ((await page.getByLabel("Commercial use for canva", { exact: true }).first().inputValue()) !== "yes") throw new Error("canva, confirmed on the Review card, is not confirmed in Settings");
  await confirmProvider("unlisted-cloudflare-9router");
  await confirmProvider("fake-img");
  // No KOKORO_BASE_URL is set: the voice comes from the Kokoro model 9router lists, and Hermes is only the fallback.
  await page.getByText("9router voice kokoro/af_heart").first().waitFor();
  await page.getByRole("button", { name: "Test voice" }).click();
  await page.getByText("Voice made by kokoro through 9router").waitFor({ timeout: 30_000 });
  const calls = fakeStats.routerSpeechCalls;
  router.tts = "error";
  await page.getByRole("button", { name: "Test voice" }).click();
  try {
    await page.getByText("Voice made by hermes-kokoro through Hermes").waitFor({ timeout: 60_000 });
  } catch (err) {
    const panel = await page.locator("form", { has: page.getByRole("button", { name: "Test voice" }) }).first().innerText().catch(() => "(voice panel not readable)");
    console.error(`Test voice fallback did not show. Voice panel text:\n${panel}\nfakeStats: ${JSON.stringify(fakeStats)}\nrouter: ${JSON.stringify(router)}`);
    throw err;
  }
  router.tts = "ok";
  if (fakeStats.hermesKokoroCalls < 1) throw new Error("the voice did not fall back to Hermes Kokoro when 9router speech failed");
  if (fakeStats.routerSpeechCalls !== calls) throw new Error("the failing 9router speech endpoint was counted as a success");
  await page.getByRole("button", { name: "Test Hermes image" }).click();
  await page.getByText("Providers Hermes reports: cloudflare, agnes").waitFor({ timeout: 60_000 });
  await page.getByText("Image made by canva via 9router plugin (fake-flux)", { exact: true }).waitFor();
  await shot("21-settings-media-desktop");

  step("production: the assets pass once every provider is confirmed, without making images again");
  {
    // Saving terms in Settings re-checks the card in after(). If that has not landed yet, the owner's button does the same.
    let pressed = false;
    const start = Date.now();
    for (;;) {
      await m.goto(`${APP}/review`);
      if (await m.locator('[data-testid="review-card"][data-stage="assets"][data-kind="approval"]').first().isVisible().catch(() => false)) break;
      const stale = assetsGateCard();
      if (!pressed && Date.now() - start > 15_000 && (await stale.isVisible().catch(() => false))) {
        const left = await blockingNames(stale);
        if (left.length !== 0) throw new Error(`the assets card still lists blocking providers after Settings confirmed them: ${left.join(", ")}`);
        await stale.getByTestId("terms-now-confirmed").waitFor();
        const id = await stale.getAttribute("data-review-id");
        await stale.getByRole("button", { name: "Check the terms again", exact: true }).click();
        await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
        pressed = true;
        continue;
      }
      if (Date.now() - start > 60_000) {
        await dumpPipeline(m, assetsRunHref ?? runHref, "the assets approval never appeared after every provider was confirmed");
        throw new Error("timed out waiting for the assets approval after the terms were confirmed");
      }
      await m.waitForTimeout(1500);
    }
    console.log(`   assets passed after the Settings confirmations via ${pressed ? "Check the terms again" : "the automatic re-check"}`);
    if (productionImageCalls() !== imagesBeforeTerms) throw new Error(`the assets were made again (${imagesBeforeTerms} -> ${productionImageCalls()} image calls)`);
  }
  await m.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-grid"] img')].every((i) => i.complete && i.naturalWidth > 0));
  await assertNoOverflow(m, "/review (assets approved terms)");
  await m.getByRole("button", { name: "Approve", exact: true }).first().click();

  step("production: voice review with an audio player");
  await waitShown(m, "/review", (p) => p.getByTestId("voice-audio"), "the voice review", 120_000);
  await m.waitForLoadState("networkidle");
  const audioSrc = await m.getByTestId("voice-audio").first().getAttribute("src");
  if (!/^\/api\/assets\/[0-9a-f-]{36}$/.test(audioSrc ?? "")) throw new Error(`unexpected audio source ${audioSrc}`);
  const audioRes = await m.request.get(`${APP}${audioSrc}`);
  if (audioRes.status() !== 200 || !(audioRes.headers()["content-type"] ?? "").startsWith("audio/")) throw new Error("the narration asset is not served as audio");
  if (fakeStats.routerSpeechCalls < 1) throw new Error("the fake 9router was never asked to speak");
  await assertNoOverflow(m, "/review (voice)");
  await assertTapTargets(m, [["Reject", m.getByRole("button", { name: "Reject" })]]);
  await shot("22-review-voice-mobile", m);
  await page.goto(`${APP}/review`);
  await page.getByTestId("voice-audio").first().waitFor();
  await shot("22-review-voice-desktop");

  // The voice provider is registered as unconfirmed by the voice stage (Kokoro through 9router), as a voice (tts) row.
  step("review: the voice card names kokoro; check again, then confirm it on the card, without recording again");
  {
    await m.goto(`${APP}/review`);
    const voiceGateCard = () => m.locator('[data-testid="review-card"][data-stage="voice"][data-kind="gate-failure"]').first();
    if (!(await voiceGateCard().isVisible().catch(() => false))) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "the voice card is not held up by the kokoro terms");
      throw new Error("expected the voice card to be held up by the unconfirmed kokoro terms");
    }
    const names = await blockingNames(voiceGateCard());
    if (names.join(",") !== "kokoro:tts") throw new Error(`the voice card should list exactly kokoro (voice); it lists: ${names.join(", ")}`);
    if ((await voiceGateCard().getByRole("button", { name: "Retry", exact: true }).count()) !== 0) throw new Error("the voice card has an unnamed Retry");
    await voiceGateCard().getByRole("button", { name: "Make the voice again", exact: true }).waitFor();
    // The fake voice speaks about 15 percent slower than the estimate. That is a note on the card, never a failed check.
    const voiceIssues = await voiceGateCard().locator("ul.list-disc > li").allInnerTexts();
    if (voiceIssues.some((t) => /script estimate|limit 10 percent|shots can fill/.test(t))) {
      throw new Error(`the voice card fails on the narration length: ${voiceIssues.join(" | ")}`);
    }
    const voiceNote = (await voiceGateCard().getByTestId("review-notes").innerText()).replace(/\s+/g, " ");
    if (!/percent longer than the script estimate/.test(voiceNote) || !/only a note/.test(voiceNote)) throw new Error(`the voice card has no length note: ${voiceNote}`);
    // Approve anyway is never offered while provider terms are open; Fit is not offered for a narration that fits.
    if ((await voiceGateCard().getByRole("button", { name: "Approve anyway", exact: true }).count()) !== 0) throw new Error("Approve anyway is offered on a card held up by provider terms");
    if ((await voiceGateCard().getByRole("button", { name: "Fit the narration to the video", exact: true }).count()) !== 0) throw new Error("Fit the narration is offered for a narration that fits");
    await voiceGateCard().getByTestId("reject-hint").getByText("stay in Assets", { exact: false }).waitFor();

    // A note about length on the voice card fits the script to the pictures: Hermes rewrites the script, only the voice
    // is recorded again, and no image is made again.
    {
      const imagesBefore = productionImageCalls();
      const ttsBeforeFit = ttsCalls();
      const fitAsksBefore = fakeStats.scriptFitAsks;
      const fitId = await voiceGateCard().getAttribute("data-review-id");
      await voiceGateCard().getByRole("textbox", { name: "What should change?", exact: true }).fill("Make the narration a bit shorter");
      await voiceGateCard().getByRole("button", { name: "Send revision", exact: true }).click();
      await m.locator(`[data-testid="review-card"][data-review-id="${fitId}"]`).waitFor({ state: "detached", timeout: 30_000 });
      let fitted = false;
      for (const end = Date.now() + 60_000; Date.now() < end && !fitted; ) {
        await m.goto(`${APP}/review`);
        fitted = (await voiceGateCard().isVisible().catch(() => false)) && (await voiceGateCard().getAttribute("data-review-id")) !== fitId;
        if (!fitted) await m.waitForTimeout(1000);
      }
      if (!fitted) {
        await dumpPipeline(m, assetsRunHref ?? runHref, "the voice card did not come back after a length note");
        throw new Error("the voice card did not come back after the length note");
      }
      if (fakeStats.scriptFitAsks <= fitAsksBefore) throw new Error("a length note on the voice card did not ask Hermes to fit the script");
      if (!/Keep every beat, in the same order/.test(lastPrompt["script-fit"] ?? "")) throw new Error("the script-fit prompt does not keep the storyboard's beats");
      if (productionImageCalls() !== imagesBefore) throw new Error(`fitting the script made images again (${imagesBefore} -> ${productionImageCalls()} image calls)`);
      // The narration is spoken in chunks of up to 400 characters, so one recording may be more than one speech call.
      if (ttsCalls() <= ttsBeforeFit) throw new Error(`fitting the script did not record the voice again (${ttsBeforeFit} -> ${ttsCalls()} speech calls)`);
      if ((await voiceGateCard().getByText(/The script was fitted to the pictures \(\d+ words\)/).count()) !== 1) {
        throw new Error(`the new voice card does not say the script was fitted: ${(await voiceGateCard().innerText()).slice(0, 400)}`);
      }
      if ((await blockingNames(voiceGateCard())).join(",") !== "kokoro:tts") throw new Error("the fitted voice card does not name kokoro");
      console.log(`   length note: script fitted by Hermes, voice recorded again, images kept (${imagesBefore} image calls)`);
    }
    await assertTapTargets(m, [
      ["Check the terms again (voice)", voiceGateCard().getByRole("button", { name: "Check the terms again", exact: true })],
      ["Commercial use OK (kokoro)", blockingRow(voiceGateCard(), "kokoro").getByRole("button", { name: "Commercial use OK", exact: true })],
    ]);
    const ttsBefore = ttsCalls();

    // Nothing changed yet: checking again replaces the card with one that still names kokoro.
    let id = await voiceGateCard().getAttribute("data-review-id");
    await voiceGateCard().getByRole("button", { name: "Check the terms again", exact: true }).click();
    await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
    await m.goto(`${APP}/review`);
    await voiceGateCard().waitFor({ timeout: 20_000 });
    if ((await voiceGateCard().getAttribute("data-review-id")) === id) throw new Error("Check the terms again did not replace the voice card");
    await voiceGateCard().getByTestId("rechecked").waitFor();
    if ((await blockingNames(voiceGateCard())).join(",") !== "kokoro:tts") throw new Error("the checked voice card does not name kokoro any more");
    if (ttsCalls() !== ttsBefore) throw new Error(`checking the terms again recorded the voice again (${ttsBefore} -> ${ttsCalls()} speech calls)`);

    // The owner confirms kokoro on the card: the card is checked again and asks for approval.
    id = await voiceGateCard().getAttribute("data-review-id");
    await blockingRow(voiceGateCard(), "kokoro").getByRole("button", { name: "Commercial use OK", exact: true }).click();
    await m.locator(`[data-testid="review-card"][data-review-id="${id}"]`).waitFor({ state: "detached", timeout: 30_000 });
    // Once the terms pass, the stage concludes under the run's autonomy: either a voice approval card, or (at a level
    // where a passed voice stage needs no owner) the run moves on by itself and no voice card is left. Both are right.
    const voiceApproval = () => m.locator('[data-testid="review-card"][data-stage="voice"][data-kind="approval"]');
    const anyVoiceCard = () => m.locator('[data-testid="review-card"][data-stage="voice"]');
    let voiceOutcome = "";
    for (const end = Date.now() + 30_000; Date.now() < end && !voiceOutcome; ) {
      await m.goto(`${APP}/review`);
      if (await voiceApproval().first().isVisible().catch(() => false)) voiceOutcome = "approval";
      else if ((await anyVoiceCard().count()) === 0) voiceOutcome = "continued";
      else await m.waitForTimeout(1000);
    }
    if (!voiceOutcome) {
      await dumpPipeline(m, assetsRunHref ?? runHref, "the voice stage did not conclude after kokoro was confirmed on the card");
      throw new Error("the voice stage did not conclude after kokoro was confirmed on the card");
    }
    console.log(`   voice after confirming kokoro: ${voiceOutcome === "approval" ? "approval card" : "passed and the run continued on its own"}`);
    if (ttsCalls() !== ttsBefore) throw new Error(`confirming kokoro recorded the voice again (${ttsBefore} -> ${ttsCalls()} speech calls)`);
    if (voiceOutcome === "approval") {
      await voiceApproval().first().getByTestId("voice-audio").waitFor();
      await assertNoOverflow(m, "/review (voice approved terms)");
      await voiceApproval().first().getByRole("button", { name: "Approve", exact: true }).click();
      await m.waitForLoadState("networkidle");
    }
  }

  step("production: render with the real worker, then the quality check");
  let qcCard = false;
  const productionRunHref = assetsRunHref ?? runHref;
  // A render or voice problem will not fix itself by waiting: stop at once and say what happened.
  const brokenCard = m.locator('[data-testid="review-card"]', { hasText: /(Video|Voice|Assets) (stopped with an error|did not pass the checks)/ });
  for (let i = 0; i < 14 && !qcCard; i++) {
    runWorker([`${OUT}/worker/run.sh`, "tick"]);
    await m.goto(`${APP}/review`);
    // Not on the first pass: the voice card that was just retried or approved may still be listed for a moment.
    if (i > 0 && (await brokenCard.first().isVisible().catch(() => false))) {
      const text = ((await brokenCard.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 600);
      await dumpPipeline(m, productionRunHref, `a production step failed on tick ${i + 1}`);
      throw new Error(`a production step failed before the quality check: ${text}`);
    }
    const video = m.getByTestId("render-video").first();
    const approveVideo = m.locator('[data-kind="approval"]', { hasText: "Approve the video" });
    if (await approveVideo.first().isVisible().catch(() => false)) {
      await video.waitFor();
      await assertNoOverflow(m, "/review (render)");
      await shot("23-review-render-mobile", m);
      await approveVideo.first().getByRole("button", { name: "Approve", exact: true }).click();
      // The decision is saved by a server action. Let it finish so the next tick finds the quality check job.
      await m.waitForLoadState("networkidle");
    }
    qcCard = await m.locator('[data-testid="review-card"]', { hasText: "Quality check" }).first().isVisible().catch(() => false);
    if (!qcCard) await m.waitForTimeout(3000);
  }
  if (!qcCard) {
    await dumpPipeline(m, productionRunHref, "the quality check review never appeared after 14 worker ticks");
    throw new Error("the quality check review never appeared");
  }
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review (quality check)");
  await shot("24-review-qc-mobile", m);
  const qc = m.locator('[data-testid="review-card"][data-stage="qc"]').first();
  // A trial run's final video is scored by the owner on its card before the decision (hook, pacing, legibility,
  // visual polish, audio; 1-5 stars, 0-100 on the server). Deciding first is refused by name.
  const approveQc = qc.getByRole("button", { name: "Approve", exact: true });
  const canApprove = await approveQc.isVisible().catch(() => false);
  await (canApprove ? approveQc : qc.getByRole("button", { name: "Reject", exact: true })).click();
  await qc.getByText(/^This is a trial run: the owner scores the video/).waitFor();
  await scoreVideo(qc, { hook: 5, pacing: 4, legibility: 4, polish: 4, audio: 4 }, "80/100 by the owner");
  await shot("24b-review-qc-scored-mobile", m);
  if (canApprove) await qc.getByRole("button", { name: "Approve", exact: true }).click();
  else await qc.getByRole("button", { name: "Reject", exact: true }).click();
  await m.waitForLoadState("networkidle");

  step("style packs: the render was routed by the pack, the trial outcome is in the curation log, and Styles shows it");
  {
    const prodRunId = /([0-9a-f-]{36})$/.exec(productionRunHref ?? "")?.[1] ?? "";
    const cap = dbValue(`SELECT capability FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${prodRunId}' ORDER BY created_at DESC LIMIT 1`);
    if (cap !== null && cap !== "pack:explainer-flat-vector@1.0.1") throw new Error(`the render job is queued under ${cap}, not the pack capability`);
    // The decision is saved by a server action; the log row follows it.
    let outcome = null;
    for (let i = 0; i < 20; i++) {
      outcome = dbValue(
        `SELECT pack_id || '@' || pack_version || ' ' || qc_passed::text || ' ' || coalesce(owner_decision, 'none') || ' ' || (video_asset_id IS NOT NULL)::text FROM style_trial_outcomes WHERE run_id = '${prodRunId}'`,
      );
      if (outcome === null || / (approved|rejected) /.test(outcome)) break;
      await m.waitForTimeout(1000);
    }
    if (outcome === null) console.log("   no database access (UI_DB unset): the curation log check is skipped");
    else if (!/^explainer-flat-vector@1\.0\.1 (true|false) (approved|rejected) true$/.test(outcome)) {
      await dumpPipeline(m, productionRunHref, "the trial outcome was not recorded");
      throw new Error(`the trial outcome is "${outcome}", expected the pack version, the QC result, the owner's decision and the video`);
    }
    await page.goto(`${APP}/studio/styles`);
    const explainerCard = page.getByTestId("style-pack-explainer-flat-vector");
    await explainerCard.getByText("Trial", { exact: true }).first().waitFor();
    await explainerCard.getByTestId("pack-availability").getByText("A worker reports pack:explainer-flat-vector@1.0.1", { exact: true }).waitFor();
    if (outcome !== null) {
      // Counted with the owner's score: 80 from 5, 4, 4, 4, 4 stars.
      await explainerCard.getByTestId("trial-record").getByText(/^Trial runs of v1\.0\.1: 1 .*mean presentation 80 \(1 scored\)/).waitFor();
      const scored = dbValue(`SELECT presentation_score::text || ' ' || coalesce(presentation_by, 'none') || ' ' || coalesce(owner_rubric->>'hook', '?') || ' ' || coalesce(renderer, '?') FROM style_trial_outcomes WHERE run_id = '${prodRunId}'`);
      if (scored !== "80 owner 5 remotion-2d") throw new Error(`the curation log has "${scored}", expected the owner's 80 with its rubric and the remotion-2d renderer`);
      await explainerCard.getByTestId("promotion-issues").getByText("Needs at least 5 trial runs (has 1)", { exact: true }).waitFor();
    }
    const plannedCard = page.getByTestId("planned-style-kinetic-facts");
    await plannedCard.getByText("Planned", { exact: true }).waitFor();
    await plannedCard.getByText("Not selectable for a run", { exact: true }).waitFor();
    await page.getByTestId("planned-styles").getByRole("heading", { name: "Planned styles (not selectable)", exact: true }).waitFor();
    await shot("15b-styles-desktop");
  }

  step("hermes render (research only): a trial run Hermes renders goes through QC and Review with its badge, is scored and counted");
  {
    const prodRunId = /([0-9a-f-]{36})$/.exec(productionRunHref ?? "")?.[1] ?? "";
    // The run reuses the finished production's approved script, storyboard, pictures and narration (copied rows), so
    // only the render, the quality check and the review run again. It is a trial of the Hermes research pack.
    const hermesRunId = prodRunId
      ? dbExec(`INSERT INTO pipeline_runs (channel_id, template_id, template_version, topic, autonomy_level, config, state)
          SELECT channel_id, 'tpl-hermes-research-explainer', (SELECT current_version FROM templates WHERE id = 'tpl-hermes-research-explainer'),
                 topic || ' (Hermes render)', autonomy_level,
                 jsonb_set(jsonb_set(config, '{styleId}', '"hermes-research-explainer"'), '{stylePack}',
                   '{"id":"hermes-research-explainer","version":"0.2.0","status":"trial","trial":true,"engine":"hermes"}'), 'running'
          FROM pipeline_runs WHERE id = '${prodRunId}' RETURNING id`)
      : null;
    if (!hermesRunId) console.log("   no database access (UI_DB unset): the Hermes render run is skipped");
    else {
      dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
        SELECT '${hermesRunId}', stage, state, attempt, output, finished_at FROM pipeline_stages
        WHERE run_id = '${prodRunId}' AND state = 'passed' AND stage IN ('idea', 'research', 'script', 'storyboard', 'assets', 'voice')`);
      try {
        dbExec(`INSERT INTO work_orders (run_id, stage, shot_ref, executor, spec, state, asset_id)
          SELECT '${hermesRunId}', stage, shot_ref, executor, spec, state, asset_id FROM work_orders WHERE run_id = '${prodRunId}' AND stage = 'assets' AND state = 'done'`);
      } catch (err) {
        console.log(`   the pictures were not copied (${String(err).slice(0, 200)}); Hermes draws those shots from their descriptions`);
      }
      dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt) VALUES ('${hermesRunId}', 'render', 'pending', 1)`);
      const hermesHref = `/studio/runs/${hermesRunId}`;
      // The Review page restarts a running run with a pending stage; the portal then asks Hermes (no worker job).
      const hermesCard = (stage) => m.locator(`[data-testid="review-card"][data-stage="${stage}"]`).filter({ has: m.getByTestId("hermes-render-badge") });
      let qcShown = false;
      for (let i = 0; i < 14 && !qcShown; i++) {
        await m.goto(`${APP}/review`);
        const broken = m.locator('[data-testid="review-card"][data-kind="stage-error"]').filter({ has: m.getByTestId("hermes-render-badge") });
        if (await broken.first().isVisible().catch(() => false)) {
          await dumpPipeline(m, hermesHref, "the Hermes render stopped with an error");
          throw new Error(`the Hermes render stopped: ${((await broken.first().innerText()) || "").replace(/\s+/g, " ").slice(0, 500)}`);
        }
        const renderCard = hermesCard("render");
        if (await renderCard.first().isVisible().catch(() => false)) {
          await renderCard.first().getByTestId("render-video").waitFor();
          await renderCard.first().getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
          await renderCard.first().getByRole("button", { name: "Approve", exact: true }).click();
          await m.waitForLoadState("networkidle");
        }
        // The quality check is the worker's qc-video, as for any render.
        runWorker([`${OUT}/worker/run.sh`, "tick"]);
        await m.goto(`${APP}/review`);
        qcShown = await hermesCard("qc").first().isVisible().catch(() => false);
        if (!qcShown) await m.waitForTimeout(3000);
      }
      if (!qcShown) {
        await dumpPipeline(m, hermesHref, "the Hermes render's quality check never reached Review");
        throw new Error("the Hermes render's quality check never reached Review");
      }
      if (fakeStats.hermesRenders < 1 || fakeStats.clipDownloads < 1) throw new Error(`Hermes was asked ${fakeStats.hermesRenders} time(s) and its clip downloaded ${fakeStats.clipDownloads} time(s)`);
      const renderAsk = lastPrompt["hermes-render"] ?? "";
      for (const want of ['"scenePlan"', '"contract"', '"shots"', '"id":"hermes-research-explainer"', "/clip/"]) {
        if (!renderAsk.includes(want)) throw new Error(`the hermes-render request misses ${want}`);
      }
      const renderJobs = dbValue(`SELECT count(*) FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${hermesRunId}'`);
      if (renderJobs !== "0") throw new Error(`a Hermes render queued ${renderJobs} worker render job(s)`);
      const provenance = dbValue(`SELECT a.metadata->>'executor' || ' ' || coalesce(a.metadata->>'backend', '?') || ' ' || a.origin_url FROM assets a
        WHERE a.id = (SELECT (output->'result'->>'assetId')::uuid FROM pipeline_stages WHERE run_id = '${hermesRunId}' AND stage = 'render' AND state = 'passed' LIMIT 1)`);
      if (!/^hermes-render capcut http:\/\/127\.0\.0\.1:\d+\/clip\/render-\d+\.mp4$/.test(provenance ?? "")) throw new Error(`the Hermes render's provenance is "${provenance}"`);
      const card = hermesCard("qc").first();
      await card.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
      await card.getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
      // Hermes's advisory on the sampled stills arrives in the background; it is shown, never decides.
      for (let i = 0; i < 10 && !(await card.getByTestId("presentation-advisory").isVisible().catch(() => false)); i++) {
        await m.waitForTimeout(2000);
        await m.goto(`${APP}/review`);
      }
      await card.getByTestId("presentation-advisory").getByText(/^Hermes advisory \(from \d+ stills, does not decide\): 60\/100/).waitFor();
      if (fakeStats.advisoryImages < 1) throw new Error("the advisory was asked without the sampled stills");
      await assertNoOverflow(m, "/review (Hermes render)");
      await scoreVideo(card, { hook: 4, pacing: 4, legibility: 5, polish: 4, audio: 3 }, "75/100 by the owner");
      await shot("24c-review-hermes-render-mobile", m);
      const approve = card.getByRole("button", { name: "Approve", exact: true });
      if (await approve.isVisible().catch(() => false)) await approve.click();
      else await card.getByRole("button", { name: "Reject", exact: true }).click();
      await m.waitForLoadState("networkidle");
      let logged = null;
      for (let i = 0; i < 20; i++) {
        logged = dbValue(`SELECT pack_id || '@' || pack_version || ' ' || coalesce(renderer, '?') || ' ' || coalesce(presentation_score::text, 'none') || ' ' || coalesce(owner_decision, 'none') || ' ' || coalesce(hermes_advisory->>'score', 'none') FROM style_trial_outcomes WHERE run_id = '${hermesRunId}'`);
        if (logged && / (approved|rejected) /.test(logged)) break;
        await m.waitForTimeout(1000);
      }
      if (!/^hermes-research-explainer@0\.2\.0 hermes 75 (approved|rejected) 60$/.test(logged ?? "")) {
        await dumpPipeline(m, hermesHref, "the Hermes render's trial outcome was not recorded");
        throw new Error(`the Hermes render's curation entry is "${logged}"`);
      }
      await page.goto(`${APP}${hermesHref}`);
      await page.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
      await page.goto(`${APP}/studio/styles`);
      const hermesPack = page.getByTestId("style-pack-hermes-research-explainer");
      await hermesPack.getByTestId("pack-availability").getByText("Rendered by the portal through Hermes", { exact: true }).waitFor();
      await hermesPack.getByTestId("trial-record").getByText(/^Trial runs of v0\.2\.0: 1 .*mean presentation 75 \(1 scored\)/).waitFor();
      await shot("15c-styles-hermes-desktop");
    }
  }

  // Research styles and lab trials (docs/style-packs.md, "Research styles and lab trials"). Runs below reuse the finished
  // production's approved script, storyboard, pictures and narration (copied rows), so only the render, the quality
  // check and the review run again.
  const RESEARCH_SKILLS = ["breakdown", "dan-koe", "graph", "kurzgesagt", "low-poly", "map-route", "minecraft", "minimalistic-graphics", "stick-figure", "zach-d-films"];
  const RESEARCH_GROUP = "Hermes research styles (from claude-animation-skills)";
  const prodRunIdForTrials = /([0-9a-f-]{36})$/.exec(productionRunHref ?? "")?.[1] ?? "";
  /** Points a freshly started run at the production's approved stages, with only the render left to do. */
  async function reuseProduction(runId, why) {
    // Wait until the run's first stage has settled (its idea card is open), so nothing is running while it is rewritten.
    let settled = false;
    for (let i = 0; i < 60 && !settled; i++) {
      const busy = dbValue(`SELECT count(*) FROM pipeline_stages WHERE run_id = '${runId}' AND state = 'running'`);
      const open = dbValue(`SELECT count(*) FROM review_items WHERE run_id = '${runId}' AND state = 'open'`);
      settled = busy === "0" && open !== "0";
      if (!settled) await page.waitForTimeout(1000);
    }
    if (!settled) {
      await dumpPipeline(page, `/studio/runs/${runId}`, `${why}: the run's first stage never settled on an open review card`);
      throw new Error(`${why}: the run's first stage never settled on an open review card`);
    }
    dbExec(`UPDATE review_items SET state = 'superseded' WHERE run_id = '${runId}' AND state = 'open'`);
    dbExec(`DELETE FROM pipeline_stages WHERE run_id = '${runId}'`);
    dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
      SELECT '${runId}', stage, state, attempt, output, finished_at FROM pipeline_stages
      WHERE run_id = '${prodRunIdForTrials}' AND state = 'passed' AND stage IN ('idea', 'research', 'script', 'storyboard', 'assets', 'voice')`);
    try {
      dbExec(`INSERT INTO work_orders (run_id, stage, shot_ref, executor, spec, state, asset_id)
        SELECT '${runId}', stage, shot_ref, executor, spec, state, asset_id FROM work_orders WHERE run_id = '${prodRunIdForTrials}' AND stage = 'assets' AND state = 'done'`);
    } catch (err) {
      console.log(`   the pictures were not copied for ${why} (${String(err).slice(0, 200)})`);
    }
    // The copied stages are the production's image-sequence list, so the reused run reads as a run from before
    // workflows (no config.workflow: RUN_STAGES). Runs that follow their own workflow are driven for real below.
    dbExec(`UPDATE pipeline_runs SET state = 'running', config = config - 'workflow', topic = (SELECT topic FROM pipeline_runs WHERE id = '${prodRunIdForTrials}') || ' (${why})' WHERE id = '${runId}'`);
    dbExec(`INSERT INTO pipeline_stages (run_id, stage, state, attempt) VALUES ('${runId}', 'render', 'pending', 1)`);
  }
  const cardOf = (runId, stage) => m.locator(`[data-testid="review-card"][data-stage="${stage}"]`).filter({ has: m.locator(`a[href="/studio/runs/${runId}"]`) });
  /** Review restarts the run; the render card is approved, the worker runs qc-video (and a worker render). */
  async function driveToQc(runIds, label) {
    const left = new Set(runIds);
    for (let i = 0; i < 24 && left.size > 0; i++) {
      await m.goto(`${APP}/review`);
      for (const id of runIds) {
        const broken = cardOf(id, "render").or(cardOf(id, "qc")).and(m.locator('[data-kind="stage-error"]'));
        if (await broken.first().isVisible().catch(() => false)) {
          await dumpPipeline(m, `/studio/runs/${id}`, `${label}: a stage stopped with an error`);
          throw new Error(`${label}: ${((await broken.first().innerText()) || "").replace(/\s+/g, " ").slice(0, 500)}`);
        }
        const render = cardOf(id, "render");
        if (await render.first().getByRole("button", { name: "Approve", exact: true }).isVisible().catch(() => false)) {
          await render.first().getByTestId("render-video").waitFor();
          await render.first().getByRole("button", { name: "Approve", exact: true }).click();
          await m.waitForLoadState("networkidle");
        }
      }
      runWorker([`${OUT}/worker/run.sh`, "tick"]);
      await m.goto(`${APP}/review`);
      for (const id of [...left]) if (await cardOf(id, "qc").first().isVisible().catch(() => false)) left.delete(id);
      if (left.size > 0) await m.waitForTimeout(3000);
    }
    if (left.size > 0) {
      for (const id of left) await dumpPipeline(m, `/studio/runs/${id}`, `${label}: the quality check never reached Review`);
      throw new Error(`${label}: the quality check never reached Review for ${[...left].join(", ")}`);
    }
  }
  /** The owner scores the final video on its card, then decides (approve when offered, else reject). */
  async function scoreAndDecide(runId, stars, shown) {
    await m.goto(`${APP}/review`);
    const card = cardOf(runId, "qc").first();
    await scoreVideo(card, stars, shown);
    const approve = card.getByRole("button", { name: "Approve", exact: true });
    if (await approve.isVisible().catch(() => false)) await approve.click();
    else await card.getByRole("button", { name: "Reject", exact: true }).click();
    await m.waitForLoadState("networkidle");
    for (let i = 0; i < 20; i++) {
      if (/ (approved|rejected)$/.test(dbValue(`SELECT pack_id || ' ' || coalesce(owner_decision, 'none') FROM style_trial_outcomes WHERE run_id = '${runId}'`) ?? "")) return;
      await m.waitForTimeout(1000);
    }
    await dumpPipeline(m, `/studio/runs/${runId}`, "the trial outcome was not recorded with the owner's decision");
    throw new Error(`the trial outcome of ${runId} was not recorded with the owner's decision`);
  }

  step("research styles: New Video shows every claude-animation-skills skill in its own group, badged, described and credited; the lifecycle is said plainly");
  {
    await page.goto(`${APP}/studio/new`);
    await page.getByTestId("lifecycle").getByText("Research styles (Hermes render) and lab trials are for testing and curating, never for publishing.", { exact: true }).waitFor();
    await page.getByTestId("lifecycle").getByText("Only Listed styles publish.", { exact: true }).waitFor();
    const group = page.locator(`[data-testid="research-group"][data-group="${RESEARCH_GROUP}"]`);
    await group.getByTestId("research-group-title").getByText(RESEARCH_GROUP, { exact: true }).waitFor();
    const rows = group.locator('li[data-testid^="trial-style-hermes-"]');
    const ids = (await rows.evaluateAll((ls) => ls.map((l) => l.getAttribute("data-testid")))).sort();
    const want = RESEARCH_SKILLS.map((s) => `trial-style-hermes-${s}`).sort();
    if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error(`the research group lists ${ids.join(", ")}, expected ${want.join(", ")}`);
    for (const s of RESEARCH_SKILLS) {
      const row = group.getByTestId(`trial-style-hermes-${s}`);
      await row.getByTestId("hermes-render-label").getByText("Hermes render (research only)", { exact: true }).waitFor();
      await row.getByTestId("trial-style-credit").getByText("From claude-animation-skills by Artem Novitckii (MIT).", { exact: true }).waitFor();
      if (!((await row.getByTestId("trial-style-about").innerText()).includes(`/${s}`))) throw new Error(`the ${s} research style does not name its skill in its description`);
    }
    const groups = await page.locator("#templateId optgroup").evaluateAll((gs) => gs.map((g) => g.label));
    if (!groups.includes(RESEARCH_GROUP)) throw new Error(`no research group in the style list: ${groups.join(", ")}`);
    await shot("28-new-video-research-desktop");
    await m.goto(`${APP}/studio/new`);
    await m.locator(`[data-testid="research-group"][data-group="${RESEARCH_GROUP}"]`).waitFor();
    await assertNoOverflow(m, "/studio/new (research styles)");
    await shot("28b-new-video-research-mobile", m);
  }

  step("batch trial: two research styles from one brief; Hermes is asked with each skill and answers with a real clip; both reach the owner's score; Styles shows them; nothing is publishable");
  {
    await page.goto(`${APP}/studio/new`);
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.fill("#brief", "Batch trial: one thing that compounds");
    const batchBox = page.getByTestId("batch-trial");
    await batchBox.getByRole("checkbox", { name: "Try Line graph (Hermes /graph)", exact: true }).check();
    await batchBox.getByRole("checkbox", { name: "Try Branching line art (Hermes /dan-koe)", exact: true }).check();
    await batchBox.getByRole("button", { name: "Start 2 trials", exact: true }).click();
    await batchBox.getByTestId("batch-started").getByText(/^2 trial runs started from one brief\. Hermes works through them one ask at a time\.$/).waitFor();
    const hrefs = await batchBox.getByTestId("batch-run-link").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    const batchIds = hrefs.map((h) => /([0-9a-f-]{36})$/.exec(h ?? "")?.[1]).filter(Boolean);
    if (batchIds.length !== 2) throw new Error(`the batch started ${batchIds.length} run(s): ${hrefs.join(", ")}`);
    const stored = dbValue(`SELECT string_agg((config->'stylePack'->>'id') || ':' || (config->'stylePack'->>'trial') || ':' || (config->'trialBatch'->>'index') || '/' || (config->'trialBatch'->>'total'), ' ' ORDER BY (config->'trialBatch'->>'index')) FROM pipeline_runs WHERE id IN ('${batchIds.join("','")}')`);
    if (stored !== null && stored !== "hermes-graph:true:1/2 hermes-dan-koe:true:2/2") throw new Error(`the batch runs are stored as "${stored}"`);
    // The queue shows both runs, in batch order.
    await page.goto(`${APP}/studio/styles`);
    const queue = page.getByTestId("trial-queue");
    await queue.locator(`[data-testid="trial-queue-run"][data-run-id="${batchIds[0]}"]`).getByText("1 of 2", { exact: true }).waitFor();
    await queue.locator(`[data-testid="trial-queue-run"][data-run-id="${batchIds[1]}"]`).getByText("2 of 2", { exact: true }).waitFor();
    await shot("29-styles-trial-queue-desktop");
    if (!prodRunIdForTrials || stored === null) console.log("   no database access (UI_DB unset) or no finished production: the batch renders are skipped");
    else {
      const before = fakeStats.hermesSkills.length;
      await reuseProduction(batchIds[0], "batch trial /graph");
      await reuseProduction(batchIds[1], "batch trial /dan-koe");
      await driveToQc(batchIds, "batch trial");
      const skills = fakeStats.hermesSkills.slice(before).sort();
      if (JSON.stringify(skills) !== JSON.stringify(["/dan-koe", "/graph"])) throw new Error(`Hermes was asked to render with ${skills.join(", ") || "no skill"}, expected /graph and /dan-koe`);
      for (const [id, skill] of [[batchIds[0], "graph"], [batchIds[1], "dan-koe"]]) {
        const jobs = dbValue(`SELECT count(*) FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${id}'`);
        if (jobs !== "0") throw new Error(`a research render queued ${jobs} worker render job(s)`);
        const prov = dbValue(`SELECT a.metadata->>'executor' || ' ' || coalesce(a.metadata->>'backend', '?') || ' ' || coalesce(a.metadata->>'hermesSkill', 'no-skill') || ' ' || a.origin_url FROM assets a
          WHERE a.id = (SELECT (output->'result'->>'assetId')::uuid FROM pipeline_stages WHERE run_id = '${id}' AND stage = 'render' AND state = 'passed' LIMIT 1)`);
        if (!new RegExp(`^hermes-render capcut /${skill} http://127\\.0\\.0\\.1:\\d+/clip/${skill}-\\d+\\.mp4$`).test(prov ?? "")) throw new Error(`the ${skill} render's provenance is "${prov}"`);
        const card = cardOf(id, "qc").first();
        await card.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
        await card.getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
      }
      await scoreAndDecide(batchIds[0], { hook: 4, pacing: 4, legibility: 5, polish: 4, audio: 3 }, "75/100 by the owner");
      await scoreAndDecide(batchIds[1], { hook: 5, pacing: 5, legibility: 5, polish: 5, audio: 5 }, "100/100 by the owner");
      await shot("29b-review-batch-scored-mobile", m);
      await page.goto(`${APP}/studio/styles`);
      await page.getByTestId("lifecycle").getByText("Trial packs collect evidence toward Proven.", { exact: true }).waitFor();
      const research = page.getByTestId("style-group-research");
      await research.getByTestId("style-pack-hermes-graph").getByTestId("trial-record").getByText(/^Trial runs of v0\.2\.0: 1 .*mean presentation 75 \(1 scored\) · owner (approved 1, rejected 0|approved 0, rejected 1)$/).waitFor();
      await research.getByTestId("style-pack-hermes-dan-koe").getByTestId("trial-record").getByText(/^Trial runs of v0\.2\.0: 1 .*mean presentation 100 \(1 scored\)/).waitFor();
      await research.getByTestId("style-pack-hermes-graph").getByTestId("pack-hermes-skill").getByText(/^Hermes skill \/graph, a quick skill from a small spec/).waitFor();
      await shot("29c-styles-research-scored-desktop");
      // Nothing from these runs is publishable: research only, never an upload or publish step.
      for (const id of batchIds) {
        await page.goto(`${APP}/studio/runs/${id}`);
        await page.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
        await page.getByTestId("trial-badge").waitFor();
      }
      const published = dbValue(`SELECT count(*) FROM pipeline_stages WHERE run_id IN ('${batchIds.join("','")}') AND stage IN ('upload', 'publish') AND state <> 'skipped'`);
      if (published !== "0") throw new Error(`a research run reached ${published} upload or publish stage(s)`);
    }
  }

  step("lab trial: a Lab pack the worker reports runs from Styles, badged Lab trial, recorded apart from promotion, never publishable");
  {
    await page.goto(`${APP}/studio/styles`);
    await page.getByTestId("style-group-lab").waitFor();
    const probeCard = page.getByTestId("style-pack-probe-line-graph");
    const action = probeCard.getByTestId("lab-trial-action");
    const tryIt = action.getByRole("link", { name: "Try it (lab trial)", exact: true });
    if (!(await tryIt.isVisible().catch(() => false))) {
      const why = (await action.getByTestId("lab-trial-unavailable").innerText().catch(() => "")) || "(no reason shown)";
      throw new Error(`the Lab pack probe-line-graph cannot run as a lab trial on the CI worker: ${why}`);
    }
    await shot("30-styles-lab-trial-desktop");
    await tryIt.click();
    await page.waitForURL(/\/studio\/new\?lab=probe-line-graph$/);
    await page.getByTestId("lab-trial-start-note").getByText(/^Lab trial \(draft pack\): Probe: line graph \(html-capture\) 0\.1\.1 is lab\./).waitFor();
    if ((await page.locator("#templateId").inputValue()) !== "tpl-probe-line-graph") throw new Error("New Video is not pre-filled with the lab pack");
    await page.getByTestId("lab-trial-note").waitFor();
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.getByRole("button", { name: "Ask Hermes for ideas", exact: true }).click();
    await page.getByText(/^Lab trial started \(Lab trial \(draft pack\), never published\)\./).first().waitFor();
    const labHref = await page.getByTestId("run-started-link").getAttribute("href");
    const labRunId = /([0-9a-f-]{36})$/.exec(labHref ?? "")?.[1];
    if (!labRunId) throw new Error(`no link to the lab trial run: ${labHref}`);
    const labStored = dbValue(`SELECT (config->'stylePack'->>'id') || ':' || (config->'stylePack'->>'status') || ':' || (config->'stylePack'->>'lab') || ':' || (config->'stylePack'->>'trial') FROM pipeline_runs WHERE id = '${labRunId}'`);
    if (labStored !== null && labStored !== "probe-line-graph:lab:true:true") throw new Error(`the lab trial is stored as "${labStored}"`);
    await page.goto(`${APP}${labHref}`);
    await page.getByTestId("lab-trial-badge").getByText("Lab trial (draft pack)", { exact: true }).waitFor();
    if (!prodRunIdForTrials || labStored === null) console.log("   no database access (UI_DB unset) or no finished production: the lab trial render is skipped");
    else {
      await reuseProduction(labRunId, "lab trial");
      await driveToQc([labRunId], "lab trial");
      const cap = dbValue(`SELECT capability FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${labRunId}' ORDER BY created_at DESC LIMIT 1`);
      if (cap !== "pack:probe-line-graph@0.1.1") throw new Error(`the lab trial's render is queued under ${cap}, not the pack capability`);
      const card = cardOf(labRunId, "qc").first();
      await card.getByTestId("lab-trial-badge").getByText("Lab trial (draft pack)", { exact: true }).waitFor();
      await scoreAndDecide(labRunId, { hook: 3, pacing: 4, legibility: 4, polish: 3, audio: 3 }, "60/100 by the owner");
      const logged = dbValue(`SELECT pack_id || '@' || pack_version || ' ' || lab_trial::text || ' ' || coalesce(renderer, '?') || ' ' || coalesce(presentation_score::text, 'none') FROM style_trial_outcomes WHERE run_id = '${labRunId}'`);
      if (!/^probe-line-graph@0\.1\.1 true html-capture \d+$/.test(logged ?? "")) throw new Error(`the lab trial's curation row is "${logged}"`);
      await page.goto(`${APP}/studio/styles`);
      const probe = page.getByTestId("style-pack-probe-line-graph");
      await probe.getByTestId("lab-trial-record").getByText(/^Lab trial \(draft pack\) runs: 1 · mean presentation \d+ \(1 scored\)/).waitFor();
      if (await probe.getByTestId("trial-record").count()) throw new Error("a Lab pack shows a promotion record");
      await shot("30b-styles-lab-trial-counted-desktop");
      const published = dbValue(`SELECT count(*) FROM pipeline_stages WHERE run_id = '${labRunId}' AND stage IN ('upload', 'publish') AND state <> 'skipped'`);
      if (published !== "0") throw new Error(`the lab trial reached ${published} upload or publish stage(s)`);
    }
    await m.goto(`${APP}/studio/styles`);
    await m.getByTestId("style-group-research").waitFor();
    await assertNoOverflow(m, "/studio/styles (research and lab)");
    await shot("30c-styles-mobile", m);
  }

  // Workflows (docs/style-packs.md, "Workflows"): runs that follow their pack's own stage list, driven for real from New
  // Video (nothing copied from the production). Every database read below is scoped to the run under test.
  /** Moves one run through Review until its quality-check card shows: picks the first idea, approves each stage card. */
  async function driveWorkflow(runId, label, onApproval) {
    const runCards = () => m.locator('[data-testid="review-card"]').filter({ has: m.locator(`a[href="/studio/runs/${runId}"]`) });
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      await m.goto(`${APP}/review`);
      if (await cardOf(runId, "qc").first().isVisible().catch(() => false)) return seen;
      const broken = runCards().and(m.locator('[data-kind="stage-error"], [data-kind="gate-failure"]'));
      if (await broken.first().isVisible().catch(() => false)) {
        await dumpPipeline(m, `/studio/runs/${runId}`, `${label}: a stage did not pass`);
        throw new Error(`${label}: ${((await broken.first().innerText()) || "").replace(/\s+/g, " ").slice(0, 600)}`);
      }
      const idea = runCards().and(m.locator('[data-kind="idea"]'));
      if (await idea.first().isVisible().catch(() => false)) {
        await idea.first().getByRole("button", { name: "Approve this idea", exact: true }).first().click();
        await m.waitForLoadState("networkidle");
        continue;
      }
      const approval = runCards().and(m.locator('[data-kind="approval"]'));
      if (await approval.first().isVisible().catch(() => false)) {
        const card = approval.first();
        const stage = (await card.getAttribute("data-stage")) ?? "";
        seen.add(stage);
        if (onApproval) await onApproval(stage, card);
        await card.getByRole("button", { name: "Approve", exact: true }).click();
        await m.waitForLoadState("networkidle");
        continue;
      }
      runWorker([`${OUT}/worker/run.sh`, "tick"]);
      await m.waitForTimeout(2000);
    }
    await dumpPipeline(m, `/studio/runs/${runId}`, `${label}: the quality check never reached Review`);
    throw new Error(`${label}: the quality check never reached Review`);
  }
  /** Starts a run of a style from New Video with its own brief; returns the run id. */
  async function startFromNewVideo(templateId, brief, workflowLine) {
    await page.goto(`${APP}/studio/new`);
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.fill("#brief", brief);
    await page.selectOption("#templateId", templateId);
    await page.getByTestId("workflow-info").getByText(workflowLine, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Ask Hermes for ideas", exact: true }).click();
    const href = await page.getByTestId("run-started-link").getAttribute("href");
    const id = /([0-9a-f-]{36})$/.exec(href ?? "")?.[1];
    if (!id) throw new Error(`no link to the ${templateId} run: ${href}`);
    return id;
  }
  const imageAskTotal = () => Object.values(fakeStats.imageAsks).reduce((n, v) => n + v, 0) + fakeStats.routerImageCalls;

  step("scene-spec trial: animated-line-graph from New Video goes idea → research → script → scene spec → voice → html-capture render → qc, with no picture made");
  if (dbValue("SELECT 1") === null) console.log("   no database access (UI_DB unset): the scene-spec run is skipped");
  else {
    const brief = "Scene spec trial: how solar capacity grew";
    const imagesBefore = imageAskTotal();
    const specAsksBefore = fakeStats.sceneSpecAsks;
    const dataAsksBefore = fakeStats.researchDataAsks;
    const runId = await startFromNewVideo("tpl-animated-line-graph", brief, "Workflow: Scene spec (data-driven, no pictures): Idea → Research → Script → Scene spec → Voice → Video → Quality check");
    const flow = dbValue(`SELECT (config->'workflow'->>'recipe') || ' ' || (config->'workflow'->'stages')::text || ' ' || (config->'workflow'->'review')::text FROM pipeline_runs WHERE id = '${runId}'`);
    if (flow !== 'scene-spec ["idea", "research", "script", "scene-spec", "voice", "render", "qc"] ["scene-spec"]') throw new Error(`the scene-spec run stored the workflow "${flow}"`);
    let specCard = false;
    const seen = await driveWorkflow(runId, "scene-spec trial", async (stage, card) => {
      if (stage !== "scene-spec") return;
      specCard = true;
      // The spec as text: one line per scene, the numbers with the note they come from; no image grid on this card.
      await card.getByTestId("scene-spec-card").waitFor();
      const lines = await card.getByTestId("scene-spec-list").getByTestId("plan-line").allInnerTexts();
      if (lines.length < 3) throw new Error(`the scene-spec card lists ${lines.length} scene(s)`);
      if (!lines.some((l) => /bar "GW" 2010: 40, 2014: 140, 2019: 500, 2023: 1200 \(note 1\)/.test(l))) throw new Error(`the scene-spec card does not show the sourced series: ${lines.join(" | ")}`);
      await card.getByTestId("plan-note").getByText(/^No still preview before the render: the worker has no stills mode for html-capture pages yet/).waitFor();
      if (await card.getByTestId("asset-grid").count()) throw new Error("the scene-spec card shows an image grid");
      await card.getByText("This style's workflow has the owner check the scene spec every time", { exact: true }).or(card.getByText(/^Manual mode/)).first().waitFor();
      await shot("31-review-scene-spec-mobile", m);
    });
    if (!specCard) throw new Error(`the scene spec never asked the owner (cards seen: ${[...seen].join(", ")}), though the pack's workflow reviews it every time`);
    if (fakeStats.researchDataAsks <= dataAsksBefore) throw new Error("the scene-spec run's research did not ask for the numbers the spec needs");
    if (fakeStats.sceneSpecAsks <= specAsksBefore) throw new Error("Hermes was never asked for the scene spec");
    if (!/On-screen elements this style allows: heading, counter, bar\./.test(lastPrompt["scene-spec"] ?? "")) throw new Error("the scene-spec prompt does not carry the pack's elements");
    // Zero image work: no work order, no storyboard, no image ask to the fake Hermes (or to 9router) for this run.
    const orders = dbValue(`SELECT count(*) FROM work_orders WHERE run_id = '${runId}'`);
    if (orders !== "0") throw new Error(`the scene-spec run has ${orders} work order(s)`);
    const stagesMade = dbValue(`SELECT coalesce(string_agg(DISTINCT stage, ',' ORDER BY stage), '') FROM pipeline_stages WHERE run_id = '${runId}'`);
    if (/storyboard|assets/.test(stagesMade ?? "")) throw new Error(`the scene-spec run made stages ${stagesMade}`);
    const tag = brief.slice(0, 60);
    if (fakeStats.imageAsksByBrief[tag] || fakeStats.storyboardAsksByBrief[tag]) throw new Error(`the scene-spec run asked Hermes for ${fakeStats.imageAsksByBrief[tag] ?? 0} image(s) and ${fakeStats.storyboardAsksByBrief[tag] ?? 0} storyboard(s)`);
    if (imageAskTotal() !== imagesBefore) throw new Error(`images were asked for while the scene-spec run ran (${imagesBefore} -> ${imageAskTotal()})`);
    // The real html-capture render through the CI worker, from the spec: the pack's page, the sourced series, one plate.
    const job = dbValue(`SELECT capability || ' ' || (payload->>'engine') || ' ' || (payload->'scenePlan'->>'template') || ' ' || (payload->'scenePlan'->'scenes'->1->'elements'->0->'series')::text FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${runId}' ORDER BY created_at DESC LIMIT 1`);
    if (job !== "pack:animated-line-graph@0.1.2 html-capture animated-line-graph [40, 140, 500, 1200]") throw new Error(`the scene-spec render job is "${job}"`);
    const plates = dbValue(`SELECT count(DISTINCT s->>'assetId') || ' ' || (SELECT count(*) FROM assets WHERE metadata->>'runId' = '${runId}' AND metadata->>'executor' = 'portal-plate' AND source = 'generated')
      FROM jobs j, jsonb_array_elements(j.payload->'shots') s WHERE j.type = 'render-video' AND j.payload->>'runId' = '${runId}'`);
    if (plates !== "1 1") throw new Error(`the scene-spec render should use one portal plate for every shot: "${plates}"`);
    const rendered = dbValue(`SELECT output->'result'->>'renderer' FROM pipeline_stages WHERE run_id = '${runId}' AND stage = 'render' AND state = 'passed' ORDER BY attempt DESC LIMIT 1`);
    if (rendered !== "html-capture") throw new Error(`the scene-spec video was rendered by "${rendered}"`);
    const card = cardOf(runId, "qc").first();
    await card.getByTestId("render-video").waitFor();
    await card.getByTestId("trial-badge").getByText("Trial style", { exact: true }).waitFor();
    await scoreAndDecide(runId, { hook: 4, pacing: 4, legibility: 4, polish: 4, audio: 4 }, "75/100 by the owner");
    const logged = dbValue(`SELECT pack_id || '@' || pack_version || ' ' || coalesce(renderer, '?') || ' ' || coalesce(presentation_score::text, 'none') FROM style_trial_outcomes WHERE run_id = '${runId}'`);
    if (logged !== "animated-line-graph@0.1.2 html-capture 75") throw new Error(`the scene-spec trial's curation row is "${logged}"`);
    // The run page shows the run's own list, and no work orders.
    await page.goto(`${APP}/studio/runs/${runId}`);
    const wf = page.locator('[data-testid="run-workflow"][data-recipe="scene-spec"]');
    await wf.locator('[data-testid="workflow-step-scene-spec"][data-state="passed"]').waitFor();
    if (await wf.getByTestId("workflow-step-assets").count()) throw new Error("the scene-spec run page lists an assets step");
    await page.getByTestId("no-work-orders").getByText("This workflow makes no pictures, so it has no work orders.", { exact: true }).waitFor();
    if (await page.getByTestId("stage-storyboard").count()) throw new Error("the scene-spec run page shows a storyboard stage");
    await shot("31b-run-scene-spec-desktop");
    console.log(`   scene-spec: ${[...seen].join(", ")} approved; 0 work orders, 0 image asks; rendered by html-capture from the spec`);
  }

  step("hermes-skill research run: /graph from New Video goes idea → research → script → skill brief → voice → Hermes render → qc; no assets stage, no image asks, the brief reaches Hermes");
  if (dbValue("SELECT 1") === null) console.log("   no database access (UI_DB unset): the hermes-skill run is skipped");
  else {
    const brief = "Skill brief trial: money that compounds";
    const imagesBefore = imageAskTotal();
    const rendersBefore = fakeStats.renderRequests.length;
    const runId = await startFromNewVideo("tpl-hermes-graph", brief, "Workflow: Hermes skill (research only, no pictures): Idea → Research → Script → Skill brief → Voice → Video → Quality check");
    const flow = dbValue(`SELECT (config->'workflow'->>'recipe') || ' ' || (config->'workflow'->'stages')::text FROM pipeline_runs WHERE id = '${runId}'`);
    if (flow !== 'hermes-skill ["idea", "research", "script", "skill-brief", "voice", "render", "qc"]') throw new Error(`the hermes-skill run stored the workflow "${flow}"`);
    const seen = await driveWorkflow(runId, "hermes-skill run", async (stage, card) => {
      if (stage !== "skill-brief") return;
      await card.getByTestId("skill-brief-card").waitFor();
      const lines = await card.getByTestId("skill-brief-list").getByTestId("plan-line").allInnerTexts();
      if (lines.length < 3 || !lines.every((l) => / Spec: \{"label":"Savings"/.test(l))) throw new Error(`the skill brief card does not list a spec per shot: ${lines.join(" | ")}`);
      await card.getByTestId("plan-note").getByText(/^For \/graph, one spec per shot; the run's narration is the audio\./).waitFor();
      if (await card.getByTestId("asset-grid").count()) throw new Error("the skill brief card shows an image grid");
    });
    const asked = fakeStats.renderRequests.slice(rendersBefore);
    if (asked.length !== 1 || asked[0].skill !== "/graph" || asked[0].briefShots < 3 || !asked[0].briefMarker || asked[0].pictures !== 0 || !asked[0].noPictureLine) {
      throw new Error(`the Hermes render of the hermes-skill run did not carry its brief: ${JSON.stringify(asked)}`);
    }
    const stagesMade = dbValue(`SELECT coalesce(string_agg(DISTINCT stage, ',' ORDER BY stage), '') FROM pipeline_stages WHERE run_id = '${runId}'`);
    if (/storyboard|assets/.test(stagesMade ?? "") || !/skill-brief/.test(stagesMade ?? "")) throw new Error(`the hermes-skill run made stages ${stagesMade}`);
    const orders = dbValue(`SELECT count(*) FROM work_orders WHERE run_id = '${runId}'`);
    if (orders !== "0") throw new Error(`the hermes-skill run has ${orders} work order(s)`);
    const tag = brief.slice(0, 60);
    if (fakeStats.imageAsksByBrief[tag] || fakeStats.storyboardAsksByBrief[tag]) throw new Error(`the hermes-skill run asked for ${fakeStats.imageAsksByBrief[tag] ?? 0} image(s) and ${fakeStats.storyboardAsksByBrief[tag] ?? 0} storyboard(s)`);
    if (imageAskTotal() !== imagesBefore) throw new Error(`images were asked for while the hermes-skill run ran (${imagesBefore} -> ${imageAskTotal()})`);
    const jobs = dbValue(`SELECT count(*) FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${runId}'`);
    if (jobs !== "0") throw new Error(`a research render queued ${jobs} worker render job(s)`);
    const prov = dbValue(`SELECT a.metadata->>'executor' || ' ' || coalesce(a.metadata->>'hermesSkill', 'no-skill') || ' ' || a.license FROM assets a
      WHERE a.id = (SELECT (output->'result'->>'assetId')::uuid FROM pipeline_stages WHERE run_id = '${runId}' AND stage = 'render' AND state = 'passed' ORDER BY attempt DESC LIMIT 1)`);
    if (!/^hermes-render \/graph .*from this run's skill brief and narration\. Research only/.test(prov ?? "")) throw new Error(`the hermes-skill render's provenance is "${prov}"`);
    const card = cardOf(runId, "qc").first();
    await card.getByTestId("hermes-render-badge").getByText("Hermes render (research only)", { exact: true }).waitFor();
    await scoreAndDecide(runId, { hook: 3, pacing: 4, legibility: 4, polish: 3, audio: 3 }, "60/100 by the owner");
    const logged = dbValue(`SELECT pack_id || '@' || pack_version || ' ' || coalesce(renderer, '?') FROM style_trial_outcomes WHERE run_id = '${runId}'`);
    if (logged !== "hermes-graph@0.2.0 hermes") throw new Error(`the hermes-skill trial's curation row is "${logged}"`);
    await page.goto(`${APP}/studio/runs/${runId}`);
    await page.locator('[data-testid="run-workflow"][data-recipe="hermes-skill"]').locator('[data-testid="workflow-step-skill-brief"][data-state="passed"]').waitFor();
    if (await page.getByTestId("stage-assets").count()) throw new Error("the hermes-skill run page shows an assets stage");
    console.log(`   hermes-skill: ${[...seen].join(", ")} approved; the brief (${asked[0].briefShots} shots) reached Hermes; 0 image asks`);
  }

  step("production: the render mixed the tagged music track as its bed, never the narration");
  {
    const musicId = dbValue(`SELECT id FROM assets WHERE title = 'Test music bed' AND 'music' = ANY(tags) ORDER BY created_at DESC LIMIT 1`);
    const productionRunIdForBed = (productionRunHref ?? "").match(/[0-9a-f-]{36}/)?.[0] ?? "";
    if (musicId !== null && !productionRunIdForBed) throw new Error(`no production run id to check the bed against (${productionRunHref})`);
    if (musicId === null) {
      console.log("   no database access (UI_DB unset): the bed check is skipped");
    } else {
      if (!/^[0-9a-f-]{36}$/.test(musicId)) throw new Error(`the uploaded music track has no music tag (got "${musicId}")`);
      const row = dbValue(
        `SELECT coalesce(payload->'audio'->'bed'->>'assetId', 'none') || ' ' || coalesce(payload->>'narrationAssetId', '') || ' ' || ` +
          `coalesce(payload->'audio'->'ambient'->>'color', 'none') || ' ' || (payload->'inputs' ? '${musicId}')::text || ' ' || (payload ? 'captionStyle')::text ` +
          // The production run's own render: later trial runs (batch, lab) queue newer render jobs of their own.
          `FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${productionRunIdForBed}' ORDER BY created_at DESC LIMIT 1`,
      );
      const [bedId, narrationId, ambient, listed, styled] = (row ?? "").split(" ");
      if (bedId !== musicId) {
        await dumpPipeline(m, productionRunHref, "the render job's bed is not the tagged music track");
        throw new Error(`the render job's bed is ${bedId}, not the uploaded music track ${musicId}`);
      }
      if (!narrationId || bedId === narrationId) throw new Error(`the render job uses its narration ${narrationId} as the bed`);
      if (ambient !== "brown") throw new Error(`the render job's mix has no ambience (${ambient})`);
      if (listed !== "true") throw new Error("the music track is not among the render job's inputs, so the worker could not download it");
      if (styled !== "true") throw new Error("the render job carries no captionStyle, though the worker reports caption-style");
      const result = dbValue(`SELECT coalesce(result->'audioMix'->'bed'->>'assetId', 'none') FROM jobs WHERE type = 'render-video' AND payload->>'runId' = '${productionRunIdForBed}' ORDER BY created_at DESC LIMIT 1`);
      if (result !== musicId) throw new Error(`the worker did not report mixing the bed (result.audioMix.bed = ${result})`);
      const licence = dbValue(`SELECT license FROM assets WHERE kind = 'video' AND metadata->>'executor' = 'render-video' AND metadata->>'runId' = '${productionRunIdForBed}' ORDER BY created_at DESC LIMIT 1`) ?? "";
      if (!licence.includes("Music bed: Test music bed (uploaded from https://example.com/venstudio-test-music): Own composition for tests, all rights")) {
        throw new Error(`the render's licence does not name the music bed: ${licence.slice(0, 300)}`);
      }
      console.log(`   bed ${musicId} (looped under the narration ${narrationId}), named in the render's licence`);
    }
  }

  step("director: the script and storyboard prompts carried the purposes and subtitles");
  {
    const scriptAsk = lastPrompt.script ?? "";
    for (const want of ["contains affiliate links", "call to action", "hook to the next episode", "translate well"]) {
      if (!scriptAsk.includes(want)) throw new Error(`the script prompt misses "${want}"`);
    }
    if (!dataBlock(scriptAsk, "owner brief").includes(STUDIO_BRIEF)) throw new Error("the script prompt has no owner brief block");
    const boardAsk = lastPrompt.storyboard ?? "";
    for (const want of ["disclosure card", "same in every shot", "bottom fifth of every frame"]) {
      if (!boardAsk.includes(want)) throw new Error(`the storyboard prompt misses "${want}"`);
    }
  }

  step("production: the run page lists each work order");
  await m.goto(`${APP}${assetsRunHref ?? runHref}`);
  await m.getByTestId("work-orders").waitFor();
  if ((await m.getByTestId("work-order").count()) < 3) throw new Error("the run page shows fewer than 3 work orders");
  if (!(await m.getByTestId("work-orders").textContent()).includes("canva")) throw new Error("the run page does not name the backend (canva)");
  // shot-01 got every 429 of the burst. Waiting for Hermes must not have used up its attempts.
  const firstOrder = await m.getByTestId("work-order").filter({ hasText: "shot-01" }).first().innerText();
  if (!/\b1 attempt\b(?!s)/.test(firstOrder)) throw new Error(`shot-01 should show 1 attempt after the 429 burst, saw: ${firstOrder.replace(/\s+/g, " ")}`);
  if ((await m.locator('[data-testid="work-order"][data-state="failed"]').count()) !== 0) throw new Error("a work order failed during the run");
  if (fakeStats.routerBadImageCalls !== 1) throw new Error("the set-aside 9router image model was asked again later in the run");
  await assertNoOverflow(m, "run page");
  await shot("25-run-production-mobile", m);
  await m.goto(`${APP}/review`);
  await m.getByText("Nothing waiting for you.").waitFor();

  step("director: invalid JSON from Hermes shows a stage error with Retry (an Indonesian video, no brief beyond the marker)");
  await page.goto(`${APP}/studio/new`);
  await page.selectOption("#channelId", { label: "Myth Stories" });
  await page.selectOption("#templateId", "tpl-explainer-flat-vector");
  await page.fill("#brief", "BREAK-JSON please");
  await page.selectOption("#language", "id");
  await page.getByTestId("kokoro-flag").getByText("Not in Kokoro", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Ask Hermes for ideas" }).click();
  await page.getByText("Run started.").waitFor();
  await waitPrompt("idea", (t) => t.includes("BREAK-JSON") && t.includes("language code id"), "the Indonesian narration language");
  await waitShown(m, "/review", (p) => p.locator('[data-kind="stage-error"]'), "the stage error card");
  await m.getByRole("button", { name: "Retry" }).first().waitFor();
  await m.waitForLoadState("networkidle");
  await assertNoOverflow(m, "/review");
  await assertTapTargets(m, [["Retry", m.getByRole("button", { name: "Retry" })]]);
  await shot("19-review-error-mobile", m);

  step("director: reject cancels the run and empties the inbox");
  await m.getByRole("button", { name: "Reject" }).first().click();
  await m.getByText("Nothing waiting for you.").waitFor();

  step("template lab: a study with an upload, a YouTube link and a repo; Hermes's notes and draft; export; revise; a trial from the study");
  {
    // Neither browser may load anything from YouTube (no embed, no thumbnail): every such request is recorded and aborted.
    const youtubeFromBrowser = [];
    for (const ctx of [desktop, mobile]) {
      await ctx.route(/^https?:\/\/([^/]*\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)\//, (route) => {
        youtubeFromBrowser.push(route.request().url());
        return route.abort();
      });
    }
    const YT = "https://www.youtube.com/watch?v=venstudioE2E";
    const REPO = "https://github.com/artemnovitckii/claude-animation-skills";
    await page.goto(`${APP}/studio/lab`);
    await page.getByRole("heading", { name: "Template Lab", exact: true }).waitFor();
    const form = page.getByTestId("new-study-form");
    await form.getByLabel("Name", { exact: true }).fill("E2E count-up study");
    await form.getByLabel("Your notes (optional)").fill("Bigger numbers, calm pace");
    await form.getByRole("button", { name: "Start the study", exact: true }).click();
    await page.waitForURL(/\/studio\/lab\/[0-9a-f-]{36}$/);
    const studyId = /([0-9a-f-]{36})$/.exec(page.url())[1];
    const studyHref = `/studio/lab/${studyId}`;

    // An upload with rights: the reference analyzed in the assets step (its analysis is reused, no new worker job).
    const upload = page.getByTestId("add-upload");
    await upload.getByLabel("Upload (with rights)").selectOption({ label: "Test reference" });
    await upload.getByRole("button", { name: "Add the upload", exact: true }).click();
    await page.getByText("Upload added. Its analysis is linked.", { exact: true }).waitFor();
    const link = page.getByTestId("add-link");
    await link.getByLabel("Public link (YouTube included)").fill(YT);
    await link.getByRole("button", { name: "Add the link", exact: true }).click();
    await page.getByText("Link added. Hermes is looking at it.", { exact: true }).waitFor();
    const repo = page.getByTestId("add-repo");
    await repo.getByLabel("Public repository").fill(REPO);
    await repo.getByLabel("Path inside it (optional)").fill("skills/graph");
    await repo.getByRole("button", { name: "Add the repository", exact: true }).click();
    await page.getByText("Repository added. Hermes is reading it.", { exact: true }).waitFor();

    const analyzed = page.locator('[data-testid="lab-source"][data-status="analyzed"]');
    for (let i = 0; i < 30 && (await analyzed.count()) < 3; i++) {
      await page.waitForTimeout(1000);
      await page.goto(`${APP}${studyHref}`);
    }
    if ((await analyzed.count()) !== 3) {
      const text = (await page.getByTestId("lab-sources").innerText()).replace(/\s+/g, " ").slice(0, 1500);
      throw new Error(`the three sources are not analyzed: ${text}`);
    }
    const src = (type) => page.locator(`[data-testid="lab-source"][data-type="${type}"]`);
    await src("upload").getByTestId("source-licence").getByText("Own test clip, study only", { exact: true }).waitFor();
    await src("upload").getByTestId("source-measured").waitFor();
    await src("link").getByTestId("source-licence").getByText("unknown", { exact: true }).waitFor();
    await src("link").getByText("YouTube: watched, never downloaded", { exact: true }).waitFor();
    await src("link").getByTestId("source-notes").getByText("Fake notes on a link source: one number, one line, calm pace.", { exact: true }).waitFor();
    await src("repo").getByTestId("source-licence").getByText("MIT (read by Hermes)", { exact: true }).waitFor();
    await src("repo").getByTestId("source-ref").getByText(`${REPO} · path skills/graph`, { exact: true }).waitFor();
    if (fakeStats.labSourceAsks < 2 || fakeStats.labYoutubeAsks < 1) throw new Error(`Hermes was asked about ${fakeStats.labSourceAsks} source(s), ${fakeStats.labYoutubeAsks} of them YouTube`);
    // The link reached Hermes only as data: inside the DATA block, with the watch-only rule outside it.
    const ytAsk = fakeStats.labYoutubePrompt;
    if (!dataBlock(ytAsk, "source").includes(`reference: ${YT}`)) throw new Error("the YouTube link did not reach Hermes in a DATA block");
    if (ytAsk.replace(/<<<DATA source\n[\s\S]*?\nDATA source>>>/, "").includes(YT)) throw new Error("the YouTube link appears outside the DATA block");
    if (!/do not download it/.test(ytAsk)) throw new Error("Hermes was not told not to download the YouTube video");
    const sourceRows = dbValue(`SELECT string_agg(type || ':' || status || ':' || licence, ' | ' ORDER BY created_at) FROM lab_sources WHERE study_id = '${studyId}'`);
    if (sourceRows !== null && sourceRows !== "upload:analyzed:Own test clip, study only | link:analyzed:unknown | repo:analyzed:MIT (read by Hermes)") throw new Error(`lab_sources has "${sourceRows}"`);
    // Only notes are stored for the link: its findings are the validated JSON, never media.
    const linkFindings = dbValue(`SELECT findings->>'kind' || ' ' || (findings::text ~* '(base64|\\.mp4|googlevideo)')::text FROM lab_sources WHERE study_id = '${studyId}' AND type = 'link'`);
    if (linkFindings !== null && linkFindings !== "hermes-notes false") throw new Error(`the link's findings are "${linkFindings}"`);

    // Synthesis: Hermes's draft, with the numbers measured from the upload overriding its guesses.
    await page.getByRole("button", { name: "Synthesize a draft pack", exact: true }).click();
    await page.getByText("Hermes is drafting the pack.", { exact: true }).waitFor();
    const draftName = page.getByTestId("draft-name");
    for (let i = 0; i < 30 && !(await draftName.isVisible().catch(() => false)); i++) {
      await page.waitForTimeout(1000);
      await page.goto(`${APP}${studyHref}`);
    }
    await draftName.getByText("E2E calm count-up", { exact: true }).waitFor();
    const synthAsk = lastPrompt["lab-synthesis"] ?? "";
    if (!dataBlock(synthAsk, "study").includes("Bigger numbers, calm pace")) throw new Error("the synthesis prompt carries no study DATA block with the owner's notes");
    if (!dataBlock(synthAsk, "measured numbers")) throw new Error("the synthesis prompt carries no measured numbers");
    await page.getByTestId("renderer-verdict").getByText("A worker reports remotion-2d", { exact: true }).waitFor();
    const measured = await page.getByTestId("draft-measured").innerText();
    if (!measured.includes("contract.pacing.shotSeconds") || !measured.includes("contract.pacing.hookWithinMs")) throw new Error(`the draft's measured fields are "${measured}"`);
    if ((await page.getByTestId("draft-summary").innerText()).includes("shots 9-12 s")) throw new Error("Hermes's guessed shot lengths were kept over the measured ones");
    await page.getByTestId("draft-closest").getByText(/^explainer-flat-vector: /).waitFor();
    await shot("26-lab-study-desktop");

    // Export: one JSON file the vendored styles validator accepts.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download draft pack", exact: true }).click()]);
    const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
    if (exported.kind !== "venstudio-lab-draft-pack" || exported.packId !== "e2e-calm-count-up") throw new Error(`the export is ${exported.kind} ${exported.packId}`);
    const validator = await import(path.join(ROOT, "styles/tools/validate.mjs"));
    const style = JSON.parse(exported.files["packs/e2e-calm-count-up/style.json"]);
    const styleIssues = validator.validateStyle(style, { dirName: "e2e-calm-count-up" });
    if (styleIssues.length) throw new Error(`the exported style.json is not valid: ${styleIssues.join("; ")}`);
    if (style.status !== "draft" || style.provenance.length !== 3) throw new Error(`the exported style.json is ${style.status} with ${style.provenance.length} sources`);
    const licences = style.provenance.map((p) => `${p.type}:${p.licence}`).join(" | ");
    if (licences !== "upload:Own test clip, study only | link:unknown | repo:MIT (as read by Hermes; check before adapting code)") throw new Error(`the provenance licences are "${licences}"`);
    if (style.provenance[1].ref !== YT || !/never downloaded/.test(style.provenance[1].notes)) throw new Error("the YouTube source's provenance is not the link with its watched-only note");
    if (!exported.steps.some((t) => t.includes("no GitHub token"))) throw new Error("the export does not say that no GitHub token is needed");
    await page.getByTestId("export-steps").getByText("node tools/validate.mjs", { exact: false }).first().waitFor();

    // One revision through Hermes, with the owner's note.
    const revise = page.getByTestId("revise-form");
    await revise.getByLabel(/^Ask for a revision \(0 of 5 used\)/).fill("Slower, please");
    await revise.getByRole("button", { name: "Revise the draft", exact: true }).click();
    await page.getByText("Hermes is revising the draft.", { exact: true }).waitFor();
    for (let i = 0; i < 30 && !(await page.getByTestId("draft-name").getByText("E2E calm count-up (revised)", { exact: true }).isVisible().catch(() => false)); i++) {
      await page.waitForTimeout(1000);
      await page.goto(`${APP}${studyHref}`);
    }
    await page.getByTestId("draft-name").getByText("E2E calm count-up (revised)", { exact: true }).waitFor();
    await page.getByTestId("revisions").getByText("Revision 1: Slower, please", { exact: true }).waitFor();
    if (!dataBlock(lastPrompt["lab-synthesis"] ?? "", "owner revision note").includes("Slower, please")) throw new Error("the revision note did not reach Hermes in a DATA block");

    // A trial from the study: New Video pre-filled with the closest pack and the study's notes; the run is linked.
    await page.getByRole("link", { name: "Start a trial video with the closest pack", exact: true }).click();
    await page.waitForURL(new RegExp(`/studio/new\\?study=${studyId}$`));
    await page.getByTestId("lab-study-trial-note").getByText(/^Trial for the lab study "E2E count-up study" with the closest pack, explainer-flat-vector\./).waitFor();
    await page.getByTestId("lab-study-link").waitFor();
    if ((await page.locator("#templateId").inputValue()) !== "tpl-explainer-flat-vector") throw new Error("New Video is not pre-filled with the closest pack");
    if (!(await page.locator("#brief").inputValue()).startsWith('Trial for the Template Lab study "E2E count-up study".\nOwner notes: Bigger numbers, calm pace')) throw new Error("New Video's brief is not the study's notes");
    await page.selectOption("#channelId", { label: "Myth Stories" });
    await page.getByRole("button", { name: "Ask Hermes for ideas", exact: true }).click();
    await page.getByText("Run started.", { exact: false }).first().waitFor();
    const linked = dbValue(`SELECT (config->'stylePack'->>'trial') || ' ' || (config->'stylePack'->>'id') FROM pipeline_runs WHERE config->>'labStudyId' = '${studyId}'`);
    if (linked !== null && linked !== "true explainer-flat-vector") throw new Error(`the study's trial run is "${linked}"`);
    await page.goto(`${APP}${studyHref}`);
    const trialRow = page.getByTestId("lab-trial");
    await trialRow.getByRole("link", { name: "Trial run with explainer-flat-vector 1.0.1", exact: true }).waitFor();
    await trialRow.getByTestId("trial-outcome").getByText(/^QC: not run yet · presentation not scored · decision none yet/).waitFor();

    // 390 px.
    await m.goto(`${APP}${studyHref}`);
    await m.getByTestId("lab-trial").first().waitFor();
    await assertNoOverflow(m, studyHref);
    await assertTapTargets(m, [["Revise the draft", m.getByRole("button", { name: "Revise the draft", exact: true })]]);
    await shot("27-lab-study-mobile", m);
    await m.goto(`${APP}/studio/lab`);
    await m.getByTestId("lab-study-row").first().waitFor();
    await assertNoOverflow(m, "/studio/lab");

    // Nobody fetched the YouTube link: not the browsers, not the fake Hermes, not the portal (CI's fetch canary).
    if (youtubeFromBrowser.length) throw new Error(`a browser requested YouTube: ${youtubeFromBrowser.join(", ")}`);
    if (fakeStats.youtubeHits) throw new Error(`${fakeStats.youtubeHits} request(s) for YouTube reached the fake Hermes`);
    const canary = process.env.E2E_FETCH_CANARY;
    if (!canary) console.log("   E2E_FETCH_CANARY unset: the portal-side fetch canary is not checked");
    else {
      let hits = "";
      try {
        hits = readFileSync(canary, "utf8").trim();
      } catch {
        hits = "";
      }
      if (hits) throw new Error(`the portal itself fetched a study link:\n${hits}`);
      console.log("   the portal made no request to YouTube or GitHub (fetch canary empty)");
    }
  }

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("UI E2E PASS");
} catch (err) {
  await shot("zz-failure").catch(() => {});
  console.error(errors.join("\n"));
  throw err;
} finally {
  await browser.close();
  fakeHermes.close();
  fakeRouter.close();
  for (const sock of routerSockets) sock.destroy();
}
