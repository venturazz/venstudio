import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProvenance,
  cc0HostAllowed,
  cc0Issues,
  claimedLicence,
  fallbackChain,
  imagePrompt,
  normalizeProvider,
  resolveImageProvider,
  providerTermsIssues,
  ttsCapcutPrompt,
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
  assert.ok(resolveImageProvider("x".repeat(80), ["a"]).length <= 49);
});

test("claimedLicence marks the statement as unverified and keeps the source link", () => {
  const t = claimedLicence("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "https://upload.wikimedia.org/a.jpg");
  assert.match(t, /^Claimed CC0 1\.0 \(stated by Hermes, not verified\)/);
  assert.ok(t.includes("https://creativecommons.org/publicdomain/zero/1.0/"));
  assert.ok(claimedLicence("", "", "https://x.org/a").includes("https://x.org/a"));
  assert.ok(claimedLicence("Public domain", "", "").length > 0);
});
