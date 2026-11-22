import "server-only";
import { hermesText } from "../hermes-json.ts";
import { fetchMedia } from "../safe-fetch.ts";
import { resolveHermesMaker } from "../../studio/asset-plan.ts";
import type { Validated } from "../../studio/director.ts";
import type { FailureClass } from "../../studio/pacing.ts";
import { MAX_VIDEO_BYTES, parseVideoReply, sniffVideo, videoIssues, type VideoInfo } from "../../studio/image-result.ts";
import {
  HERMES_RENDER_ASKS,
  HERMES_RENDER_FETCH_TIMEOUT_MS,
  HERMES_RENDER_TIMEOUT_MS,
  clipUrlIssues,
  hermesRenderMessages,
  skillVoiceOf,
  type HermesRenderRequest,
  type SkillVoice,
} from "../../studio/hermes-render.ts";
import { hermesMediaUrlBase, hermesTrustedOrigins, providerOrderHint } from "./hermes-image.ts";

/**
 * The hermes renderer (research only): asks Hermes, through the shared gate, to render the whole video and checks the
 * clip it publishes, exactly as a Hermes video clip is checked (hermes-video.ts): parse the reply, download from a
 * trusted media origin, sniff the real bytes, and name the backend and plugin for provenance. Never throws.
 */
export interface HermesRender {
  bytes: Uint8Array;
  info: VideoInfo;
  provider: string;
  backend: string;
  plugin: string;
  model: string;
  /** The /clip/ URL Hermes published the video at. */
  originUrl: string;
  /** hermes.voice skill: the voice backend the skill recorded the narration with (from the reply), else null. */
  voice: SkillVoice | null;
}

export type HermesRenderResult =
  | { ok: true; video: HermesRender; attempts: number }
  | { ok: false; error: string; cause: FailureClass; busyUntil?: Date; slow?: { afterMs: number } };


export function hermesClipBase(): string | null {
  return hermesMediaUrlBase("video");
}

export async function renderWithHermes(request: Omit<HermesRenderRequest, "clipBase">): Promise<HermesRenderResult> {
  const clipBase = hermesClipBase();
  const trusted = hermesTrustedOrigins();
  const result = await hermesText<HermesRender>(
    hermesRenderMessages({ ...request, clipBase }),
    async (reply): Promise<Validated<HermesRender>> => {
      const parsed = parseVideoReply(reply);
      if (!parsed.ok) return { ok: false, issues: parsed.issues };
      // A skill that records its own voice must say with what, so the narration's provenance and terms are known.
      const voice = request.voice === "skill" ? skillVoiceOf(reply) : null;
      if (request.voice === "skill" && !voice) {
        return { ok: false, issues: ['Name the voice backend you recorded the voiceover with: "voice":{"provider":"<the voice tool>","source":"<the backend that spoke it>","model":"<model>"}'] };
      }
      const urlIssues = clipUrlIssues(parsed.source, clipBase);
      if (urlIssues.length > 0) return { ok: false, issues: urlIssues };
      let bytes: Uint8Array;
      try {
        bytes = (await fetchMedia(parsed.source.value, { maxBytes: MAX_VIDEO_BYTES, timeoutMs: HERMES_RENDER_FETCH_TIMEOUT_MS, trustedOrigins: trusted })).bytes;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "The video could not be read";
        return { ok: false, issues: [`${msg}. Publish the MP4 on your media host under /clip/ and reply with its URL.`] };
      }
      const info = sniffVideo(bytes);
      const issues = videoIssues(info);
      if (issues.length > 0 || !info) return { ok: false, issues };
      const maker = resolveHermesMaker({ provider: parsed.provider, backend: parsed.backend }, providerOrderHint());
      return {
        ok: true,
        value: { bytes, info, provider: maker.provider, backend: maker.backend, plugin: maker.plugin, model: parsed.model, originUrl: parsed.source.value, voice },
      };
    },
    // Hermes is one agent: while it renders, the gate's slot is held, so other Hermes asks wait (research only, rare).
    { busyFromReply: true, timeoutMs: HERMES_RENDER_TIMEOUT_MS, retries: HERMES_RENDER_ASKS - 1 },
  );
  if (!result.ok) return { ok: false, error: result.error, cause: result.cause, busyUntil: result.busyUntil, ...(result.slow ? { slow: result.slow } : {}) };
  return { ok: true, video: result.value, attempts: result.attempts };
}
