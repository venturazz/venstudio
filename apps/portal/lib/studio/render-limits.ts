/**
 * What one render-video job may hold, shared by the storyboard check, the scene plan, the caption lines and the render
 * payload, and mirrored by RENDER_LIMITS in apps/worker/venstudio-worker.ts (the worker cannot import portal code;
 * apps/worker/audio-mix.test.ts checks both are the same object).
 *
 * Derived from the catalogue, not guessed: the longest video is 1200 s (VIDEO_FORMATS.long) and the fastest style
 * cuts every 2 s, so a legitimate long explainer has up to 600 shots; captions are at most two lines a shot. A limit
 * that differed between the portal and the worker would fail a render after its images and narration were paid for.
 */
export const RENDER_LIMITS = { maxShots: 600, maxSeconds: 1800, maxCaptions: 1200, minShotSeconds: 0.5 } as const;
