/**
 * A fixed image-sequence sample for image-sequence-golden.test.ts: the director prompts, the work orders, an image
 * prompt and a storyboard-based Hermes render request, built from constant input. Pure. It uses only builders that
 * existed before workflows, so the same file run against the code before workflows wrote the golden.
 */
import { classifyPrompt, ideaPrompt, researchPrompt, scriptPrompt, storyboardPrompt, workOrdersFromStoryboard, type DirectorContext, type Shot } from "./director.ts";
import { imagePrompt } from "./asset-plan.ts";
import { hermesRenderMessages } from "./hermes-render.ts";
import { seedTemplates } from "./templates.ts";

export function imageSequenceSample(): Record<string, unknown> {
  const template = seedTemplates().find((t) => t.styleId === "explainer-flat-vector") ?? seedTemplates()[0];
  const ctx: DirectorContext = {
    niche: "How everyday things are made",
    plan: "Two short explainers a week about materials and tools.",
    category: "education",
    language: "en",
    format: "short",
    durationSec: 45,
    themeId: "science",
    template,
    pastTitles: ["Why glass is clear"],
    topicHint: "How a blade is forged",
    purposes: ["educate"],
    subtitles: ["id"],
    wordsPerMinute: 150,
  };
  const idea = { title: "How a blade is forged", hook: "Iron is everywhere, and almost none of it is useful yet.", angle: "Follow one bar from ore to edge" };
  const notes = [
    { claim: "Forging steel is heated to about 1200 degrees Celsius", sourceUrl: "https://example.org/forging", sourced: true, summary: "Typical hot forging range is 1100 to 1250 C." },
    { claim: "Quenching hardens steel", sourceUrl: "", sourced: false, summary: "Rapid cooling traps carbon in the iron lattice." },
  ];
  const script = "Iron is everywhere, and almost none of it is useful yet. The furnace reaches twelve hundred degrees. The hammer draws the bar out. Quenching locks the grain. That is how a blade is born.";
  const shots: Shot[] = [
    { beatRole: "hook", seconds: 3, description: "Iron is everywhere", imagePrompt: "a foundry floor, sparks in the air, no people", provider: "agnes", needs: "text-layout" },
    { beatRole: "body", seconds: 5, description: "The furnace", imagePrompt: "a glowing ingot inside a furnace mouth", onScreen: { elements: [{ kind: "counter", text: "degrees", value: 1200 }], tokens: ["counter"] } },
    { beatRole: "cta", seconds: 4, description: "A blade is born", imagePrompt: "a finished blade on a wooden bench" },
  ];
  const orders = workOrdersFromStoryboard(shots);
  return {
    idea: ideaPrompt(ctx, "Make it about knives"),
    research: researchPrompt(ctx, idea, undefined, ["web-research"]),
    script: scriptPrompt(ctx, idea, notes, undefined, ["copywriter"]),
    storyboard: storyboardPrompt(ctx, script, undefined, ["pic-forge"], ["agnes", "canva"]),
    classify: classifyPrompt("The pictures are too dark", "storyboard"),
    workOrders: orders,
    image: imagePrompt({ prompt: orders[0].spec.prompt, beatRole: "hook", format: "short", shotRef: orders[0].shotRef, providerOrder: ["canva"], shotProvider: "agnes", shotNeeds: "text-layout", mediaOrigin: "http://hermes-files:8000/img" }),
    hermesRender: hermesRenderMessages({
      topic: idea.title,
      format: "short",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSec: 12,
      shots: orders.map((o, i) => ({ shotRef: o.shotRef, seconds: shots[i].seconds, beatRole: shots[i].beatRole, description: shots[i].description, imageUrl: i === 2 ? null : `http://hermes-files:8000/img/${o.shotRef}.png` })),
      scenePlan: { version: 1 },
      narration: { url: "http://hermes-files:8000/audio/n.wav", seconds: 12, tempo: 1 },
      captions: ["Iron is everywhere.", "That is how a blade is born."],
      packId: "hermes-research-explainer",
      packVersion: "0.1.1",
      contract: { pacing: { shotSeconds: [2, 6] } },
      skill: { name: "/zach-d-films", aliases: ["/zach-3d-films"], mode: "project", input: "Use the run's narration.", output: "A reel." },
      clipBase: "http://hermes-files:8000/clip",
    }),
  };
}
