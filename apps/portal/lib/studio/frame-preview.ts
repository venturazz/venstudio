/**
 * The still-frame preview (stage "preview", recipes scene-spec and html-design), pure. After the scene spec or the page
 * Hermes wrote is approved, and before the voice and the render, a worker (0.11.0+, job type preview-frames) takes a
 * few still frames of the html-capture page with the run's real render props: the pack's own page for scene-spec, the
 * uploaded page for html-design. The owner approves the look on the Review card or sends a note back to that stage.
 *
 * Without a worker that reports preview-frames, a scene-spec run's card says so and the owner may continue with the
 * spec text only (what the studio did before previews); an html-design run never renders its page without the check.
 */
import type { RenderPayload } from "./render.ts";

export const PREVIEW_CAPABILITY = "preview-frames";
export const DEFAULT_PREVIEW_STILLS = 6;
export const MAX_PREVIEW_STILLS = 12;
/**
 * The narration id the preview's payload is built with (buildRenderPayload needs one), stripped before the job is
 * queued: a preview runs before the voice. Never an asset.
 */
export const PREVIEW_NARRATION_PLACEHOLDER = "00000000-0000-4000-8000-00000000a0a0";

export const NO_PREVIEW_WORKER =
  "No worker reports preview-frames yet (it needs worker 0.11.0 or later with the html-capture renderer), so this card has no still frames.";
export const NO_PREVIEW_CONTINUE = `${NO_PREVIEW_WORKER} You can approve and continue with the spec text only, as before previews; the final video's card shows the real render.`;
export const HTML_DESIGN_NEEDS_PREVIEW =
  `${NO_PREVIEW_WORKER} A page Hermes wrote is never rendered without its still-frame check. Update a worker to 0.11.0 or later with the html-capture renderer (it updates itself when signed updates are on), then press Retry.`;

/** Where the preview stands with the workers that report now (stored rows only, never a call to a worker). */
export type PreviewWorkers = "ready" | "waiting-pack" | "no-worker";

/**
 * "ready": a worker reports preview-frames and the run's pack version (or no pack is needed); "waiting-pack": some
 * worker reports preview-frames but none has this pack version yet (the job waits, as a render does); "no-worker": no
 * worker reports preview-frames. A failed read (null) counts as no worker.
 */
export function previewWorkers(lists: readonly (readonly string[])[] | null, packCapability: string | null): PreviewWorkers {
  const able = (lists ?? []).filter((l) => l.includes(PREVIEW_CAPABILITY));
  if (able.length === 0) return "no-worker";
  if (!packCapability || able.some((l) => l.includes(packCapability))) return "ready";
  return "waiting-pack";
}

/**
 * The times of the stills: the middle of each scene, or of `n` scenes spread over the video when there are more, filled
 * up with evenly spaced times when there are fewer. Sorted, at least 0.25 s apart, inside the video. `starts` are the
 * scene start times and `durationSec` the video's length (the narration's when it exists, otherwise the planned one).
 */
export function previewTimes(starts: readonly number[], durationSec: number, n: number = DEFAULT_PREVIEW_STILLS): number[] {
  const count = Math.max(1, Math.min(MAX_PREVIEW_STILLS, Math.round(n)));
  if (!(durationSec > 0)) return [];
  const round = (x: number) => Math.round(x * 100) / 100;
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] : durationSec));
  const mids = starts.map((s, i) => (s + Math.min(ends[i], durationSec)) / 2).filter((t) => t >= 0 && t < durationSec);
  let picked: number[];
  if (mids.length >= count) {
    picked = count === 1 ? [mids[0]] : Array.from({ length: count }, (_, k) => mids[Math.round((k * (mids.length - 1)) / (count - 1))]);
  } else {
    picked = [...mids];
    for (let k = 0; k < count && picked.length < count; k++) {
      const t = (durationSec * (k + 0.5)) / count;
      if (picked.every((p) => Math.abs(p - t) >= 0.25)) picked.push(t);
    }
  }
  const out: number[] = [];
  for (const t of picked.map(round).sort((a, b) => a - b)) if (out.every((o) => Math.abs(o - t) >= 0.25)) out.push(Math.min(t, round(durationSec - 0.05)));
  return out.slice(0, count);
}

/** Scene start times of a render payload (hard cuts or cross-fades), as the worker's timeline has them. */
export function sceneStartsOf(payload: Pick<RenderPayload, "shots" | "transitionSec">): number[] {
  const fade = payload.shots.length > 1 ? payload.transitionSec : 0;
  const out: number[] = [];
  let at = 0;
  for (const s of payload.shots) {
    out.push(Math.round(at * 1000) / 1000);
    at += s.seconds - fade;
  }
  return out;
}

/**
 * The preview-frames payload from a render payload built with PREVIEW_NARRATION_PLACEHOLDER: the same shots, scene
 * plan, captions and font, without the narration, the tempo or the soundtrack, plus the times and the uploaded page.
 */
export function previewPayload(render: RenderPayload, times: readonly number[], pageAssetId: string | null): Record<string, unknown> {
  const { narrationAssetId, narrationSec: _sec, narrationTempo: _tempo, audio: _audio, ...rest } = render;
  const inputs = render.inputs.filter((i) => i !== narrationAssetId && i !== PREVIEW_NARRATION_PLACEHOLDER);
  return {
    ...rest,
    inputs: pageAssetId ? [...inputs, pageAssetId] : inputs,
    preview: { times: [...times], ...(pageAssetId ? { page: pageAssetId } : {}) },
  };
}

export interface PreviewResult {
  stills: Array<{ name: string; atSec: number }>;
  consoleErrors: string[];
  blocked: string[];
  page: "uploaded" | "pack";
  drawsCaptions: boolean;
  /** Set when the worker stopped drawing before the last asked still (a heavy page, a bounded preview). */
  stopped: string | null;
  /** How many stills the preview asked for, when the worker stopped early. */
  planned: number | null;
}

/** Reads a preview-frames job result (worker 0.11.0), keeping plain values within limits. */
export function parsePreviewResult(raw: unknown): PreviewResult {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 300)) : []);
  const stills = Array.isArray(r.stills)
    ? r.stills.flatMap((s) => {
        const o = typeof s === "object" && s !== null ? (s as Record<string, unknown>) : {};
        return typeof o.name === "string" && /^still-\d{2}\.jpg$/.test(o.name) && typeof o.atSec === "number" && Number.isFinite(o.atSec) ? [{ name: o.name, atSec: o.atSec }] : [];
      })
    : [];
  return {
    stills: stills.slice(0, MAX_PREVIEW_STILLS),
    consoleErrors: texts(r.consoleErrors),
    blocked: texts(r.blocked),
    page: r.page === "uploaded" ? "uploaded" : "pack",
    drawsCaptions: r.drawsCaptions === true,
    stopped: typeof r.stopped === "string" && r.stopped ? r.stopped.slice(0, 300) : null,
    planned: typeof r.planned === "number" && Number.isFinite(r.planned) ? r.planned : null,
  };
}

/** The note on the preview card. */
export function previewNote(i: { stills: number; drawsCaptions: boolean; designed: boolean }): string {
  const what = i.designed ? "the page Hermes wrote (research only)" : "this style's page";
  const caps = i.drawsCaptions ? "" : " Captions are burned in at the render and are not in these stills.";
  return `${i.stills} still frame${i.stills === 1 ? "" : "s"} of ${what}, drawn by a worker with this run's real props before the voice and the render.${caps} Approve the look, or send a note back to the ${i.designed ? "page" : "scene spec"}.`;
}

/** Plain lines for the card: what the page logged and what it tried that was blocked. */
export function previewNotes(r: Pick<PreviewResult, "consoleErrors" | "blocked">): string[] {
  return [
    ...r.consoleErrors.slice(0, 5).map((e) => `The page logged an error: ${e}`),
    ...r.blocked.slice(0, 5).map((b) => `The page tried something the sandbox blocks: ${b}`),
  ];
}
