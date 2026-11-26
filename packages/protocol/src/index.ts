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
  /**
   * render-video runs engine hermes-mux: the run's narration (and its mix) laid on a picture Hermes rendered, with the
   * shared audio chain; a short picture holds its last frame (tpad). Reported only where ffmpeg has the audio-mix chain
   * and tpad. Worker 0.13.0+.
   */
  | "hermes-mux"
  | "tts-kokoro"
  | "remotion-2d"
  /**
   * render-video renders engine html-capture: an HTML template captured frame by frame in the headless Chromium of the
   * Remotion project. Reported only after a 1-second probe page rendered on this machine with its one network request
   * blocked. Worker 0.10.0+.
   */
  | "html-capture"
  /**
   * The worker takes still frames of an html-capture page (job type preview-frames): an installed pack's page or a page
   * uploaded with the job (html-design), with the run's props, through the same isolation as html-capture. Reported
   * only after the html-capture probe and a still of the probe page passed on this machine. Worker 0.11.0+.
   */
  | "preview-frames"
  /**
   * render-video renders engine command: a style pack's fixed render argv run with the tools its environment
   * installed, then the shared encode, caption, audio and probe steps. Reported where ffmpeg runs. Worker 0.12.0+.
   */
  | "command"
  | "remotion-3d"
  | "godot"
  | "manim"
  /**
   * A style pack this worker installed (style-packs.json) and whose renderer probe passed here, at exactly this
   * version: `pack:<id>@<version>`. Worker 0.9.0+. The portal queues a render of a pack under this capability.
   */
  | `pack:${string}`
  /**
   * An environment a style pack's recipe installed on this worker (`env:<id>@<version>`, <home>/envs/<id>@<version>/),
   * reported only after its probe passed here. Worker 0.12.0+.
   */
  | `env:${string}`
  /**
   * An agent skill this worker installed from agent-skills.json (`skill:<id>@<version>`, <home>/agent-skills/), reported
   * only where the Muse agent takes tasks. Worker 0.17.0+. The portal queues a Muse render of that skill under it.
   */
  | `skill:${string}`;

export const CAPABILITIES: readonly Capability[] = [
  "echo",
  "ffmpeg",
  "xfade",
  "narration-tempo",
  "audio-mix",
  "caption-style",
  "hermes-mux",
  "tts-kokoro",
  "remotion-2d",
  "html-capture",
  "preview-frames",
  "command",
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
  /** Still frames of an html-capture page with a run's props, before the voice and the render (worker 0.11.0+). */
  | "preview-frames"
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
export const WORKER_VERSION = "0.19.1";

export interface ClaimRequest {
  capabilities: Capability[];
  /** Job types this worker's code can run. The portal never hands it any other type. */
  jobTypes?: JobType[];
  mode: WorkerMode;
  version: string;
  /** Long-poll: the portal may hold the request up to this many seconds (max 25) waiting for a job. */
  waitSeconds?: number;
  /** The environments this worker's packs need and how their installs stand (worker 0.12.0+). */
  environments?: EnvironmentReport[];
}

/** One environment on a worker: installing, ready (its probe passed; also reported as env:<id>@<version>) or failed. */
export interface EnvironmentReport {
  id: string;
  version: string;
  status: "installing" | "ready" | "failed";
  /** Why it failed, or what it is doing. */
  detail: string;
  /** The packs that use it, as <id>@<version>. */
  packs: string[];
  /** When the status last changed (ISO 8601). */
  at: string;
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
  name: "venstudio-worker.ts" | "render-remotion.json" | "style-packs.json" | "env-packs.json" | "agent-skills.json";
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
  files: { "venstudio-worker.ts": string; "render-remotion.json": string | null; "style-packs.json"?: string | null; "env-packs.json"?: string | null; "agent-skills.json"?: string | null };
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
  /**
   * Worker 0.19.0+: the sha256 of the install.sh this portal serves, so a worker that has no Remotion project can run
   * that installer itself and check the file it fetched against this. Absent from older portals.
   */
  installSha256?: string;
}

export interface UpdateReportRequest {
  status: "ok" | "refused" | "rolled_back" | "failed";
  /** The version this result is about (the one installed for "ok", the one refused or rolled back otherwise). */
  version: string;
  detail: string;
}
