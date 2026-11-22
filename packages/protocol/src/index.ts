/**
 * Worker <-> portal protocol (version 1).
 *
 * Workers only make outbound HTTPS calls. All endpoints live under
 * /api/worker and, except /enroll, require `Authorization: Bearer <token>`.
 *
 *   POST /api/worker/enroll                      EnrollRequest  -> EnrollResponse
 *   POST /api/worker/claim                       ClaimRequest   -> ClaimResponse | 204 (long-polls up to waitSeconds)
 *   POST /api/worker/jobs/:id/heartbeat          HeartbeatRequest -> HeartbeatResponse
 *   PUT  /api/worker/jobs/:id/artifacts/:name    raw body       -> ArtifactResponse
 *   POST /api/worker/jobs/:id/complete           CompleteRequest -> { ok: true }
 *   POST /api/worker/jobs/:id/fail               FailRequest    -> { ok: true }
 *   GET  /api/worker/update                      -> UpdateInfoResponse (the worker's self-test)
 *   POST /api/worker/update                      UpdateCheckRequest -> UpdateCheckResponse (worker 0.8.0+)
 *   POST /api/worker/update/report               UpdateReportRequest -> { ok: true }
 *
 * This file contains types only, so the worker can import it with
 * `import type` and run without any npm dependencies.
 */

export const PROTOCOL_VERSION = 1;

/** What a worker can run. The portal only hands out jobs whose capability the worker reports. */
export type Capability =
  | "echo"
  | "ffmpeg"
  /** The worker builds cross-fades between shots (ffmpeg xfade) and accepts the longer shot timeline they need. */
  | "xfade"
  /** render-video honours narrationTempo: the narration is played at a small tempo change (ffmpeg atempo). Worker 0.6.0+. */
  | "narration-tempo"
  /**
   * render-video honours payload.audio: a music bed ducked under the narration (looped or trimmed to the cut),
   * synthesised ambience, accents and a mastered loudness. Reported only where ffmpeg has every filter of that chain.
   * Worker 0.7.0+.
   */
  | "audio-mix"
  /** render-video draws captions with payload.captionStyle (size, outline, shadow, margins, wrap width). Worker 0.7.0+. */
  | "caption-style"
  | "tts-kokoro"
  | "remotion-2d"
  /**
   * render-video renders engine html-capture: an HTML template captured frame by frame in the headless Chromium of the
   * Remotion project. Reported only after a 1-second probe page rendered on this machine with its one network request
   * blocked. Worker 0.10.0+.
   */
  | "html-capture"
  | "remotion-3d"
  | "godot"
  | "manim"
  /**
   * A style pack this worker installed (style-packs.json) and whose renderer probe passed here, at exactly this
   * version: `pack:<id>@<version>`. Worker 0.9.0+. The portal queues a render of a pack under this capability.
   */
  | `pack:${string}`;

export const CAPABILITIES: readonly Capability[] = [
  "echo",
  "ffmpeg",
  "xfade",
  "narration-tempo",
  "audio-mix",
  "caption-style",
  "tts-kokoro",
  "remotion-2d",
  "html-capture",
  "remotion-3d",
  "godot",
  "manim",
];

/**
 * `tick`: run until the queue is empty, then exit.
 * `hold`: stay online for a time budget (~55 min), then exit (Muse hourly task).
 * `daemon`: run forever (VPS / GPU box).
 */
export type WorkerMode = "tick" | "hold" | "daemon";

export type JobType =
  | "echo"
  | "smoke-test"
  | "analyze-video"
  | "render-preview"
  | "qc-video"
  | "tts"
  | "render-video"
  | "fetch-asset"
  | "agent-task";

export interface EnrollRequest {
  code: string;
  name: string;
  host: "muse" | "vps" | "local";
  capabilities: Capability[];
  version: string;
}

export interface EnrollResponse {
  workerId: string;
  token: string;
}

/** Latest worker release. Workers older than this are shown as out of date in the portal. */
export const WORKER_VERSION = "0.10.0";

export interface ClaimRequest {
  capabilities: Capability[];
  /** Job types this worker's code can run. The portal never hands it any other type. */
  jobTypes?: JobType[];
  mode: WorkerMode;
  version: string;
  /** Long-poll: the portal may hold the request up to this many seconds (max 25) waiting for a job. */
  waitSeconds?: number;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  capability: Capability;
  payload: Record<string, unknown>;
  attempt: number;
  /** ISO timestamp. Send a heartbeat well before this or the job returns to the queue. */
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
}

export interface ClaimResponse {
  job: ClaimedJob;
}

export interface HeartbeatRequest {
  /** 0..1 */
  progress?: number;
  message?: string;
}

export interface HeartbeatResponse {
  leaseExpiresAt: string;
  /** True when someone cancelled the job in the portal. Stop work and exit the job. */
  cancel: boolean;
}

export interface ArtifactResponse {
  name: string;
  bytes: number;
  sha256: string;
}

export interface CompleteRequest {
  result?: Record<string, unknown>;
  message?: string;
}

export interface FailRequest {
  error: string;
  /** False for errors that will fail again (bad input). The portal then skips remaining retries. */
  retryable: boolean;
}

export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// Signed self-update (worker 0.8.0+). See docs/worker-updates.md and apps/portal/lib/update-manifest.ts.

export interface UpdateManifestFile {
  name: "venstudio-worker.ts" | "render-remotion.json" | "style-packs.json";
  sha256: string;
  bytes: number;
}

/** Signed by the portal's Ed25519 key over "venstudio-update-manifest-v1\n" + canonical JSON without `signature`. */
export interface UpdateManifest {
  format: 1;
  keyId: string;
  workerId: string;
  version: string;
  pin: boolean;
  release: string;
  issuedAt: string;
  expiresAt: string;
  files: UpdateManifestFile[];
  signature: string;
}

export interface UpdateCheckRequest {
  version: string;
  /** SHA-256 of each file the worker has; the bundle is null without a Remotion project, "unknown" without its marker. */
  files: { "venstudio-worker.ts": string; "render-remotion.json": string | null; "style-packs.json"?: string | null };
  /** Id of the key this worker pinned, if any. */
  keyId?: string;
}

export interface UpdateCheckResponse {
  /** Null when nothing is offered (current, updates off, or waiting for the owner's approval). */
  manifest: UpdateManifest | null;
  reason: "current" | "off" | "awaiting-approval" | "approved" | "auto";
}

export interface UpdateInfoResponse {
  keyId: string;
  mode: "auto" | "approve" | "off";
}

export interface UpdateReportRequest {
  status: "ok" | "refused" | "rolled_back" | "failed";
  /** The version this result is about (the one installed for "ok", the one refused or rolled back otherwise). */
  version: string;
  detail: string;
}
