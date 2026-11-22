/**
 * How the render stage turns what the workers report into a payload and a queued job. Pure.
 *
 * `buildRenderPayload` already refuses an engine the worker cannot run when it is given `workerCapabilities`. This
 * decides *when* to give it that list, which capability the job is queued under, and how a refusal reads on the
 * Review card. Kept out of production.ts so it can be tested without a database.
 */
import type { Capability } from "@venstudio/protocol";
import { capabilityForEngine, isPortalEngine, XFADE_CAPABILITY } from "./render-engine.ts";
import { packCapability } from "./style-registry.ts";

/**
 * The capability list to gate a render on, or undefined to skip the gate.
 *
 * Skipped when the read failed or no worker is enrolled at all: then the job waits in the queue, and the Jobs page
 * already explains that no worker can take it. Failing the stage there would turn "enroll a worker" into an error.
 * Once any worker reports, an engine none of them can run fails at planning, with the engine named.
 */
export function gateCapabilities(reported: readonly string[] | null | undefined): readonly string[] | undefined {
  if (!reported || reported.length === 0) return undefined;
  return reported;
}

/**
 * Who renders a run's video: a worker plugin, reached through the capability the render-video job is queued under,
 * or the portal itself (hermes, research only). Routed by pack plus renderer: a pack's job goes to a worker that
 * reports pack:<id>@<version> (its probe implies the renderer), a job without a pack to one that reports the
 * renderer's capability under the names workers have always reported (ffmpeg, xfade, remotion-2d, html-capture).
 */
export type RenderRoute = { by: "worker"; renderer: string; capability: Capability } | { by: "portal"; renderer: string };

export function renderRoute(engine: string, transitionSec: number = 0, pack?: { id: string; version: string } | null): RenderRoute {
  if (isPortalEngine(engine)) return { by: "portal", renderer: engine };
  return { by: "worker", renderer: engine, capability: renderJobCapability(engine, transitionSec, pack) };
}

/**
 * Capability the render-video job is queued under, so only a worker that can run the engine claims it.
 * The stills engine keeps "ffmpeg", which is what every render-video job used before engines existed. An engine the
 * portal does not know, or one the portal renders itself, is refused by name: it is never queued as stills.
 */
export function renderJobCapability(engine: string, transitionSec: number = 0, pack?: { id: string; version: string } | null): Capability {
  if (isPortalEngine(engine)) throw new Error(`Engine "${engine}" is rendered by the portal through Hermes, never queued for a worker`);
  const known = capabilityForEngine(engine);
  if (known === null) throw new Error(`Unknown render engine "${engine}": nothing was queued, and it is not rendered as stills instead`);
  // A run started with a style pack renders only on a worker that installed and probed exactly that pack version
  // (0.9.0+). Its probe needs the engine (and xfade for stills), so the pack capability implies both.
  if (pack) return packCapability(pack.id, pack.version) as Capability;
  // An engine whose capability is not a worker one (provider, blender) never gets here: the gate refused it, or no
  // worker is enrolled and nothing will claim the job anyway.
  const need = known as Capability;
  // A faded stills timeline is longer than the narration, and a worker without xfade (0.4) refuses it. So with more
  // than one worker, only one that reports xfade may claim it.
  if (need === "ffmpeg" && transitionSec > 0) return XFADE_CAPABILITY as Capability;
  return need;
}

/**
 * Plans with the fade, and again with hard cuts when only the fade stopped it.
 *
 * A cross-fade lengthens every shot but one by its overlap, so a storyboard whose shots already run near the
 * template's limit cannot carry it. `fitTransitionSec` makes the same trade for shots too short for a fade: a render
 * that worked with hard cuts keeps working. When both fail, the faded plan's problems are reported.
 */
export function withFadeFallback<T extends { ok: boolean }>(transitionSec: number, plan: (transitionSec: number) => T): { result: T; transitionSec: number } {
  const faded = plan(transitionSec);
  if (faded.ok || !(transitionSec > 0)) return { result: faded, transitionSec };
  const cut = plan(0);
  return cut.ok ? { result: cut, transitionSec: 0 } : { result: faded, transitionSec };
}

/**
 * The note on the render stage when workers report capabilities but none reports this pack version yet, or null when
 * one does (or nothing is reported yet). The job is queued anyway under the pack capability and waits: workers 0.9.0+
 * install a new pack version with their next signed update (minutes), and the Jobs page says why it waits. An engine
 * no worker can run at all is still refused at planning, by the engine gate.
 */
export function packWaitNote(pack: { id: string; version: string } | null, gate: readonly string[] | undefined): string | null {
  if (!pack || !gate) return null;
  const cap = packCapability(pack.id, pack.version);
  if (gate.includes(cap)) return null;
  return (
    `Waiting for a worker with the style pack ${pack.id} ${pack.version} ("${cap}"). Workers 0.9.0 and later install style ` +
    `packs with their signed updates and report a pack once its renderer probe passes; the render starts then. If it ` +
    `keeps waiting, check the Workers page (update mode, last update result) or run install.sh again.`
  );
}

/** Where the owner finds the Remotion install steps. */
export const REMOTION_DOC = "docs/remotion-worker.md";
export const HTML_CAPTURE_DOC = "docs/html-capture.md";

/**
 * The stage error for a render that could not be planned: each problem once, plus what to do when the cause is an
 * engine no worker can run. The Review card shows this with its Retry button, which plans the render again.
 */
export function renderStageError(issues: readonly string[], engine: string): string {
  const unique = [...new Set(issues.map((i) => i.trim().replace(/\.$/, "")).filter(Boolean))];
  const need = capabilityForEngine(engine);
  const engineBlocked = need !== null && unique.some((i) => i.includes(`"${engine}"`) && i.includes(`"${need}"`));
  const text = unique.join(". ") + ".";
  if (!engineBlocked) return text;
  const how =
    engine === "remotion-2d"
      ? `Update the worker to 0.5.0 or later and install the Remotion renderer on it (install.sh --with-remotion, see ${REMOTION_DOC}). `
      : engine === "html-capture"
        ? `Update the worker to 0.10.0 or later and install the Remotion renderer on it, whose headless Chromium html-capture uses (install.sh --with-remotion, see ${HTML_CAPTURE_DOC}). `
        : `Enable "${need}" on a worker. `;
  return `${text} This style renders with "${engine}", and it is not rendered as a slideshow instead. ${how}Then press Retry.`;
}

/** Capability a worker (0.6.0+) reports when render-video honours `narrationTempo` (ffmpeg atempo on the narration). */
export const NARRATION_TEMPO_CAPABILITY = "narration-tempo";

/**
 * Whether a narration with a changed tempo can be rendered: at least one worker can render (reports ffmpeg) and every
 * worker that can render also reports NARRATION_TEMPO_CAPABILITY. A render job is queued under its engine's
 * capability, so an older worker could claim it and ignore the tempo; requiring all of them rules that out.
 * `workers` holds each non-revoked worker's reported capabilities.
 */
export function tempoReadyFor(workers: ReadonlyArray<readonly string[]>): boolean {
  const renderers = workers.filter((caps) => caps.includes("ffmpeg"));
  return renderers.length > 0 && renderers.every((caps) => caps.includes(NARRATION_TEMPO_CAPABILITY));
}

/** The render stage error for a fitted narration that no worker can play at its tempo yet. */
export function tempoWorkerMessage(tempo: number): string {
  return `This narration is set to play at ${tempo}x so it fits the shots, and every render worker must be 0.6.0 or later to do that. Update the worker (install.sh, same command as before), then press Retry.`;
}

/** Capability a worker (0.7.0+) reports when render-video mixes `audio` (bed, ducking, ambience, accents, master). */
export const AUDIO_MIX_CAPABILITY = "audio-mix";
/** Capability a worker (0.7.0+) reports when render-video draws captions with `captionStyle`. */
export const CAPTION_STYLE_CAPABILITY = "caption-style";

/** What a render may carry beyond the 0.6.0 payload, and the line the run shows when it carries less. */
export interface MixFeatures {
  /** Send `audio` (and so pick a music bed). */
  audio: boolean;
  /** Send `captionStyle`. */
  captionStyle: boolean;
  /** Plain note for the render stage when either is held back. Null when both are sent. */
  note: string | null;
}

/**
 * Whether the render payload may carry `audio` and `captionStyle`. Same rule as the tempo: a render job is queued
 * under its engine's capability, so any render worker (one that reports ffmpeg) may claim it, and an older one would
 * ignore the fields and quietly render the 0.6.0 video. So a field is sent only when every render worker reports the
 * capability that honours it. Unknown (null) or no render worker at all: nothing new is sent, so whichever worker
 * enrolls later renders exactly what the payload says, and the bed's licence is never listed for a video without it.
 */
export function mixFeaturesFor(workers: ReadonlyArray<readonly string[]> | null): MixFeatures {
  const renderers = (workers ?? []).filter((caps) => caps.includes("ffmpeg"));
  const all = (cap: string) => renderers.length > 0 && renderers.every((caps) => caps.includes(cap));
  const audio = all(AUDIO_MIX_CAPABILITY);
  const captionStyle = all(CAPTION_STYLE_CAPABILITY);
  if (audio && captionStyle) return { audio, captionStyle, note: null };
  const missing = [...(audio ? [] : ["music, ambience and the mastered loudness"]), ...(captionStyle ? [] : ["the measured caption style"])].join(" and ");
  const why =
    renderers.length === 0
      ? "no render worker has reported what it can do yet"
      : "every render worker must be 0.7.0 or later for that, and at least one is older";
  return {
    audio,
    captionStyle,
    note: `This video renders without ${missing}: ${why}. Update the worker (install.sh, same command as before); the next render carries them.`,
  };
}
