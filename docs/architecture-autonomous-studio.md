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
   skills, images,         models, TTS)              claim -> heartbeat -> complete
   vision QC)                                         ffmpeg draft/render, qc-video,
                                                      agent-task inbox (Muse agent)
```

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
| assets | portal work orders: Hermes `image_gen` chain, CC0 library through a worker `fetch-asset` job, Muse agent task only behind a flag |
| voice | portal: Kokoro primary, CapCut through Hermes as backup |
| draft | skipped in Phase 4 (no animatic yet) |
| render | worker (`render-video`) |
| qc | worker `qc-video` plus portal rules; vision (`G-presentation`) not built, the owner decides |
| approval | human or autonomy policy |
| upload | portal (YouTube API, private) |
| claim-watch | portal (wait, then read status) |
| publish | portal |
| learn | portal (metrics into template stats) |

## 3. Data model (migrations 0007, 0008 and 0009)

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
1. Hermes image, two attempts, each asking Hermes up to 3 times with the problems fed back.
2. CC0 library: Hermes names a candidate (`VENSTUDIO_STAGE: cc0`), the portal checks the host allowlist and a CC0 or
   public-domain licence string, and a `fetch-asset` job downloads it. The work order waits for the job. The licence
   text is Hermes' claim, so it is stored as "Claimed ... (stated by Hermes, not verified)" with the licence or source
   link, and the host is a provider the owner has to confirm in Settings.
3. Muse agent task, only when `MUSE_AGENT_TASKS=1` on the portal.
A shot that fails the whole chain fails its work order with the reasons. Retry in Review resets only failed orders.

Voice: Kokoro is the primary narration (OpenAI-compatible `POST /v1/audio/speech` with `response_format: wav`, `GET
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
for long tasks and its vision support are **unverified** and still unused.

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
| 4 | Asset work orders (Hermes `image_gen` chain, CC0 library, flagged Muse agent tasks), Kokoro voice with CapCut backup, `render-video` and `qc-video` | Implemented. Offline tests pass; CI e2e covers it against fakes. Not verified against live services, see below |
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

### First live run checklist (owner)
1. Set `KOKORO_BASE_URL` (and `KOKORO_API_KEY` if needed) on the portal. Kokoro is the primary voice; CapCut through
   Hermes is the backup. Open Settings and confirm the Kokoro card says Connected.
2. Press **Test voice**. It should report the voice name and the seconds of audio.
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

`reapStuckStages` fails a stage that has been running longer than `STUCK_MINUTES` (15, above the 540 s worst case of
`hermesJson`), in one transaction with the run update and the `stage-error` review. It also calls `advanceRun` for
running runs that have a pending stage and no running one. It runs only when `/review`, `/studio/runs` or a run page
renders; there is no periodic caller yet, so a phone that never opens those pages does not trigger recovery. A
blocked stage (for example a retired template) opens a `stage-error` review instead of failing the run silently.
