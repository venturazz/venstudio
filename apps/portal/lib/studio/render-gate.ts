/**
 * How the render stage turns what the workers report into a payload and a queued job. Pure.
 *
 * `buildRenderPayload` already refuses an engine the worker cannot run when it is given `workerCapabilities`. This
 * decides *when* to give it that list, which capability the job is queued under, and how a refusal reads on the
 * Review card. Kept out of production.ts so it can be tested without a database.
 */
import type { Capability } from "@venstudio/protocol";
import { capabilityForEngine } from "./render-engine.ts";

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
 * Capability the render-video job is queued under, so only a worker that can run the engine claims it.
 * The stills engine keeps "ffmpeg", which is what every render-video job used before engines existed.
 */
export function renderJobCapability(engine: string): Capability {
  // An engine whose capability is not a worker one (provider, blender) never gets here: the gate refused it, or no
  // worker is enrolled and nothing will claim the job anyway.
  return (capabilityForEngine(engine) ?? "ffmpeg") as Capability;
}

/** Where the owner finds the Remotion install steps. */
export const REMOTION_DOC = "docs/remotion-worker.md";

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
      : `Enable "${need}" on a worker. `;
  return `${text} This style renders with "${engine}", and it is not rendered as a slideshow instead. ${how}Then press Retry.`;
}
