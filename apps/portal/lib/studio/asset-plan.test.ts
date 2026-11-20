import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProvenance,
  cc0HostAllowed,
  cc0Issues,
  claimedLicence,
  fallbackChain,
  imagePrompt,
  parseTriedProviders,
  normalizeProvider,
  resolveImageProvider,
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

test("ttsKokoroPrompt never asks for base64 and places the audio under the media origin", () => {
  const [, user] = ttsKokoroPrompt({ text: "Hi.", languageLabel: "English", languageCode: "en", mediaOrigin: "http://hermes-files:8000/tts" });
  assert.doesNotMatch(user.content, /or base64 audio data/);
  assert.match(user.content, /http:\/\/hermes-files:8000\/tts/);
  assert.match(user.content, /audio\.value must be exactly/);
});
