import { test } from "node:test";
import assert from "node:assert/strict";
import { AGNES_CLIP_SECONDS, clipSecondsIssues } from "./image-result.ts";
import {
  buildProvenance,
  cc0HostAllowed,
  cc0Issues,
  claimedLicence,
  fallbackChain,
  imagePrompt,
  parseTriedProviders,
  planClipRequests,
  normalizeProvider,
  resolveImageProvider,
  MAX_CLIPS_PER_SHOT,
  videoPrompt,
  PROVIDER_NAME_MAX,
  providerTermsIssues,
  ttsCapcutPrompt,
  ttsKokoroPrompt,
} from "./asset-plan.ts";
import { provenanceIssues } from "./provenance.ts";

test("normalizeProvider makes a lowercase slug", () => {
  assert.equal(normalizeProvider("Cloudflare AI"), "cloudflare-ai");
  assert.equal(normalizeProvider("  Qwen_Image!! "), "qwen-image");
  assert.equal(normalizeProvider(""), "unknown");
  assert.equal(normalizeProvider(undefined), "unknown");
  assert.equal(normalizeProvider("***"), "unknown");
});

test("providerTermsIssues words unknown and no differently and names Settings", () => {
  const uses = [
    { title: "a", provider: "Cloudflare", kind: "image" as const },
    { title: "b", provider: "cloudflare", kind: "image" as const },
    { title: "c", provider: "qwen", kind: "image" as const },
    { title: "d", provider: "agnes", kind: "image" as const },
    { title: "v", provider: "kokoro", kind: "tts" as const },
  ];
  const terms = [
    { name: "cloudflare", kind: "image" as const, commercialOk: "yes" as const },
    { name: "qwen", kind: "image" as const, commercialOk: "no" as const },
    { name: "kokoro", kind: "tts" as const, commercialOk: "unknown" as const },
  ];
  const issues = providerTermsIssues(uses, terms);
  assert.equal(issues.length, 3);
  assert.match(issues.find((i) => i.includes("qwen"))!, /not cleared for commercial use/);
  assert.match(issues.find((i) => i.includes("agnes"))!, /Confirm the commercial-use terms for agnes in Settings/);
  assert.match(issues.find((i) => i.includes("kokoro"))!, /Confirm the commercial-use terms/);
  assert.deepEqual(providerTermsIssues([], []), []);
});

test("providerTermsIssues keeps kinds apart", () => {
  const issues = providerTermsIssues([{ title: "v", provider: "capcut", kind: "tts" }], [{ name: "capcut", kind: "image", commercialOk: "yes" }]);
  assert.equal(issues.length, 1);
});

test("buildProvenance sets the source per executor and passes provenanceIssues", () => {
  const img = buildProvenance({ executor: "hermes-image", title: "shot-01", kind: "image", provider: "Cloudflare", model: "flux", prompt: "a cat", shotRef: "shot-01" });
  assert.equal(img.record.source, "hermes");
  assert.equal(img.provider, "cloudflare");
  assert.equal(img.providerKind, "image");
  assert.equal(img.metadata.model, "flux");
  assert.deepEqual(provenanceIssues([img.record], "publish"), []);
  const kokoro = buildProvenance({ executor: "kokoro", title: "narration", kind: "audio", provider: "kokoro" });
  assert.equal(kokoro.record.source, "generated");
  assert.equal(kokoro.providerKind, "tts");
  const capcut = buildProvenance({ executor: "hermes-capcut", title: "narration", kind: "audio", provider: "capcut" });
  assert.equal(capcut.record.source, "hermes");
  const lib = buildProvenance({ executor: "worker-fetch", title: "x", kind: "image", provider: "wikimedia", licence: "CC0 1.0", originUrl: "https://upload.wikimedia.org/a.png" });
  assert.equal(lib.record.source, "worker");
  assert.equal(lib.providerKind, "library");
  assert.deepEqual(provenanceIssues([lib.record], "publish"), []);
});

test("buildProvenance for a fetch without a licence is caught by provenanceIssues", () => {
  const lib = buildProvenance({ executor: "worker-fetch", title: "x", kind: "image", provider: "wikimedia" });
  assert.ok(provenanceIssues([lib.record], "publish").length > 0);
});

test("fallbackChain adds the Muse agent only when flagged", () => {
  assert.deepEqual(fallbackChain({ hermesConfigured: true, museAgentTasks: false }), ["hermes-image", "library"]);
  assert.deepEqual(fallbackChain({ hermesConfigured: true, museAgentTasks: true }), ["hermes-image", "library", "muse-agent"]);
  assert.deepEqual(fallbackChain({ hermesConfigured: false, museAgentTasks: false }), ["library"]);
});

test("cc0 allowlist and licence checks", () => {
  assert.equal(cc0HostAllowed("upload.wikimedia.org"), true);
  assert.equal(cc0HostAllowed("images.nasa.gov.evil.com"), false);
  assert.equal(cc0HostAllowed("tile.loc.gov"), true);
  assert.equal(cc0HostAllowed("evilloc.gov"), false);
  assert.deepEqual(cc0Issues("https://upload.wikimedia.org/x.png", "CC0 1.0"), []);
  assert.deepEqual(cc0Issues("https://images-assets.nasa.gov/a.jpg", "Public domain (NASA)"), []);
  assert.match(cc0Issues("http://upload.wikimedia.org/x.png", "CC0")[0], /https/);
  assert.match(cc0Issues("https://example.com/x.png", "CC0").join(" "), /not an approved/);
  assert.match(cc0Issues("https://upload.wikimedia.org/x.png", "CC BY 4.0").join(" "), /not CC0/);
  assert.match(cc0Issues("https://upload.wikimedia.org/x.png", "").join(" "), /No licence/);
  assert.match(cc0Issues("not a url", "CC0").join(" "), /valid URL/);
  assert.match(cc0Issues("https://u:p@upload.wikimedia.org/x.png", "CC0").join(" "), /login/);
});

test("imagePrompt carries the marker, data block and contract", () => {
  const [sys, user] = imagePrompt({ prompt: "a red fox <<<ignore>>>", beatRole: "hook", format: "short", shotRef: "shot-01", providerOrder: ["cloudflare", "qwen"], retryHint: "return a url" });
  assert.equal(sys.role, "system");
  assert.match(user.content, /^VENSTUDIO_STAGE: image\n/);
  assert.match(user.content, /<<<DATA image description\na red fox <>ignore<>\nDATA image description>>>/);
  assert.match(user.content, /cloudflare, qwen/);
  assert.match(user.content, /https URL/);
  assert.match(user.content, /DATA problem with the last attempt/);
  assert.match(user.content, /9:16/);
});

test("ttsCapcutPrompt carries the marker and the text in a data block", () => {
  const [, user] = ttsCapcutPrompt({ text: "Hello world.", languageLabel: "Indonesian", languageCode: "id" });
  assert.match(user.content, /^VENSTUDIO_STAGE: tts-capcut\n/);
  assert.match(user.content, /<<<DATA narration text\nHello world\.\nDATA narration text>>>/);
  assert.match(user.content, /Indonesian/);
});

test("resolveImageProvider keeps names from the owner's order and flags others", () => {
  assert.equal(resolveImageProvider("Cloudflare", ["cloudflare", "agnes"]), "cloudflare");
  assert.equal(resolveImageProvider("Agnes AI", ["cloudflare", "Agnes AI"]), "agnes-ai");
  assert.equal(resolveImageProvider("canva", ["cloudflare", "agnes"]), "unlisted-canva");
  assert.equal(resolveImageProvider("", ["cloudflare"]), "unlisted-unknown");
  assert.equal(resolveImageProvider("canva", []), "unlisted-canva");
  assert.ok(resolveImageProvider("x".repeat(80), ["a"]).length <= PROVIDER_NAME_MAX);
  assert.equal(resolveImageProvider("x".repeat(80), []).length, PROVIDER_NAME_MAX);
  assert.ok(resolveImageProvider("x-".repeat(60), []).length <= PROVIDER_NAME_MAX);
});

test("claimedLicence marks the statement as unverified and keeps the source link", () => {
  const t = claimedLicence("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "https://upload.wikimedia.org/a.jpg");
  assert.match(t, /^Claimed CC0 1\.0 \(stated by Hermes, not verified\)/);
  assert.ok(t.includes("https://creativecommons.org/publicdomain/zero/1.0/"));
  assert.ok(claimedLicence("", "", "https://x.org/a").includes("https://x.org/a"));
  assert.ok(claimedLicence("Public domain", "", "").length > 0);
});

test("fallbackChain puts 9router images after Hermes and before the library, only when available", () => {
  assert.deepEqual(fallbackChain({ hermesConfigured: true, museAgentTasks: true, routerImageAvailable: true }), ["hermes-image", "router-image", "library", "muse-agent"]);
  assert.deepEqual(fallbackChain({ hermesConfigured: false, museAgentTasks: false, routerImageAvailable: true }), ["router-image", "library"]);
  assert.deepEqual(fallbackChain({ hermesConfigured: true, museAgentTasks: false, routerImageAvailable: false }), ["hermes-image", "library"]);
});

test("buildProvenance names the real path for the 9router and Hermes Kokoro executors", () => {
  const tts = buildProvenance({ executor: "router-tts", title: "narration", kind: "audio", provider: "Kokoro", model: "kokoro/af_heart" });
  assert.equal(tts.record.source, "generated");
  assert.equal(tts.providerKind, "tts");
  assert.equal(tts.metadata.via, "9router");
  assert.match(tts.record.license, /Voice generated by kokoro \(kokoro\/af_heart\) through 9router\. Commercial terms are tracked in Settings\./);
  assert.deepEqual(provenanceIssues([tts.record], "publish"), []);

  const hk = buildProvenance({ executor: "hermes-kokoro", title: "narration", kind: "audio", provider: "unlisted-foo" });
  assert.equal(hk.record.source, "hermes");
  assert.equal(hk.providerKind, "tts");
  assert.equal(hk.metadata.via, "hermes");
  assert.match(hk.record.license, /Hermes was asked for Kokoro/);

  const img = buildProvenance({ executor: "router-image", title: "shot", kind: "image", provider: "flux", model: "flux/dev" });
  assert.equal(img.providerKind, "image");
  assert.equal(img.metadata.via, "9router");
  assert.match(img.record.license, /through 9router/);

  assert.equal(buildProvenance({ executor: "kokoro", title: "n", kind: "audio", provider: "kokoro" }).metadata.via, "direct");
  assert.equal(buildProvenance({ executor: "hermes-image", title: "n", kind: "image", provider: "x" }).metadata.via, "hermes");
});

test("ttsKokoroPrompt carries its own stage marker, the text and the skill hints as data", () => {
  const [, user] = ttsKokoroPrompt({ text: "Hello world.", languageLabel: "English", languageCode: "en", skillHints: ["kokoro-tts", "a", "b", "c", "d", "e", "f"] });
  assert.match(user.content, /^VENSTUDIO_STAGE: tts-kokoro/);
  assert.match(user.content, /Do not change the words/);
  assert.match(user.content, /Hello world\./);
  assert.match(user.content, /kokoro-tts/);
  assert.doesNotMatch(user.content, /, f/);
  // The schema must not hand Hermes the confirmed provider name to copy.
  assert.doesNotMatch(user.content, /"provider":"kokoro"/);
});

test("imagePrompt lets Hermes choose and fall through its own providers, and asks which ones failed", () => {
  const [, user] = imagePrompt({ prompt: "a fox", beatRole: "body", format: "long", shotRef: "shot-02" });
  assert.match(user.content, /for shot shot-02/);
  assert.match(user.content, /You choose the provider/);
  assert.match(user.content, /fall through its own providers/);
  assert.match(user.content, /"tried"/);
  assert.doesNotMatch(user.content, /Preferred provider order/);
});

test("parseTriedProviders keeps bounded, normalised names from Hermes' report", () => {
  assert.deepEqual(parseTriedProviders({ tried: [{ provider: "Cloudflare", error: "rate limited" }, { name: "agnes" }, "canva", { provider: "cloudflare" }, { provider: "" }] }), [
    { provider: "cloudflare", error: "rate limited" },
    { provider: "agnes", error: "" },
    { provider: "canva", error: "" },
  ]);
  assert.deepEqual(parseTriedProviders(null), []);
  assert.deepEqual(parseTriedProviders({ tried: "cloudflare" }), []);
  assert.equal(parseTriedProviders({ tried: Array.from({ length: 30 }, (_, i) => `p${i}`) }).length, 12);
});

test("imagePrompt never asks for base64 — that is what makes the turn loop", () => {
  for (const mediaOrigin of [undefined, "http://hermes-files:8000"]) {
    const [, user] = imagePrompt({ prompt: "a fox", beatRole: "hook", format: "short", shotRef: "shot-04", mediaOrigin });
    // The word may appear only as a prohibition, never as an offer.
    assert.doesNotMatch(user.content, /or base64 image data/);
    assert.doesNotMatch(user.content, /Return a file path/);
  }
});

test("imagePrompt hands Hermes the media origin and says the reply is a name, not the file", () => {
  const [, user] = imagePrompt({ prompt: "a fox", beatRole: "hook", format: "short", shotRef: "shot-05", mediaOrigin: "http://hermes-files:8000/img" });
  assert.match(user.content, /http:\/\/hermes-files:8000\/img/);
  assert.match(user.content, /base name/i);
  assert.match(user.content, /image\.value must be exactly http:\/\/hermes-files:8000\/img\/<file name>/);
  assert.match(user.content, /do not use terminal or execute_code/i);
  assert.match(user.content, /do not convert it to base64/i);
  assert.doesNotMatch(user.content, /or base64 image data/);
});

test("imagePrompt asks for the real backend in source, apart from provider", () => {
  const [, user] = imagePrompt({ prompt: "a fox", beatRole: "hook", format: "short", shotRef: "s1", mediaOrigin: "http://hermes-files:8000/img" });
  assert.match(user.content, /"source":string/);
  assert.match(user.content, /backend that really made the image/);
});

test("ttsKokoroPrompt never asks for base64 and places the audio under the media origin", () => {
  const [, user] = ttsKokoroPrompt({ text: "Hi.", languageLabel: "English", languageCode: "en", mediaOrigin: "http://hermes-files:8000/tts" });
  assert.doesNotMatch(user.content, /or base64 audio data/);
  assert.match(user.content, /http:\/\/hermes-files:8000\/tts/);
  assert.match(user.content, /audio\.value must be exactly/);
});

test("videoPrompt asks for one clip, not a film, and states the length", () => {
  const [, user] = videoPrompt({ prompt: "a fox runs through snow", beatRole: "hook", format: "short", shotRef: "shot-03", seconds: 5, mode: "text" });
  const text = String(user.content);
  assert.match(text, /VENSTUDIO_STAGE: video/);
  assert.match(text, /shot-03/);
  assert.match(text, /vertical 9:16 \(720x1280\)/);
  assert.match(text, /5 seconds/);
  // The provider returns a shot, so the prompt must not imply a whole video.
  assert.match(text, /ONE continuous clip/);
  assert.match(text, /not a film/);
  assert.match(text, /"video":\{/);
  assert.match(text, /"source":string/);
});

test("videoPrompt names the source images per mode", () => {
  const [, keyframe] = videoPrompt({ prompt: "a fox", beatRole: "body", format: "long", shotRef: "shot-04", seconds: 8, mode: "keyframe", sourceImageUrls: ["https://x.test/f.png"] });
  const kf = String(keyframe.content);
  assert.match(kf, /opening frame/);
  assert.match(kf, /https:\/\/x\.test\/f\.png/);
  assert.match(kf, /landscape 16:9 \(1280x720\)/);

  const [, plain] = videoPrompt({ prompt: "a fox", beatRole: "body", format: "short", shotRef: "shot-05", seconds: 6, mode: "text" });
  assert.match(String(plain.content), /no source image/);
});

test("videoPrompt hands over a base name when a media origin is configured", () => {
  const [, user] = videoPrompt({ prompt: "a fox", beatRole: "body", format: "short", shotRef: "shot-06", seconds: 4, mode: "text", mediaOrigin: "http://hermes-files:8000/clip" });
  const text = String(user.content);
  // The byte-carrying reply is what made the model loop, so it must never be asked for.
  assert.match(text, /Do not read the file, do not convert it to base64/);
  assert.match(text, /base name only/);
  assert.match(text, /http:\/\/hermes-files:8000\/clip\/<file name>/);

  const [, bare] = videoPrompt({ prompt: "a fox", beatRole: "body", format: "short", shotRef: "shot-07", seconds: 4, mode: "text" });
  assert.match(String(bare.content), /never convert the file to base64/);
});

test("planClipRequests leaves a shot that already fits as one clip", () => {
  const plan = planClipRequests(
    { shotRef: "shot-10", beatRole: "body", prompt: "a fox runs", seconds: 6 },
    { format: "short" },
  );
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].shotRef, "shot-10");
  assert.equal(plan.clips[0].seconds, 6);
  assert.equal(plan.clips[0].mode, "text");
  assert.deepEqual(plan.notes, []);
});

test("planClipRequests splits a shot longer than one clip, and the parts still sum to it", () => {
  const plan = planClipRequests(
    { shotRef: "shot-11", beatRole: "hook", prompt: "a long chase", seconds: 30 },
    { format: "short" },
  );
  assert.equal(plan.clips.length, 3);
  // Order has to survive the join, so the refs are suffixed in sequence.
  assert.deepEqual(plan.clips.map((c) => c.shotRef), ["shot-11-c1", "shot-11-c2", "shot-11-c3"]);
  assert.deepEqual(plan.clips.map((c) => c.seconds), [10, 10, 10]);
  assert.equal(plan.clips.reduce((n, c) => n + c.seconds, 0), 30);
  assert.match(plan.notes.join(" "), /3 clips/);
  // Each part must be renderable on its own, not just in total.
  for (const clip of plan.clips) assert.deepEqual(clipSecondsIssues(clip.seconds), []);
  // A continuation clip must not restage the opening.
  assert.match(plan.clips[1].prompt, /clip 2 of 3/);
  assert.match(plan.clips[2].prompt, /Do not restage the opening/);
});

test("planClipRequests handles a remainder rather than dropping a second", () => {
  const plan = planClipRequests(
    { shotRef: "shot-12", beatRole: "body", prompt: "a fox", seconds: 13 },
    { format: "long" },
  );
  assert.equal(plan.clips.length, 2);
  assert.deepEqual(plan.clips.map((c) => c.seconds), [7, 6]);
  assert.equal(plan.clips.reduce((n, c) => n + c.seconds, 0), 13);
  assert.equal(plan.clips[0].format, "long");
});

test("planClipRequests names a shot below the provider minimum instead of stretching it silently", () => {
  const plan = planClipRequests(
    { shotRef: "shot-13", beatRole: "body", prompt: "a blink", seconds: 2 },
    { format: "short" },
  );
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].seconds, AGNES_CLIP_SECONDS[0]);
  assert.match(plan.notes.join(" "), /cannot make less than 4s/);
});

test("planClipRequests picks reference mode when stills are supplied", () => {
  const plan = planClipRequests(
    { shotRef: "shot-14", beatRole: "body", prompt: "a fox", seconds: 5 },
    { format: "short", sourceImageUrls: ["https://x.test/f.png"] },
  );
  assert.equal(plan.clips[0].mode, "reference");
  const forced = planClipRequests(
    { shotRef: "shot-15", beatRole: "body", prompt: "a fox", seconds: 5 },
    { format: "short", sourceImageUrls: ["https://x.test/f.png"], mode: "keyframe" },
  );
  assert.equal(forced.clips[0].mode, "keyframe");
});

test("planClipRequests refuses a shot it cannot cover with legal clips", () => {
  const plan = planClipRequests(
    { shotRef: "shot-16", beatRole: "body", prompt: "an endless pan", seconds: 600 },
    { format: "long" },
  );
  // The request cap must never be paid for with illegal clips: 600s in 6 clips is 100s each, which the
  // provider refuses outright. So nothing is returned and the note says where the fix belongs.
  assert.deepEqual(plan.clips, []);
  assert.match(plan.notes.join(" "), /split it in the storyboard/i);
});

test("planClipRequests allows exactly the cap and refuses one clip past it", () => {
  const atCap = planClipRequests(
    { shotRef: "shot-17", beatRole: "body", prompt: "a long take", seconds: 12 * MAX_CLIPS_PER_SHOT },
    { format: "long" },
  );
  assert.equal(atCap.clips.length, MAX_CLIPS_PER_SHOT);
  assert.deepEqual(atCap.clips.map((c) => c.seconds), Array(MAX_CLIPS_PER_SHOT).fill(12));
  for (const clip of atCap.clips) assert.deepEqual(clipSecondsIssues(clip.seconds), []);

  const past = planClipRequests(
    { shotRef: "shot-18", beatRole: "body", prompt: "a long take", seconds: 12 * MAX_CLIPS_PER_SHOT + 1 },
    { format: "long" },
  );
  assert.deepEqual(past.clips, []);
  assert.match(past.notes.join(" "), /needs 7 clips/);
});
