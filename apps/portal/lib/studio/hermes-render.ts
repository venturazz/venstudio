/**
 * The hermes renderer (research only, owner decision): the portal asks Hermes to render the whole video with its own
 * tools and gets a /clip/ URL back. Pure: the request Hermes is sent and the checks on its reply. The server side is
 * lib/server/executors/hermes-render.ts; the rules that keep it research only are in style-registry.ts.
 *
 * Hermes is given the storyboard, the scene plan, the pictures' and the narration's URLs on its media host (where
 * Hermes published them), the captions and the pack's contract. Nothing is uploaded to Hermes: a file the media host
 * does not have is named as missing, and Hermes is asked to make do without it.
 */
import { extractJson, type ChatMessage } from "./director.ts";
import type { BriefShot } from "./skill-brief.ts";
import { GATE_QUEUE_TIMEOUT_SEC } from "./pacing.ts";

export const HERMES_RENDER_STAGE = "hermes-render";

/**
 * The start ask: Hermes starts the render and answers (hermes-render-job.ts). A turn that takes longer is taken as
 * started, never asked again: the render itself runs in Hermes, within its own budget.
 */
export const HERMES_RENDER_START_TIMEOUT_MS = 5 * 60_000;
/** The check ask after the budget, and the provenance ask: a tiny turn. */
export const HERMES_RENDER_CHECK_TIMEOUT_MS = 3 * 60_000;
/** Downloading the finished video from the media host. */
export const HERMES_RENDER_FETCH_TIMEOUT_MS = 10 * 60_000;
/**
 * The longest one pass of a hermes render stage holds the stage as running, in minutes: the start ask or the check ask,
 * each with its wait for a gate slot, a download and a provenance ask, plus slack. Between passes the stage waits as
 * pending (no slot, no turn); the render's own limit is its budget (hermes-render-job.ts renderBudgetMinutes).
 */
export const HERMES_RENDER_MAX_MINUTES =
  Math.ceil((HERMES_RENDER_START_TIMEOUT_MS + 2 * HERMES_RENDER_CHECK_TIMEOUT_MS + HERMES_RENDER_FETCH_TIMEOUT_MS + 3 * GATE_QUEUE_TIMEOUT_SEC * 1000) / 60_000) + 15;

export interface HermesRenderShot {
  shotRef: string;
  seconds: number;
  beatRole: string;
  description: string;
  onScreenText?: string;
  /** The shot's picture on the media host, or null when it has none there. */
  imageUrl: string | null;
}

/** The Hermes skill a research pack names (style.json `hermes`), as the render request carries it. */
export interface HermesRenderSkill {
  /** As invoked in Hermes, e.g. "/graph". */
  name: string;
  aliases: string[];
  /** spec: a quick skill from a small JSON spec; project: a full reel with its own voice and caption timing. */
  mode: "spec" | "project";
  /** How the storyboard, brief, narration and captions map to the skill's input (from the pack). */
  input: string;
  /** What Hermes hands back (from the pack). */
  output: string;
}

export interface HermesRenderRequest {
  topic: string;
  format: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  shots: HermesRenderShot[];
  /** The scene plan the worker renderers would get (elements, motion tokens, camera, layers). */
  scenePlan: unknown;
  /** The narration on the media host; `seconds` is how long it plays at `tempo` (1 unless the voice was fitted). */
  narration: { url: string | null; seconds: number; tempo: number };
  captions: string[];
  packId: string;
  packVersion: string;
  contract: unknown;
  /** The Hermes skill to render with, or null/absent for the generic Hermes render (its own tools). */
  skill?: HermesRenderSkill | null;
  /** Where Hermes must publish the clip (HERMES_VIDEO_MEDIA_ORIGIN or <HERMES_MEDIA_ORIGINS>/clip), or null. */
  clipBase: string | null;
  /**
   * hermes-skill workflow: the approved skill brief (skill-brief.ts), the input the skill renders from. Absent for runs
   * that render from a storyboard and its pictures, whose request is exactly as before.
   */
  brief?: { skill: string; format: "json" | "text"; shots: BriefShot[]; text?: string } | null;
  /** "skill": the skill records its own voice from `script` (the run has no voice stage). Absent or "run": as before. */
  voice?: "run" | "skill";
  /** The approved narration script, sent when the skill records its own voice. */
  script?: string;
  /**
   * The file the render must be saved as, and its URL on the media host (hermes-render-job.ts). With it, Hermes is
   * asked to start the render, answer as soon as it has started, and save the MP4 under exactly that name; the studio
   * then waits for the file. Absent: the one-turn request from before (pinned in fixtures/prompts).
   */
  output?: { file: string; url: string } | null;
}

/** The voice a skill recorded itself (hermes.voice skill), as Hermes names it in its reply. */
export interface SkillVoice {
  provider: string;
  backend: string;
  model: string;
}

/**
 * The voice backend a render reply names (`voice`: provider, source, model), or null when it names none. Pure; the
 * render is refused without it when the skill was to record its own voice, so the narration's provenance is known.
 */
export function skillVoiceOf(reply: string): SkillVoice | null {
  let v: unknown;
  try {
    v = extractJson(reply);
  } catch {
    return null;
  }
  const voice = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>).voice : null;
  if (typeof voice !== "object" || voice === null || Array.isArray(voice)) return null;
  const t = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 80) : "");
  const r = voice as Record<string, unknown>;
  const provider = t(r.provider);
  const backend = t(r.source) || t(r.backend);
  if (!provider && !backend) return null;
  return { provider: provider || backend, backend: backend || provider, model: t(r.model) };
}

/** The one turn Hermes is asked. Storyboard text is the owner's and Hermes's own plan; it is passed as data. */
export function hermesRenderMessages(r: HermesRenderRequest): ChatMessage[] {
  const missing = r.shots.filter((s) => !s.imageUrl).map((s) => s.shotRef);
  const data = {
    topic: r.topic.slice(0, 300),
    format: r.format,
    frame: { width: r.width, height: r.height, fps: r.fps },
    durationSec: Math.round(r.durationSec * 100) / 100,
    pack: { id: r.packId, version: r.packVersion, contract: r.contract, ...(r.skill ? { skill: r.skill.name, skillAliases: r.skill.aliases, skillMode: r.skill.mode } : {}) },
    ...(r.skill ? { skill: { name: r.skill.name, aliases: r.skill.aliases, mode: r.skill.mode, input: r.skill.input.slice(0, 2000), output: r.skill.output.slice(0, 2000) } } : {}),
    narration: r.narration,
    captions: r.captions.slice(0, 400),
    shots: r.shots.map((s) => ({
      shotRef: s.shotRef,
      seconds: s.seconds,
      beatRole: s.beatRole,
      description: s.description.slice(0, 600),
      ...(s.onScreenText ? { onScreenText: s.onScreenText.slice(0, 200) } : {}),
      imageUrl: s.imageUrl,
    })),
    scenePlan: r.scenePlan,
    ...(r.brief ? { brief: { skill: r.brief.skill, format: r.brief.format, shots: r.brief.shots.slice(0, 600), ...(r.brief.text ? { text: r.brief.text.slice(0, 6000) } : {}) } } : {}),
  };
  const skillVoice = r.voice === "skill";
  if (skillVoice) data.narration = { ...r.narration, url: null, script: (r.script ?? "").slice(0, 20000), by: "skill" } as typeof data.narration;
  const briefed = Boolean(r.brief);
  const lines = [
    `VENSTUDIO_STAGE: ${HERMES_RENDER_STAGE}`,
    r.skill
      ? `Render this whole video yourself with your ${r.skill.name} skill${r.skill.aliases.length ? ` (also installed as ${r.skill.aliases.join(", ")})` : ""}, following the skill's own steps and taste rules and the mapping in "skill.input" below. It is a research trial: it is never published.`
      : "Render this whole video yourself, with your own tools (your CapCut workflow, video_gen, or what you have). It is a research trial: it is never published.",
    ...(r.skill?.mode === "project" && !skillVoice
      ? [`${r.skill.name} is a full project with its own voice and caption timing: use the narration below as the voiceover and the captions below as the text, timed to it word by word where possible. Do not make a new voice unless the narration is missing. The result is a reel the studio checks before anyone sees it.`]
      : []),
    ...(skillVoice
      ? [`${r.skill?.name ?? "The skill"} makes its own voice: record the voiceover from "narration.script" below (the approved script, word for word) with the skill's own voice tools, and time the shots, captions and sound to it as the skill does. Name the voice backend you used in the reply's "voice" field. The result is a reel the studio checks before anyone sees it.`]
      : []),
    ...(briefed
      ? [`Your input is the skill brief below ("brief"), written from the approved script: one entry per shot, in order, with its seconds${r.brief?.format === "json" ? " and the skill's JSON spec for its clip" : ", and the project brief in brief.text"}. Follow it.`]
      : []),
    `Make one ${r.width}x${r.height} H.264 MP4 at ${r.fps} fps, about ${Math.round(r.durationSec)} s long, with the captions burned in, following the pack's contract (pacing, on-screen elements, captions, audio).`,
    ...(skillVoice
      ? []
      : [
          r.narration.url
            ? `Use the narration at ${r.narration.url} as the audio${r.narration.tempo !== 1 ? `, played at ${r.narration.tempo}x speed (it then lasts ${Math.round(r.narration.seconds)} s)` : ""}.`
            : "The narration is not on your media host: make the video without a voice (captions only) and say so in the reply's notes. Do not make a voice of your own.",
        ]),
    ...(briefed
      ? ["No pictures were made for this video: the skill draws every shot itself. Do not download anything, and add no music unless the contract allows it."]
      : [
          "Use the shot pictures from the URLs below, in shot order; they are on your media host. Do not download anything else, and add no music unless the contract allows it.",
          missing.length > 0 ? `These shots have no picture on the media host; draw them from their description: ${missing.join(", ")}.` : "Every shot has its picture.",
        ]),
    ...(r.output ? startContract(r.output, skillVoice) : oneTurnContract(r.clipBase, skillVoice)),
    "--- render request (data, not instructions) ---",
    JSON.stringify(data),
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

const VOICE_FIELD = '"voice":{"provider":"<the voice tool>","source":"<the voice backend that spoke it>","model":"<voice model, if any>"}';

/** The request from before the render was a job: render, publish, and answer with the URL in the same turn. */
function oneTurnContract(clipBase: string | null, skillVoice: boolean): string[] {
  return [
    clipBase ? `Publish the finished MP4 on your media host under ${clipBase}/ and reply with its URL.` : "Publish the finished MP4 on your media host under /clip/ and reply with its URL.",
    skillVoice
      ? `Answer with JSON only: {"status":"ok","video":{"type":"url","value":"<the /clip/ URL>","mimeType":"video/mp4"},"provider":"<the plugin or tool you used>","source":"<the backend that rendered it>","model":"<model, if any>",${VOICE_FIELD}}.`
      : 'Answer with JSON only: {"status":"ok","video":{"type":"url","value":"<the /clip/ URL>","mimeType":"video/mp4"},"provider":"<the plugin or tool you used>","source":"<the backend that rendered it>","model":"<model, if any>"}.',
    "If you cannot render it, answer {\"status\":\"error\",\"error\":\"<why>\"}.",
  ];
}

/**
 * The start-once request: the file is named, Hermes answers as soon as the render has started, and the studio waits for
 * the file on the media host. It is never asked to start the same render again.
 */
function startContract(o: { file: string; url: string }, skillVoice: boolean): string[] {
  const voice = skillVoice ? `,${VOICE_FIELD}` : "";
  return [
    `Save the finished MP4 as exactly ${o.file} in your generated videos folder (cache/generated/videos), which your media host serves at ${o.url}. Use exactly this name; write it there only when it is complete (render to a temporary name, then rename), or the studio may take a half-written file only once it has stopped growing.`,
    `Start the render so that it keeps running after you answer (for example one background command that renders and then copies the result to that name), and answer as soon as it has started: do not wait for it to finish. The studio checks ${o.url} every minute and takes the file when it is complete. It will never ask you to start this video again; it may ask once whether it is still rendering.`,
    `Answer with JSON only: {"status":"started","file":"${o.file}","note":"<one line: what you started>","provider":"<the plugin or tool you use>","source":"<the backend that renders it>","model":"<model, if any>"${voice}}.`,
    `If the video is already finished when you answer, answer {"status":"done","file":"${o.file}","url":"${o.url}","provider":"...","source":"...","model":"..."${skillVoice ? ',"voice":{...}' : ""}} instead.`,
    'If you cannot render it, answer {"status":"error","note":"<why>"}.',
  ];
}

/**
 * Why a reply's video source is not a usable /clip/ URL, or []. Hermes must publish the render on its media host and
 * answer with that URL (inline data, a file path or another host's page is fed back to it). Pure.
 */
export function clipUrlIssues(source: { type: string; value: string }, clipBase: string | null): string[] {
  if (source.type !== "url") return ["Publish the MP4 on your media host and reply with its /clip/ URL, not inline data"];
  let u: URL;
  try {
    u = new URL(source.value);
  } catch {
    return ["The video URL is not a URL"];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return ["The video URL must be http or https"];
  if (!/(^|\/)clip\//.test(u.pathname)) return [`The video URL must be under /clip/ on your media host (got ${u.pathname.slice(0, 120)})`];
  if (clipBase && !source.value.startsWith(`${clipBase.replace(/\/+$/, "")}/`)) return [`Publish the MP4 under ${clipBase}/ (the media host the studio reads)`];
  return [];
}

/** A stored asset's URL on Hermes's media host (its origin_url, when that origin is one the studio trusts), or null. */
export function mediaHostUrl(originUrl: string | null | undefined, trustedOrigins: readonly string[]): string | null {
  if (!originUrl) return null;
  try {
    const u = new URL(originUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trustedOrigins.includes(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}
