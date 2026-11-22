/**
 * Video style catalog: formats, engines (with Muse placement), themes and styles.
 * Pure data with no server imports, so the planner, the UI and the tests share one source.
 * Research and sources: docs/research/03-production-styles-and-muse-capabilities.md
 */

export type Format = "short" | "long";
/** The frame an art direction was measured on. */
export type Frame = "landscape" | "portrait" | "both";
/**
 * Which shape of assets a template expects. `image-per-shot` is the stills model, where image count grows
 * with beat count. `plates-and-diagrams` means a few reused plates and character cut-outs, with every
 * diagram drawn by the template in code, so image count stops growing with the script.
 */
export type AssetModel = "image-per-shot" | "plates-and-diagrams";
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

/** The frame a format actually produces, so a style's natural frame can be compared against it. */
export function frameForFormat(format: Format): Frame {
  const f = VIDEO_FORMATS[format];
  if (f.width === f.height) return "both";
  return f.width > f.height ? "landscape" : "portrait";
}

/** The frame a style's art direction was built for. Most styles fit any. */
export function frameOf(style: Style): Frame {
  return style.naturalFrame ?? "both";
}

/** The asset shape a style's template expects. Most styles still take one image per shot. */
export function assetModelOf(style: Style): AssetModel {
  return style.assetModel ?? "image-per-shot";
}

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
  "html-capture": {
    id: "html-capture",
    label: "HTML templates (GSAP, CSS, three.js) captured in headless Chrome",
    capability: "html-capture",
    tier: "light",
    muse: "muse-ok",
    note: "Each frame is captured from a page in the Chromium the Remotion renderer installs, offline, then encoded by ffmpeg. Worker 0.10.0+.",
  },
  hermes: {
    id: "hermes",
    label: "Hermes renders with its own tools (research only)",
    capability: "hermes",
    tier: "light",
    muse: "external",
    note: "The portal asks Hermes, which renders with its own tools and returns a clip. Owner decision: trials and research only, never published.",
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
  // Original themes (styles already reference these ids)
  { id: "history", label: "History", keywords: ["history", "historical", "ancient", "empire", "war", "medieval", "civilization", "century", "dynasty", "kingdom"], policy: ["Cite sources in the description and check dates against a primary source."] },
  { id: "science", label: "Science and nature", keywords: ["science", "biology", "physics", "nature", "evolution", "cell", "facts", "ocean"], policy: ["Check each claim against a primary source before publishing."] },
  { id: "space", label: "Space and astronomy", keywords: ["space", "astronomy", "planet", "galaxy", "moon", "mars", "universe", "black hole", "telescope"], policy: ["Check each image's usage notes; public-domain agency images still need attribution where asked."] },
  { id: "finance", label: "Finance and economy", keywords: ["money", "finance", "economy", "stock", "inflation", "budget", "invest", "bank", "debt", "salary"], policy: ["No investment advice. Add a disclaimer and avoid promised returns."] },
  { id: "mystery", label: "Mystery and unsolved", keywords: ["mystery", "unsolved", "unexplained", "conspiracy", "disappearance", "clue", "secret"], policy: ["Don't name private people in crime stories, and use no real crime footage.", "Label speculation clearly as speculation."] },
  { id: "horror", label: "Horror and ghost stories", keywords: ["horror", "scary", "creepy", "ghost", "haunted", "nightmare", "monster"], policy: ["Original fiction only. Don't tie stories to real victims or real places of tragedy."] },
  { id: "myth", label: "Myth and folklore", keywords: ["myth", "folklore", "legend", "mythology", "fairy tale", "gods", "fable"], policy: ["Public-domain myths are fine. Retellings must use original wording."] },
  { id: "kids", label: "Kids and bedtime", keywords: ["kids", "children", "bedtime", "lullaby", "nursery", "cartoon"], policy: ["Set Made for Kids in YouTube Studio, and check what that setting limits.", "No personal data collection and no comments aimed at children."] },
  { id: "travel", label: "Travel and places", keywords: ["travel", "city", "places", "tour", "destination", "landmark", "country", "journey"], policy: ["Use your own photos or images with recorded licences. Avoid trademarked buildings and logos."] },
  { id: "tech", label: "Tech and gadgets", keywords: ["tech", "technology", "gadget", "software", "device", "app", "ai"], policy: ["Don't reuse press images without permission."] },
  { id: "motivation", label: "Motivation", keywords: ["motivation", "mindset", "discipline", "success", "inspire", "habits", "quote"], policy: ["Quotes need attribution or a public-domain source. Write the rest in your own words."] },
  { id: "product", label: "Product reviews", keywords: ["review", "product", "unboxing", "tested", "buy", "compare"], policy: ["Disclose paid partnerships and affiliate links.", "Use only your own photos and tests."] },
  { id: "relax", label: "Relaxation and ambience", keywords: ["relax", "ambient", "sleep", "rain", "calm", "lofi", "study", "focus"], policy: ["Music is the main Content ID risk: use self-composed or licensed tracks only."] },
  { id: "news", label: "News recap", keywords: ["news", "recap", "update", "weekly", "breaking", "roundup"], policy: ["Use commentary and original graphics. Don't reuse news clips or photos."] },
  // Genres and topics added for completeness
  { id: "thriller", label: "Thriller and suspense", keywords: ["thriller", "suspense", "chase", "twist", "heist", "spy", "betrayal"], policy: ["Fiction only. Keep real people out of suspect or villain roles.", "Check the platform's rules on graphic violence before publishing."] },
  { id: "comedy", label: "Comedy and sketches", keywords: ["comedy", "funny", "sketch", "humor", "joke", "parody"], policy: ["No copied sketches, clips or jokes from other shows."] },
  { id: "drama", label: "Drama and character stories", keywords: ["drama", "character", "relationship", "family drama", "emotional"], policy: ["Fiction only. Don't present a story about a real person as fact."] },
  { id: "romance", label: "Romance", keywords: ["romance", "love story", "wedding", "crush", "couple"], policy: ["Keep it suitable for general audiences unless the age-restriction rules are checked."] },
  { id: "scifi", label: "Sci-fi", keywords: ["sci-fi", "scifi", "science fiction", "future", "robot", "alien", "spaceship", "dystopia"], policy: [] },
  { id: "fantasy", label: "Fantasy", keywords: ["fantasy", "dragon", "wizard", "magic", "kingdom of", "quest", "epic"], policy: [] },
  { id: "true-crime", label: "True crime", keywords: ["true crime", "murder", "case", "detective", "investigation", "criminal"], policy: ["No real crime footage. Don't name or show private people beyond what the public record says.", "Check defamation risk for every named person before publishing."] },
  { id: "education", label: "Education and how-to", keywords: ["tutorial", "how to", "lesson", "learn", "step by step", "guide", "course"], policy: ["Test every step you show. Note the version or date of any software."] },
  { id: "language-learning", label: "Language learning", keywords: ["language", "learn english", "vocabulary", "grammar", "pronunciation", "phrases"], policy: ["Have a native speaker check pronunciation and translations."] },
  { id: "food", label: "Food and recipes", keywords: ["food", "recipe", "cooking", "baking", "kitchen", "dish", "meal"], policy: ["Recipes can be shared, but write the method in your own words and use only photos you took."] },
  { id: "fitness", label: "Fitness", keywords: ["fitness", "workout", "exercise", "training", "gym", "stretch"], policy: ["Add a safety note. No promised results and no medical advice."] },
  { id: "health", label: "Health", keywords: ["health", "symptoms", "diet", "wellness", "supplement", "medical"], policy: ["No medical claims or cures. Add a 'not medical advice' note and cite sources.", "Health claims are a common reason for removal: check each one."] },
  { id: "business", label: "Business and startups", keywords: ["business", "startup", "entrepreneur", "marketing", "sales", "side hustle"], policy: ["No guaranteed-income claims. Show real numbers only with a source."] },
  { id: "sports", label: "Sports", keywords: ["sports", "football", "soccer", "basketball", "match", "highlights", "athlete"], policy: ["Broadcast highlights and team logos are copyrighted: use your own footage or licensed clips only."] },
  { id: "gaming", label: "Gaming", keywords: ["gaming", "game", "gameplay", "walkthrough", "speedrun", "esports"], policy: ["Gameplay footage and game music belong to the publisher: check each game's content rules. Commentary alone can be original."] },
  { id: "music", label: "Music", keywords: ["music", "song", "lyrics", "beat", "album", "playlist"], policy: ["A song needs its licence (publisher or licensed library) before it appears in a video."] },
  { id: "real-estate", label: "Real estate", keywords: ["property", "house tour", "apartment", "real estate", "rent", "listing"], policy: ["Show a property only with the owner's permission. No misleading price or size claims."] },
  { id: "fashion", label: "Fashion", keywords: ["fashion", "outfit", "style", "clothing", "wardrobe", "streetwear"], policy: ["Brand names and logos only with fair-use reasons or licences. Disclose paid partnerships."] },
  { id: "beauty", label: "Beauty", keywords: ["beauty", "makeup", "skincare", "routine", "cosmetics"], policy: ["Disclose paid partnerships. Avoid claims a product can cure skin conditions."] },
  { id: "cars", label: "Cars", keywords: ["car", "cars", "vehicle", "motorcycle", "driving", "engine"], policy: ["Trademarked badges are fine in reviews; don't imply a brand endorses your video."] },
  { id: "diy", label: "DIY and crafts", keywords: ["diy", "craft", "woodworking", "repair", "build", "handmade"], policy: ["Add safety notes for tools, electricity and heights."] },
  { id: "parenting", label: "Parenting", keywords: ["parenting", "parents", "toddler", "baby", "family tips"], policy: ["No medical advice. Don't show children's faces or details without consent."] },
  { id: "self-improvement", label: "Self-improvement", keywords: ["self improvement", "productivity", "habit", "routine", "focus tips", "life hacks"], policy: ["Avoid promised outcomes. Cite research where you quote a study."] },
  { id: "interviews", label: "Interviews and talks", keywords: ["interview", "conversation", "podcast", "talk", "guest", "q and a"], policy: ["Get a recording release from every guest before publishing."] },
  { id: "wildlife", label: "Wildlife and pets", keywords: ["wildlife", "pets", "dogs", "cats", "birds", "safari", "pet care"], policy: ["Don't stage harm to animals. Use your own footage or licensed clips."] },
];

/**
 * Why a video exists. Purposes add stages and rules on top of the style and theme.
 * extraStages are inserted after the research stage.
 */
export interface StageTemplate {
  id: string;
  label: string;
  executor: Executor;
  role: string;
  detail: string;
}

export interface Purpose {
  id: string;
  label: string;
  description: string;
  extraStages: StageTemplate[];
  policy: string[];
}

export const PURPOSES: Purpose[] = [
  { id: "entertain", label: "Entertain", description: "Story, comedy or fun for its own sake.", extraStages: [], policy: [] },
  { id: "educate", label: "Educate", description: "Teach or explain something. Facts need sources.", extraStages: [], policy: ["Cite a source for every factual claim."] },
  {
    id: "affiliate",
    label: "Affiliate links",
    description: "Links that earn a commission when someone buys.",
    extraStages: [
      { id: "product-research", label: "Product research and links", executor: "hermes", role: "research", detail: "Products, the claims to verify, and each affiliate link with its disclosure line." },
    ],
    policy: [
      "Affiliate commissions count as paid promotion: tick YouTube's paid promotion box and say so in the video and in the description.",
      "Test any product before you recommend it.",
    ],
  },
  {
    id: "advertising",
    label: "Advertising for a client",
    description: "A video paid for by a brand or client.",
    extraStages: [
      { id: "client-brief", label: "Client brief and claims check", executor: "human", role: "approve", detail: "The brief, the approved claims and the disclosure wording, signed off by the client." },
    ],
    policy: [
      "Paid promotion must be disclosed with YouTube's paid promotion box.",
      "Check YouTube's rules on third-party sponsorships inside videos before you sell a slot.",
    ],
  },
  {
    id: "series",
    label: "Series (recurring episodes)",
    description: "Episodes that share characters, world and format.",
    extraStages: [
      { id: "series-bible", label: "Series bible", executor: "hermes", role: "series", detail: "Characters, world rules, the recurring format and the episode arc. Saved to Assets and reused by every episode." },
    ],
    policy: ["Keep recurring characters and the art style in Assets, so every episode matches."],
  },
  {
    id: "testimonial",
    label: "Testimonial or interview",
    description: "Someone speaks on camera or in narration about their experience.",
    extraStages: [
      { id: "release", label: "Signed release", executor: "human", role: "consent", detail: "A recording and publishing release from everyone who speaks or appears." },
    ],
    policy: ["Get a signed release before publishing anyone's words or likeness."],
  },
  {
    id: "brand-story",
    label: "Brand story",
    description: "Company or product story told for the brand's own channel.",
    extraStages: [
      { id: "client-brief", label: "Brand brief and approval", executor: "human", role: "approve", detail: "Brand guidelines, approved messages and the final approval." },
    ],
    policy: ["Keep claims factual and sourced. Disclose that the video is made for the brand."],
  },
];

export const PURPOSE_BY_ID: Record<string, Purpose> = Object.fromEntries(PURPOSES.map((p) => [p.id, p]));

/**
 * Narration and subtitle languages. `tts` says whether Kokoro (the TTS model in the plan) lists the language:
 * "kokoro" = listed on its model cards, "other" = not listed (needs another voice provider), "verify" = unclear.
 */
export interface Language {
  code: string;
  label: string;
  tts: "kokoro" | "other" | "verify";
  ttsNote: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", label: "English", tts: "kokoro", ttsNote: "Kokoro has US and UK English voices." },
  { code: "es", label: "Spanish", tts: "kokoro", ttsNote: "Kokoro lists Spanish voices." },
  { code: "fr", label: "French", tts: "kokoro", ttsNote: "Kokoro lists only one French voice; listen before publishing." },
  { code: "hi", label: "Hindi", tts: "kokoro", ttsNote: "Kokoro lists Hindi voices." },
  { code: "it", label: "Italian", tts: "kokoro", ttsNote: "Kokoro lists Italian voices." },
  { code: "ja", label: "Japanese", tts: "kokoro", ttsNote: "Kokoro lists Japanese voices." },
  { code: "zh", label: "Chinese (Mandarin)", tts: "kokoro", ttsNote: "Kokoro lists Mandarin voices." },
  { code: "pt", label: "Portuguese (Brazil)", tts: "kokoro", ttsNote: "Kokoro lists Brazilian Portuguese voices." },
  { code: "id", label: "Indonesian", tts: "other", ttsNote: "Not in Kokoro's listed languages. Narration needs another voice provider; confirm one through 9router or Hermes." },
  { code: "ms", label: "Malay", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "ko", label: "Korean", tts: "verify", ttsNote: "Some Kokoro builds list Korean. Check the exact model you run." },
  { code: "de", label: "German", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "ar", label: "Arabic", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "ru", label: "Russian", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "vi", label: "Vietnamese", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "th", label: "Thai", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "tr", label: "Turkish", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
  { code: "nl", label: "Dutch", tts: "other", ttsNote: "Not in Kokoro's listed languages. Needs another voice provider." },
];

export const LANGUAGE_BY_CODE: Record<string, Language> = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

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
  /**
   * The frame the art direction was measured on. A job in another frame needs its layout re-derived, so
   * the planner says so instead of quietly reusing a 16:9 composition inside a 9:16 frame.
   */
  naturalFrame?: Frame;
  /** Which asset shape the template expects. Defaults to the stills model. */
  assetModel?: AssetModel;
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
    // Measured on the reference rather than guessed: 196 cuts in 8:14 is 23.8 cuts a minute with a 2.27 s
    // median shot, which lands inside the 15-30 a minute this range implies and outside what 3-6 implies.
    shotSeconds: [2, 4],
    // The art direction was measured at 1920x1080: safe box, colour bands and caption margins all assume it.
    naturalFrame: "landscape",
    // A few plates and cut-outs reused across beats, with the diagrams drawn by the template in code.
    assetModel: "plates-and-diagrams",
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
  {
    // Research only (owner decision): Hermes renders the whole video with its own tools. Its pack can never go above
    // Trial and every run of it is a trial (style-registry.ts), so the planner's keywords stay deliberately narrow.
    id: "hermes-research-explainer",
    label: "Hermes render (research only)",
    family: "explainer",
    description: "Hermes renders the whole video with its own tools from the storyboard, scene plan and pictures. For trials and research, never for publishing.",
    formats: ["short"],
    engine: "hermes",
    narration: true,
    shotSeconds: [2, 4],
    naturalFrame: "portrait",
    themes: [],
    keywords: ["hermes render research", "hermes research render", "research render trial"],
    assetKinds: ["image"],
    cautions: ["Research only: a Hermes render is never published.", "Hermes's tools have their own terms; record what it used."],
    sources: [],
  },
];

export const STYLE_BY_ID: Record<string, Style> = Object.fromEntries(STYLES.map((s) => [s.id, s]));
