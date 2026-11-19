# Architecture: autonomous studio

Companion to [docs/research/04-autonomous-studio-workflow.md](research/04-autonomous-studio-workflow.md). That file
holds the reasoning and sources. This file holds the design that code follows. Stage ids, gate ids, thresholds,
autonomy levels and template statuses here must match the research doc exactly.

## 1. Components and data flow

```
 Owner (phone/desktop)
   │ plan, assign workers, approve ideas/revisions/uploads
   ▼
 ┌──────────────────────────── Portal (Next.js) + Postgres ───────────────────────────┐
 │ templates · pipeline_runs/stages · work_orders · qc_reports · assets+provenance     │
 │ state machine · gates · autonomy · YouTube upload (tokens stay here)                │
 └───────┬───────────────────────┬──────────────────────────────┬─────────────────────┘
         │ HTTP (coolify net)    │ HTTP (coolify net)           │ HTTPS, outbound-only from workers
         ▼                       ▼                              ▼
   Hermes (brain,          9router (cheap            Pull workers (Muse VMs, VPS, PC)
   skills, images,         models, TTS,              claim -> heartbeat -> complete
   vision QC)              images)                    ffmpeg draft/render, qc-video,
                                                      agent-task inbox (Muse agent)
```

Hermes is the first place the studio looks for any capability (research, script, storyboard, images, CapCut editing,
music, thumbnails). 9router is called directly where raw bytes and deterministic errors matter (narration today, images
as the second choice). The portal finds out what exists by asking both (the capability scan, section 5) and needs no
variables beyond `NINEROUTER_*` and `HERMES_*`.

Rules: workers never receive YouTube tokens, `ENCRYPTION_KEY` or 9router keys. Muse is never contacted inbound.
Hermes and 9router are reached by container name on the Docker `coolify` network, never exposed publicly.

## 2. Pipeline state machine

Stage ids in order: `idea`, `research`, `script`, `storyboard`, `assets`, `voice`, `draft`, `render`, `qc`,
`approval`, `upload`, `claim-watch`, `publish`, `learn`.

Run states: `running`, `waiting-human`, `failed`, `done`, `cancelled`.
Stage states: `pending`, `running`, `passed`, `failed`, `waiting-human`, `skipped`.

```
 idea ─▶ research ─▶ script ─▶ storyboard ─▶ assets ─▶ voice ─▶ draft ─▶ render ─▶ qc
  │                    │G-script   │G-storyboard │G-assets  │G-voice                  │G-technical
  │                    │           │             │          │                         │G-presentation
  │ owner/auto         │           │             │          │                         │G-compliance
  ▼                    ▼ fail: back to owning stage, max 2 retries, then waiting-human
 (autonomy ≥ 2 picks)                                                                  ▼
 approval ─▶ upload (private) ─▶ claim-watch (6 h, G-claims) ─▶ publish ─▶ learn
   │ owner, or policy at level 3 (score ≥ 85, proven, not paused, every 5th video to owner)
   └ revision note ─▶ Hermes picks the owning stage ─▶ reruns from there
```

Gate pass tests are in section 4 of the research doc and are encoded as pure functions in `apps/portal/lib/studio`
(FEAT-003). Executors per stage:

| Stage | Executor |
|---|---|
| idea, research, script, storyboard | hermes |
| assets | portal work orders: Hermes `image_gen` chain (Hermes picks its providers), then a 9router image model only once a real call proved it, CC0 library through a worker `fetch-asset` job, Muse agent task only behind a flag |
| voice | portal: optional Kokoro override, then Kokoro through 9router, then Hermes asked for Kokoro, then CapCut through Hermes |
| draft | skipped in Phase 4 (no animatic yet) |
| render | worker (`render-video`) |
| qc | worker `qc-video` plus portal rules; vision (`G-presentation`) not built, the owner decides |
| approval | human or autonomy policy |
| upload | portal (YouTube API, private) |
| claim-watch | portal (wait, then read status) |
| publish | portal |
| learn | portal (metrics into template stats) |

## 3. Data model (migrations 0007 to 0011)

All tables use `uuid` primary keys and `timestamptz` times, matching existing migrations. Append-only numbered SQL;
`scripts/e2e.sh` asserts a second migrate run says "up to date".

| Table | Columns (summary) |
|---|---|
| `templates` | `id`, `slug` unique, `name`, `status` (`draft`,`candidate`,`proven`,`retired`), `style_id` (catalog key), `current_version`, `created_at`, `updated_at` |
| `template_versions` | `id`, `template_id`, `version`, `spec` jsonb (beats, pacing limits, identity, audio rules, asset policy), `checklist` jsonb, `signed_by`, `signed_at`, unique (`template_id`,`version`) |
| `template_trials` | `id`, `template_id`, `version`, `kind` (`lab`,`production`), `passed_technical` bool, `presentation_score` int, `asset_failures` int, `compliance_failures` int, `claim` bool, `qc_report_id`, `created_at` |
| `pipeline_runs` | `id`, `channel_id`, `template_id`, `template_version`, `topic`, `state`, `autonomy_level` at start, `kind` (`production`,`lab`), `created_at`, `finished_at` |
| `pipeline_stages` | `id`, `run_id`, `stage` (stage id), `state`, `attempt`, `output` jsonb, `error`, `started_at`, `finished_at`, unique (`run_id`,`stage`,`attempt`) |
| `work_orders` | `id`, `run_id`, `stage`, `shot_ref`, `executor` (`hermes-image`,`muse-agent`,`router`,`worker-tool`,`library`), `spec` jsonb, `state`, `job_id`, `asset_id`, `attempts`, `created_at` |
| `qc_reports` | `id`, `run_id`, `asset_id`, `gate`, `passed` bool, `score` int null, `details` jsonb, `executor`, `created_at` |
| `channels` (alter) | add `autonomy_level` smallint default 1 check 0..3, `autonomy_paused` bool default false |

Seed styles from `03` are inserted as `candidate` templates, never `proven`.

As built in `0007_templates_pipeline.sql`: template ids are text (`tpl-<style id>`) so seeds are stable, `template_versions.spec`
holds the whole template document, and `qc_reports` also carries `production_id` and `job_id` because a QC job on a
production has no pipeline run yet. `pipeline_runs` has an optional `production_id`. `productions` gains `template_id`
and `template_version`. The Templates page seeds the candidates on first load (`ensureSeedTemplates`, insert only, never
overwrites a promoted row). It first counts the stored seeds and writes nothing when all are present, and a database
error is logged and shown as a "not ready" notice. `templates.status` mirrors `template_versions.spec.status`; reads use
the spec, so any status change must write both in one transaction.

QC wiring: the job `complete` and `fail` routes call `evaluateQcCompletion`. For a `qc-video` job with a `productionId`
it stores one `G-technical` report (a failed report for a failed job, unreadable result or missing template). Writes
are an upsert on the unique index `qc_reports(job_id, gate) WHERE job_id IS NOT NULL`, so concurrent evaluations store
one row and a retried job replaces its stale report. A reconcile pass then re-evaluates the 20 newest finished QC jobs
(last 7 days) whose production exists and that have no report newer than their finish time. `reapExpiredLeases` runs
the same pass when it fails a job for good, so lease-expiry failures get their report on the next claim or dashboard
load instead of waiting for another job to finish. `combineGates` requires the publish gates (technical,
presentation, assets, compliance, claims) and returns `missingGates`; a missing gate is never a pass. `decideNext` takes
the stage id so level 1 asks the owner to approve the `idea` stage, and sends a missing gate to the owner.

As built in `0008_director.sql`: `channels.plan` (text, written only by the owner in the channel form; Hermes reads it when it
proposes ideas), `pipeline_runs.config` (jsonb: format, themeId, language, durationSec, styleId, purposes, topicHint, set
once at start) and `review_items` (`id`, `run_id`, `stage`, `kind` of `idea`, `approval`, `gate-failure` or
`stage-error`, `state` of `open`, `approved`, `revision`, `rejected` or `superseded`, `payload` jsonb, `note`,
`decided_by`, `decided_at`, `created_at`). A unique index allows one open item per run, stage and kind. Nothing in the
engine writes the channel category, the worker mapping or the autonomy level.

As built in `0009_production_assets.sql` (Phase 4): `asset_providers` (primary key `name`+`kind`; `kind` is `image`, `tts` or
`library`; `commercial_ok` is `unknown` (default), `yes` or `no`; `note`, `confirmed_by`, `confirmed_at`). A provider row
is inserted as `unknown` the first time an asset from it is saved, and only the owner's Settings action
(`setProviderTerms`) ever changes `commercial_ok`. Nothing reads a model's claim about licensing. `work_orders` gains
`result` (jsonb), `error`, `provider`, `started_at` and `updated_at`, and an index on (`run_id`, `state`). `G-assets` and
`G-voice` fail with "Confirm the commercial-use terms for <provider> in Settings" while a provider is `unknown`, and
with a "cannot be published" issue when it is `no`. `scripts/e2e.sh` checks the tables exist, that no provider starts
cleared, and that a second migrate run says "up to date".

As built in `0010_capabilities.sql` (Phase 4.5): `capability_scans` is a one-row table (`id` text primary key default
`current`, `scanned_at`, `hermes` jsonb, `router` jsonb, `error`). The scan upserts it. Pages read only this row and never
call Hermes or 9router while rendering. `scripts/e2e.sh` checks the table exists.

As built in `0011_hermes_pacing.sql`: `hermes_gate` is a one-row table (`id` text primary key `hermes`, `busy_until`,
`consecutive`, `last_status`, `last_reason`, `updated_at`) holding the shared Hermes busy time. `endpoint_health`
(primary key `endpoint`+`model`+`kind`; `endpoint` is `9router` or `hermes`, `kind` is `image` or `tts`;
`last_success_at`, `last_failure_at`, `failure_class` of `busy`, `auth`, `client`, `server`, `unreachable` or
`content`, `last_error`, `quarantined_at`, `successes`, `failures`) records what real calls showed. `pipeline_stages`
gains `not_before`, and `work_orders` gains `not_before` and `wait_reason`. `scripts/e2e.sh` checks the tables, the
idle gate row, the columns and the failure-class check. See section 5, Pacing and endpoint health.

Template Lab server path (no UI yet, UI is Phase 7): `lib/server/template-lab.ts` `blendDraft(jobIds, baseStyleId)` reads
the `analysis.json` of succeeded `analyze-video` jobs, blends the numeric fingerprints, runs the originality guard and
saves a `draft` template. A draft stays a draft; `readyForTrials` is true only with three or more samples.

## 4. Job types

| Job type | Phase | Runs on | Purpose | Verified |
|---|---|---|---|---|
| `qc-video` | 2 | worker | ffprobe, ebur128, blackdetect, silencedetect, freezedetect, keyframe extraction; returns a measurement report for `G-technical`. Takes `productionId` or `runId` | In CI (`scripts/e2e.sh`) |
| `render-video` | 4 | worker (ffmpeg) | Renders ordered stills with a gentle zoom, the narration WAV and captions to `video.mp4` (x264 veryfast, 2 threads, loudnorm). Shots must add up to the narration length within 1 s | Code and offline tests. Real render runs in CI (`scripts/e2e.sh`, then `scripts/ui-e2e.mjs`). Not yet run on a Muse VM |
| `fetch-asset` | 4 | any worker (capability `echo`) | Downloads one CC0 or public-domain image or audio file from an allowlisted host, checks magic bytes, hashes it, uploads it | Offline tests with a local server. Never run against a real host |
| `tts` | 4 | worker that sets `VENSTUDIO_KOKORO_URL` | Narration chunks through Kokoro to `narration.wav` | Offline tests. The portal does not create it: it speaks in-process, so no key reaches a worker |
| `agent-task` | 4 | Muse worker, hold mode, `VENSTUDIO_AGENT_TASKS=1` | Hands a work order to the Muse agent through the inbox (section 6) | **UNVERIFIED** |

Existing job types (`analyze-video`, `render-preview`, and others) stay. A new job type needs: `JOB_TYPES` in
`lib/server/jobs.ts`, the `JobType` union in `packages/protocol` (a unit test compares the two), a worker handler, a
`WORKER_VERSION` bump (0.4.0) and worker tests.

## 5. Executor abstraction

A work order has an `executor`. The portal resolves it through one interface (pure, so it is unit-testable):

```
Executor { id, canHandle(workOrder): boolean, run(workOrder): Promise<ExecutorResult> }
ExecutorResult { assetBytesRef | text | json, provenance }
```

Provenance is created by the executor wrapper, not by the model, so it cannot be forgotten or invented. Fallback order:
worker tool, Hermes image, Muse agent task, CC0 library, licensed library (research doc section 5).

### As built in Phase 4
The default image source is Hermes' own `image_gen` chain (the owner reports cloudflare, agnes, canva, qwen, minimax,
sensenova and others, working today). The portal asks for one image per shot (`VENSTUDIO_STAGE: image`) and does not
choose a provider; the optional env `HERMES_IMAGE_PROVIDER_ORDER` is only a hint in the prompt. The reply is JSON
`{status, provider, model, image:{type, value, mimeType}, error}` where `type` is `url`, `base64` or `data-uri`. A
markdown link, a bare URL or a `data:` URI in free text is accepted as a fallback. A file path is a validation issue
that is fed back to Hermes. The portal checks the bytes itself: PNG, JPEG or WebP by magic bytes, at most 20 MB, short
side at least 480 px. URLs are fetched through an SSRF-safe fetcher (`lib/server/safe-fetch.ts`: https only except the
configured Hermes origin, private, loopback, link-local, NAT64 and 6to4 addresses refused after DNS lookup, size and
time limits, 3 redirects). The Hermes exemption matches scheme, host and port of `HERMES_BASE_URL` exactly and only for
the first request: a redirect never keeps it, and a redirect into that origin is refused. The provider name Hermes
reports is a self-report and Hermes is the only source of it. A name in `HERMES_IMAGE_PROVIDER_ORDER` is stored as is;
any other name, and every name when the order is empty (the default), is stored as `unlisted-<name>`, a separate
provider the owner has to confirm in Settings before anything from it can publish. A reply can still claim any name
inside the order, so list only providers whose terms you have checked. Confirming `cloudflare` in Settings does not clear
`unlisted-cloudflare` while `HERMES_IMAGE_PROVIDER_ORDER` is unset; the owner confirms the `unlisted-` name. The review card shows the names with
"stated by Hermes, not verified". If Hermes serves files from another port or host than `HERMES_BASE_URL`, list that
origin in `HERMES_MEDIA_ORIGINS`. That first request may use plain http and private hosts, so list only origins you control.
CapCut backup narration must be WAV or MP3: the portal can measure those lengths, so an Ogg reply is fed back to
Hermes with a request for WAV or MP3.

Fallback chain per shot (`fallbackChain`), one work order at a time (`FOR UPDATE SKIP LOCKED`):
1. Hermes image, two attempts, each asking Hermes up to 3 times with the problems fed back. (Since 0011: a rate limit
   is not an attempt, and a 9router image model proven by a real call comes between this step and the CC0 library.)
2. CC0 library: Hermes names a candidate (`VENSTUDIO_STAGE: cc0`), the portal checks the host allowlist and a CC0 or
   public-domain licence string, and a `fetch-asset` job downloads it. The work order waits for the job. The licence
   text is Hermes' claim, so it is stored as "Claimed ... (stated by Hermes, not verified)" with the licence or source
   link, and the host is a provider the owner has to confirm in Settings.
3. Muse agent task, only when `MUSE_AGENT_TASKS=1` on the portal.
A shot that fails the whole chain fails its work order with the reasons. Retry in Review resets only failed orders.

Voice (superseded in part by Phase 4.5 below; the optional override still behaves like this): Kokoro is narration (OpenAI-compatible `POST /v1/audio/speech` with `response_format: wav`, `GET
/v1/audio/voices`; env `KOKORO_BASE_URL`, `KOKORO_API_KEY`, `KOKORO_MODEL`, `KOKORO_VOICE`). The portal splits the
script, speaks each chunk, and joins the WAV pieces in pure JS (the portal image has no ffmpeg). The backup is CapCut
through Hermes (`VENSTUDIO_STAGE: tts-capcut`, same reply contract with an `audio` field), used when Kokoro is not
configured, fails, or does not cover the language. `TTS_BACKUP=off` disables it. WAV length and clipping are measured in
the portal and MP3 length is read from the frame headers. Clipping of non-WAV audio is measured by the render, and
Ogg length falls back to the script estimate. The render fails when ffprobe finds the real narration more than 1 s
from the length the shots were planned for. English is the only language treated as verified, and the voice stage
summary says so for any other voice.

Captions: the portal sends the newest font asset (`kind = 'font'`) as `fontAssetId`, as the preview render does. Without
a font the render still runs and the stage summary says no captions were burned in.

Render and QC: `render-video` is queued at urgent priority for the channel's home worker. The job complete and fail
routes call `onJobFinished`, and the reaper reconciles stuck runs, because there is no scheduler. The rendered
`video.mp4` is saved as an asset, then a `qc-video` job measures it and stores `G-technical` against the run.
`G-presentation`, `G-compliance` and `G-claims` are not produced, so they show as missing and the owner decides.
Approving the `qc` stage sets the run to `done`. Upload is a later phase.

Provenance is automatic: `buildProvenance` writes source, licence text and origin for each executor. Provider terms
follow section 3. At autonomy level 1 the owner approves `idea` and `assets`; later production stages continue on their
own when their gates pass and ask the owner when they fail. Production stages never revise automatically and never
publish. Nothing here writes the channel category, the worker mapping or the autonomy level.

### As built in Phase 4.5: Hermes first, no extra env
The owner already has Kokoro, `image_gen`, CapCut and other skills reachable through Hermes and 9router, so the studio
discovers them instead of asking for more variables.

Discovery flow (`lib/server/capabilities.ts`, pure rules in `lib/studio/capabilities.ts`):
1. A scan runs when the owner presses **Scan now** (Settings, Studio capabilities), or in the background when the stored
   snapshot is missing, older than 6 hours, or older than 10 minutes with a source down. It never runs synchronously
   while a page renders, and the scan never fails as a whole: each source records its own status and hint.
2. Hermes is asked (`VENSTUDIO_STAGE: capabilities`, 120 s) to list, from its own skill listing, the skills that help
   make videos, the stage ids each serves, its `image_gen` providers and its voice engines. The reply is validated
   (lists capped, unknown stage ids dropped, strings truncated, nothing executable). `GET /v1/skills` is merged in when it
   answers.
3. 9router is probed with 15 s per probe (list paths and request shapes follow the 9router SKILL.md: `GET /v1/models`,
   `/v1/models/{image,tts,web,stt,image-to-text}`, `POST /v1/audio/speech {model,input}`, `POST /v1/images/generations
   {model,prompt,n,size,response_format}`, 503 "All accounts unavailable" retried once after `Retry-After`, 401 means refresh
   the key, 400 "Invalid model format"; `/v1/models/video` is not in that file and a 404 is tolerated): `/v1/models`, `/v1/models/image`, `/v1/models/tts`, `/v1/models/web`,
   `/v1/models/stt`, `/v1/models/video` (404 tolerated) and `/v1/audio/voices` only when the TTS list is empty. The base
   URL may or may not end in `/v1`.
4. The snapshot is stored in `capability_scans`. The Settings card turns it into one section per stage with a badge
   (Ready, Found not used yet, Missing, Later) and chips that say whether the executor is Hermes or 9router. No skill
   name or model id is hardcoded: classification uses Hermes' own stage tags first, then keyword rules for gaps.

Stage map. A stage with no executor fails with a message that says what was checked (not scanned, a source unreachable,
or nothing listed) and what to do.

| Stage | Today |
|---|---|
| research, script, storyboard | Hermes, with discovered skill names added to the prompt as a DATA block (at most 5, hints only) |
| image | Hermes `image_gen`, then 9router `POST /v1/images/generations` with a proven model only, then CC0 library, then Muse agent |
| voice | optional `KOKORO_BASE_URL` override, 9router TTS, Hermes asked for Kokoro (`VENSTUDIO_STAGE: tts-kokoro`), Hermes CapCut (`tts-capcut`) |
| editing, subtitles | worker `render-video` (ffmpeg) |
| video-clips, music, sfx, thumbnail, CapCut editing | listed in the map as "Found, not used yet": no stage calls them, so a listing does not prove they work. The card says so per stage. The owner (or an editor) can press **Check skills**: one Hermes chat turn (`VENSTUDIO_STAGE: skill-check`, no retry, 120 s) that gets only the skill names in a DATA block and is told to load each skill without running it. Hermes answers per skill `{name, loadable, inputs, output: file-path\|url\|base64\|text\|unknown, note}`. The answer is validated (`validateSkillCheck`: only asked names, bounded text), stored inside the Hermes part of the capability snapshot and kept across rescans. The card shows it as Hermes's own answer, not a test run: a loadable skill that returns a URL or base64 "could be used by a later phase", one that returns a file path "needs a file hand-off in Phase 5". Generation is not run from Settings: it would spend provider quota on an output contract that is not defined yet. The real first call happens in Phase 5 |
| upload | Phase 5, not built |

Voice order. The Kokoro model is picked from `/v1/models/tts` (an id containing `kokoro`, preferring `af_heart` for
English). Only Kokoro voices are used automatically, so another engine such as edge-tts is never chosen silently. The
override is tried first only when `KOKORO_BASE_URL` is set. Each failed path is kept and shown in the voice stage
summary and in Settings, Test voice. English is the only verified language. The stored list is used only when its TTS
probe worked and names a Kokoro voice. Otherwise (no scan, a failed TTS probe, or no Kokoro in the list) one 20 s probe of
`/v1/models/tts` runs when the voice is requested, never at render, so a voice added later is found and the real cause is
reported.

Image order. Hermes `image_gen` stays first because its provider chain is proven live. 9router images come second and
only with a model a real call has proven (superseded rule: the first listed model; see Pacing and endpoint health).

Provenance. `buildProvenance` records the executor that really produced each asset: `router-tts`, `hermes-kokoro`,
`router-image` besides the existing ones, plus `metadata.via` (`9router`, `hermes` or `direct`). `asset_providers`
gets the real provider (`kokoro` when 9router or your own server made it, `hermes-kokoro` when Hermes says it used Kokoro, `unlisted-<name>`, or `9router-combo-<id>` for a 9router combo, whose underlying
provider is unknown). It starts `unknown` and only the owner confirms it in Settings.

Trust. Skills Hermes only named in its chat answer (not in `/v1/skills`), and its image providers and voice engines, are
shown as "not verified" and are never passed back as prompt hints. A stage whose only callable names are unverified shows
"Ready (unverified)", not "Ready". The scan asks Hermes once (no retry) while `hermesStatus()` runs beside it, and that
call can fall back to a chat skills listing with a 180 s timeout, so a manual scan takes up to three minutes.

Optional env. `KOKORO_*`, `TTS_BACKUP`, `HERMES_IMAGE_PROVIDER_ORDER`, `HERMES_MEDIA_ORIGINS` and `HERMES_MAX_CONCURRENCY` are overrides. Nothing
beyond `NINEROUTER_*` and `HERMES_*` is required.

Per-stage trade-off:

| Stage | Executor | Why |
|---|---|---|
| research, script, storyboard, CapCut editing, music, thumbnail | Hermes | Agentic work. The skills live in Hermes. The output is text, or files Hermes has to hand back as base64 or a link |
| voice | 9router first, then Hermes | 9router direct returns raw audio bytes and deterministic HTTP errors. A Hermes chat reply can be a path or prose and costs a model turn, so it is the fallback |
| images | Hermes first, then a proven 9router model | Hermes' `image_gen` chain is proven live and Hermes knows which of its providers work. A listed 9router model is not proof: the owner's Cloudflare model answered 400 "prompt is required" for every shot |
| video-clips | 9router video API, listed only | No stage consumes clips yet. Creation requests bill, so they are never retried automatically |

9router video API, for a later phase (reference, not wired): creation is asynchronous and returns a `request_id`. The
response carries an `x-9router-connection-id` header. Poll for the result with that value sent as `x-connection-id`.
HTTP 403 means the account has no video access. Do not retry the creation POST on a timeout, because it may have
billed.

### Calling Hermes
The portal posts to `/v1/chat/completions` (model `hermes-agent`, `stream: false`, 180 s timeout) from
`lib/server/hermes-json.ts`. Each prompt starts with a marker line `VENSTUDIO_STAGE: <stage>`, asks for JSON only and
wraps untrusted text (channel plan, past titles, owner notes) in labelled DATA blocks that the model is told not to
obey. The reply is parsed tolerantly (fences and surrounding text are stripped) and checked by a hand-written
validator in `lib/studio/director.ts` (pure, no zod, so it runs under `node --test`). On a transport error, bad JSON
or failed validation the portal asks again up to 2 more times, feeding the validation issues back. After the last
try the stage fails with the reason and the owner sees a stage-error item with Retry. No `response_format` parameter is
sent because the gateway may reject it; whether live Hermes keeps to the schema is measured with the "Test Hermes JSON"
button on `/studio/runs`. Model output is data and is never executed. Prompts contain no secrets. The Hermes runs API
for long tasks and its vision support are **unverified** and still unused. Every model turn goes through the shared
gate described next; a rate limit is not retried in this loop.

### Pacing and endpoint health (migration 0011)

The problem this solves: on the owner's deployment every shot of an assets stage failed within seconds with "Hermes
answered HTTP 429", then a 9router 400, then a 429 from the CC0 search. The portal asked Hermes back to back with no
wait, counted a 429 as a failed attempt, and sent the first listed 9router image model a request it could not take.

**One gate for every Hermes model turn** (`lib/server/hermes-gate.ts`, pure rules in `lib/studio/pacing.ts`). All
callers go through it: the director stages, images, the CC0 search, voice through Hermes, the capability scan, Check
skills, the revision classifier, Test Hermes JSON and the chat skills fallback in `hermes.ts`. The `/v1/capabilities`
and `/v1/skills` GETs of the status card are not model turns and stay outside.
- Concurrency: one model turn at a time in the portal process. `HERMES_MAX_CONCURRENCY` (1 to 8) is an optional
  override, not required. A turn waits at most 2 minutes for a slot (`GATE_QUEUE_TIMEOUT_SEC`), then it answers busy
  with a one-minute not-before ("busy with other studio work"). Owner clicks use a shorter wait (5 s for the revision
  classifier, which then falls back to keywords). The stuck-stage limits count this wait (`HERMES_ASK_WORST_SEC`).
- Busy time: `hermes_gate.busy_until` in Postgres, so a restart keeps it. While it is in the future no call is made.
  It is set on HTTP 429 or 503, and on a reply that failed validation and reads like a rate limit (429, "rate limit",
  "too many requests", "quota exceeded", "overloaded"). The wait is `Retry-After` (delay seconds or an HTTP date, at
  least 1 s, at most 1 h per wait), otherwise exponential backoff from 15 s doubling to 10 min. A normal answer resets
  the backoff. The cause of a 429 (Hermes's own concurrency limit or its upstream model) does not matter: both are waits.

**Busy is not failure.** `hermesJson`/`hermesText` return `cause: "busy"` and `busyUntil`. A work order goes back to
pending with its attempt returned and `not_before`/`wait_reason` set; the stage goes back to pending with
`not_before` and `output.hermesWait` (`deferStage`). Director stages and the voice stage (when 9router could not speak
and Hermes is busy) do the same. `claimNext` and `claimOrder` skip anything whose not-before is in the future. The run
page and the Review inbox show "Waiting for Hermes (rate limited), next try at HH:MM UTC, in about N min" (UTC
because pages render on the server). `output.waitSince` marks when the wait began; a stage that has waited 3 hours
(`HERMES_WAIT_GIVE_UP_MS`) without progress becomes a stage error with Retry.

Resuming, and why both: an in-process timer (`scheduleResume`) calls `advanceRun` when the not-before passes, so a
short wait resumes within a second. A timer dies with the process, so the worker claim route also calls
`nudgeRecovery()` after its response: a reaper pass at most once a minute. Workers in hold mode call claim every ~25 s,
so recovery no longer depends on someone opening `/review`, `/studio/runs` or a run page (those still reap too). The
reaper's orphan query only restarts runs whose pending stage is due. Trade-off: with no worker polling and no page
open, a wait that outlives a restart resumes on the next claim or page load, not at the exact minute.

**Systemic pause.** If the first two orders of an assets pass fail with the same systemic cause (`auth`, `unreachable`,
`server`; see `systemicPause` and `orderFailureCause`), the pass stops, those orders return to pending with their
attempt, and one stage error says "Paused after the first 2 shots failed the same way: ..." with Retry. The other
shots are not tried. A model-specific 4xx (`client`) and a bad answer (`content`) never pause: they belong to one shot.

**No blind 9router.** `endpoint_health` records every real 9router image and speech call, the Settings tests, and
Hermes's own report of which provider made a picture (endpoint `hermes`, from `provider` and the new `tried` list in the
image reply; a self-report used for health only, never for terms). A 4xx client error (for example "prompt is
required" or "Invalid model format") sets the model aside (`quarantined_at`) for 7 days or until a success lifts it.
Within a stage a model that answered 4xx is excluded at once, even if the health write failed.
- Images: the automatic chain uses a 9router model only if a real call proved it (`pickProvenImageModel`; the
  `HERMES_IMAGE_PROVIDER_ORDER` hint wins among proven ones, else the newest success). Trade-off chosen: 9router is
  not in the chain by default. A new image model costs one press of **Test 9router image** in Settings, which tries
  proven, then untried, then set-aside models (at most three) and stops at the first real picture. The alternative,
  trying listed models in production, is what failed every shot. Hermes picks its own providers anyway, so 9router is
  only the fallback.
- Voice: a listed Kokoro voice is still tried automatically (that is the path that already worked in the owner's Test
  voice, and a failed voice falls through to Hermes), but proven voices come first and set-aside ones are skipped
  (`pickRouterVoiceWithHealth`). `KOKORO_VOICE` still wins when listed. **Test voice** ignores the quarantine, so the
  owner can lift it. A 500 or 503 never sets a voice aside.
- Settings wording: the capability card marks 9router chips "proven by a real call", "listed, not proven yet" or
  "set aside after a request error". A listed-only image model does not count as used, and a listed-only voice makes
  the stage "Ready (unverified)", not "Ready". The image card lists each 9router model with its health.
- Errors: 9router error bodies are shortened to the provider message (`shortProviderError`), e.g. "Cloudflare: prompt
  is required (code 3030)", at most 200 characters per step and 500 per work order.

**Let Hermes choose.** The image prompt tells Hermes to let its `image_gen` chain fall through its own providers
(cloudflare, agnes, canva, qwen, minimax, sensenova ...) and report the one that succeeded in `provider` and the ones
that failed in `tried`. A reply that says every provider is rate limited is a wait. Provenance and `asset_providers`
still record the provider as before (`unlisted-<name>` unless it is in `HERMES_IMAGE_PROVIDER_ORDER`), and commercial
terms are still set by the owner only. A rate limit never moves a shot to 9router: waiting keeps Hermes's choice of
provider, at the cost of time.

## 6. Muse agent-task delivery (UNVERIFIED, needs a Muse test)

0. Flag-gated: the portal creates these jobs only when `MUSE_AGENT_TASKS=1`, and a worker advertises the handler only when `VENSTUDIO_AGENT_TASKS=1`. Both default to off, and the task is never in the default fallback chain.
1. Portal creates an `agent-task` job from a work order.
2. A worker in `hold` mode claims it, writes `/home/hatch/venstudio/inbox/<jobId>/TASK.md`, and prints the task text.
3. The Muse agent that launched `run.sh` reads it and performs the task, saving files to
   `/home/hatch/venstudio/inbox/<jobId>/out/`.
4. The agent runs `run.sh submit <jobId>`, which uploads the artifacts and completes the job.

Worker 0.4.0 has a handler for this (`agent-task`, off unless `VENSTUDIO_AGENT_TASKS=1`, hold mode only). It uses an `out/DONE` marker instead of `run.sh submit`. It stays UNVERIFIED: tests 12 to 16 in the research doc are still needed. Task text comes only from the authenticated portal channel
(prompt-injection control). If it fails, work orders use Hermes image generation and worker tools only.

## 7. Review screens (mobile first)

The **Review inbox** (`/review`) lists items waiting for the owner. Built in Phase 3: one column of cards, each with
the channel, run topic and stage. Idea cards list every idea (title, hook, angle) with its own **Approve this idea**
button. Approval cards show a text summary of the research, script or storyboard. Gate-failure cards list the plain
issues, and stage-error cards show the error with **Retry**. Every card has a revision note box with **Send
revision** and a **Reject** button; buttons are at least 48 px tall and full width on phones. Problems sort before
approvals, and approvals before ideas. A revision note is classified to the earliest stage that must change (Hermes,
then a keyword fallback, then the stage shown), the stage runs again as a new attempt and later stages are
superseded. Reject cancels the run. The nav shows an open-count badge on Review. On phones the bottom bar holds
Review, Studio, Channels, Jobs and Settings; Assets and Workers are linked from the Studio page, and the side nav
on wide screens lists everything. `scripts/ui-e2e.mjs` covers `/review` at 390 px (no horizontal overflow, tap
targets of 44 px or more) against a fake Hermes.

Phase 4 cards (`ReviewPayload.media` and `.checks`):
- **Assets**: a two-column thumbnail grid (`/api/assets/<id>`) with the shot and the provider under each image. When a
  provider is not confirmed, a notice links to Settings (a 44 px link). The card is a gate-failure item with **Retry**
  until the owner confirms the provider, then an approval item.
- **Voice**: an `<audio controls>` player and the voice provider, plus the same terms notice (Kokoro is a provider too).
- **Video** and **Quality check**: a `<video controls playsInline>` player, the one-line results of each check, and a
  note that the presentation check is manual in Phase 4.

Routes: `/review` (inbox), `/studio/runs` (start a run, recent runs, Test Hermes JSON), `/studio/runs/[id]` (stage
timeline with a summary for every stage including the production stages, a link to the render job, a work order list
with state, provider, attempts and error per shot, the checks, cancel). Settings has the Kokoro health card with **Test
voice**, **Test Hermes image** (lists the providers Hermes reports and makes one small picture, saving nothing) and the
owner-only Asset providers list. `scripts/ui-e2e.mjs` drives the whole path against a fake Hermes and a fake Kokoro at
390 px and on desktop.

## 8. Security rules

- No secrets in prompts, work orders, TASK.md or Assets (standing decision).
- YouTube refresh tokens stay encrypted with `ENCRYPTION_KEY` in the portal and are never sent to workers.
- Workers keep per-worker tokens limited to their own jobs; downloads use assigned assets only (existing design).
- Model output is data: validated by schema, never executed, never used to build shell commands.
- Template copyright sign-off records user id and date; only the owner role can sign.
- Autonomous publishing is blocked unless the channel level is 3, not paused, and all gates pass; claim events pause it.
- Worker-to-channel mapping and channel category are written only by the owner.

## 9. Phased plan

| Phase | Scope | Status |
|---|---|---|
| 0 | Baseline: existing tests green | Done in this task (41 portal tests, 9 pass and 4 skip for worker) |
| 1 | Pure domain engine: templates, QC gates, autonomy, Template Lab, provenance v2, in `apps/portal/lib/studio` with unit tests | Implemented in this task (FEAT-003) |
| 2 | Migration 0007, `qc-video` worker job, read-only Templates page, e2e | Implemented in this task (FEAT-004) |
| 3 | Hermes director: idea, research, script, storyboard stages as work orders; Review inbox on mobile | Implemented. Unverified against a real Hermes: JSON reliability, vision, runs API |
| 4 | Asset work orders (Hermes `image_gen` chain, 9router images, CC0 library, flagged Muse agent tasks), voice through 9router Kokoro, Hermes Kokoro and CapCut, capability scan, `render-video` and `qc-video` | Implemented. Offline tests pass; CI e2e covers it against fakes. Not verified against live services, see below |
| 5 | YouTube upload, copyright claim wait, metrics | Planned |
| 6 | Autonomous publishing with demotion | Planned |
| 7 | Template Lab UI and trial runner | Planned |

### Phase 4: verified and unverified

Verified (offline tests and CI against fakes): reply parsing and byte checks for images and audio, the SSRF-safe
fetcher, provider terms enforcement, the fallback order, WAV joining and the voice gate, the render payload and
ffmpeg arguments, the review cards at 390 px, the Settings tests, and a real `render-video` plus `qc-video` on the CI
worker using generated stills.

Not verified, because it needs the owner's live systems:
- The real `image_gen` return shape. The parser accepts several shapes, but the exact tool names and what comes back
  (URL, base64, or a path the portal cannot read) are unknown until **Test Hermes image** is run.
- Provider licence terms. No provider is assumed cleared. The studio will not publish an asset from a provider the
  owner has not confirmed in Settings.
- Kokoro location. No address is assumed. It is a Kokoro container the portal can reach, or a route through 9router.
- The CapCut backup path through Hermes. It has never run.
- Muse agent tasks (research tests 12 to 16). Behind a flag, off by default.
- `G-presentation` (vision). Not built; the owner watches the video and decides.
- Non-English Kokoro voices, and a full-length render on a Muse VM (2 vCPU, 8 GB, no GPU).

### After deploying the pacing fix (migration 0011)
1. Check the container log says migration `0011_hermes_pacing.sql` applied.
2. Settings, Studio capabilities: press **Scan now**. 9router image chips should read "listed, not proven yet".
3. Settings, Image providers: press **Test 9router image**. A model that refuses the request shows a short reason
   (for example "Cloudflare: prompt is required (code 3030)") and is set aside; the first that works is proven. If none
   works, the studio simply does not use 9router images.
4. Press **Test voice** once so the Kokoro voice is marked proven.
5. Retry the failed assets stage in Review. If Hermes is busy, the run page shows "Waiting for Hermes (rate limited),
   next try at HH:MM UTC" and continues on its own; nothing should fail with HTTP 429. Keep a worker in hold mode so
   waits resume after a restart without opening a page.
6. If Hermes stays rate limited, look at its own log for the cause (its API server limit or its upstream model). Setting
   `HERMES_MAX_CONCURRENCY` above 1 only helps when Hermes can take parallel turns.

### First live run checklist (owner)
1. Open Settings, Studio capabilities, and press **Scan now**. Read the map: voice should show a Kokoro model via
   9router, images should show Hermes providers. No Kokoro variable is needed.
2. Press **Test voice**. It should report the provider, whether it went through 9router or Hermes, and the seconds of audio.
3. Press **Test Hermes image**. Check the providers listed (for example cloudflare, agnes, canva, qwen, minimax,
   sensenova) and that a picture appears. If it reports a path or an error, tell the developer the exact text.
4. After the first run makes assets, open Settings, Asset providers. Read each provider's commercial terms and set
   **Commercial use OK** only for those you have checked. Then press **Retry** on the Assets card in Review.
5. Start one short on one channel with a worker enrolled for it. Approve the assets, check the voice, wait for the
   video, watch it fully (the presentation check is yours) and approve or reject.

### Entry criteria, unknowns and owner needs

| Phase | Entry criteria | Unverified | Needs from the owner |
|---|---|---|---|
| 3 | Phase 2 merged; Hermes reachable from the portal container | Hermes runs API; Hermes vision; structured-output reliability (run Test Hermes JSON, then a real run) | Channel plan text, channel categories, worker mapping, starting autonomy (recommend 1) |
| 4 | Phase 3 producing approved scripts and storyboards | Hermes `image_gen` return shape; provider licence terms; Kokoro location; CapCut backup path; Muse agent-task delivery (tests 12 to 16); Kokoro language gaps | Kokoro address; confirm each provider's terms in Settings; language list; decision on a GPU box for 3D |
| 5 | Phase 4 renders pass `G-technical` and `G-presentation`; OAuth client and `YOUTUBE_*` env set; consent screen in production | Whether claim status is readable by API for private uploads; claim wait length | Connect each of 10 channels |
| 6 | Phase 5 live; at least one template `proven` with signed checklist; 5 trial runs recorded | Real false-pass rate of vision QC | Per-channel opt-in to level 3; approval of spot-check rate |
| 7 | Phase 4 render path stable; analysis job (`analyze-video`) exists | Quality of Hermes structure descriptions | Samples the owner holds rights to; daily lab budget |

## 10. Verification in each phase

Pure modules: `node --test "apps/portal/lib/**/*.test.ts"`. Worker: `node --test "apps/worker/*.test.ts"` (some tests
skip without ffmpeg). CI also runs typecheck, build, `scripts/e2e.sh`, `scripts/ui-e2e.mjs` and the Docker build;
typecheck and build cannot run in the offline sandbox, so types are written conservatively.

## Known issues

- `/settings` overflows horizontally on mobile. It predates the studio work and is excluded from the overflow assertion in `scripts/ui-e2e.mjs`. Fix the page, then remove the exclusion.

### Recovery of lost stages (Phase 3)

`reapStuckStages` fails a stage that has been running longer than `STUCK_MINUTES` (21, above the 900 s worst case of
`hermesJson` with its gate waits), in one transaction with the run update and the `stage-error` review. It also calls
`advanceRun` for running runs that have a due pending stage and no running one. It runs when `/review`, `/studio/runs`
or a run page renders, and, since migration 0011, from the worker claim route through `nudgeRecovery` (at most once a
minute), so a phone that never opens those pages still gets recovery while a worker polls. A blocked stage (for
example a retired template) opens a `stage-error` review instead of failing the run silently.
