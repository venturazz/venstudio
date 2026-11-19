# Autonomous studio: workflow, templates, quality control and learning

Date: 2026-11-20. Follows `01`, `02` and `03`. Web access was blocked while writing this, so nothing here was fetched
fresh. Sources are either already cited in `01` and `03` (fetched earlier) or listed in section 11 as
"not re-fetched in this session, verify before relying on it". Every claim says where it comes from, or is tagged
**design decision** or **unverified**. Nothing is quoted from a source.

## 0. What changed from research 01 to 03

The earlier notes assumed Muse was a render machine and that the owner designs each video and prepares media. Both
assumptions were wrong.

- **Muse is an agent.** It chats, generates pictures and runs tools. Asked in chat, it can already make a video. So the
  studio must not make the owner design shots or hand over media. It must hand Muse and Hermes a work order and
  collect the result.
- **The owner is the boss.** The owner makes the major plan (channel category, which worker serves which channel,
  autonomy level) and does light review (approve ideas, ask for revisions, approve uploads).
- **Styles become final templates.** A style the studio offers must already have passed presentation QC and a copyright
  checklist. Seed styles from `03` are therefore **candidates**, not proven (section 3).
- **Media is sourced by Hermes and Muse.** Section 5 replaces the "Assets are uploaded by the owner" idea for
  production. Assets remain the place for the owner's own samples and for provenance records.
- **Copy-cat becomes the Template Lab.** It learns structure from a sample to create new candidate templates. It never
  produces a production from the sample (section 7).

What stays valid: pull-only workers, the hourly or hold-mode wake, per-channel encrypted YouTube tokens that never
reach workers, private-first upload, the provenance rule, and the Muse hardware limits (all from `01` to `03`).

## 1. Corrected product model

| Role | Who | What it does | Source |
|---|---|---|---|
| Boss | Owner (often on a phone) | Sets channel category, maps workers to channels manually, sets the autonomy level, approves ideas, asks for revisions, approves uploads, signs template copyright checklists | Standing decisions, design decision |
| Director (brain) | Hermes on the VPS | Ideas, research, scripts, storyboards, quality judgement, image generation, writes work orders | Product facts from the owner |
| Field agent | Muse (agent with chat, image generation and tool execution on a VM) | Takes agent-task work orders: generate pictures, run tools, assemble clips, report back | Product facts from the owner. Delivery path is **unverified** (section 9) |
| Model router | 9router on the VPS | Cheap model calls, text-to-speech | Product facts from the owner |
| Tools | Pull workers (`apps/worker`) | Deterministic work: ffmpeg draft and render, measurement for QC. No judgement | `01`, `02`, existing code |
| Ledger | Portal and Postgres | State machine, gates, provenance, autonomy, YouTube upload with tokens | Existing code, design decision |

The portal is the only component that holds secrets. Hermes, 9router and Muse never receive YouTube tokens or
`ENCRYPTION_KEY`. Prompts to any model carry no secrets (standing decision).

**Owner touchpoints** (everything else is automatic): approve, reject or revise an **idea**; **final approval** unless
the autonomy level allows auto-publish; any **gate failure** that automatic revision could not fix; assigning workers
and categories; signing a template's copyright checklist.

## 2. Best end-to-end workflow

Fourteen stages, each followed by a gate where one exists. Stage ids are fixed identifiers used in code, database and
these docs.

| # | Stage id | Executor | Output | Gate after the stage |
|---|---|---|---|---|
| 1 | `idea` | Hermes | 5 to 10 ideas from the channel plan and past metrics | Owner approves, rejects or revises (autonomy 2 and above auto-picks from the channel plan) |
| 2 | `research` | Hermes | Source notes with URLs, facts marked as sourced | none (feeds `G-script`) |
| 3 | `script` | Hermes | Script with 3 hook variants, one chosen | `G-script` |
| 4 | `storyboard` | Hermes | Shot list following the template beats | `G-storyboard` |
| 5 | `assets` | Hermes plus Muse work orders | One asset per shot with provenance | `G-assets` |
| 6 | `voice` | 9router / TTS | Narration audio and word timings | `G-voice` |
| 7 | `draft` | Worker (animatic of stills) | Low-cost preview from stills and voice | none (cheap early look for vision QC) |
| 8 | `render` | Worker | Final file | none (measured in `qc`) |
| 9 | `qc` | Worker, Hermes vision, portal rules | QC report | `G-technical`, `G-presentation`, `G-compliance` |
| 10 | `approval` | Human or autonomy policy | Approved or revision requested | Owner or policy |
| 11 | `upload` | Portal (YouTube API, private) | Private video on the channel | none |
| 12 | `claim-watch` | Portal | Waits, then reads claim status | `G-claims` |
| 13 | `publish` | Portal | Video made public or scheduled | none |
| 14 | `learn` | Portal | Metrics folded into template stats | none |

Design reasons for this order:

- **Draft before render.** An animatic of stills lets the vision check run on keyframes before a full render spends
  Muse time. `01` already recommended checking stills first. Design decision.
- **Gate early, fix early.** A failed script gate costs one Hermes call; a failed render gate costs a render.
  Failures route back to the stage that caused them (automatic revision, at most 2 attempts per stage, then the owner;
  1 attempt when `G-assets` or `G-compliance` failed). Design decision.
- **Private upload then wait.** YouTube runs copyright checks after upload, so the portal uploads private and waits
  before publishing (`01` section 3, rule 6).
- **Learning closes the loop.** Metrics feed template statistics and demotion (section 8).

### Revision loop
The owner's revision note (plain text from a phone) is sent to the stage that owns the problem. Hermes classifies the
note to a stage (idea, script, storyboard, assets, voice) and reruns from there. Only changed stages rerun, which
matches the plan-file idea in `03` section 2. Design decision.

## 3. Proven template design

A **final template** is the unit the owner picks and the autonomy engine trusts. It contains:

- **Format and engine:** short or long, resolution and fps, rendering engine with Muse placement (from `03`).
- **Beats:** the ordered structure (hook, setup, body beats, payoff, call to action) with target seconds.
- **Pacing limits:** `maxShotSeconds`, `hookByMs` (first shot change), `wordsPerMinute`, duration range.
- **Visual identity:** palette, fonts (OFL), caption style and safe area, character or background rules.
- **Audio rules:** voice provider and language support, music policy, loudness target, ducking.
- **Asset policy:** allowed executors and sources, forbidden kinds.
- **Copyright checklist:** written items, signed by the owner (user id and date).
- **Stats:** trial runs, gate pass rates, mean presentation score, real productions, claim count. The mean covers every counted trial; a trial with no presentation score counts as 0, so unscored runs cannot support promotion.
- **Version:** every change creates a new version; evidence belongs to a version.

### Lifecycle
`draft -> candidate -> proven -> retired`

| Status | Meaning | Who may use it |
|---|---|---|
| `draft` | Being written, incomplete | Nobody in production |
| `candidate` | Complete and runnable, not yet proven | Trial runs and owner-supervised productions (autonomy at most 2) |
| `proven` | Passed promotion evidence | Any channel, and autonomy level 3 |
| `retired` | Withdrawn | Nobody; history kept |

**Promotion rule (candidate to proven)**, all required:
1. At least 5 trial runs.
2. 100 percent of trial runs pass `G-technical`.
3. Mean `G-presentation` score at least 80.
4. Zero `G-assets` failures and zero `G-compliance` failures across the trials.
5. A signed copyright checklist (owner sign-off recorded with user id and date).
6. No open claims.

**Demotion (proven to candidate):** two consecutive real productions fail a gate, or any claim is recorded.

**Why seed styles ship as candidates.** The catalog from `03` has about 20 styles that have never been rendered through
these gates. Nothing may be called proven until trial runs and a sign-off exist. Shipping them as `proven` would
break the product rule that every style is a tested final template. Design decision.

**Why 5 trials and 80.** These numbers are design decisions chosen so a single lucky run cannot promote a template
while 5 runs are affordable (about 2 videos per channel per day). They should be tuned with real data. Unverified as
optimal.

## 4. QC gates

Every gate has an id, a concrete test and a named executor. Thresholds are the contract that code and docs share.

| Gate | After stage | Test | Executor |
|---|---|---|---|
| `G-script` | script | Hook present within first 3 s (short) or first 30 s (long); three hook variants scored; no unsourced factual claims on research-required themes; script length within template `wordsPerMinute` x duration, plus or minus 15 percent; similarity to any research source text (5-gram overlap) below 8 percent | Portal rules (length, overlap), Hermes (hook score, claim sourcing) |
| `G-storyboard` | storyboard | Every template beat covered; no shot longer than template `maxShotSeconds`; first shot change inside template `hookByMs` | Portal rules |
| `G-assets` | assets | Every shot has an asset with a provenance record; no `reference-video` kind; no asset with an empty licence; no upload or licensed asset without an origin; no real-person likeness or brand logo flagged by the vision check | Portal rules, Hermes vision |
| `G-voice` | voice | TTS language supported, else the provider must be named; narration duration within 10 percent of script estimate; no clipped samples | Portal rules, worker measurement |
| `G-technical` | qc | Resolution and fps equal the format; duration inside template range; has an audio stream; integrated loudness -14 LUFS plus or minus 2; true peak at or below -1 dBTP; no black run over 1.0 s outside the first and last 0.5 s; no silence over 2.5 s in narrated templates (silencedetect at -50 dB); no frozen frame over 4 s except ambient templates; no shot longer than 1.5 times template `maxShotSeconds` (measured between cuts); on shorts other than ambient, the first cut inside template `hookByMs` | Worker `qc-video` job (ffprobe, ebur128, blackdetect, silencedetect, freezedetect) |
| `G-presentation` | qc | Vision QC on keyframes every 3 s: captions inside the safe area and readable, no garbled text, no off-model characters, no artifacts. Score 0 to 100, pass at 75 | Hermes vision |
| `G-compliance` | qc | Altered/synthetic disclosure flag set when realistic synthetic content; paid promotion flag set for affiliate or advertising purposes; Made for Kids set for the kids theme; template copyright checklist signed; music has a licence or is self-generated | Portal rules |
| `G-claims` | claim-watch | After private upload wait 6 hours (configurable), then read copyright and claim status. Any claim or restriction blocks publish and demotes the template to candidate | Portal (YouTube API) |

Notes:

- `-14 LUFS` target comes from `01` section 2 ("about -14 LUFS"). The plus or minus 2 and the -1 dBTP ceiling are design
  decisions. The ffmpeg filters (`ebur128`, `blackdetect`, `silencedetect`, `freezedetect`) are standard ffmpeg
  filters; exact parameter syntax is **unverified here**, check against the ffmpeg version on the worker.
- The pass mark is 75 for a single video, 80 mean for promotion, 85 for auto-publish. All are design decisions.
- A vision model can be wrong. It is one signal inside a gate list, and the human approval stage stays until autonomy
  level 3 is earned. Unverified accuracy; measure false passes during trials and store them in `qc_reports`.
- **Auto-revision:** a failed gate routes to the owning stage, at most 2 retries. A `G-assets` or `G-compliance`
  failure gets 1 retry, because repeating a rights or disclosure problem does not fix it. Then it becomes a human
  touchpoint. A `G-claims` failure or a retired template is never revised, it blocks.
- **Required gates:** a missing result is not a pass. A video can be approved for publishing only when `G-technical`,
  `G-presentation`, `G-assets`, `G-compliance` and `G-claims` all have a result and all passed (`combineGates`
  returns `missingGates`). A missing gate sends the item to the owner. Stage-only checks name the gates of that stage.
- **QC records:** a `qc-video` job tied to a production always ends with a `G-technical` report. A failed job, an
  unreadable result or a missing template store a failed report. If the portal could not evaluate a job when it
  finished, the next job completion or failure retries it (jobs from the last 7 days).

## 5. Asset sourcing by Hermes and Muse

The owner does not prepare media. After `storyboard` the portal creates one **work order** per shot (or per group of
shots). A work order states what is needed, the template's asset policy, the allowed executors and the output format.

| Executor | Use | Provenance written automatically |
|---|---|---|
| Hermes image generation | Stills, backgrounds, character sheets | Generator name, model, prompt hash, date, licence "generated, per provider terms" |
| Muse agent task | Pictures through Muse's own generation, or tool runs (charts, diagrams, code-drawn graphics) | Same fields, plus worker id. Muse's commercial-use terms for its images are **unverified** (`01` notes the same) |
| 9router | Cheap model calls, TTS | Provider and model |
| Deterministic worker tools | ffmpeg, Rhubarb, Manim, Remotion renders, synthesized music and SFX | Tool and version, "self-generated" |
| Licensed or CC0 libraries | Poly Haven, ambientCG, Kenney, Quaternius, Freesound (CC0 filter), Google Fonts, YouTube Audio Library | Source URL, licence, date, hash (rules from `01` section 3) |

**Fallback order** (design decision): self-generated by a worker tool, then Hermes image generation, then Muse agent
task, then CC0 library, then licensed library. If every executor fails, the work order fails and the run goes to the
owner with the reason.

**Never allowed:**
- Any `reference-video` asset in a published video (already enforced by `provenance.ts`).
- Assets with no provenance record or an empty licence.
- Prompts containing franchise names, brand logos, living artists' names or real people's likeness (`01` rule 3).
- Secrets or tokens in work orders or in Assets (standing decision).
- Third-party video downloaded by a tool such as yt-dlp (section 7).

## 6. Copyright and policy rules, mapped to gates

| Policy | Rule enforced | Gate | Source |
|---|---|---|---|
| Inauthentic content (mass-produced or repetitive content is not monetizable; AI as a tool is fine) | Each channel has a distinct template and real per-video variation; research notes and human approval stored as evidence of creative input; `G-script` similarity and unsourced-claim checks | `G-script`, approval | [YouTube monetization policies](https://support.google.com/youtube/answer/1311392?hl=en-GB), cited in `01` |
| Reused content | No reference footage, script text, characters, thumbnails or music from a sample; 5-gram overlap below 8 percent against research sources | `G-script`, `G-assets` | Design decision; policy page cited in `01` |
| Altered or synthetic content disclosure | Flag set whenever the video shows realistic synthetic people, places or events | `G-compliance` | `01` rule 7; YouTube Help page "not re-fetched in this session, verify" (section 11) |
| Content ID and music | Self-generated music first, then YouTube Audio Library, then paid AI music with commercial rights; a music asset needs a licence | `G-assets`, `G-compliance`, `G-claims` | `01` rule 4 (Thematic, Foxi Music, dev.to Suno article) |
| Likeness | No real person's face or voice; vision check flags likeness; no "in the style of" a living artist | `G-assets` | `01` rule 3 |
| Brands and logos | Prompt filter plus vision check | `G-assets` | `01` rule 3 |
| Paid promotion | Flag set for affiliate or ad purposes | `G-compliance` | YouTube paid promotion disclosure, "not re-fetched in this session, verify" |
| Kids content | Made for Kids set when the theme is kids | `G-compliance` | YouTube Help, "not re-fetched in this session, verify" |
| Upload private first | Upload is always private; publish only after `G-claims` | `G-claims` | `01` rule 6 |
| Upload quota | 100 uploads per day per project, 1 unit each; 10 channels at 2 a day is 20 | scheduler | [Google quota calculator](https://developers.google.com/youtube/data/determine_quota_cost), cited in `01` |
| Remotion licence | Free up to three people, otherwise a company licence; confirm an internal studio of this kind stays free before scaling | template engine field | [Remotion licence](https://www.remotion.pro/license), cited in `03` |
| Kokoro language gaps | Kokoro does not cover Indonesian, Malay, German or Arabic; templates for those languages must name another TTS provider | `G-voice` | Owner's product facts; Kokoro model card cited in `01` |

Legal caveat: these rules reduce risk. They are not legal advice and cannot guarantee that no claim will occur.

## 7. Learning from samples (Template Lab)

**Purpose:** enrich the template library from video samples. It is a learning feature, not a production path. No
production is ever created from the sample.

### Legal boundary
- Samples are **the owner's own videos or videos the owner is licensed to use**, uploaded to Assets with a source and
  licence note.
- The studio does **not** download third-party videos with yt-dlp-style tools. That conflicts with YouTube's terms
  (the Terms of Service and the API Services Terms restrict downloading and separating content; "not re-fetched in
  this session, verify"). Design decision: upload only.
- Only structure is studied: cut times, shot lengths, hook timing, loudness, beat structure, caption placement,
  title patterns. This is the rule already in `01` rule 5 and `03` section 4.

### Pipeline
1. **Measure (deterministic).** The existing `analyze-video` worker job gives cuts, shot lengths, loudness and hook
   timing. PySceneDetect is the upgrade path (`03` section 4).
2. **Describe (Hermes vision).** On keyframes, Hermes writes a structure description: beats, caption style, shot types,
   pacing curve. It must not transcribe script text or describe characters in a reusable way. Unverified quality.
3. **Abstract.** The portal converts the measurements and description into a draft template: beats with target
   seconds, `maxShotSeconds`, `hookByMs`, caption rules. Specific content is dropped.
4. **Originality guard.** The draft is compared with the sample. It is rejected if it keeps the sample's script
   wording (5-gram overlap at or above 8 percent), its characters, its music or its distinctive visual identity. The
   palette and fonts are chosen fresh by Hermes.
5. **Trial and error in a lab.** Hermes runs the new template on synthetic test topics through the full pipeline
   (section 2) with `lab` runs that never upload. Each run produces a QC report. Hermes adjusts the template
   (pacing, caption size, beats) and reruns. The loop stops after the trial budget (default 8 runs) or on promotion
   evidence.
6. **Promotion.** If evidence meets the rule in section 3, the draft becomes `candidate` after the first pass, and
   `proven` only with the owner's signed checklist.

### Why trial and error is safe
Lab runs are not published, so claims and policy exposure do not apply. They use the same worker minutes as normal
runs, so the lab has a daily budget (design decision).

## 8. Autonomy levels and auto-assignment

| Level | Name | Behaviour |
|---|---|---|
| 0 | manual | Owner approves every stage output |
| 1 | ideas and final approval by owner | The owner approves the `idea` stage. Every other stage between is automatic |
| 2 | final approval by owner only | Ideas are auto-picked from the channel plan |
| 3 | auto-publish | Publishes when all gates pass, the template is `proven`, QC score is at least 85, and the channel is not paused. Every 5th video still goes to the owner as a spot check |

`pause`: any `G-claims` failure, strike or Content ID claim sets `channels.autonomy_paused` and drops the channel to
level 1 until the owner resumes it.

**Auto-assignment of jobs** means the queue assigns the next production's work to an idle worker. It never chooses a
channel category or the worker-to-channel mapping; those stay owner decisions (standing decision). The scheduler still
prefers a channel's home worker and falls back to any idle worker (from `01` section 7).

**Demotion triggers:** template `proven` to `candidate` (section 3); channel to level 1 on pause; a channel that
fails two consecutive productions at a gate drops one level. Promotion of a channel's level is always an owner action.
Design decisions.

## 9. Muse agent-task delivery (UNVERIFIED)

Hermes and Muse should cooperate on assets, but Muse has no inbound API and the VM is outbound-only. The proposed
path stays inside the existing pull model:

1. The portal creates an `agent-task` job with a work order.
2. The worker (hold mode) claims it, writes `/home/hatch/venstudio/inbox/<jobId>/TASK.md` and prints the task text.
3. The Muse agent, which launched `run.sh`, reads that output and performs the task (generate pictures, run tools),
   saving files in `/home/hatch/venstudio/inbox/<jobId>/out/`.
4. The agent runs `run.sh submit <jobId>`, which uploads the artifacts and completes the job.

**This is unverified.** It depends on the Muse agent treating worker output as instructions, which also is a prompt
injection surface, so the task text must come only from the portal over the authenticated channel. Tests needed
before building it:

12. Does a Muse agent that started `run.sh hold` act on text the script prints, and keep the worker running while it works?
13. Can Muse generate an image from an agent task, save it to `/home/hatch`, and report its size and format reliably?
14. What are the terms for commercial use of Muse-generated images?
15. How many agent tasks per day fit within Muse usage limits (builds on test 10 in `02`)?
16. Does the agent respect a refusal list (no logos, no real people) written in the task?

If tests 12 or 13 fail, fall back to Hermes image generation plus worker tools only.

## 10. Risks, open questions, facts that need a live check

### Risks
- Vision QC may pass bad videos or fail good ones. Mitigation: keep the human gate until level 3 is earned; record
  false results.
- Fully automated, repetitive output is the exact pattern the inauthentic content policy targets. Mitigation:
  per-channel templates, real per-video research and variation, human approval evidence.
- Muse usage limits and VM recycling can stall agent tasks. Mitigation: work orders are idempotent; fallbacks in
  section 5.
- Prompt injection through fetched web pages in `research`. Mitigation: Hermes output is validated against a schema,
  never executed, and research text is treated as data.
- Hermes API shape is unverified in this sandbox (`/v1/chat/completions` is used today; a runs API may exist).

### Open questions for the owner
1. Which category does each of the 10 channels get, and which worker serves each?
2. Starting autonomy level for each channel (recommended: 1).
3. How much lab budget per day (worker minutes and Hermes calls)?
4. Which languages are required? Each of id, ms, de, ar needs a named TTS provider.
5. Do you accept the 6 hour claim wait before publishing, or want a longer one?
6. Which samples can you upload for the Template Lab, and do you hold rights to them?

### Facts that need a live check
- Muse tests 6 to 11 from `01` and `02`, plus tests 12 to 16 above.
- Hermes runs API shape and its vision capability.
- Exact YouTube policy wording on inauthentic content, synthetic disclosure, Made for Kids and paid promotion.
- Whether `claim-watch` can read claim status through the YouTube API for private uploads, and after how many hours the
  result is usually final. **Unverified.** If the API does not expose it, the owner checks Studio manually and the
  portal asks for confirmation.
- ffmpeg filter parameters on the version installed on Muse VMs.
- Remotion licence terms for this use.

## 11. Sources

Already cited in `01` and `03` (fetched earlier, not re-fetched this session):
- [YouTube monetization policies](https://support.google.com/youtube/answer/1311392?hl=en-GB)
- [Google quota calculator](https://developers.google.com/youtube/data/determine_quota_cost)
- [YouTube API revision history](https://developers.google.com/youtube/data/revision_history)
- [Remotion licence](https://www.remotion.pro/license)
- [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M)
- [Thematic](https://hellothematic.com/ai-music-for-youtube/), [Foxi Music](https://www.foximusic.com/blog/content-id-safe-music-youtube-monetization-guide/)
- [Stark Insider Muse specs](https://www.starkinsider.com/2026/09/meta-muse-specs-what-it-runs-on.html)
- [PySceneDetect](https://www.scenedetect.com/)
- [Hugovdd ai-video-workspace](https://github.com/Hugovdd/ai-video-workspace) and [Orkas VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio) (plan-as-data idea, from `03`)

Not re-fetched in this session, verify before relying on it (cited from memory, URLs may have moved):
- YouTube Help, "Disclosing use of altered or synthetic content" (support.google.com/youtube, search that title).
- YouTube Help, paid product placement and sponsorship disclosure.
- YouTube Help, "Set your channel or video's audience" (Made for Kids).
- [YouTube Terms of Service](https://www.youtube.com/t/terms) and [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service) on downloading content.
- ffmpeg filters documentation: [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html) (`ebur128`, `blackdetect`, `silencedetect`, `freezedetect`).
- YouTube Data API `videos.list` fields for copyright and content status (claim visibility is unverified).
