import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINES, STYLES, THEMES, VIDEO_FORMATS, FAMILY_LABELS, ASSET_KINDS, ASSET_SOURCES, PURPOSES, LANGUAGES } from "./catalog.ts";
import { buildPlan, detectTheme, hasPhrase, suggestStyles } from "./planner.ts";
import { provenanceIssues } from "./provenance.ts";

test("catalog is internally consistent", () => {
  const ids = STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "style ids are unique");
  for (const s of STYLES) {
    assert.ok(ENGINES[s.engine], `${s.id} uses a known engine`);
    assert.ok(s.formats.length > 0, `${s.id} supports at least one format`);
    assert.ok(s.keywords.length >= 3, `${s.id} has keywords for suggestions`);
    assert.ok(s.shotSeconds[0] > 0 && s.shotSeconds[0] <= s.shotSeconds[1], `${s.id} has a sane shot length`);
    assert.ok(FAMILY_LABELS[s.family], `${s.id} has a family label`);
    for (const t of s.themes) assert.ok(THEMES.some((th) => th.id === t), `${s.id} references known theme ${t}`);
    for (const k of s.assetKinds) assert.ok(ASSET_KINDS.includes(k), `${s.id} uses a known asset kind`);
  }
  for (const e of Object.values(ENGINES)) assert.ok(["light", "medium", "heavy"].includes(e.tier));
  assert.ok(ASSET_SOURCES.length >= 5);
  assert.ok(VIDEO_FORMATS.short.durationSec[0] < VIDEO_FORMATS.short.durationSec[1]);
});

test("phrase matching is whole-word and ignores punctuation", () => {
  assert.equal(hasPhrase("Best AI tools", "ai"), true);
  assert.equal(hasPhrase("a nice chair", "ai"), false);
  assert.equal(hasPhrase("Lo-fi beats to study to", "lo-fi"), true);
  assert.equal(hasPhrase("2.5D parallax city", "2.5d"), true);
  assert.equal(hasPhrase("", "history"), false);
});

test("a history brief suggests a documentary first for long videos", () => {
  const top = suggestStyles("A history documentary about the Roman roads", "long");
  assert.equal(top[0].style.id, "documentary-stills");
  assert.deepEqual(top[0].matched.sort(), ["documentary", "history"]);
});

test("format filters suggestions: long-only styles never appear for shorts", () => {
  const shorts = suggestStyles("data chart of inflation and economy", "short");
  assert.ok(!shorts.some((s) => s.style.id === "chart-story"));
  const longs = suggestStyles("data chart of inflation and economy", "long");
  assert.equal(longs[0].style.id, "chart-story");
});

test("theme detection and theme-based ranking", () => {
  assert.equal(detectTheme("why do ocean animals glow")?.id, "science");
  assert.equal(detectTheme("nothing relevant here at all"), undefined);
  const ranked = suggestStyles("a short tale", "short", "kids");
  assert.ok(ranked.length > 0, "a theme alone still produces suggestions");
  assert.ok(ranked.every((s) => s.style.themes.includes("kids") || s.matched.length > 0));
});

test("an original plan lists the Hermes stages, narration and a render stage that is not runnable yet", () => {
  const r = buildPlan({ brief: "The rise of Rome", format: "long", styleId: "documentary-stills", themeId: "history" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.plan.stages.map((s) => s.id);
  assert.deepEqual(ids.slice(0, 4), ["research", "script", "storyboard", "visuals"]);
  assert.ok(ids.includes("voice"));
  assert.ok(ids.indexOf("render") > ids.indexOf("music"));
  assert.equal(r.plan.stages.find((s) => s.id === "render")?.runnable, false);
  assert.ok(r.plan.warnings.some((w) => w.startsWith("History:")), "theme policy is shown as a warning");
  assert.equal(r.plan.durationSec[0], 480);
});

test("ambient style has no narration stage", () => {
  const r = buildPlan({ brief: "rain on a window for studying", format: "long", styleId: "ambient-loop" });
  assert.equal(r.ok && r.plan.stages.some((s) => s.id === "voice"), false);
});

test("heavy and muse-slow engines get a time warning, not a refusal", () => {
  const r = buildPlan({ brief: "a stylized 3d myth", format: "short", styleId: "stylized-3d-story" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.plan.muse, "muse-slow");
  assert.ok(r.plan.warnings.some((w) => w.includes("Muse has no GPU")));
});

test("long videos with heavy engines warn about total render time", () => {
  const r = buildPlan({ brief: "blender scene of the solar system", format: "long", styleId: "blender-3d" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.plan.warnings.some((w) => w.includes("many hours")));
});

test("copy-cat workflow adds analysis and blueprint, and needs a reference", () => {
  const missing = buildPlan({ brief: "a myth", format: "short", styleId: "animated-series-2d", workflow: "copycat-structure" });
  assert.equal(missing.ok, false);
  const r = buildPlan({ brief: "a myth", format: "short", styleId: "animated-series-2d", workflow: "copycat-structure", hasReference: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.plan.stages.slice(0, 2).map((s) => [s.id, s.executor, s.runnable]), [
    ["analyze", "worker", true],
    ["blueprint", "hermes", false],
  ]);
  assert.ok(r.plan.warnings.some((w) => w.includes("structure only")));
});

test("wrong format, unknown style and empty brief are rejected with a reason", () => {
  const wrongFormat = buildPlan({ brief: "x y", format: "long", styleId: "story-read-aloud" });
  assert.equal(wrongFormat.ok, false);
  assert.match(wrongFormat.ok ? "" : wrongFormat.error, /made for/);
  assert.equal(buildPlan({ brief: "x", format: "short", styleId: "nope" }).ok, false);
  assert.equal(buildPlan({ brief: "   ", format: "short", styleId: "kinetic-facts" }).ok, false);
});

test("provenance: publishing needs a licence note and an origin for uploads", () => {
  const issues = provenanceIssues(
    [
      { title: "Owned photo", kind: "image", source: "generated", license: "own render", originUrl: "" },
      { title: "Stock clip", kind: "video", source: "upload", license: "", originUrl: "" },
      { title: "Music", kind: "audio", source: "licensed", license: "CC-BY 4.0", originUrl: "" },
      { title: "Study clip", kind: "reference-video", source: "upload", license: "study only", originUrl: "https://example.com/x" },
    ],
    "publish",
  );
  assert.ok(issues.some((i) => i.startsWith("Stock clip: no licence")));
  assert.ok(issues.some((i) => i.startsWith("Music: say where")));
  assert.ok(issues.some((i) => i.startsWith("Study clip: a reference video")));
  assert.ok(!issues.some((i) => i.startsWith("Owned photo")));
  assert.deepEqual(provenanceIssues([{ title: "x", kind: "video", source: "upload", license: "", originUrl: "" }], "analyze"), []);
});

test("themes, purposes and languages have unique ids and sane fields", () => {
  const unique = (xs: string[]) => new Set(xs).size === xs.length;
  assert.ok(unique(THEMES.map((t) => t.id)), "theme ids unique");
  assert.ok(unique(PURPOSES.map((p) => p.id)), "purpose ids unique");
  assert.ok(unique(LANGUAGES.map((l) => l.code)), "language codes unique");
  assert.ok(THEMES.length >= 30, "the catalog covers a wide range of genres and topics");
  for (const p of PURPOSES) for (const st of p.extraStages) assert.ok(st.id && st.label && st.detail, `${p.id} stage is complete`);
});

test("new genres are detected from the brief", () => {
  assert.equal(detectTheme("a true crime case with a detective and a murder")?.id, "true-crime");
  assert.equal(detectTheme("learn english vocabulary and grammar in five minutes")?.id, "language-learning");
  assert.equal(detectTheme("a thriller with a spy and a twist")?.id, "thriller");
});

test("affiliate purpose adds product research after research and a disclosure warning", () => {
  const r = buildPlan({ brief: "best budget headphones", format: "short", styleId: "product-review", themeId: "product", purposeIds: ["affiliate"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.plan.stages.map((s) => s.id);
  assert.ok(ids.indexOf("product-research") === ids.indexOf("research") + 1);
  assert.ok(r.plan.warnings.some((w) => w.startsWith("Affiliate links:") && w.includes("paid promotion")));
  assert.deepEqual(r.plan.purposes, [{ id: "affiliate", label: "Affiliate links" }]);
});

test("advertising and testimonial purposes add human approval stages", () => {
  const r = buildPlan({ brief: "launch video for a coffee brand", format: "long", styleId: "explainer-flat-vector", purposeIds: ["advertising", "testimonial"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const human = r.plan.stages.filter((s) => s.executor === "human").map((s) => s.id);
  assert.ok(human.includes("client-brief"));
  assert.ok(human.includes("release"));
});

test("series purpose adds a series bible before the script", () => {
  const r = buildPlan({ brief: "a cartoon fable episode", format: "short", styleId: "animated-series-2d", purposeIds: ["series"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.plan.stages.map((s) => s.id);
  assert.ok(ids.indexOf("series-bible") < ids.indexOf("script"));
});

test("non-English narration adds translation and localized metadata stages", () => {
  const r = buildPlan({ brief: "the rise of Rome", format: "long", styleId: "documentary-stills", language: "es" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.plan.stages.map((s) => s.id);
  assert.ok(ids.includes("translate"));
  assert.ok(ids.includes("localize-meta"));
  assert.equal(r.plan.stages.find((s) => s.id === "voice")?.label, "Narration (Spanish)");
  assert.equal(r.plan.language.tts, "kokoro");
});

test("a language outside Kokoro's list gets a voice-provider warning", () => {
  const r = buildPlan({ brief: "the rise of Rome", format: "long", styleId: "documentary-stills", language: "id" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.plan.warnings.some((w) => w.startsWith("Narration in Indonesian:") && w.includes("another voice provider")));
});

test("subtitles add a subtitles stage; the narration language is never repeated as a subtitle", () => {
  const r = buildPlan({ brief: "the rise of Rome", format: "long", styleId: "documentary-stills", subtitles: ["en", "id", "ja", "id"] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.plan.subtitles.map((x) => x.code), ["id", "ja"]);
  assert.ok(r.plan.stages.some((s) => s.id === "subtitles"));
  assert.ok(r.plan.stages.some((s) => s.id === "localize-meta"));
});

test("unknown purpose or language is rejected with a reason", () => {
  assert.equal(buildPlan({ brief: "x y", format: "short", styleId: "kinetic-facts", purposeIds: ["nope"] }).ok, false);
  assert.equal(buildPlan({ brief: "x y", format: "short", styleId: "kinetic-facts", language: "xx" }).ok, false);
  assert.equal(buildPlan({ brief: "x y", format: "short", styleId: "kinetic-facts", subtitles: ["xx"] }).ok, false);
});

test("provenance v2: AI disclosure and likeness rules", async () => {
  const { aiDisclosureRequired, likenessIssues } = await import("./provenance.ts");
  assert.equal(aiDisclosureRequired({ sources: ["hermes"], realisticSynthetic: true }), true);
  assert.equal(aiDisclosureRequired({ sources: ["muse", "upload"], realisticSynthetic: true }), true);
  assert.equal(aiDisclosureRequired({ sources: ["hermes"], realisticSynthetic: false }), false);
  assert.equal(aiDisclosureRequired({ sources: ["upload", "licensed", "worker"], realisticSynthetic: true }), false);
  const rec = { title: "face", kind: "image" as const, source: "upload" as const, license: "own", originUrl: "x" };
  assert.equal(likenessIssues([rec]).length, 0);
  assert.equal(likenessIssues([{ ...rec, tags: ["person-likeness"] }]).length, 1);
  assert.equal(likenessIssues([{ ...rec, tags: ["brand-logo"], permissionNote: " " }]).length, 1);
  assert.equal(likenessIssues([{ ...rec, tags: ["brand-logo", "person-likeness"], permissionNote: "release 2025" }]).length, 0);
  assert.equal(provenanceIssues([{ ...rec, tags: ["person-likeness"] }], "publish").length, 0, "provenanceIssues is unchanged");
});
