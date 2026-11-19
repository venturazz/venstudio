import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCapabilities,
  capabilitiesPrompt,
  classifyRouterModels,
  classifySkill,
  emptyRouterLists,
  missingCapabilityMessage,
  parseRouterList,
  parseVoiceList,
  resolveStage,
  scanStateOf,
  skillHintsFor,
  stageStatus,
  validateHermesCapabilities,
  MAX_SKILLS,
  type CapabilitySnapshot,
  type HermesScan,
  type RouterScan,
  type RouterModel,
} from "./capabilities.ts";

const OK = { configured: true, ok: true };
const model = (id: string, ownedBy = "x", kind = ""): RouterModel => ({ id, ownedBy, kind });

function hermes(over: Partial<HermesScan> = {}): HermesScan {
  return { status: OK, skills: [], imageProviders: [], voiceEngines: [], notes: "", ...over };
}
function router(lists: Partial<RouterScan["lists"]> = {}, status = OK): RouterScan {
  return { status, probes: {}, lists: { ...emptyRouterLists(), ...lists } };
}
function snap(h: HermesScan | null, r: RouterScan | null): CapabilitySnapshot {
  return { scannedAt: "2026-01-01T00:00:00Z", hermes: h, router: r, error: null };
}

test("classifySkill uses keywords on invented skills", () => {
  assert.deepEqual(classifySkill({ name: "edge-voice", description: "Neural speech" }), ["voice"]);
  assert.ok(classifySkill({ name: "capcut-editor", description: "Edit a timeline" }).includes("editing"));
  assert.ok(classifySkill({ name: "srt-maker", description: "Writes subtitles" }).includes("subtitles"));
  assert.ok(classifySkill({ name: "flux-image", description: "Makes pictures" }).includes("image"));
  assert.deepEqual(classifySkill({ name: "github", description: "Pull requests" }), []);
});

test("Hermes-assigned stages beat keywords, unknown ids are ignored", () => {
  assert.deepEqual(classifySkill({ name: "edge-voice", description: "speech", stages: ["music"] }), ["music"]);
  assert.deepEqual(classifySkill({ name: "edge-voice", description: "speech", stages: ["bogus"] }), ["voice"]);
});

test("validateHermesCapabilities accepts a good reply and trims it", () => {
  const v = validateHermesCapabilities({
    skills: [{ name: " kokoro-tts ", description: "Narrates\n text", category: "audio", stages: ["voice", "nope"] }],
    imageProviders: ["cloudflare", "cloudflare", "agnes"],
    voiceEngines: [{ name: "capcut" }],
    notes: "ok",
  });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.value.skills[0].name, "kokoro-tts");
  assert.equal(v.value.skills[0].description, "Narrates text");
  assert.deepEqual(v.value.skills[0].stages, ["voice"]);
  assert.deepEqual(v.value.imageProviders, ["cloudflare", "agnes"]);
  assert.deepEqual(v.value.voiceEngines, ["capcut"]);
});

test("validateHermesCapabilities rejects non-objects and caps lists", () => {
  assert.equal(validateHermesCapabilities("hi").ok, false);
  assert.equal(validateHermesCapabilities({ skills: "x" }).ok, false);
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `skill-${i}`, description: "", stages: [] }));
  const v = validateHermesCapabilities({ skills: many, imageProviders: many.map((s) => s.name) });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.value.skills.length, MAX_SKILLS);
  assert.equal(v.value.imageProviders.length, 20);
});

test("validateHermesCapabilities drops names that are not plain names", () => {
  const v = validateHermesCapabilities({ skills: [{ name: "$(rm -rf /)" }, { name: "ok-skill" }] });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.value.skills.map((s) => s.name), ["ok-skill"]);
});

test("capabilitiesPrompt starts with the stage marker and lists every stage", () => {
  const p = capabilitiesPrompt();
  assert.ok(p[1].content.startsWith("VENSTUDIO_STAGE: capabilities"));
  assert.ok(p[1].content.includes("video-clips"));
});

test("parseRouterList reads both shapes and the kind field", () => {
  const a = parseRouterList({ object: "list", data: [{ id: "m1", owned_by: "combo" }, { id: "v1", kind: "video" }, { id: "m1" }] });
  assert.deepEqual(a, [
    { id: "m1", ownedBy: "combo", kind: "" },
    { id: "v1", ownedBy: "", kind: "video" },
  ]);
  assert.deepEqual(parseRouterList([{ id: "x" }, "y"]).map((m) => m.id), ["x", "y"]);
  assert.deepEqual(parseRouterList(null), []);
});

test("parseVoiceList handles arrays and wrappers", () => {
  assert.deepEqual(parseVoiceList(["a", { id: "b" }, { name: "c" }]), ["a", "b", "c"]);
  assert.deepEqual(parseVoiceList({ voices: ["z"] }), ["z"]);
});

test("classifyRouterModels maps each list to a stage and pulls video out of chat", () => {
  const caps = classifyRouterModels({
    ...emptyRouterLists(),
    chat: [model("combo-a", "combo"), model("clip-gen", "p", "video")],
    image: [model("img-1")],
    tts: [model("tts-1")],
    web: [model("search-1", "p", "webSearch")],
  });
  const by = (stage: string) => caps.filter((c) => c.stage === stage).map((c) => c.id);
  assert.deepEqual(by("image"), ["img-1"]);
  assert.deepEqual(by("voice"), ["tts-1"]);
  assert.ok(by("research").includes("search-1"));
  assert.deepEqual(by("video-clips"), ["clip-gen"]);
  assert.ok(by("script").includes("combo-a"));
  assert.ok(!by("script").includes("clip-gen"));
  assert.ok(caps.find((c) => c.id === "combo-a")?.detail.startsWith("combo"));
});

test("voice list is used when 9router has no TTS model", () => {
  const caps = classifyRouterModels({ ...emptyRouterLists(), voices: ["af_heart", "am_adam"] });
  assert.equal(caps.filter((c) => c.stage === "voice").length, 1);
});

test("resolveStage puts 9router first for voice and Hermes first for images", () => {
  const s = snap(
    hermes({ voiceEngines: ["capcut"], imageProviders: ["cloudflare"] }),
    router({ tts: [model("tts-1")], image: [model("img-1")] }),
  );
  const voice = resolveStage("voice", s);
  const image = resolveStage("image", s);
  assert.ok(voice.ok && image.ok);
  if (!voice.ok || !image.ok) return;
  assert.equal(voice.executors[0].via, "9router");
  assert.equal(image.executors[0].via, "hermes");
  assert.equal(stageStatus("voice", s), "ready");
});

test("missing messages differ for not scanned, unreachable and none listed", () => {
  const unscanned = resolveStage("voice", null);
  assert.ok(!unscanned.ok);
  const none = resolveStage("voice", snap(hermes(), router()));
  const down = resolveStage("voice", snap(hermes({ status: { configured: true, ok: false, error: "x" } }), router({}, { configured: true, ok: false })));
  const half = resolveStage("voice", snap(hermes({ status: { configured: true, ok: false } }), router()));
  assert.ok(!none.ok && !down.ok && !half.ok && !unscanned.ok);
  if (none.ok || down.ok || half.ok || unscanned.ok) return;
  assert.ok(unscanned.message.includes("not scanned"));
  assert.ok(none.message.includes("Hermes lists no") && none.message.includes("9router lists no TTS model"));
  assert.ok(down.message.includes("could not reach"));
  assert.ok(half.message.includes("Hermes could not be reached"));
  assert.equal(new Set([unscanned.message, none.message, down.message, half.message]).size, 4);
  assert.ok(none.message.startsWith("No voice found."));
});

test("builtIn stages are ready without discoveries and upload is later", () => {
  assert.equal(stageStatus("editing", null), "ready");
  assert.equal(stageStatus("upload", null), "later");
  assert.equal(stageStatus("music", null), "missing");
  const s = snap(hermes({ skills: [{ name: "song-maker", description: "music", category: "audio", stages: [], listedByApi: true }] }), router());
  assert.equal(stageStatus("music", s), "found");
  assert.deepEqual(skillHintsFor("music", s), ["song-maker"]);
});

test("a skill only Hermes claimed is unverified and never becomes a prompt hint", () => {
  const s = snap(
    hermes({
      skills: [
        { name: "song-maker", description: "music", category: "audio", stages: [], listedByApi: true },
        { name: "invented-singer", description: "music", category: "audio", stages: [], listedByApi: false },
      ],
      voiceEngines: ["capcut"],
    }),
    router(),
  );
  const caps = buildCapabilities(s);
  assert.equal(caps.find((c) => c.id === "song-maker")?.verified, true);
  assert.equal(caps.find((c) => c.id === "invented-singer")?.verified, false);
  assert.equal(caps.find((c) => c.id === "capcut")?.verified, false);
  assert.deepEqual(skillHintsFor("music", s), ["song-maker"]);
});

test("scanStateOf separates sources", () => {
  assert.equal(scanStateOf(null).scanned, false);
  const st = scanStateOf(snap(hermes({ status: { configured: false, ok: false } }), router()));
  assert.equal(st.hermes, "not-configured");
  assert.equal(st.router, "ok");
  assert.ok(missingCapabilityMessage("image", st).includes("Hermes could not be reached"));
  assert.deepEqual(buildCapabilities(null), []);
});
