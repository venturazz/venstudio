/**
 * Studio capabilities, pure. What Hermes (skills, tools) and 9router (models) can do for each production stage,
 * discovered live and never hardcoded: Hermes tags its own skills, keyword rules only fill gaps, and 9router
 * lists are classified by the endpoint they came from. Also the validators for what Hermes and 9router answer,
 * stage resolution and the messages shown when a capability is missing. No network, no database, no zod.
 * Spec: docs/architecture-autonomous-studio.md (Capabilities)
 */
import type { ChatMessage, Validated } from "./director.ts";

export const CAPABILITY_STAGES = [
  "research",
  "script",
  "image",
  "voice",
  "music",
  "sfx",
  "video-clips",
  "editing",
  "subtitles",
  "thumbnail",
  "upload",
] as const;
export type CapabilityStage = (typeof CAPABILITY_STAGES)[number];

export interface StageInfo {
  label: string;
  /** What the studio does with a capability for this stage today. */
  today: string;
  /** True when the studio already calls a discovered capability for this stage. */
  used: boolean;
  /** True when the stage works without any discovered capability (the worker does it). */
  builtIn: boolean;
  /** True when the stage is not built yet, so it is neither ready nor missing. */
  later: boolean;
  /** Short name used in messages: "No <noun> found." */
  noun: string;
  /** What was checked in Hermes, and what to add. */
  hermesWhat: string;
  routerWhat: string | null;
  fix: string;
}

export const STAGE_INFO: Record<CapabilityStage, StageInfo> = {
  research: {
    label: "Research",
    today: "Hermes skills named in the director prompts do the research.",
    used: true,
    builtIn: false,
    later: false,
    noun: "research tool",
    hermesWhat: "web search or research skill",
    routerWhat: "web search model",
    fix: "Add a search provider in the 9router dashboard or a research skill in Hermes",
  },
  script: {
    label: "Script",
    today: "Hermes writes the script. 9router chat models are kept for quick formatting.",
    used: true,
    builtIn: false,
    later: false,
    noun: "writing tool",
    hermesWhat: "writing skill",
    routerWhat: "chat model",
    fix: "Add a chat provider in the 9router dashboard or a writing skill in Hermes",
  },
  image: {
    label: "Images",
    today: "Hermes image_gen first, then 9router image models.",
    used: true,
    builtIn: false,
    later: false,
    noun: "image maker",
    hermesWhat: "image_gen or image skill",
    routerWhat: "image model",
    fix: "Add an image provider in the 9router dashboard or an image skill in Hermes",
  },
  voice: {
    label: "Voice",
    today: "9router text to speech first, then Hermes voice skills such as CapCut.",
    used: true,
    builtIn: false,
    later: false,
    noun: "voice",
    hermesWhat: "text-to-speech or CapCut voice skill",
    routerWhat: "TTS model",
    fix: "Add a TTS provider in the 9router dashboard or a voice skill in Hermes",
  },
  music: {
    label: "Music",
    today: "Found, not used by a stage yet. Nothing has called these skills, so a listing does not prove they work; the studio first calls them in Phase 5.",
    used: false,
    builtIn: false,
    later: false,
    noun: "music maker",
    hermesWhat: "music skill",
    routerWhat: null,
    fix: "Add a music skill in Hermes",
  },
  sfx: {
    label: "Sound effects",
    today: "Found, not used by a stage yet. Nothing has called these skills, so a listing does not prove they work; the studio first calls them in Phase 5.",
    used: false,
    builtIn: false,
    later: false,
    noun: "sound effect maker",
    hermesWhat: "sound effect skill",
    routerWhat: null,
    fix: "Add a sound effect skill in Hermes",
  },
  "video-clips": {
    label: "Video clips",
    today: "Found, not used by a stage yet. Nothing has called these skills, so a listing does not prove they work; the studio first calls them in Phase 5.",
    used: false,
    builtIn: false,
    later: false,
    noun: "video clip maker",
    hermesWhat: "video or animation skill",
    routerWhat: "video model",
    fix: "Add a video provider in the 9router dashboard or a video skill in Hermes",
  },
  editing: {
    label: "Editing",
    today: "The worker renders the video with ffmpeg. CapCut editing through Hermes is found, not used yet. Nothing has called it, so a listing does not prove it works.",
    used: false,
    builtIn: true,
    later: false,
    noun: "editor",
    hermesWhat: "editing skill",
    routerWhat: null,
    fix: "Nothing to add, the worker renders",
  },
  subtitles: {
    label: "Subtitles",
    today: "The worker burns subtitles in with ffmpeg.",
    used: false,
    builtIn: true,
    later: false,
    noun: "subtitle maker",
    hermesWhat: "subtitle skill",
    routerWhat: "speech to text model",
    fix: "Nothing to add, the worker renders",
  },
  thumbnail: {
    label: "Thumbnail",
    today: "Found, not used by a stage yet. Nothing has called these skills, so a listing does not prove they work; the studio first calls them in Phase 5.",
    used: false,
    builtIn: false,
    later: false,
    noun: "thumbnail maker",
    hermesWhat: "thumbnail skill",
    routerWhat: null,
    fix: "Add a thumbnail or image skill in Hermes",
  },
  upload: {
    label: "Upload",
    today: "Phase 5, not built yet.",
    used: false,
    builtIn: false,
    later: true,
    noun: "uploader",
    hermesWhat: "YouTube upload skill",
    routerWhat: null,
    fix: "Upload is built in Phase 5",
  },
};

export type CapabilitySource = "hermes-skill" | "hermes-tool" | "router-model";

export interface Capability {
  stage: CapabilityStage;
  source: CapabilitySource;
  id: string;
  label: string;
  detail: string;
  via: "hermes" | "9router";
  used: boolean;
  /**
   * False for what Hermes only said about itself in its chat answer (a skill /v1/skills did not list, an image
   * provider, a voice engine). Such names are shown as unverified and never reach a prompt as a hint.
   */
  verified: boolean;
}

export function isStage(v: unknown): v is CapabilityStage {
  return typeof v === "string" && (CAPABILITY_STAGES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------------------------
// Hermes skills

export interface SkillInput {
  name: string;
  description: string;
  category?: string;
  /** Stage ids Hermes assigned itself. When present and valid they win over the keyword rules. */
  stages?: readonly string[];
}

const KEYWORD_RULES: Array<[RegExp, CapabilityStage]> = [
  [/tts|voice|speech|narrat|kokoro|capcut.*(voice|audio)/, "voice"],
  [/thumbnail/, "thumbnail"],
  [/image|picture|illustrat|flux|diffusion|photo/, "image"],
  [/capcut|\bedit|timeline|render/, "editing"],
  [/subtitle|caption|\bsrt\b/, "subtitles"],
  [/music|\bsong|\bbgm\b/, "music"],
  [/sfx|sound effect/, "sfx"],
  [/video|\bclip|animat/, "video-clips"],
  [/\bresearch|\bsearch|\bsources?\b/, "research"],
  [/\bscript|\bstory|\bwrit(e|ing)/, "script"],
  [/youtube|upload/, "upload"],
];

/** Stages for a skill: the ones Hermes assigned, or else the ones the keyword rules find in its name and text. */
export function classifySkill(skill: SkillInput): CapabilityStage[] {
  const assigned = (skill.stages ?? []).filter(isStage);
  if (assigned.length > 0) return [...new Set(assigned)];
  const hay = `${skill.name} ${skill.description} ${skill.category ?? ""}`.toLowerCase();
  const found: CapabilityStage[] = [];
  for (const [re, stage] of KEYWORD_RULES) if (re.test(hay) && !found.includes(stage)) found.push(stage);
  return found;
}

export interface HermesSkillEntry {
  name: string;
  description: string;
  category: string;
  stages: CapabilityStage[];
  /** True when /v1/skills listed it, false when it came from Hermes's own chat answer. */
  listedByApi: boolean;
}

export interface HermesCapabilityReply {
  skills: Array<{ name: string; description: string; category: string; stages: CapabilityStage[] }>;
  imageProviders: string[];
  voiceEngines: string[];
  notes: string;
}

export const MAX_SKILLS = 60;
export const MAX_PROVIDERS = 20;
const NAME_RE = /^[\w .:@/+()-]{1,80}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collapses whitespace and control characters, then truncates. Keeps the value plain text. */
function plain(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function names(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const raw = isRecord(item) ? item.name : item;
    const n = plain(raw, 80);
    if (n && NAME_RE.test(n) && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** Hermes's answer to the capabilities prompt. Text only, trimmed and capped. Nothing in it is ever run. */
export function validateHermesCapabilities(value: unknown): Validated<HermesCapabilityReply> {
  if (!isRecord(value)) return { ok: false, issues: ["Expected an object with skills, imageProviders, voiceEngines and notes"] };
  if (!Array.isArray(value.skills)) return { ok: false, issues: ["skills must be an array (use an empty array when there are none)"] };
  const skills: HermesCapabilityReply["skills"] = [];
  for (const raw of value.skills) {
    if (skills.length >= MAX_SKILLS) break;
    if (!isRecord(raw)) continue;
    const name = plain(raw.name, 80);
    if (!name || !NAME_RE.test(name) || skills.some((s) => s.name === name)) continue;
    const stages = Array.isArray(raw.stages) ? [...new Set(raw.stages.filter(isStage))] : [];
    skills.push({ name, description: plain(raw.description, 300), category: plain(raw.category, 60) || "other", stages });
  }
  return {
    ok: true,
    value: {
      skills,
      imageProviders: names(value.imageProviders, MAX_PROVIDERS),
      voiceEngines: names(value.voiceEngines, MAX_PROVIDERS),
      notes: plain(value.notes, 500),
    },
  };
}

export function capabilitiesPrompt(): ChatMessage[] {
  const stages = CAPABILITY_STAGES.join(", ");
  return [
    {
      role: "system",
      content:
        "You are the asset maker for a YouTube channel studio. Report what you can do. Use your own skill and tool listing, do not guess and do not invent skills. " +
        "Reply with JSON only. No markdown fences and no text before or after the JSON.",
    },
    {
      role: "user",
      content: [
        "VENSTUDIO_STAGE: capabilities",
        "List every skill or tool you have that helps make videos or video assets.",
        `Tag each one with the production stages it serves, using only these stage ids: ${stages}.`,
        "Also list the image providers your image_gen tool can use, and the voice engines you can narrate with (for example Kokoro or CapCut), if you have any.",
        'Reply as {"skills":[{"name":"","description":"one sentence","category":"","stages":[""]}],"imageProviders":[""],"voiceEngines":[""],"notes":""}.',
        "Use empty arrays when you have none. Do not run anything, only report.",
      ].join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 9router lists

export interface RouterModel {
  id: string;
  ownedBy: string;
  kind: string;
}

export const MAX_ROUTER_MODELS = 500;

/** `{object:'list',data:[{id,owned_by,kind?}]}`, or a bare array of the same entries or of ids. */
export function parseRouterList(body: unknown): RouterModel[] {
  const list: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: RouterModel[] = [];
  for (const item of list) {
    const rec = isRecord(item) ? item : { id: item };
    const id = plain(rec.id, 120);
    if (!id || out.some((m) => m.id === id)) continue;
    out.push({ id, ownedBy: plain(rec.owned_by, 60), kind: plain(rec.kind, 30) });
    if (out.length >= MAX_ROUTER_MODELS) break;
  }
  return out;
}

/** GET /v1/audio/voices: an array or `{data|voices:[...]}` of names or objects with id, name or voice. */
export function parseVoiceList(body: unknown): string[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.voices)
        ? body.voices
        : [];
  const out: string[] = [];
  for (const item of list) {
    const raw = isRecord(item) ? (item.id ?? item.name ?? item.voice) : item;
    const v = plain(raw, 80);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 200) break;
  }
  return out;
}

export interface RouterLists {
  chat: RouterModel[];
  image: RouterModel[];
  tts: RouterModel[];
  web: RouterModel[];
  stt: RouterModel[];
  video: RouterModel[];
  voices: string[];
}

export function emptyRouterLists(): RouterLists {
  return { chat: [], image: [], tts: [], web: [], stt: [], video: [], voices: [] };
}

function routerCap(m: RouterModel, stage: CapabilityStage, detail: string): Capability {
  const combo = m.ownedBy === "combo";
  return {
    stage,
    source: "router-model",
    id: m.id,
    label: m.id,
    detail: combo ? `combo. ${detail}` : m.ownedBy ? `${m.ownedBy}. ${detail}` : detail,
    via: "9router",
    used: STAGE_INFO[stage].used && stage !== "script" && stage !== "research",
    verified: true,
  };
}

/** Maps each 9router list to the stage it serves. Entries tagged kind video are video clips wherever they appear. */
export function classifyRouterModels(lists: RouterLists): Capability[] {
  const caps: Capability[] = [];
  const videoIds = new Set(lists.video.map((m) => m.id));
  const all = [...lists.chat, ...lists.image, ...lists.tts, ...lists.web, ...lists.stt, ...lists.video];
  for (const m of all) if (m.kind === "video") videoIds.add(m.id);
  const videos = new Map<string, RouterModel>();
  for (const m of all) if (videoIds.has(m.id) && !videos.has(m.id)) videos.set(m.id, m);

  for (const m of lists.image) if (!videoIds.has(m.id)) caps.push(routerCap(m, "image", "image model"));
  for (const m of lists.tts) if (!videoIds.has(m.id)) caps.push(routerCap(m, "voice", "text to speech"));
  if (lists.tts.length === 0 && lists.voices.length > 0) {
    caps.push({
      stage: "voice",
      source: "router-model",
      id: lists.voices[0],
      label: `${lists.voices.length} voices`,
      detail: "voices listed by 9router",
      via: "9router",
      used: true,
      verified: true,
    });
  }
  for (const m of lists.web) {
    const what = m.kind === "fetch" ? "page fetch" : "web search";
    caps.push(routerCap(m, "research", what));
  }
  for (const m of lists.stt) caps.push(routerCap(m, "subtitles", "speech to text"));
  for (const m of videos.values()) caps.push(routerCap(m, "video-clips", "video model"));
  for (const m of lists.chat) {
    if (videoIds.has(m.id)) continue;
    caps.push(routerCap(m, "script", "quick formatting"));
    caps.push(routerCap(m, "research", "quick formatting"));
  }
  return caps;
}

export function routerCombos(lists: RouterLists): string[] {
  const ids = new Set<string>();
  for (const m of [...lists.chat, ...lists.image, ...lists.tts, ...lists.web, ...lists.stt, ...lists.video]) {
    if (m.ownedBy === "combo") ids.add(m.id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------------------------------------------
// The stored snapshot and the map built from it

export interface SourceStatus {
  configured: boolean;
  ok: boolean;
  error?: string;
  hint?: string;
}

export interface HermesScan {
  status: SourceStatus;
  skills: HermesSkillEntry[];
  imageProviders: string[];
  voiceEngines: string[];
  notes: string;
}

export interface RouterScan {
  status: SourceStatus;
  /** Per probe outcome, keyed by list name. A failing probe never fails the scan. */
  probes: Record<string, SourceStatus>;
  lists: RouterLists;
}

export interface CapabilitySnapshot {
  scannedAt: string;
  hermes: HermesScan | null;
  router: RouterScan | null;
  error: string | null;
}

/** Everything the studio knows, flattened per stage. */
export function buildCapabilities(snap: CapabilitySnapshot | null): Capability[] {
  if (!snap) return [];
  const caps: Capability[] = [];
  const h = snap.hermes;
  if (h) {
    for (const s of h.skills) {
      for (const stage of classifySkill(s)) {
        caps.push({
          stage,
          source: "hermes-skill",
          id: s.name,
          label: s.name,
          detail: s.description || s.category,
          via: "hermes",
          used: STAGE_INFO[stage].used,
          verified: s.listedByApi,
        });
      }
    }
    for (const p of h.imageProviders) {
      caps.push({ stage: "image", source: "hermes-tool", id: p, label: p, detail: "image_gen provider", via: "hermes", used: true, verified: false });
    }
    for (const v of h.voiceEngines) {
      caps.push({ stage: "voice", source: "hermes-tool", id: v, label: v, detail: "voice engine", via: "hermes", used: true, verified: false });
    }
  }
  if (snap.router) caps.push(...classifyRouterModels(snap.router.lists));
  return caps;
}

export function capabilitiesFor(stage: CapabilityStage, caps: Capability[]): Capability[] {
  return caps.filter((c) => c.stage === stage);
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution and messages

export type SourceState = "ok" | "unreachable" | "not-configured" | "unscanned";

export interface ScanState {
  scanned: boolean;
  hermes: SourceState;
  router: SourceState;
}

function sourceState(scan: { status: SourceStatus } | null | undefined): SourceState {
  if (!scan) return "unscanned";
  if (!scan.status.configured) return "not-configured";
  return scan.status.ok ? "ok" : "unreachable";
}

export function scanStateOf(snap: CapabilitySnapshot | null): ScanState {
  if (!snap) return { scanned: false, hermes: "unscanned", router: "unscanned" };
  return { scanned: true, hermes: sourceState(snap.hermes), router: sourceState(snap.router) };
}

/** Where to look first for a stage: Hermes for images, 9router for raw voice bytes. */
const PREFER_ROUTER_FIRST: ReadonlySet<CapabilityStage> = new Set<CapabilityStage>(["voice"]);

export type Resolution = { ok: true; executors: Capability[] } | { ok: false; message: string };

/** The capabilities the studio can call for a stage, in the order they should be tried. */
export function resolveStage(stage: CapabilityStage, snap: CapabilitySnapshot | null): Resolution {
  const info = STAGE_INFO[stage];
  const caps = capabilitiesFor(stage, buildCapabilities(snap)).filter((c) => c.used);
  if (caps.length === 0) {
    if (info.builtIn) return { ok: true, executors: [] };
    return { ok: false, message: missingCapabilityMessage(stage, scanStateOf(snap)) };
  }
  const first = PREFER_ROUTER_FIRST.has(stage) ? "9router" : "hermes";
  const ordered = [...caps.filter((c) => c.via === first), ...caps.filter((c) => c.via !== first)];
  return { ok: true, executors: ordered };
}

export function missingCapabilityMessage(stage: CapabilityStage, state: ScanState): string {
  const info = STAGE_INFO[stage];
  if (info.later) return `${info.label} is not built yet. ${info.fix}.`;
  if (!state.scanned) {
    return `No ${info.noun} is known yet because the studio has not scanned Hermes and 9router. Press Scan now on Settings > Capabilities.`;
  }
  const down = (s: SourceState) => s === "unreachable" || s === "not-configured";
  const name = (s: "hermes" | "router") => (s === "hermes" ? "Hermes" : "9router");
  const problems = (["hermes", "router"] as const).filter((s) => down(state[s]));
  if (problems.length === 2) {
    return `Cannot tell whether a ${info.noun} is available: the last scan could not reach Hermes or 9router. Fix the connections on Settings, then press Scan now on Settings > Capabilities.`;
  }
  const checked = (["hermes", "router"] as const).filter((s) => !down(state[s]));
  const listed = [
    checked.includes("hermes") ? `Hermes lists no ${info.hermesWhat}` : "",
    checked.includes("router") && info.routerWhat ? `9router lists no ${info.routerWhat}` : "",
  ].filter(Boolean);
  const none = `No ${info.noun} found. ${listed.length > 0 ? listed.join(" and ") : "Nothing was listed"}.`;
  if (problems.length === 1) {
    return `${none} ${name(problems[0])} could not be reached, so it may have one. Fix that connection, then press Scan now on Settings > Capabilities.`;
  }
  return `${none} ${info.fix}, then press Scan on Settings > Capabilities.`;
}

/** Up to five skill names Hermes may prefer for a stage. Only skills /v1/skills listed count; a name Hermes only claimed is not passed back to it. */
export function skillHintsFor(stage: CapabilityStage, snap: CapabilitySnapshot | null): string[] {
  const names: string[] = [];
  for (const c of capabilitiesFor(stage, buildCapabilities(snap))) {
    if (c.source === "hermes-skill" && c.verified && !names.includes(c.id)) names.push(c.id);
    if (names.length >= 5) break;
  }
  return names;
}

export type StageStatus = "ready" | "found" | "missing" | "later";

/** Ready: the studio can call something. Found: something exists but no stage calls it yet. */
export function stageStatus(stage: CapabilityStage, snap: CapabilitySnapshot | null): StageStatus {
  const info = STAGE_INFO[stage];
  if (info.later) return "later";
  const caps = capabilitiesFor(stage, buildCapabilities(snap));
  if (info.builtIn || caps.some((c) => c.used)) return "ready";
  return caps.length > 0 ? "found" : "missing";
}
