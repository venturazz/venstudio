import type { ProductionPlan } from "./planner.ts";
import { VIDEO_FORMATS } from "./catalog.ts";

export interface PreviewSpec {
  /** Text for each card, shown in turn. */
  cards: string[];
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

/**
 * What a test render shows: the plan's own choices as text cards, so a render proves the path works
 * (plan -> job -> worker -> video -> job page) without Hermes, 9router or a finished script.
 */
export function previewSpec(plan: ProductionPlan, brief: string): PreviewSpec {
  const format = VIDEO_FORMATS[plan.format];
  const briefLine = brief.replace(/\s+/g, " ").trim().slice(0, 140);
  const themeLine = [plan.themeLabel, ...plan.purposes.map((p) => p.label)].filter(Boolean).join(" · ");
  const subtitleLine = plan.subtitles.length ? ` · Subtitles: ${plan.subtitles.map((s) => s.label).join(", ")}` : "";
  return {
    cards: [
      `${plan.styleLabel}\n${briefLine}`,
      themeLine || "No theme or purpose set",
      `Narration: ${plan.language.label}${subtitleLine}`,
      `Test render at ${format.width}×${format.height}: placeholder cards and a test tone, not the final video`,
    ],
    durationSec: 20,
    width: format.width,
    height: format.height,
    fps: 30,
  };
}
