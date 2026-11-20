/**
 * Provider names and per-shot provider needs. Pure leaf module (no imports), so both the director (storyboard) and
 * asset planning can use it without an import cycle. asset-plan.ts re-exports normalizeProvider.
 */

/** Lowercase slug so "Cloudflare AI" and "cloudflare-ai" are one provider. Empty or missing becomes "unknown". */
export function normalizeProvider(raw: string | null | undefined): string {
  const slug = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "unknown";
}

/**
 * Hermes image_gen plugins that front several backends with different terms (docs/research/05: the 9router plugin
 * walks canva, agnes, cloudflare, modelscope, sensenova, free ...). A plugin id is never the maker of a file.
 */
export const HERMES_IMAGE_PLUGINS: readonly string[] = ["9router"];

/**
 * What a storyboard shot may say it needs from the image backend. A small fixed set, so a model cannot invent
 * requirements the studio cannot explain to Hermes:
 * - reference-edit: keep a subject from a reference image (backends that accept one: agnes, sensenova-edit, qwen-edit).
 *   The studio does not hand Hermes a reference file yet, so this only steers the backend choice.
 * - text-layout: a designed card with legible words or typography (canva is template-based and suits this).
 * - photoreal: a photographic look rather than a flat illustration or a template.
 * - portrait-native: a true vertical frame from the backend itself (canva returns 1200x1200, which the render crops).
 */
export const SHOT_NEEDS = ["reference-edit", "text-layout", "photoreal", "portrait-native"] as const;
export type ShotNeed = (typeof SHOT_NEEDS)[number];

export function isShotNeed(v: unknown): v is ShotNeed {
  return typeof v === "string" && (SHOT_NEEDS as readonly string[]).includes(v);
}

/** Plain words for each need, as Hermes reads them in the image prompt. */
export const SHOT_NEED_TEXT: Record<ShotNeed, string> = {
  "reference-edit": "editing from a reference image to keep the same subject, so use a backend that accepts a reference image (for example agnes, sensenova-edit or qwen-edit)",
  "text-layout": "a designed layout with legible words or typography (a template backend such as canva suits this)",
  photoreal: "a photographic, realistic look rather than a flat illustration or a template",
  "portrait-native": "a true vertical frame made by the backend itself, not a square image (canva returns 1200x1200)",
};

/**
 * The 9router plugin's prompt tag per backend name (docs/research/05, "Steering, proven by call order"): "[canva]" on
 * the first line of the image_generate prompt puts that backend first and keeps the rest of the chain behind it.
 * Only measured tags are listed; any other name gets no tag.
 */
const PLUGIN_TAGS: Record<string, string> = {
  canva: "canva",
  agnes: "agnes",
  "agnes-edit": "agnes",
  modelscope: "modelscope",
  qwen: "modelscope",
  "qwen-edit": "modelscope",
  sensenova: "sensenova",
  "sensenova-edit": "sensenova",
  cloudflare: "cloudflare",
  "cloudflare-9router": "cloudflare",
  minimax: "minimax",
};

export function pluginTagFor(backend: string): string | null {
  return PLUGIN_TAGS[normalizeProvider(backend)] ?? null;
}

/** "unlisted-canva" and "canva" are the same backend for a preference or a refusal. */
export function bareProviderName(name: string): string {
  const raw = name.trim().toLowerCase();
  return normalizeProvider(raw.startsWith("unlisted-") ? raw.slice("unlisted-".length) : raw);
}
