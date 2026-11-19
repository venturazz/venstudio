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
 *
 * This file contains types only, so the worker can import it with
 * `import type` and run without any npm dependencies.
 */

export const PROTOCOL_VERSION = 1;

/** What a worker can run. The portal only hands out jobs whose capability the worker reports. */
export type Capability =
  | "echo"
  | "ffmpeg"
  | "tts-kokoro"
  | "remotion-2d"
  | "remotion-3d"
  | "godot"
  | "manim";

export const CAPABILITIES: readonly Capability[] = [
  "echo",
  "ffmpeg",
  "tts-kokoro",
  "remotion-2d",
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
export const WORKER_VERSION = "0.4.0";

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
