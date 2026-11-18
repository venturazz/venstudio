/** Video format families from docs/research/01-video-automation-research.md. */
export const FORMATS = [
  { id: "animated-story", label: "Animated story shorts", pipeline: "Remotion three.js or 2.5D parallax" },
  { id: "character-series", label: "2D character series", pipeline: "Sprite puppet + Rhubarb lip sync" },
  { id: "narrated-doc", label: "Narrated documentary / mystery", pipeline: "AI stills + parallax + ffmpeg" },
  { id: "explainer", label: "Explainer (science, money, how-to)", pipeline: "Manim / Motion Canvas" },
  { id: "data-ranking", label: "Data / ranking / comparison", pipeline: "Remotion 2D charts" },
  { id: "pixel-game", label: "Pixel-art / game-style stories", pipeline: "Godot 2D" },
  { id: "other", label: "Other / undecided", pipeline: "" },
] as const;

export function formatLabel(id: string) {
  return FORMATS.find((f) => f.id === id)?.label ?? (id || "Undecided");
}
