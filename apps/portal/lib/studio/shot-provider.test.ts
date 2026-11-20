import { test } from "node:test";
import assert from "node:assert/strict";
import { imagePrompt, knownImageBackends, refusedIssue, refusedProviders, resolveHermesMaker, type ProviderTerms } from "./asset-plan.ts";
import { storyboardPrompt, validateStoryboard, workOrdersFromStoryboard, type DirectorContext } from "./director.ts";
import { parseOrderSpec } from "./production.ts";
import { stageSummary } from "./engine.ts";
import { recentlyFailing, RECENT_FAILURE_MS, type EndpointHealth } from "./endpoint-health.ts";
import { bareProviderName, isShotNeed, pluginTagFor, SHOT_NEEDS } from "./providers.ts";

const base = { beatRole: "body", seconds: 3, description: "A card with the title", imagePrompt: "A title card" };
const KNOWN = ["canva", "agnes", "qwen-edit"];

test("storyboard: a known provider and a known need are kept", () => {
  const r = validateStoryboard({ shots: [{ ...base, provider: "Canva", needs: "text-layout" }, { ...base, needs: "Reference-Edit" }] }, { knownProviders: KNOWN });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.shots[0].provider, "canva");
  assert.equal(r.value.shots[0].needs, "text-layout");
  assert.equal(r.value.shots[1].provider, undefined);
  assert.equal(r.value.shots[1].needs, "reference-edit");
  assert.equal(r.value.notes, undefined);
});

test("storyboard: unknown values are dropped with a note and never fail the storyboard", () => {
  const r = validateStoryboard(
    {
      shots: [
        { ...base, provider: "midjourney" },
        { ...base, needs: "anime" },
        { ...base, provider: "9router" },
        { ...base, provider: 7, needs: ["x"] },
        { ...base, provider: "unlisted-agnes" },
      ],
    },
    { knownProviders: KNOWN },
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(
    r.value.shots.map((s) => [s.provider, s.needs]),
    [[undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], ["agnes", undefined]],
  );
  const notes = r.value.notes ?? [];
  assert.equal(notes.length, 5);
  assert.match(notes[0], /Shot 1: provider "midjourney" is not among the backends Hermes reported \(canva, agnes, qwen-edit\)/);
  assert.match(notes[1], /Shot 2: needs "anime" is not one of reference-edit, text-layout, photoreal, portrait-native/);
  assert.match(notes[2], /Shot 3: provider "9router" is not an image backend/);
  assert.match(notes[3], /Shot 4: provider must be text/);
  assert.match(notes[4], /Shot 4: needs must be text/);
});

test("storyboard: with no reported backends a provider is dropped; without a check (stored) it is kept", () => {
  const none = validateStoryboard({ shots: [{ ...base, provider: "canva" }] }, { knownProviders: [] });
  assert.ok(none.ok);
  if (none.ok) {
    assert.equal(none.value.shots[0].provider, undefined);
    assert.match(none.value.notes?.[0] ?? "", /Hermes has reported no image backends yet/);
  }
  const stored = validateStoryboard({ shots: [{ ...base, provider: "canva", needs: "photoreal" }] });
  assert.ok(stored.ok);
  if (stored.ok) assert.deepEqual([stored.value.shots[0].provider, stored.value.shots[0].needs], ["canva", "photoreal"]);
  // Missing fields: the shot is exactly as before.
  const plain = validateStoryboard({ shots: [base] }, { knownProviders: KNOWN });
  assert.ok(plain.ok);
  if (plain.ok) assert.deepEqual(plain.value, { shots: [base] });
});

test("storyboardPrompt offers the optional fields and the reported backends as data", () => {
  const ctx: DirectorContext = { niche: "tales", plan: "", language: "en", format: "short", durationSec: 30 };
  const text = storyboardPrompt(ctx, "A script.", undefined, [], ["canva", "agnes"])[1].content;
  assert.match(text, /"provider"\?:string,"needs"\?:string/);
  assert.match(text, /reference-edit, text-layout, photoreal, portrait-native/);
  assert.match(text, /<<<DATA image backends you have reported\ncanva, agnes\n/);
  assert.doesNotMatch(storyboardPrompt(ctx, "A script.")[1].content, /DATA image backends/);
});

test("work orders carry the preference only when a shot has one", () => {
  const orders = workOrdersFromStoryboard([
    { beatRole: "hook", seconds: 2, description: "d", imagePrompt: "p", provider: "canva", needs: "text-layout" },
    { beatRole: "body", seconds: 3, description: "d", imagePrompt: "q" },
  ]);
  assert.deepEqual(orders[0].spec, { prompt: "p", seconds: 2, beatRole: "hook", provider: "canva", needs: "text-layout" });
  assert.deepEqual(orders[1].spec, { prompt: "q", seconds: 3, beatRole: "body" });
});

test("parseOrderSpec reads the new fields and keeps old rows unchanged", () => {
  assert.deepEqual(parseOrderSpec({ prompt: "a", seconds: 3, beatRole: "hook", note: "", provider: "Canva", needs: "portrait-native" }), {
    prompt: "a",
    seconds: 3,
    beatRole: "hook",
    note: "",
    provider: "canva",
    needs: "portrait-native",
  });
  // An old row: no provider, no needs, same spec as before.
  assert.deepEqual(parseOrderSpec({ prompt: "a", seconds: 3, beatRole: "hook" }), { prompt: "a", seconds: 3, beatRole: "hook", note: "" });
  // Junk is ignored, not fatal.
  const junk = parseOrderSpec({ prompt: "a", provider: 5, needs: "anime" });
  assert.equal(junk.provider, undefined);
  assert.equal(junk.needs, undefined);
  assert.equal(parseOrderSpec({ provider: "  " }).provider, undefined);
});

const req = { prompt: "a title card", beatRole: "hook" as const, format: "short" as const, shotRef: "shot-01" };

test("imagePrompt puts the shot's backend first, above the global order", () => {
  const text = imagePrompt({ ...req, providerOrder: ["cloudflare", "agnes"], shotProvider: "canva", shotNeeds: "text-layout" })[1].content;
  assert.match(text, /For this shot use canva first\. If it fails, continue your chain as usual, and report in source which backend really made the image\./);
  assert.match(text, /start the prompt you give image_generate with the tag \[canva\]/);
  assert.match(text, /Never use the \[canva:\] form/);
  assert.match(text, /This shot needs a designed layout with legible words/);
  assert.match(text, /For the rest of the chain, preferred order if you have them: cloudflare, agnes\. The choice for this shot above comes first\./);
  assert.ok(text.indexOf("For this shot use canva first") < text.indexOf("For the rest of the chain"));
  // Without a preference the old wording stays.
  const plain = imagePrompt({ ...req, providerOrder: ["cloudflare"] })[1].content;
  assert.match(plain, /Preferred provider order, if you have them: cloudflare\. This is a preference, not a rule\./);
  assert.doesNotMatch(plain, /For this shot use/);
  assert.doesNotMatch(plain, /Do not use these backends/);
  // A need alone asks Hermes to pick a capable backend; a backend without a known tag gets no tag line.
  const need = imagePrompt({ ...req, shotNeeds: "reference-edit" })[1].content;
  assert.match(need, /This shot needs editing from a reference image.*Try a backend in your chain that can do this first/);
  assert.doesNotMatch(imagePrompt({ ...req, shotProvider: "free-fallback" })[1].content, /with the tag/);
});

test("imagePrompt tells Hermes not to use backends the owner refused, and the refusal beats the storyboard", () => {
  const text = imagePrompt({
    ...req,
    providerOrder: ["canva", "agnes"],
    shotProvider: "canva",
    avoidProviders: ["unlisted-canva", "modelscope"],
    failingProviders: ["cloudflare-9router", "canva"],
  })[1].content;
  assert.match(text, /Do not use these backends: canva, modelscope\. The owner marked them not for commercial use, so an image from them is refused\./);
  assert.doesNotMatch(text, /For this shot use canva/);
  assert.doesNotMatch(text, /tag \[canva\]/);
  assert.match(text, /Preferred provider order, if you have them: agnes\./);
  assert.match(text, /These backends failed recently, skip them if you can: cloudflare-9router\./);
});

const terms: ProviderTerms[] = [
  { name: "unlisted-canva", kind: "image", commercialOk: "no" },
  { name: "agnes", kind: "image", commercialOk: "unknown" },
  { name: "unlisted-9router", kind: "image", commercialOk: "no" },
  { name: "edge", kind: "tts", commercialOk: "no" },
];

test("refusedProviders lists owner-no backends by their bare name and skips plugin rows", () => {
  assert.deepEqual(refusedProviders(terms, "image"), ["canva"]);
  assert.deepEqual(refusedProviders(terms, "tts"), ["edge"]);
  assert.deepEqual(refusedProviders([], "image"), []);
});

test("refusedIssue rejects an owner-no backend, under either name, and allows unknown", () => {
  const canva = resolveHermesMaker({ provider: "9router", backend: "canva" }, ["canva"]);
  assert.equal(canva.provider, "canva");
  // The owner said no to unlisted-canva; the same backend stored bare is still refused.
  assert.match(refusedIssue(canva, "image", terms) ?? "", /^canva cannot be used: Settings says unlisted-canva is not cleared for commercial use\./);
  assert.ok(refusedIssue(resolveHermesMaker({ provider: "9router", backend: "canva" }, []), "image", terms));
  assert.equal(refusedIssue(resolveHermesMaker({ provider: "9router", backend: "agnes" }, []), "image", terms), null);
  assert.equal(refusedIssue(resolveHermesMaker({ provider: "9router", backend: "agnes" }, ["agnes"]), "image", terms), null);
  // A reply without a backend lands on the plugin row, which the owner refused here.
  assert.ok(refusedIssue(resolveHermesMaker({ provider: "9router" }, []), "image", terms));
  // Kinds do not mix.
  assert.equal(refusedIssue({ provider: "unlisted-edge", backend: "edge", plugin: "capcut" }, "image", terms), null);
});

test("knownImageBackends merges the scan and Hermes's chain reports, without plugins", () => {
  assert.deepEqual(knownImageBackends(["9router", "Agnes", "canva", "qwen-edit"], ["canva", "unlisted-9router", "cloudflare-9router", ""]), [
    "agnes",
    "canva",
    "qwen-edit",
    "cloudflare-9router",
  ]);
});

function health(model: string, over: Partial<EndpointHealth>): EndpointHealth {
  return { endpoint: "hermes", model, kind: "image", lastSuccessAt: null, lastFailureAt: null, failureClass: null, lastError: "", quarantinedAt: null, successes: 0, failures: 0, ...over };
}

test("recentlyFailing names Hermes backends whose last call failed recently", () => {
  const now = 10 * RECENT_FAILURE_MS;
  const list = [
    health("cloudflare-9router", { lastFailureAt: now - 60_000, failureClass: "busy" }),
    health("canva", { lastFailureAt: now - 120_000, lastSuccessAt: now - 60_000 }),
    health("agnes", { lastFailureAt: now - 2 * RECENT_FAILURE_MS }),
    health("modelscope", { quarantinedAt: now - 1000 }),
    health("unlisted-9router", { lastFailureAt: now - 1000 }),
    health("x", { endpoint: "9router", lastFailureAt: now - 1000 }),
  ];
  assert.deepEqual(recentlyFailing(list, "hermes", "image", now), ["cloudflare-9router", "modelscope"]);
});

test("needs, tags and bare names", () => {
  assert.deepEqual([...SHOT_NEEDS], ["reference-edit", "text-layout", "photoreal", "portrait-native"]);
  assert.equal(isShotNeed("photoreal"), true);
  assert.equal(isShotNeed("Photoreal"), false);
  assert.equal(pluginTagFor("cloudflare-9router"), "cloudflare");
  assert.equal(pluginTagFor("qwen-edit"), "modelscope");
  assert.equal(pluginTagFor("free-fallback"), null);
  assert.equal(bareProviderName("Unlisted-Canva"), "canva");
});

test("stageSummary mentions preferences and dropped values", () => {
  const s = stageSummary("storyboard", { shots: [{ ...base, provider: "canva" }, base], notes: ['Shot 2: needs "anime" is not one of ...'] });
  assert.match(s, /^2 shots, about 6 seconds\. 1 with an image backend preference\. 1 preference dropped: Shot 2/);
  assert.equal(stageSummary("storyboard", { shots: [base] }), "1 shot, about 3 seconds");
});
