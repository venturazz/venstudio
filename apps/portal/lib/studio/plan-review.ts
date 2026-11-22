/**
 * What the Review card shows for the plan stages of workflows without pictures (recipes.ts), pure: the scene spec as
 * one line per scene (elements, numbers and the research note each cites, motion, caption), the skill brief as one
 * line per shot plus its project text. An image-sequence storyboard card is unchanged (it carries no `plan`).
 */
import type { ReviewPayload } from "./review.ts";
import { readSceneSpec, sceneSpecLines } from "./scene-spec.ts";
import { readSkillBrief, skillBriefLines } from "./skill-brief.ts";

/** Why the scene-spec card has no stills yet: said on the card, so the owner knows what is and is not shown. */
export const SCENE_SPEC_PREVIEW_NOTE =
  "No still preview before the render: the worker has no stills mode for html-capture pages yet, so this card shows the spec as text. The final video's card shows the real render.";

export function planReview(stage: string, result: unknown): Pick<ReviewPayload, "plan"> {
  if (stage === "scene-spec") {
    const spec = readSceneSpec(result);
    return spec ? { plan: { kind: "scene-spec", lines: sceneSpecLines(spec), note: SCENE_SPEC_PREVIEW_NOTE } } : {};
  }
  if (stage === "skill-brief") {
    const brief = readSkillBrief(result);
    if (!brief) return {};
    const who = brief.skill ? `For ${brief.skill}` : "For Hermes's own tools";
    const voice = brief.voice === "skill" ? "the skill records its own voice from the script" : "the run's narration is the audio";
    return {
      plan: {
        kind: "skill-brief",
        lines: skillBriefLines(brief),
        ...(brief.text ? { text: brief.text } : {}),
        note: `${who}, ${brief.format === "json" ? "one spec per shot" : "a project brief"}; ${voice}. No pictures are made: the skill draws every shot.`,
      },
    };
  }
  return {};
}

/** Reads a stored card's `plan` back (reviews.ts), keeping only plain text within limits. */
export function parsePlanPayload(raw: unknown): ReviewPayload["plan"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (p.kind !== "scene-spec" && p.kind !== "skill-brief") return undefined;
  const lines = Array.isArray(p.lines) ? p.lines.filter((l): l is string => typeof l === "string").slice(0, 600).map((l) => l.slice(0, 2000)) : [];
  return {
    kind: p.kind,
    lines,
    ...(typeof p.text === "string" && p.text ? { text: p.text.slice(0, 6000) } : {}),
    ...(typeof p.note === "string" && p.note ? { note: p.note.slice(0, 600) } : {}),
  };
}
