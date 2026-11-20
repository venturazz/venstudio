import "server-only";
import { hermesText } from "../hermes-json.ts";
import { fetchMedia } from "../safe-fetch.ts";
import { parseTriedProviders, resolveHermesMaker, videoPrompt, type TriedProvider } from "../../studio/asset-plan.ts";
import { extractJson, type Validated } from "../../studio/director.ts";
import type { FailureClass } from "../../studio/pacing.ts";
import type { Format } from "../../studio/catalog.ts";
import type { BeatRole } from "../../studio/templates.ts";
import {
  clipSecondsIssues,
  decodeInlineSource,
  MAX_VIDEO_BYTES,
  parseVideoReply,
  sniffVideo,
  videoIssues,
  type VideoInfo,
} from "../../studio/image-result.ts";
import { hermesMediaUrlBase, hermesTrustedOrigins, providerOrderHint, recordHermesChain } from "./hermes-image.ts";

export interface VideoJob {
  /** What the shot shows. Comes from the storyboard, so it is untrusted text. */
  prompt: string;
  beatRole: BeatRole;
  format: Format;
  shotRef: string;
  /** Seconds for this shot's clip. Must fit the provider's window; see clipSecondsIssues. */
  seconds: number;
  /** text = from the description alone; keyframe = animate one still; reference = keep a character or style. */
  mode: "text" | "keyframe" | "reference";
  sourceImageUrls?: string[];
  /** Owner revision note for this shot, shown to Hermes as data. */
  note?: string;
}

export interface GeneratedVideo {
  bytes: Uint8Array;
  info: VideoInfo;
  /** The name provider terms are tracked under, by backend as for images (resolveHermesMaker). */
  provider: string;
  model: string;
  /** The backend Hermes says really rendered the clip (agnes, veo, kling), normalised. Empty when it did not say. */
  backend: string;
  /** The plugin Hermes asked, normalised. Empty when it did not say. */
  plugin: string;
  /** The URL Hermes gave, when the clip was downloaded. Empty for inline data. */
  originUrl: string;
  mode: VideoJob["mode"];
  seconds: number;
}

export type VideoResult =
  | { ok: true; video: GeneratedVideo; attempts: number; tried: TriedProvider[] }
  | { ok: false; error: string; cause: FailureClass; busyUntil?: Date };

/** A clip is slower and larger than a still, so the download gets its own budget. */
const VIDEO_FETCH_TIMEOUT_MS = 300_000;

function triedIn(reply: string): TriedProvider[] {
  try {
    return parseTriedProviders(extractJson(reply));
  } catch {
    return [];
  }
}

/**
 * Asks Hermes for one video clip through its video chain and checks the real bytes.
 *
 * The clip length is validated *before* the call. The provider returns 4-12s while a short runs 15-60s, so a 30s
 * shot is a planning mistake, not a provider problem, and asking anyway would return something truncated that the
 * studio would only discover at final playback.
 *
 * A reply that is a file path, an unreachable URL or not a video is fed back to Hermes (up to 2 more asks). After
 * that the result is a plain failure, never an exception.
 */
export async function generateVideo(job: VideoJob): Promise<VideoResult> {
  const lengthIssues = clipSecondsIssues(job.seconds);
  if (lengthIssues.length > 0) return { ok: false, error: lengthIssues.join(" "), cause: "content" };

  const trusted = hermesTrustedOrigins();
  const messages = videoPrompt({
    prompt: job.note ? `${job.prompt}\n\nOwner note: ${job.note}` : job.prompt,
    beatRole: job.beatRole,
    format: job.format,
    shotRef: job.shotRef,
    seconds: job.seconds,
    mode: job.mode,
    sourceImageUrls: job.sourceImageUrls,
    providerOrder: providerOrderHint(),
    mediaOrigin: hermesMediaUrlBase("video") ?? undefined,
  });

  const result = await hermesText<GeneratedVideo & { tried: TriedProvider[] }>(
    messages,
    async (reply): Promise<Validated<GeneratedVideo & { tried: TriedProvider[] }>> => {
      const parsed = parseVideoReply(reply);
      if (!parsed.ok) return { ok: false, issues: parsed.issues };
      let bytes: Uint8Array;
      let originUrl = "";
      try {
        const inline = decodeInlineSource(parsed.source);
        if (inline) bytes = inline;
        else {
          const got = await fetchMedia(parsed.source.value, {
            maxBytes: MAX_VIDEO_BYTES,
            timeoutMs: VIDEO_FETCH_TIMEOUT_MS,
            trustedOrigins: trusted,
          });
          bytes = got.bytes;
          originUrl = parsed.source.value;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "The clip could not be read";
        return { ok: false, issues: [`${msg}. Return a public https URL or base64 video data.`] };
      }
      const info = sniffVideo(bytes);
      const issues = videoIssues(info);
      if (issues.length > 0 || !info) return { ok: false, issues };
      const maker = resolveHermesMaker({ provider: parsed.provider, backend: parsed.backend }, providerOrderHint());
      return {
        ok: true,
        value: {
          bytes,
          info,
          provider: maker.provider,
          model: parsed.model,
          backend: maker.backend,
          plugin: maker.plugin,
          originUrl,
          mode: job.mode,
          seconds: job.seconds,
          tried: triedIn(reply),
        },
      };
    },
    { busyFromReply: true },
  );

  if (!result.ok) return { ok: false, error: result.error, cause: result.cause, busyUntil: result.busyUntil };
  const { tried, ...video } = result.value;
  await recordHermesChain(video.backend || video.provider, tried, "video");
  return { ok: true, video, attempts: result.attempts, tried };
}

