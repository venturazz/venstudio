import "server-only";
import { hermesText } from "../hermes-json.ts";
import { fetchMedia, headMedia, SafeFetchError } from "../safe-fetch.ts";
import { resolveHermesMaker } from "../../studio/asset-plan.ts";
import type { ChatMessage } from "../../studio/director.ts";
import { hermesTimeoutScale, scaledMs, type FailureClass } from "../../studio/pacing.ts";
import { MAX_VIDEO_BYTES, sniffVideo, videoIssues, type VideoInfo } from "../../studio/image-result.ts";
import { HERMES_RENDER_FETCH_TIMEOUT_MS, hermesRenderMessages, type HermesRenderRequest, type SkillVoice } from "../../studio/hermes-render.ts";
import {
  HERMES_RENDER_CHECK_TIMEOUT_MS,
  HERMES_RENDER_START_TIMEOUT_MS,
  parseRenderReply,
  renderCheckMessages,
  type RenderJob,
  type RenderProbe,
  type RenderReply,
} from "../../studio/hermes-render-job.ts";
import { hermesMediaUrlBase, hermesOrigin, hermesTrustedOrigins, providerOrderHint } from "./hermes-image.ts";

/**
 * The hermes renderer (research only), as a job: the portal asks Hermes once, through the shared gate, to start the
 * render into a named file (the start ask), then checks the media host for that file without a Hermes turn (probe and
 * download), and asks one tiny question at most when the budget is spent (the check ask). The clip is checked like a
 * Hermes video clip (hermes-video.ts): a trusted media origin only, the real bytes sniffed, the backend and plugin named
 * for provenance. The flow itself is runHermesRenderStage in production.ts; the decisions are hermes-render-job.ts.
 * Nothing here throws.
 */
export interface HermesRender {
  bytes: Uint8Array;
  info: VideoInfo;
  provider: string;
  backend: string;
  plugin: string;
  model: string;
  /** The /clip/ URL the video was read from. */
  originUrl: string;
  /** hermes.voice skill: the voice backend the skill recorded the narration with (from Hermes's answer), else null. */
  voice: SkillVoice | null;
}

export type RenderAsk = { ok: true; reply: RenderReply } | { ok: false; error: string; cause: FailureClass; busyUntil?: Date; slow?: { afterMs: number } };

/** Where Hermes publishes videos (HERMES_VIDEO_MEDIA_ORIGIN or <HERMES_MEDIA_ORIGINS>/clip), or null when unset. */
export function hermesClipBase(): string | null {
  return hermesMediaUrlBase("video");
}

/**
 * The base the studio names the render file under: the configured video media base, else /clip on the Hermes origin
 * (a Hermes that serves its media itself). Null when Hermes is not set up at all.
 */
export function renderFileBase(): string | null {
  const base = hermesClipBase();
  if (base) return base;
  const origin = hermesOrigin();
  return origin ? `${origin}/clip` : null;
}

async function ask(messages: ChatMessage[], expected: { file: string; url: string }, timeoutMs: number): Promise<RenderAsk> {
  const clipBase = hermesClipBase();
  const trusted = hermesTrustedOrigins();
  // Never re-asked inside the call (retries 0): a second start would render the video twice. Any answer is read
  // leniently, so an answer that is not JSON is "unclear", taken as started, and the file is waited for.
  const r = await hermesText<RenderReply>(messages, (reply) => ({ ok: true, value: parseRenderReply(reply, expected, clipBase, trusted) }), {
    retries: 0,
    timeoutMs: scaledMs(timeoutMs, hermesTimeoutScale(process.env)),
    busyFromReply: true,
  });
  if (r.ok) return { ok: true, reply: r.value };
  return { ok: false, error: r.error, cause: r.cause, ...(r.busyUntil ? { busyUntil: r.busyUntil } : {}), ...(r.slow ? { slow: r.slow } : {}) };
}

/** The start ask: render into `output.file`, answer as soon as it has started. */
export function askRenderStart(request: Omit<HermesRenderRequest, "clipBase" | "output">, output: { file: string; url: string }): Promise<RenderAsk> {
  return ask(hermesRenderMessages({ ...request, clipBase: hermesClipBase(), output }), output, HERMES_RENDER_START_TIMEOUT_MS);
}

/** The check ask: is the named file still being rendered (or, for `provenance`, which tools made it)? */
export function askRenderCheck(job: RenderJob, opts: { voice: boolean; why: "overdue" | "provenance" }): Promise<RenderAsk> {
  return ask(renderCheckMessages(job, opts), { file: job.file, url: job.url }, HERMES_RENDER_CHECK_TIMEOUT_MS);
}

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Looks for the render file on the media host: a HEAD (no download). A host without HEAD, or one that sends no
 * Content-Length, is read with a GET, whose bytes are kept so a stable file is not downloaded twice. Trusted media
 * origins only.
 */
export async function probeRender(url: string): Promise<{ probe: RenderProbe; bytes?: Uint8Array }> {
  const trusted = hermesTrustedOrigins();
  try {
    const h = await headMedia(url, { trustedOrigins: trusted, timeoutMs: PROBE_TIMEOUT_MS });
    if (h.status === 404 || h.status === 410) return { probe: { kind: "missing" } };
    if (h.status >= 200 && h.status < 300 && h.size !== null) return { probe: { kind: "present", size: h.size } };
    // No size in the answer (or no HEAD at all): the GET below measures the file.
    if (!(h.status >= 200 && h.status < 300) && h.status !== 405 && h.status !== 501) return { probe: { kind: "error", message: `The media host answered HTTP ${h.status}` } };
  } catch (err) {
    return { probe: { kind: "error", message: err instanceof Error ? err.message : "The media host could not be reached" } };
  }
  try {
    const got = await fetchMedia(url, { maxBytes: MAX_VIDEO_BYTES, timeoutMs: HERMES_RENDER_FETCH_TIMEOUT_MS, trustedOrigins: trusted });
    return { probe: { kind: "present", size: got.bytes.length }, bytes: got.bytes };
  } catch (err) {
    if (err instanceof SafeFetchError && (err.status === 404 || err.status === 410)) return { probe: { kind: "missing" } };
    return { probe: { kind: "error", message: err instanceof Error ? err.message : "The media host could not be read" } };
  }
}

/** Downloads the finished file and checks it is a real video. */
export async function downloadRender(url: string): Promise<{ ok: true; bytes: Uint8Array; info: VideoInfo } | { ok: false; issue: string }> {
  let bytes: Uint8Array;
  try {
    bytes = (await fetchMedia(url, { maxBytes: MAX_VIDEO_BYTES, timeoutMs: HERMES_RENDER_FETCH_TIMEOUT_MS, trustedOrigins: hermesTrustedOrigins() })).bytes;
  } catch (err) {
    return { ok: false, issue: err instanceof Error ? err.message : "The video could not be read" };
  }
  return checkRenderBytes(bytes);
}

export function checkRenderBytes(bytes: Uint8Array): { ok: true; bytes: Uint8Array; info: VideoInfo } | { ok: false; issue: string } {
  const info = sniffVideo(bytes);
  const issues = videoIssues(info);
  if (issues.length > 0 || !info) return { ok: false, issue: issues[0] ?? "The file is not a video" };
  return { ok: true, bytes, info };
}

/** The provenance of a finished render: the plugin and backend Hermes named (start, check or provenance answer). */
export function renderMaker(replies: ReadonlyArray<RenderReply | null>): { provider: string; backend: string; plugin: string; model: string } {
  const named = replies.find((r) => r && (r.provider || r.backend)) ?? null;
  const maker = resolveHermesMaker({ provider: named?.provider ?? "", backend: named?.backend ?? "" }, providerOrderHint());
  const model = replies.find((r) => r && r.model)?.model ?? "";
  return { provider: maker.provider, backend: maker.backend, plugin: maker.plugin, model };
}
