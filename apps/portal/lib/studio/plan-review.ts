/**
 * What the Review card shows for the plan stages of workflows without pictures (recipes.ts), pure: the scene spec as
 * one line per scene (elements, numbers and the research note each cites, motion, caption), the skill brief as one
 * line per shot plus its project text. An image-sequence storyboard card is unchanged (it carries no `plan`).
 */
import type { PlanKind, ReviewPayload } from "./review.ts";
import { readSceneSpec, sceneSpecLines } from "./scene-spec.ts";
import { readSkillBrief, skillBriefLines } from "./skill-brief.ts";
import { htmlDesignLines, readHtmlDesign } from "./html-design.ts";

/** What comes after the scene spec: said on the card, so the owner knows what is and is not shown. */
export const SCENE_SPEC_PREVIEW_NOTE =
  "This card shows the spec as text. Still frames of the page, drawn with this run's props, come next, before the voice and the render (when a worker reports preview-frames).";
/** A scene-spec run started before previews has no preview stage: its card says what it always said. */
export const SCENE_SPEC_NO_PREVIEW_NOTE =
  "This run started before still previews, so this card shows the spec as text and there are no stills before the render. The final video's card shows the real render.";
/** What the html-design card is: research only, checked before anything ran, stills next. */
export const HTML_DESIGN_NOTE =
  "Research only: Hermes wrote this page. It was checked before anything ran (no network, frames, workers or eval; fonts and files only from the pack and the run). Still frames of it come next, before the voice and the render; the page is never published.";

export function planReview(stage: string, result: unknown, stages?: readonly string[]): Pick<ReviewPayload, "plan"> {
  if (stage === "scene-spec") {
    const spec = readSceneSpec(result);
    const note = stages && !stages.includes("preview") ? SCENE_SPEC_NO_PREVIEW_NOTE : SCENE_SPEC_PREVIEW_NOTE;
    return spec ? { plan: { kind: "scene-spec", lines: sceneSpecLines(spec), note } } : {};
  }
  if (stage === "html-design") {
    const design = readHtmlDesign(result);
    return design ? { plan: { kind: "html-design", lines: htmlDesignLines(design), text: design.note, note: HTML_DESIGN_NOTE } } : {};
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
  const kinds: readonly PlanKind[] = ["scene-spec", "skill-brief", "html-design"];
  const kind = kinds.find((k) => k === p.kind);
  if (!kind) return undefined;
  const lines = Array.isArray(p.lines) ? p.lines.filter((l): l is string => typeof l === "string").slice(0, 600).map((l) => l.slice(0, 2000)) : [];
  return {
    kind,
    lines,
    ...(typeof p.text === "string" && p.text ? { text: p.text.slice(0, 6000) } : {}),
    ...(typeof p.note === "string" && p.note ? { note: p.note.slice(0, 600) } : {}),
  };
}
