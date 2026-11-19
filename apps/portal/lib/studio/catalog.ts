/**
 * Video style catalog: formats, engines (with Muse placement), themes and styles.
 * Pure data with no server imports, so the planner, the UI and the tests share one source.
 * Research and sources: docs/research/03-production-styles-and-muse-capabilities.md
 */

export type Format = "short" | "long";
export type Workflow = "original" | "copycat-structure";
export type Family =
  | "explainer"
  | "documentary"
  | "narrative"
  | "animation-2d"
  | "animation-2.5d"
  | "animation-3d"
  | "motion-graphics"
  | "game-style"
  | "data-list"
  | "ambient";
export type RenderTier = "light" | "medium" | "heavy";
/** Where the engine can run: muse-ok, muse-slow (possible, long CPU renders), muse-test (verify first), gpu-preferred, external. */
export type MusePlacement = "muse-ok" | "muse-slow" | "muse-test" | "gpu-preferred" | "external";
export type Executor = "hermes" | "9router" | "worker" | "human" | "provider";
export type AssetKind =
  | "video"
  | "reference-video"
  | "image"
  | "audio"
  | "font"
  | "sprite-sheet"
  | "model-3d"
  | "script"
  | "other";
export type AssetSource = "upload" | "hermes" | "muse" | "worker" | "licensed" | "generated";

export const ASSET_KINDS = [
  "video",
  "reference-video",
  "image",
  "audio",
  "font",
  "sprite-sheet",
  "model-3d",
  "script",
  "other",
] as const satisfies readonly AssetKind[];

export const ASSET_SOURCES = ["upload", "hermes", "muse", "worker", "licensed", "generated"] as const satisfies readonly AssetSource[];

export const FAMILY_LABELS: Record<Family, string> = {
  explainer: "Explainer",
  documentary: "Documentary",
  narrative: "Story",
  "animation-2d": "2D animation",
  "animation-2.5d": "2.5D animation",
  "animation-3d": "3D animation",
  "motion-graphics": "Motion graphics",
  "game-style": "Game style",
  "data-list": "Data and lists",
  ambient: "Ambient",
};

export const VIDEO_FORMATS: Record<Format, { label: string; width: number; height: number; fps: number; durationSec: [number, number] }> = {
  short: { label: "Short (vertical 9:16)", width: 1080, height: 1920, fps: 30, durationSec: [15, 60] },
  long: { label: "Long video (16:9)", width: 1920, height: 1080, fps: 30, durationSec: [480, 1200] },
};

export const WORKFLOWS: Record<Workflow, { label: string; description: string }> = {
  original: { label: "Original", description: "Everything is written and made from your brief." },
  "copycat-structure": {
    label: "Copy-cat (structure only)",
    description: "Learns the pacing and shot structure of a reference video. Script, footage, characters and music stay your own.",
  },
};

export interface Engine {
  id: string;
  label: string;
  /** Worker capability that runs it, or "provider" / "blender" when no worker handles it yet. */
  capability: string;
  tier: RenderTier;
  muse: MusePlacement;
  note: string;
}

export const ENGINES: Record<string, Engine> = {
  "ffmpeg-stills": {
    id: "ffmpeg-stills",
    label: "Stills with camera moves (ffmpeg)",
    capability: "ffmpeg",
    tier: "light",
    muse: "muse-ok",
    note: "Cheap to render. Only the smoke test runs today; the full still-render pipeline is the next build.",
  },
  "remotion-2d": {
    id: "remotion-2d",
    label: "Motion graphics and kinetic type (Remotion)",
    capability: "remotion-2d",
    tier: "light",
    muse: "muse-ok",
    note: "Renders frames in headless Chrome on the CPU. Chrome Headless Shell is the faster CPU option, per Remotion's docs.",
  },
  "sprite-rig": {
    id: "sprite-rig",
    label: "Sprite characters with lip sync (Remotion + Rhubarb)",
    capability: "remotion-2d",
    tier: "medium",
    muse: "muse-ok",
    note: "Rhubarb Lip Sync turns the voice track into mouth timings. Its binary must be installed on the worker (unverified on Muse).",
  },
  manim: {
    id: "manim",
    label: "Math and diagram animation (Manim)",
    capability: "manim",
    tier: "medium",
    muse: "muse-ok",
    note: "CPU rendering. Formulas need LaTeX on the worker.",
  },
  "godot-2d": {
    id: "godot-2d",
    label: "Godot 2D scenes (Movie Maker)",
    capability: "godot",
    tier: "medium",
    muse: "muse-test",
    note: "Needs a virtual display with software OpenGL. Movie Maker output matches on slow hardware; it is only slower.",
  },
  "remotion-3d": {
    id: "remotion-3d",
    label: "Stylized 3D (three.js in Remotion)",
    capability: "remotion-3d",
    tier: "heavy",
    muse: "muse-slow",
    note: "Without a GPU Remotion uses a software WebGL path that is slow. Time a 10-second test on Muse before planning a series.",
  },
  "godot-3d": {
    id: "godot-3d",
    label: "Godot 3D scenes",
    capability: "godot",
    tier: "heavy",
    muse: "gpu-preferred",
    note: "3D scenes on software rendering are slow. Use a GPU worker for series.",
  },
  "blender-cycles": {
    id: "blender-cycles",
    label: "Full 3D (Blender Cycles)",
    capability: "blender",
    tier: "heavy",
    muse: "muse-slow",
    note: "CPU path tracing on 2 cores is very slow. Muse can run it as a long batch with resume; a GPU worker is much faster.",
  },
  "provider-video": {
    id: "provider-video",
    label: "AI video clips from a provider",
    capability: "provider",
    tier: "light",
    muse: "external",
    note: "Generation happens at the provider. The studio stores and joins the clips.",
  },
};

export interface Theme {
  id: string;
  label: string;
  keywords: string[];
  /** Shown as warnings whenever the theme is chosen. */
  policy: string[];
}

export const THEMES: Theme[] = [
  { id: "history", label: "History", keywords: ["history", "historical", "ancient", "empire", "war", "medieval", "civilization", "century", "dynasty", "kingdom"], policy: ["Cite sources in the description and check dates against a primary source."] },
  { id: "science", label: "Science and nature", keywords: ["science", "biology", "physics", "nature", "animals", "evolution", "cell", "facts", "ocean"], policy: ["Check each claim against a primary source before publishing."] },
  { id: "space", label: "Space and astronomy", keywords: ["space", "astronomy", "planet", "galaxy", "moon", "mars", "universe", "black hole", "telescope"], policy: ["Check each image's usage notes; public-domain agency images still need attribution where asked."] },
  { id: "finance", label: "Finance and economy", keywords: ["money", "finance", "economy", "stock", "inflation", "budget", "invest", "bank", "debt", "salary"], policy: ["No investment advice. Add a disclaimer and avoid promised returns."] },
  { id: "mystery", label: "Mystery and unsolved", keywords: ["mystery", "unsolved", "unexplained", "conspiracy", "disappearance", "clue", "secret"], policy: ["Don't name private people in crime stories, and use no real crime footage.", "Label speculation clearly as speculation."] },
  { id: "horror", label: "Horror and ghost stories", keywords: ["horror", "scary", "creepy", "ghost", "haunted", "nightmare", "monster"], policy: ["Original fiction only. Don't tie stories to real victims or real places of tragedy."] },
  { id: "myth", label: "Myth and folklore", keywords: ["myth", "folklore", "legend", "mythology", "fairy tale", "gods", "fable"], policy: ["Public-domain myths are fine. Retellings must use original wording."] },
  { id: "kids", label: "Kids and bedtime", keywords: ["kids", "children", "bedtime", "lullaby", "nursery", "cartoon"], policy: ["Set Made for Kids in YouTube Studio, and check what that setting limits.", "No personal data collection and no comments aimed at children."] },
  { id: "travel", label: "Travel and places", keywords: ["travel", "city", "places", "tour", "destination", "landmark", "country", "journey"], policy: ["Use your own photos or images with recorded licences. Avoid trademarked buildings and logos."] },
  { id: "tech", label: "Tech and gadgets", keywords: ["tech", "technology", "gadget", "software", "device", "app", "ai"], policy: ["Don't reuse press images without permission."] },
  { id: "motivation", label: "Motivation", keywords: ["motivation", "mindset", "discipline", "success", "inspire", "habits", "quote"], policy: ["Quotes need attribution or a public-domain source. Write the rest in your own words."] },
  { id: "product", label: "Product reviews", keywords: ["review", "product", "unboxing", "gadget", "tested", "buy", "compare"], policy: ["Disclose paid partnerships and affiliate links.", "Use only your own photos and tests."] },
  { id: "relax", label: "Relaxation and ambience", keywords: ["relax", "ambient", "sleep", "rain", "calm", "lofi", "study", "focus"], policy: ["Music is the main Content ID risk: use self-composed or licensed tracks only."] },
  { id: "news", label: "News recap", keywords: ["news", "recap", "update", "weekly", "breaking", "roundup"], policy: ["Use commentary and original graphics. Don't reuse news clips or photos."] },
];

export const THEME_BY_ID: Record<string, Theme> = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export interface Style {
  id: string;
  label: string;
  family: Family;
  description: string;
  formats: Format[];
  /** Key into ENGINES. */
  engine: string;
  narration: boolean;
  /** Typical shot length, used to size the storyboard. */
  shotSeconds: [number, number];
  /** Themes this style suits; used to rank suggestions. */
  themes: string[];
  /** Words and phrases that match a brief (matched as whole words). */
  keywords: string[];
  assetKinds: AssetKind[];
  cautions: string[];
  /** Where the research for this style came from. */
  sources: string[];
}

export const STYLES: Style[] = [
  {
    id: "explainer-flat-vector",
    label: "Flat-vector explainer",
    family: "explainer",
    description: "A calm narrator over flat illustrated scenes that build one argument step by step.",
    formats: ["short", "long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["science", "space", "tech", "history"],
    keywords: ["explainer", "explain", "how it works", "why", "science", "biology", "facts", "animated facts", "documentary style"],
    assetKinds: ["image"],
    cautions: ["Write the argument yourself. Don't paraphrase another channel's script.", "Build your own illustration style; don't copy a specific channel's look."],
    sources: ["https://www.revid.ai/blog/best-faceless-youtube-channels"],
  },
  {
    id: "kinetic-facts",
    label: "Kinetic facts and quotes",
    family: "motion-graphics",
    description: "Large animated text, icons and counters for facts, quotes and lists.",
    formats: ["short"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [2, 4],
    themes: ["science", "motivation", "tech"],
    keywords: ["facts", "did you know", "kinetic", "quotes", "typography", "text animation", "counter"],
    assetKinds: ["font"],
    cautions: ["Quotes need attribution or a public-domain source."],
    sources: ["https://clippie.ai/blog/best-short-form-video-formats-monetization-2026"],
  },
  {
    id: "ranking-list",
    label: "Top-10 ranking",
    family: "data-list",
    description: "A numbered reveal where each item gets a short fact and an image.",
    formats: ["short", "long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [3, 5],
    themes: ["travel", "tech", "product", "science", "space", "history"],
    keywords: ["top 10", "top five", "ranking", "ranked", "list", "best", "worst", "versus", "compare", "countdown"],
    assetKinds: ["image"],
    cautions: ["Every item needs its own research and source. Generic lists carry a monetization risk."],
    sources: ["https://clippie.ai/blog/anonymous-content-ideas-faceless-videos"],
  },
  {
    id: "chart-story",
    label: "Data story with animated charts",
    family: "data-list",
    description: "Charts and maps animate in while the narrator explains the numbers.",
    formats: ["long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [6, 12],
    themes: ["finance", "science", "news", "tech"],
    keywords: ["chart", "charts", "data", "statistics", "stats", "graph", "numbers", "economy", "trend"],
    assetKinds: ["other"],
    cautions: ["Show the data source on screen and in the description."],
    sources: [],
  },
  {
    id: "math-explainer",
    label: "Math and diagram animation",
    family: "explainer",
    description: "Equations and diagrams built step by step with a narrator.",
    formats: ["short", "long"],
    engine: "manim",
    narration: true,
    shotSeconds: [4, 8],
    themes: ["science", "tech"],
    keywords: ["math", "equation", "proof", "physics", "formula", "geometry", "calculus", "theorem"],
    assetKinds: [],
    cautions: ["Check every formula before rendering."],
    sources: [],
  },
  {
    id: "documentary-stills",
    label: "Narrated documentary with stills",
    family: "documentary",
    description: "Narration over stills with slow camera moves and a clear timeline.",
    formats: ["short", "long"],
    engine: "ffmpeg-stills",
    narration: true,
    shotSeconds: [4, 8],
    themes: ["history", "science", "travel", "space", "finance"],
    keywords: ["documentary", "history", "historical", "story of", "the rise", "the fall", "biography", "narrated", "narration"],
    assetKinds: ["image"],
    cautions: ["Use your own generated or licensed images and record each licence.", "Facts need primary sources in the description."],
    sources: ["https://www.seedance.tv/blog/faceless-youtube-channel-ideas"],
  },
  {
    id: "mystery-narration",
    label: "Mystery narration with atmosphere",
    family: "narrative",
    description: "Atmospheric stills and a slow, suspenseful narration.",
    formats: ["short", "long"],
    engine: "ffmpeg-stills",
    narration: true,
    shotSeconds: [4, 7],
    themes: ["mystery", "myth", "horror"],
    keywords: ["mystery", "unsolved", "unexplained", "legend", "conspiracy", "what happened", "disappearance"],
    assetKinds: ["image", "audio"],
    cautions: ["No real crime footage and no identifiable private people.", "Label speculation clearly."],
    sources: ["https://www.seedance.tv/blog/faceless-youtube-channel-ideas"],
  },
  {
    id: "horror-story",
    label: "Original horror story",
    family: "narrative",
    description: "A fictional story told over dark stills with sound design.",
    formats: ["short", "long"],
    engine: "ffmpeg-stills",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["horror", "mystery"],
    keywords: ["horror", "scary", "creepy", "ghost", "haunted", "nightmare", "monster", "story time"],
    assetKinds: ["image", "audio"],
    cautions: ["Original fiction only. No real places tied to tragedies.", "Sound design must be your own or licensed."],
    sources: [],
  },
  {
    id: "kids-fable-2d",
    label: "Kids fable (2D cartoon)",
    family: "animation-2d",
    description: "A simple 2D cartoon fable with a clear moral and a friendly narrator.",
    formats: ["short", "long"],
    engine: "sprite-rig",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["kids", "myth"],
    keywords: ["kids", "children", "fable", "bedtime", "nursery", "lesson", "moral", "cartoon for kids"],
    assetKinds: ["sprite-sheet", "audio"],
    cautions: ["Set Made for Kids in YouTube Studio.", "Original characters only. No comments or personal data aimed at children."],
    sources: [],
  },
  {
    id: "animated-series-2d",
    label: "2D animated series with a recurring cast",
    family: "animation-2d",
    description: "Episodes with the same characters, lip-synced to narration or dialogue.",
    formats: ["short", "long"],
    engine: "sprite-rig",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["kids", "history", "myth", "horror"],
    keywords: ["series", "episode", "character", "recurring", "cast", "2d animation", "cartoon", "sprite", "animated story"],
    assetKinds: ["sprite-sheet", "image", "audio"],
    cautions: ["Keep one character sheet per character in Assets so the look stays the same across episodes."],
    sources: [],
  },
  {
    id: "parallax-2-5d",
    label: "2.5D parallax story",
    family: "animation-2.5d",
    description: "Layered painted backgrounds with depth motion and sprite characters on top.",
    formats: ["short", "long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["history", "myth", "horror", "kids", "mystery"],
    keywords: ["2.5d", "parallax", "layers", "layered", "painted", "diorama", "paper cut"],
    assetKinds: ["image", "sprite-sheet"],
    cautions: ["Keep one art style per series. Record the licence of every generated layer."],
    sources: [],
  },
  {
    id: "stylized-3d-story",
    label: "Stylized 3D story",
    family: "animation-3d",
    description: "Toon-shaded 3D characters in a painted world, with ink outlines.",
    formats: ["short"],
    engine: "remotion-3d",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["myth", "history", "kids", "horror"],
    keywords: ["3d", "3d animation", "three.js", "cinematic 3d", "stylized 3d", "ink outlines", "toon"],
    assetKinds: ["model-3d", "image", "audio"],
    cautions: ["Muse renders this on the CPU, which is slow. Time a 10-second test first.", "Keep models and textures under licences you hold (CC0 or your own)."],
    sources: ["https://github.com/mromidev/claude-animated-shorts"],
  },
  {
    id: "blender-3d",
    label: "Full 3D (Blender)",
    family: "animation-3d",
    description: "Scenes built in Blender with path-traced lighting.",
    formats: ["short", "long"],
    engine: "blender-cycles",
    narration: true,
    shotSeconds: [4, 8],
    themes: ["science", "space", "history"],
    keywords: ["blender", "cgi", "3d render", "realistic 3d", "3d scene", "product 3d"],
    assetKinds: ["model-3d"],
    cautions: ["Cycles on CPU is very slow. Plan for a GPU worker or long batch renders.", "Use CC0 or your own models."],
    sources: ["https://projects.blender.org/blender/blender/issues/61164"],
  },
  {
    id: "pixel-game-story",
    label: "Pixel-art game story",
    family: "game-style",
    description: "Pixel-art scenes with sprites and retro sound, built as a small game scene.",
    formats: ["short", "long"],
    engine: "godot-2d",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["kids", "myth", "horror", "mystery"],
    keywords: ["pixel", "pixel art", "8-bit", "retro", "game", "sprite", "arcade", "godot"],
    assetKinds: ["sprite-sheet", "audio"],
    cautions: ["Check each sprite pack's licence. CC0 packs or your own art only."],
    sources: [],
  },
  {
    id: "ambient-loop",
    label: "Relaxing ambience loop",
    family: "ambient",
    description: "Long, calm shots with ambient sound and no narration.",
    formats: ["short", "long"],
    engine: "ffmpeg-stills",
    narration: false,
    shotSeconds: [20, 60],
    themes: ["relax", "science"],
    keywords: ["relax", "relaxing", "ambient", "sleep", "rain", "lofi", "lo-fi", "study", "focus", "calm"],
    assetKinds: ["image", "audio"],
    cautions: ["Music is the main Content ID risk: self-composed or licensed tracks only.", "Long videos need real variation, or they read as repetitive."],
    sources: [],
  },
  {
    id: "travel-documentary",
    label: "Travel documentary (own or generated scenery)",
    family: "documentary",
    description: "Narrated journey through places, using your photos or licensed generated scenery.",
    formats: ["short", "long"],
    engine: "ffmpeg-stills",
    narration: true,
    shotSeconds: [4, 8],
    themes: ["travel", "science"],
    keywords: ["travel", "city", "tour", "destination", "landmark", "places", "country", "journey", "vlog"],
    assetKinds: ["image", "audio"],
    cautions: ["Use your own photos or images with recorded licences.", "Generated images must not show trademarked buildings or logos prominently."],
    sources: ["https://clippie.ai/blog/best-short-form-video-formats-monetization-2026"],
  },
  {
    id: "product-review",
    label: "Product review with your own photos",
    family: "explainer",
    description: "Your photos and tests, with animated specs and a clear verdict.",
    formats: ["short", "long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [3, 5],
    themes: ["product", "tech"],
    keywords: ["review", "product", "unboxing", "gadget", "tested", "test", "vs", "buy"],
    assetKinds: ["image", "video"],
    cautions: ["Only your own photos and tests.", "Disclose paid partnerships and affiliate links."],
    sources: [],
  },
  {
    id: "news-recap",
    label: "News recap with original graphics",
    family: "motion-graphics",
    description: "Commentary over original graphics that summarise the week's stories.",
    formats: ["short", "long"],
    engine: "remotion-2d",
    narration: true,
    shotSeconds: [4, 6],
    themes: ["news", "finance", "tech"],
    keywords: ["news", "recap", "update", "weekly", "this week", "breaking", "roundup"],
    assetKinds: ["image", "other"],
    cautions: ["Commentary and original graphics only. Don't reuse news clips or photos.", "Check facts against primary sources before publishing."],
    sources: [],
  },
  {
    id: "story-read-aloud",
    label: "Story read-aloud (adapted, original)",
    family: "narrative",
    description: "A first-person story rewritten as original narration over stills.",
    formats: ["short"],
    engine: "ffmpeg-stills",
    narration: true,
    shotSeconds: [3, 6],
    themes: ["horror", "mystery", "motivation"],
    keywords: ["reddit", "story time", "aita", "confession", "read aloud", "true story", "drama"],
    assetKinds: ["image"],
    cautions: ["Low monetization fit: rewrite as original narration.", "Never read other people's posts word for word."],
    sources: ["https://clippie.ai/blog/best-short-form-video-formats-monetization-2026"],
  },
  {
    id: "ai-character-sketch",
    label: "AI character sketch (original characters)",
    family: "narrative",
    description: "Short comedy sketches with original AI-generated characters. Experimental.",
    formats: ["short"],
    engine: "provider-video",
    narration: true,
    shotSeconds: [2, 4],
    themes: ["tech", "kids"],
    keywords: ["ai character", "funny", "absurd", "sketch", "meme", "character comedy"],
    assetKinds: ["video"],
    cautions: ["Trend copies get removed. Build original characters.", "The provider's terms set what you may publish; check each output."],
    sources: ["https://www.opus.pro/blog/viral-ai-video-styles-2026"],
  },
];

export const STYLE_BY_ID: Record<string, Style> = Object.fromEntries(STYLES.map((s) => [s.id, s]));
