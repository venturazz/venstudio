# Style packs (Phases 1 and 2, research trials)

A look is a **style pack**: a versioned, tested, curated directory with its contract, renderer requirement, render
project (when the renderer has one), fixture, learning provenance and curation record. Plan:
`docs/plans/style-system.md`. Format: `styles/FORMAT.md` (vendored from the styles repo).

## Where packs live

| Place | What |
| --- | --- |
| `venturazz/venstudio-styles` | Source of truth. Hermes and Kiro open PRs, the owner merges. Its CI validates every pack and renders the Remotion compositions with a copy of the runtime. `tools/validate.mjs` (the validator) is edited only there. |
| `styles/` here | A pinned copy: `packs/`, `tools/`, `schema/`, `FORMAT.md`, written by `scripts/sync-styles.mjs`. Never edited by hand. |
| `styles/lock.json` | The styles commit, and per pack its version, status, engine, composition, file hashes and pack digest. No timestamps: the same commit gives the same bytes. |

The portal needs no GitHub token and reads nothing from GitHub: it reads `styles/` from disk once per process
(`lib/server/style-packs.ts`), checks every file against `lock.json`, and leaves out (and logs) a pack that differs.

### Updating the vendored copy ("bump styles to <commit>")

```
git -C ../venstudio-styles fetch && git -C ../venstudio-styles checkout <commit>
node scripts/sync-styles.mjs --from ../venstudio-styles --commit <commit>
node scripts/sync-styles.mjs --check
git add styles && git commit -m "chore(styles): bump styles to <short commit>"
```

The sync copies the files of that commit (`git ls-tree`/`git show`, not the working tree), validates them with the
validator from the same commit, refuses the whole commit if any pack is invalid, and rewrites `lock.json`. It warns
when the styles repo's runtime copy differs from `apps/render-remotion`. The PR must pass CI here, which renders
every stills pack's fixture through the real worker (`apps/worker/style-pack-fixtures.test.ts`) and the explainer's
golden fixture from the Remotion project assembled out of the vendored pack (`scripts/remotion-project.mjs`).

## Registry and status rules

`lib/studio/style-registry.ts` merges the packs with `lib/studio/catalog.ts`: a pack overrides the catalogue entry
with its id; catalogue styles without a pack are **Planned** (shown on Styles with the engine they would need, never
selectable). Each migrated pack carries exactly the parameters the portal used before (catalogue, seed template,
render parameters); `style-registry.test.ts` checks they still match, so the migration changed no behaviour. The
planner keeps reading `catalog.ts` and the templates as before; wiring a pack's contract into planning is later work.

| Status | New Video | Run |
| --- | --- | --- |
| Listed | Main list, when a worker reports `pack:<id>@<version>` | Normal |
| Trial | Separate section "Trial styles (research only, not for publishing)", when a worker reports the pack | `pipeline_runs.config.stylePack.trial = true`; "Trial style" badge on the run page and Review cards; outcome recorded |
| Draft, Lab | Only as a lab trial, opened from Styles or a study (`?lab=<id>`) | Lab trial: `stylePack.lab = true`, research only, counted apart (below); otherwise refused by `startRun` |
| Proven, Retired | Never | Refused by `startRun` |
| Planned (no pack) | Never | Refused by `startRun` |

Listed or Trial packs no worker reports yet are named under the Trial section as "waiting for a worker".

## Workers

- The portal serves `/install/style-packs.json` (`lib/style-packs-index.ts`): each vendored pack's id, version,
  status, engine, minimum worker version, composition and digest. It is the third file of the signed update manifest
  (Phase 0 key and mechanism), listed only for workers that report it, so 0.8.0 workers keep getting their two files.
- Worker 0.9.0 installs it to `<home>/styles/style-packs.json` (from `install.sh`, then from signed updates; a pack
  change needs no worker version bump) and reports `pack:<id>@<version>` for each pack whose probe passes on that
  machine: stills packs need ffmpeg with `xfade`; Remotion packs need `remotion-2d` and the project's full probe to
  have rendered exactly that pack version's composition (`scripts/probe.mjs` reads `src/packs/packs.json`).
- The Remotion bundle (`/install/render-remotion.json`) is the runtime (`apps/render-remotion`) plus every
  remotion-2d pack's `render/`, installed as `src/packs/<id>/` with a generated `src/packs/index.ts` that `Root.tsx`
  registers. The worker maps a scene plan's template to its composition from the installed `packs.json`.
- A run's render job is queued under `pack:<id>@<version>` (the version the portal serves at render time), so only a
  worker that has that pack claims it. When workers report but none has that pack version yet (right after a deploy
  or a pack bump), the job waits and the render stage and the Jobs page say why; workers install it with their next
  signed update. An engine no worker can run at all is still refused at planning. Runs started before packs keep the
  engine routing they had.
- Known limits: a stills pack needs ffmpeg with `xfade` on the worker (every supported ffmpeg has it), so a worker
  without it gets no stills pack instead of falling back to hard cuts; a pack-only change shows on the Workers page
  as an available update of the version the worker already runs, and approve mode asks for it like any release.
- A Trial run's presentation score comes from the G-presentation gate, which the owner gives on the final video's
  Review card (Phase 2, below); runs without one are listed as not scored, never averaged in as 0, and block
  promotion until measured.

## Environments and engine command (worker 0.12.0): the handover from Hermes

Owner decision: tools are not pre-built by guess. When a style works in Hermes with its own tools (three.js, Godot,
Manim, Blender, Python libraries) and the owner liked a trial, Hermes opens a PR to venstudio-styles with the pack as
engine `command` and an `environment`: the exact recipe it used (pinned https downloads with sha256 and size, `npm ci
--ignore-scripts` from a lockfile in the pack, `pip --require-hashes` wheels, PATH-like variables), a probe and a fixed
render argv. The guide written for Hermes is [docs/hermes-handover.md in venstudio-styles](https://github.com/venturazz/venstudio-styles/blob/main/docs/hermes-handover.md)
(with a checklist and an Indonesian summary); the format is `styles/FORMAT.md` "Environments".

1. venstudio-styles CI installs the recipe on a clean runner as a non-root user with the vendored worker's own
   installer (`env-install`), runs the probe, renders the fixture with the worker's command renderer
   (`render-command`) and checks it with `check-video`. A failing recipe cannot pass.
2. The owner merges (the one control point). A venstudio PR vendors the commit; this repo's CI (`e2e.sh`) delivers the
   pack to a real worker through the signed update and checks it reports `env:` and `pack:`.
3. The portal serves `/install/env-packs.json` (`lib/env-packs.ts`): every pack with an environment and all its files.
   It is the fourth file of the signed update manifest, listed only for workers that report it (0.12.0+), so older
   workers keep getting the files they accept. The packs index names each pack's environment (`environment:
   "<id>@<version>"`, only on such packs).
4. Worker 0.12.0 checks each pack's files against its digest and writes them to `<home>/packs/<id>@<version>/`. Between
   jobs, in the background, it installs each environment into `<home>/envs/<id>@<version>/` (never as root; a disk
   check first; downloads verified; archives checked against traversal and symlinks; a manifest of installed files),
   runs the probe, and only then reports `env:<id>@<version>` and the pack's `pack:<id>@<version>`. A failure is
   recorded with its reason and tried again after 5 min, doubling up to 6 h; it never blocks other jobs. An older
   version of an environment is removed once a newer one passed and no installed pack uses it. Each claim carries the
   environments' statuses (`environments`, stored in `workers.environments`, migration 0021).
5. A render of a command pack runs the pack's argv with substitutions from a closed set, cwd its scratch folder, a
   minimal environment (no worker token or portal URL), a time limit from `secondsPerVideoSecond`, and its output
   captured into `command.log` (64 KB). Network: inside a user and network namespace where the machine allows it
   unprivileged (then it has none); otherwise every proxy variable points at a loopback listener that refuses and
   records requests, and any recorded request fails the job. The job result's `network` says which applied. Then the
   shared steps: PNG frames are checked (count and size) and encoded, captions burned, narration and audio mixed,
   probed, uploaded. The result records the pack, the environment and its licences.

What the portal shows, from stored rows only:

- Styles and New Video: the pack and a line "A worker has env:<id>@<v>", "env:<id>@<v>: installing… on <worker>",
  "env:<id>@<v>: failed on <worker>: <reason>" or "No worker has env:<id>@<v> yet" (`environmentLine`). A lab trial
  waits for `command`, then the environment, then the pack, saying which.
- Workers: each worker's environments with their status and reason (`workerEnvironmentLabel`).
- Template Lab: a look that needs a renderer no worker has reads "Needs an environment: hand it over from Hermes
  (docs/hermes-handover.md)", never that Kiro must build a renderer (`rendererVerdict`, `labTrialOption`). A video
  provider (`provider-video`) keeps its own wording.

The first pack through the channel is `three-low-poly` (Draft until its first real CI run): three.js 0.183.2 from npm
projects flat-shaded low-poly shapes on the CPU and resvg 0.44.0 from its GitHub release rasterises the frames.

What is enforced and what is trusted is listed in `styles/FORMAT.md` ("What a worker enforces, and what it trusts"):
the recipe's shape, hashes, hosts, archive safety, no root, the probe before any capability, the minimal render
environment and its limits are enforced; the code of the pack and of the tools it installs is trusted after review, the
styles CI and the owner's merge.

## Phase 2: renderers, html-capture, the Hermes research renderer, the presentation score

### Renderers

A pack names its renderer in `renderer.engine`. The worker (0.10.0) has one plugin per renderer (`ffmpeg-stills`,
`remotion-2d`, `html-capture`): id, probe, input check, render step, and whether the shared 0.7.0 audio mix and
caption burn run after it. The portal routes a render by pack plus renderer (`renderRoute` in
`lib/studio/render-gate.ts`): a pack's job is queued under `pack:<id>@<version>`, a job without a pack under the
renderer's capability (`ffmpeg`, `xfade`, `remotion-2d`, `html-capture`; the names workers already reported), and a
`hermes` render is done by the portal. An unknown engine is refused by name on both sides, never rendered as stills.

### html-capture packs

`render/index.html` plus its text files (`docs/html-capture.md`, `styles/FORMAT.md`). They travel in the same signed
Remotion bundle as `html/<id>/` with `html/packs.json` (id, version, `drawsCaptions`, render digest), so a worker
with the Remotion renderer gets them with its next signed update. First pack: `probe-line-graph` (Lab), rendered in
CI here and in the styles repo.

### The hermes renderer (research only, owner decision)

A pack with engine `hermes` (`hermes-research-explainer`) is rendered by the portal: the render stage sends Hermes,
through the Hermes gate, the storyboard, the scene plan, the pictures' and narration's URLs on Hermes's media host
and the pack's contract (`lib/studio/hermes-render.ts`). Hermes renders with its own tools and answers with a
`/clip/` URL, which is parsed, downloaded from a trusted media origin and sniffed like any Hermes clip
(`lib/server/executors/hermes-render.ts`). The video is stored with executor `hermes-render` and the backend and
plugin Hermes named in its provenance, then goes through qc-video, Review and the curation log like any render,
with `renderer: hermes`. The render is a job the portal starts once and then waits for (below, "Long renders").
Rules, each in code with no bypass:

| Rule | Where |
| --- | --- |
| A hermes pack is never above Trial | the styles validator; `parsePack` leaves such a pack out |
| A hermes run is always a trial | `runStylePack` and `parseRunStylePack` (whatever a config says); the render stage refuses a run that is not a trial |
| Never published, never auto-approved | `publishRefusal` and `guardFinalDecision` (the final video always goes to the owner) |
| New Video: Trial section only, "Hermes render (research only)" | `newVideoStyles(..., { hermes })`, shown when Hermes is set up |

### The presentation score (G-presentation)

On the final video's Review card the owner rates hook, pacing, legibility, visual polish and audio from 1 to 5 stars
(390 px friendly, owner only). The score is the mean mapped to 0-100 (1 star = 0, 5 stars = 100) and gated with
`PRESENTATION_PASS` (`lib/studio/presentation.ts`). It is stored as the run's G-presentation qc report for that
video (executor `owner`, the rubric in its details) and counts only for that video. A trial run's video cannot be
approved, approved anyway or rejected before it is scored (a quality check that stopped with an error, and so has no
video, can still be rejected or retried); other runs may skip it.

Hermes's advisory (optional): when Hermes is set up, the quality check asks the worker (0.10.0) for 6 evenly spaced
stills; the portal shows them to Hermes through the gate with the pack's contract and stores its JSON rating on the
quality-check stage and in the curation log. It is shown on the card as advisory and never decides or counts.

Migration 0016 (additive) adds `owner_rubric`, `presentation_by`, `hermes_advisory` and `renderer` to
`style_trial_outcomes`. With five owner-scored trials at a mean of 80 or more (and the rest of the rule met), the
Styles page reaches **Ready to promote**.

## Research styles and lab trials

What the owner sees, in plain words, on New Video and Styles (`LIFECYCLE_TEXT`):

- Research styles (Hermes render) and lab trials are for testing and curating, never for publishing.
- Trial packs collect evidence toward Proven.
- Only Listed styles publish.

### Research styles: one Hermes research pack per claude-animation-skills skill

The styles repo has ten `hermes-*` packs at `trial`, one per skill of
github.com/artemnovitckii/claude-animation-skills at `86f70106c9ae` (MIT, fonts OFL; `zach-3d-films` is an alias
inside `hermes-zach-d-films`). Hermes has that repository installed and renders with the skill itself, so a pack is a
contract plus a `hermes` block: the skill (`/graph`), its aliases, `mode` (`spec`: a quick skill from a small JSON
spec; `project`: a full reel with its own voice and caption timing) and how the storyboard, narration and captions
map to its input. Their evidence for `trial` is a `research-source` curation entry (the pinned skill and the owner's
report that it works in Hermes); there is no CI render for a hermes pack (FORMAT.md).

| Pack | Hermes skill |
| --- | --- |
| `hermes-breakdown` | `/breakdown` |
| `hermes-dan-koe` | `/dan-koe` |
| `hermes-graph` | `/graph` (research variant of `animated-line-graph`) |
| `hermes-kurzgesagt` | `/kurzgesagt` |
| `hermes-low-poly` | `/low-poly` |
| `hermes-map-route` | `/map-route` |
| `hermes-minecraft` | `/minecraft` |
| `hermes-minimalistic-graphics` | `/minimalistic-graphics` (research variant of `minimal-line-art`) |
| `hermes-stick-figure` | `/stick-figure` (full project) |
| `hermes-zach-d-films` | `/zach-d-films`, alias `/zach-3d-films` (full project) |

New Video shows them in the Trial section under "Hermes research styles (from claude-animation-skills)"
(`researchGroupOf`), each with the "Hermes render (research only)" badge, its description and the source credit.
They are selectable whenever `HERMES_BASE_URL` is set; no worker is needed. The render request
(`hermesRenderMessages`) names the skill in its instruction and in its data (`skill.name`, `skill.input`,
`skill.output`); a `project` skill is told to use the run's narration and captions where it can, and that the result
is a reel the studio checks. With the `hermes-skill` workflow (below) the request carries the run's skill brief instead
of a storyboard and pictures. Hermes's reply is handled exactly as before: a `/clip/` URL, parsed, downloaded from a
trusted media origin, sniffed, then qc-video. The video asset's metadata records `executor: hermes-render`, the
backend, the plugin and `hermesSkill`; the render stage's result carries `hermesSkill` too.

### Long renders: start once, then wait for the file

A long skill (`/stick-figure`, `/zach-d-films`, 3D) renders for longer than any chat turn the portal can hold open.
The render used to be one turn with a 30-minute timeout; after a slow turn the stage waited and asked again, so Hermes
started the same video from scratch every time and never finished. Now (`lib/studio/hermes-render-job.ts`, driven by
`runHermesRenderStage` in `lib/server/production.ts`):

1. **Start once.** The request names the output file, `vs-<runId>-<attempt>-<rand>.mp4` under the video media base
   (`/clip/` → Hermes's `cache/generated/videos`; without `HERMES_MEDIA_ORIGINS`, `/clip` on the Hermes origin), and
   asks Hermes to render with the pack's skill, save exactly that name, and answer as soon as the render has started:
   `{"status":"started"|"done"|"error","file","note",...}`. The start ask goes through the gate with a 5-minute
   timeout and is never retried inside the call. The job (file, URL, `startedAt`, attempt, budget, Hermes's answer)
   is stored in the stage output (`hermesRender`) *before* the ask, so a restart polls instead of asking again.
2. **Poll, don't re-ask.** The stage then waits as pending with a not-before time, holding no gate slot: every minute
   for 10 looks, every 2 min for 10 more, then every 3 min, the portal sends a HEAD for the expected URL (a trusted
   media origin only; a host without HEAD gets a GET). The file is taken when Hermes said it is done, or when it has
   the same size at two looks in a row; then it is downloaded (`fetchMedia` limits), sniffed, stored with the usual
   provenance (executor `hermes-render`, backend, plugin, `hermesSkill`, research only) and qc-video is queued as
   before. A complete file that is not a video is looked at again and fails after 3 in a row. Polls run from the
   in-process resume timer, the worker claim route's nudge and the reaper's restart of due stages; pages never make the
   call themselves.
3. **Status.** The run page and Review say "Video: Hermes is rendering with /<skill> (started HH:MM UTC, N min ago).
   The studio checks for the finished file every minute; nothing is restarted." (`renderingText`). No progress asks
   are made while it renders (Hermes is one agent and is busy with the render).
4. **Limits.** The budget is the pack's `hermes.renderMinutes` when the styles format has it (the portal reads it;
   the styles validator does not accept the key yet), else 120 min for a `spec` skill and 240 min for a `project`
   skill. Past it, Hermes gets one tiny check ask ("is vs-….mp4 still being rendered?"); then the stage fails with
   "Hermes did not produce <file> within N min; ..." and Retry, which starts a new attempt with a new file name.
   If the check cannot be asked (Hermes busy), the studio tries again for 30 min, then fails without it. A render is
   never restarted automatically. The reaper uses the budget too: it fails a hermes render only past its budget plus
   45 min, and puts a pass that stopped answering (a restart mid-poll) back to pending, which polls again.
5. **Old Hermes behaviour.** An answer of `done` with a URL (a quick skill, or the old `{"status":"ok","video":...}`)
   is taken at once. A different file name or URL on the trusted media host is accepted and recorded. An answer that
   is not JSON, or a start turn that times out, is taken as "started": the file is waited for, never asked again.
6. **The gate.** Only the start ask, the check ask and (for a skill that voices itself and did not name its voice
   backend) one provenance ask go through the gate. Waiting does not hold it, so other runs and the owner's chat go on.
7. **Runs from before.** A render stage left in the old "busy or slow, trying again" state has no `hermesRender` in
   its output: on its next turn it starts once with this flow (a fresh attempt, the old slow streak and wait clock
   dropped). A pass the old code left running is put back to pending by the reaper and does the same. The owner can
   also Cancel such a run.

### Packs the catalogue does not know

A pack without a catalogue entry (the html-capture adaptations, the research packs, a future learned pack) gets its
style from its own contract (`styleFromPack`) and a seed template `tpl-<id>` from it (`packSeedTemplate`, seeded by
`ensureSeedTemplates`). The scene plan and the render parameters read that style (`buildScenePlan({ style })`,
`renderParamsForStyle(id, style)`, including the pack's own cross-fade), so such a pack renders with its own engine
instead of falling back to stills. When the vendored pack version changes, `ensureSeedTemplates` writes the template's
next version from the new contract (`refreshedPackTemplate`: same status, the owner's checklist sign-offs kept).

### Batch trials ("Try these styles")

New Video's Trial section has a "Try these styles" list: tick two or more Trial or research styles and press
"Start N trials". One brief (channel, brief, format, language and theme from the form) starts one trial run per style,
in the order ticked (`startBatchTrialAction`; `batchTrialIssues` refuses fewer than 2 or more than 12 picks, repeats,
styles New Video does not offer in its Trial section, lab trials and the wrong format, before any run starts). Each run
records `config.trialBatch` (`{ id, index, total }`, additive). They start together; Hermes takes one ask at a time
through its gate (concurrency 1 unless `HERMES_MAX_CONCURRENCY` says otherwise). A Hermes render holds the slot only
for its start ask; while Hermes renders, the studio waits for the file without a slot, so the runs move in turn. The **Trial queue** card on New Video and Styles shows the newest batches,
each run with its position and where it is (queued for Hermes, Hermes is on it, waiting for you in Review, finished).

### Lab trials (Draft and Lab packs)

A Draft or Lab pack can run as a **lab trial** without waiting for promotion:

- From Styles: "Try it (lab trial)" on each Draft or Lab pack opens `/studio/new?lab=<id>`.
- From a Template Lab study: "Lab trial" for the closest pack and every other Draft or Lab pack opens
  `/studio/new?lab=<id>&study=<study>` (linked to the study).

`labTrialOption` decides from stored worker rows only. A hermes pack needs Hermes set up. Any other pack needs a worker
that reports `pack:<id>@<version>`; otherwise the button is disabled with the exact reason and the fix: "No worker
reports html-capture" (update the worker to 0.10.0 or later with the Remotion renderer), "No worker reports
pack:<id>@<version> yet" (update the worker: it installs the pack with its next signed update), or "Needs a renderer
that isn't installed: <engine>" (a 3D or other engine no worker runs). When a hermes pack names the pack in
`hermes.variantOf`, Styles also offers "Try the Hermes research variant".

`startRun({ labTrial: true })` accepts only Draft and Lab packs and checks `labTrialOption` again. The run's
`stylePack` gets `lab: true` (and `trial: true`): badged "Lab trial (draft pack)" on New Video, the run page and Review;
refused by `publishRefusal` ("Lab trial (draft pack) <id> <version>: research only, never published.") and kept from
auto-approval by `guardFinalDecision`. Its outcome is written to `style_trial_outcomes` with `lab_trial = true`
(migration 0018, additive), shown on Styles as its own record, and never counted by `trialCounts` or copied by
`curationRecord`: only runs of the pack once it is at Trial count toward Proven.

### Where each style sits on Styles

Styles groups the packs (`styleGroup`): Research styles (every hermes pack), Trial, Draft and Lab, Listed, Proven,
Retired, then Planned. Each Trial pack shows its trial count, technical pass rate, mean presentation score and the
owner's decisions for its current version; a pack with lab trials shows those apart.

## Workflows (recipes)

Every run used to go idea → research → script → storyboard (an image prompt per shot) → assets (a picture per shot) →
voice → render → qc, whatever the style, so data-driven pages and the Hermes research styles generated pictures they
never used. Now a pack names the **workflow** its runs follow (style.json `workflow`, `styles/FORMAT.md` "Workflows"):
a recipe, the stage kinds in order, plus `review`, the stages where the owner always reviews whatever the autonomy level.

| Recipe | Stages | Packs |
| --- | --- | --- |
| `image-sequence` | idea, research, script, storyboard, assets, voice, render, qc | the six stills packs, `explainer-flat-vector`. Today's pipeline, byte for byte. |
| `scene-spec` | idea, research, script, **scene-spec**, **preview**, voice, render, qc | `animated-line-graph`, `minimal-line-art`, `probe-line-graph` (all with `review: ["scene-spec"]`; the preview is always reviewed) |
| `hermes-skill` | idea, research, script, **skill-brief**, voice, render, qc (no voice when `hermes.voice` is `skill`) | the ten `hermes-*` skill packs and `hermes-research-explainer` (all with `review: ["skill-brief"]`) |
| `html-design` | idea, research, script, **html-design**, **preview**, voice, render, qc. **Research only** (owner decision) | `hermes-designed-explainer` (trial, `review: ["html-design", "preview"]`) |
| `engine-project`, `clip-sequence` | reserved | none: refused by the validator and by `startRun`. |

### How a run's list is chosen and stored

- `startRun` asks `workflowForPack` (`lib/studio/recipes.ts`): the pack's `workflow.recipe`, or the one its engine and
  asset model imply when it names none (hermes → hermes-skill; html-capture with plates → scene-spec; otherwise
  image-sequence; the styles validator infers the same). The stage list (without the voice when a hermes skill voices
  itself) and the review points are stored in `pipeline_runs.config.workflow` (additive). A recipe that is not built
  refuses the start: "This style needs a workflow that isn't built yet: <name>".
- The engine reads the run's own list (`runStagesOf`) for the next stage (`approveStage`), revision targets
  (`revisionTarget(..., stages)`: a note about pictures or the storyboard in a scene-spec run restarts the scene spec;
  a voice note in a run whose skill voices itself restarts the brief), the run page and the Review titles. A stage
  missing from the list is refused instead of finishing the run.
- A run without `config.workflow` (started before workflows, or a damaged one) keeps `RUN_STAGES`, which is also the
  image-sequence list. `fixtures/prompts/image-sequence-prompts.json`, written by the code before workflows, pins the
  image-sequence prompts, work orders and the storyboard Hermes render request; `fixtures/render/explainer-payload.json`
  still pins the payload.
- Migration 0019 widens the `pipeline_stages.stage` CHECK with `scene-spec` and `skill-brief`. The stuck and orphan
  reapers and the stage claim know both kinds. The final decision waits for G-assets only in a workflow with an assets
  stage (`finalGatesFor`).

### scene-spec

- Research gets two more lines (`SCENE_SPEC_RESEARCH_LINES`): find the real numbers the scenes need, each with its
  source, written exactly as the source gives them. Image-sequence and hermes-skill research prompts are unchanged.
- The scene-spec stage asks Hermes, through the gate, for JSON: per scene `seconds`, `beat`, `elements` (`kind`, `text`,
  `value`, `series`, `labels`, `source`), `tokens` and `caption` (`lib/studio/scene-spec.ts`). The validator checks it
  against the pack's contract: only the pack's elements and motion tokens, a token per scene, series of 1 to 6 numbers,
  one label per value, values in range, `source` naming a research note. The gate checks pacing and narration coverage
  with the storyboard's shared limits, and that every number (value, series, any digit in a text) is in the research
  note it cites and that note has a source link. A spec with an unsourced number fails, by name: "Scene 3 counter
  shows 1200 but cites no research note. Numbers must come from the research notes; never invent data." The script of
  a scene-spec run is burned in as captions, so its script gate also fails a number written in digits that no sourced
  note contains (numbers spelled out in words are not read).
- The spec becomes the scene plan and the render payload directly (`sceneSpecShots` → `buildScenePlan` →
  `buildRenderPayload`): the worker contract is unchanged, so no worker bump. The render contract carries a picture per
  shot, so the portal draws one plain-colour plate per run (`lib/studio/plate.ts`, source `generated`, executor
  `portal-plate`, no model) and every shot points at it. Labels and sources stay in the spec for Review.
- Review: the scene-spec card lists the scenes as text (elements, numbers with the note each cites, motion, caption).
  The preview stage that follows shows still frames of the pack's page (below).

### The still-frame preview (scene-spec and html-design)

- After the scene spec (or the page Hermes wrote) is approved, and before the voice and the render, the preview stage
  queues a `preview-frames` job (worker 0.11.0, `docs/html-capture.md`) under the run's `pack:<id>@<version>`: the
  render payload without the narration (`frame-preview.ts` `previewPayload`), six times (`previewTimes`: the middle of
  each scene, spread or filled to six), and for html-design the page asset. The narration's length is used when the run
  already has one (a revision after the voice), otherwise the planned scene times.
- The worker draws every frame up to the last asked one through the same loopback server, request blocking and
  virtual clock as a render, captures the asked ones as JPEG (`still-01.jpg` ...) and reports the page's console errors
  and anything it tried that was blocked. The Review card shows the stills (`/api/artifacts/<id>`), the plan and a note.
  The owner approves the look, or a revision note goes back to the stage before the preview (`revisionTarget`: a note on
  a preview card restarts the scene spec or the page, or an earlier stage when it says so).
- The preview is an owner-only stage (`OWNER_ONLY_STAGES` in `recipes.ts`, with `html-design`): no autonomy level and no
  stored config approves it.
- No worker reports `preview-frames` (`previewWorkers`, stored rows only): a scene-spec run's card says so and the owner
  continues with the spec text only, as before previews. An html-design run stops with a stage error instead
  (`HTML_DESIGN_NEEDS_PREVIEW`): its page is never rendered without the check. Workers that report preview-frames but
  not yet the pack version leave the job waiting, as a render does.
- A failed preview job (the page threw, tried the network, the worker refused) becomes a gate-failure card with the
  worker's error: Retry, Send revision (to the scene spec or the page) or Reject.

### html-design (research only)

The owner approved building it: Hermes writes the HTML page for each video. It is the one place model-written code
runs, so the page is checked before anything runs and run in a sandbox, and every run is research only.

- **The stage.** `html-design` asks Hermes, through the Hermes gate (`hermesJson`), for JSON: `html` (one
  self-contained `index.html`, inline CSS and JS), optional `files` (small `.js`, `.css`, `.svg`), a short `note`, and
  `scenes` (beat, seconds, caption: the script's beats mapped to times), plus optional `backend`/`plugin`
  (`lib/studio/html-design.ts`). The prompt carries the pack's `design` brief (palette, typography, layout), its contract,
  the frame, the props contract and the rules below, and the pack's vendored files the page may load as `../pack/<path>`.
- **The validator** (`pageIssues`, best effort by token scan, before anything runs): 300 KB and 20 files at most, text
  only, plain relative names; no URL to another host anywhere (`http(s)://`, `ws(s)://`, `//host`, `@import` of a host,
  `<base>`; XML namespace names are allowed only outside URL attributes); `data:` only for images (a font comes from
  `../pack/` or the run's font, and `@font-face` sources are checked for it, so every font has a recorded licence); no
  `<iframe>`, `<object>`, `<embed>`, `<form action>`, any `<meta http-equiv>`, service workers, `Worker`, blob
  URLs, `WebSocket`, `fetch`, `XMLHttpRequest`, `EventSource`, `sendBeacon`, `import()`, `eval`, `new Function`, string
  timers, `window.open`, navigation, `atob`/`fromCharCode`, `local()` fonts or GSAP; `window.VENSTUDIO` with `init` and
  `renderFrame`; every reference is the page's own file, `../pack/<vendored file>` or `../in/<input>`. The issues go
  back to Hermes through hermesJson's retry (with the line they are on), then through the owner's revision loop. The
  gate (`htmlDesignGate`) checks the scene list's pacing and narration coverage with the storyboard's limits.
- **Storage and provenance.** The approved page is stored as the run's `html-page` asset (migration 0020, additive), a
  page bundle `{ format: 1, kind: "venstudio-html-page", files }` saved as `application/json` (never `text/html`, so the
  portal never serves it as a document), source `hermes`, executor `hermes-html-design`, `researchOnly: true`, the
  backend and plugin Hermes named, the stage it came from and its sha256 (`lib/server/html-page.ts`). One asset per run
  and page; the preview and the render share it.
- **The render.** `render-video` carries `page: { assetId }` (listed in `inputs`) under `pack:<id>@<version>`. Worker
  0.11.0 serves the page as `page/`, the pack's files as `../pack/`, the run's media as `../in/`, with a strict CSP and
  the page guard (`docs/html-capture.md`), and renders an html-design pack only with an uploaded page (`designed` in
  `html/packs.json`), so a pack's reference page never stands in for a run's page.
- **Research only, each rule in code:** the validator keeps an html-design pack at most `trial` and on `html-capture`;
  `parsePack` leaves out one that claims more; `runStylePack`, `parseRunStylePack` and `parseRunConfig` make every
  html-design run a trial (`stylePack.designed`), whatever a stored config says; `publishRefusal` and
  `guardFinalDecision` refuse publishing and auto-approval ("Hermes-designed page (research only): a video drawn from a
  page Hermes wrote is never published."); the html-design and preview stages are owner-only; the html-design stage,
  the preview and the render refuse a run that is not a trial; New Video shows such packs only in the Trial section,
  with the badge "Hermes-designed page (research only)" (also on the run page and every Review card).
- **Template Lab.** html-design is a built recipe: a draft may recommend it (html-capture only); its exported
  style.json carries `workflow: { recipe: "html-design", review: ["html-design", "preview"] }`, worker 0.11.0 and a
  starting `design` block, so it validates; Start a trial works with an html-design pack like any Trial pack.

### hermes-skill

- The skill-brief stage has Hermes turn the approved script into the input the pack's skill expects
  (`lib/studio/skill-brief.ts`): one JSON spec per shot for a `spec` skill (plain data, no links, at most 2000
  characters), a text project brief for a `project` skill or the generic Hermes render. The gate checks pacing and
  coverage. The Hermes render request carries the brief (`data.brief`) and says no pictures were made.
- `hermes.voice` decides the voice. The eight quick skills (`run`) use the run's narration. `stick-figure` and
  `zach-d-films` (`skill`) record their own voice with the skill's Kokoro tool and time every shot to it, so the run
  has no voice stage: the script goes to Hermes as `narration.script`, the reply must name the voice backend
  (`voice`), the video's licence and metadata (`narration`) record it, the backend is registered as a provider, and its
  terms gate the narration like any voice (a G-voice result on the render). Research-only rules are unchanged.

- **Portal override, `SKILL_VOICE=studio` (default).** New runs of these two packs keep the voice stage anyway
  (`withStudioVoice` in `recipes.ts`; the pack files are unchanged). The narration is made by the studio's voice paths,
  Kokoro on a worker first, instead of inside the long Hermes render; the skill brief tells the skill the run narrates;
  the render asks Hermes for picture and captions only and tells it to skip the skill's own voice step; a `hermes-mux`
  worker lays the narration on. Runs started earlier keep their stored list. `SKILL_VOICE=skill` restores the old way.

### The run's narration on Hermes's picture (hermes-mux, worker 0.13.0)

The run's narration lives in the portal's storage, which Hermes cannot read (Kokoro and 9router voices have no media-host
URL), so a `run`-voice render used to come back silent. Now (`lib/studio/hermes-mux.ts`, `queueHermesMux` and
`completeHermesMux` in `lib/server/production.ts`):

- Every hermes render whose narration is the run's (`hermes.voice: "run"`, and any hermes render of a run with a voice
  stage) asks Hermes for the picture and the burned-in captions only, timed to the narration ("The studio adds the sound
  afterwards …"). Hermes is never told to render without a voice.
- Hermes's clip is stored as a video asset ("Hermes picture", executor `hermes-render`, its backend, plugin, skill and
  `/clip/` URL), then a `render-video` job with `engine: "hermes-mux"` is queued under the `hermes-mux` capability. Its
  inputs (the clip, the narration, the bed and accents of the run's audio plan) are downloaded like any job input. The
  worker drops the clip's audio and runs the shared chain (`buildMuxArgs`, `audioMixFilter`: narration tempo, bed,
  ambience, mastered loudness). Lengths: a picture shorter than the narration holds its last frame (`tpad`, re-encoded);
  up to 3 s longer plays whole with the narration padded with silence; longer than that is cut 0.5 s after the
  narration. The result reports `mux` (mode, lengths) and the measured `integratedLufs`; the card says what was done.
- The final video asset (executor `hermes-mux`, source worker) names both inputs in its metadata (`picture`,
  `narration`, `musicBed`, `inputAssetIds`) and licence. QC runs on it as before.
- A worker reports `hermes-mux` only where its ffmpeg has the whole audio-mix chain and `tpad`. With no such worker the
  render stage stops before Hermes is asked: "… no worker reports hermes-mux (worker 0.13.0 or later …). Update the
  worker …". A silent video is never concluded.
- `stick-figure` and `zach-d-films` (`hermes.voice: "skill"`) keep Hermes's own audio; G-technical fails a video whose
  audio is silent ("The video's audio is silent": loudness below -50 LUFS or not measured, or silence over 80% of the
  video; styles without narration fail only when both agree, and never with music policy `none`).

### Revisions on a Hermes video

A note on the render or quality-check card of a hermes run goes back to the **render** stage (`revisionTarget` with
`renderer: "hermes"`): the new attempt asks for a new file, and the start ask carries the note as a DATA block ("Owner's
notes on the previous video") with the previous file's name. Only a note about the voice itself (`VOICE_NOTE` in
`voice-fit.ts`: voice, accent, pronunciation, male/female, robotic, speaker, narrator) records the narration again; "no
sound", "silent", "audio missing" never do. For worker-rendered runs a note about missing or wrong sound re-runs the
render (the mix) and only voice words go to the voice. The card's hint says where the note goes.

### What the owner sees

| | image-sequence | scene-spec | hermes-skill |
| --- | --- | --- | --- |
| New Video | "Workflow: Image sequence: Idea → … → Quality check" under the engine line | "Workflow: Scene spec (data-driven, no pictures): …" | "Workflow: Hermes skill (research only, no pictures): …" |
| Run page | the run's own steps with their state (`run-workflow`); "Workflow" in Video settings | the same; "This workflow makes no pictures, so it has no work orders." | the same |
| Review | storyboard card as before; the image grid on the assets card | the scene-spec card (scene list as text, the preview note) | the skill brief card (a line per shot with its spec, the project text) |

### Known limits

- A skill that voices itself is checked only by its voice backend's provider terms on the render card, and by qc-video
  on the finished reel (loudness, silence, length); there is no separate narration file to check for language or
  clipping. When only those terms block, the render card offers **Check the terms again**: the terms are judged again
  on the reel that is already made (nothing is rendered again), and a terms change in Settings re-checks such cards on
  its own, like assets and voice cards.
- Voice-card labels and hints in runs without pictures say "keep the plan" (`tightenLabel`, `keptWord`).
- The html-design validator is a token scan: it cannot prove a page safe (a page can build a name at run time). That is
  why the worker's sandbox (CSP, request blocking, the page guard, the DOM check, the frame budget) is the boundary,
  and the validator the first, readable line.
- The preview's stills of a page that does not draw its own captions have no captions (they are burned at the render);
  the card says so.
- The skill brief's own numbers are not checked against the research notes (research-only rules are as before).
- Rolling the portal back after 0019 leaves runs with scene-spec or skill-brief stages unclaimed (the old code does
  not know those kinds); cancel them first. The same holds for html-design and preview stages after 0020.

### Template Lab

A study's synthesized draft recommends a workflow as well as a renderer (`DraftSpec.workflow`): a known recipe that
fits the renderer (an unknown or misfitting one is fed back to Hermes). A recipe that is not built is kept and said
plainly ("needs a workflow that isn't built yet: html-design"); the exported style.json carries `workflow` only for a
built recipe, so the draft still validates, and its README names the recommendation.

## Curation log and promotion

A Trial run's outcome is written to `style_trial_outcomes` (migration 0015, additive) after its quality check and
again after every decision on it: pack version, QC gates, G-technical result, presentation score, the owner's final
decision (approved, rejected, revised, or auto-approved by the autonomy policy) and the video asset.

The Styles page shows, per Trial pack, the counts for its current version against the promotion rule in
`lib/studio/templates.ts`: at least 5 trials, every one passing G-technical, mean presentation at least 80, no asset
or compliance failures, no open claims, and the owner's copyright checklist (Templates page) signed. When nothing is
missing it shows **Ready to promote** with a JSON block of curation entries and a copy button.

### Promotion procedure (no GitHub token anywhere)

1. On Studio → Styles, the pack shows "Ready to promote: copy this curation record into the pack". Press **Copy
   curation record**.
2. In venturazz/venstudio-styles, open a PR (Hermes or Kiro may prepare it) that appends those entries to
   `packs/<id>/style.json` → `curation`, sets `status` to `proven` and bumps `version` (patch). The owner adds the
   `owner-review` entry with result `approved` (date, ref = the PR). The validator refuses `proven` without it.
3. The owner merges. Later, a second owner-approved PR sets `status` to `listed`.
4. Here: run the sync for the merged commit, open "bump styles to <commit>", let CI pass (real renders included),
   merge, deploy. Workers pick up the new index and bundle with their next signed update.

## Files

`scripts/sync-styles.mjs`, `scripts/remotion-project.mjs`, `styles/`, `lib/studio/style-registry.ts`,
`lib/server/style-packs.ts`, `lib/server/style-trials.ts`, `lib/style-packs-index.ts`, `lib/install-bundle.ts`,
`lib/update-manifest.ts`, `app/(app)/studio/new/page.tsx`, `app/(app)/studio/runs/run-form.tsx`,
`app/(app)/studio/styles/page.tsx`, `db/migrations/0015_style_trials.sql`, worker `parsePacksIndex`,
`packCapabilitiesFor`, `installPacksIndex` and `install-packs`. Phase 2: `lib/studio/presentation.ts`,
`lib/server/presentation.ts`, `lib/studio/hermes-render.ts`, `lib/server/executors/hermes-render.ts`,
`app/(app)/review/presentation-form.tsx`, `db/migrations/0016_presentation_scores.sql`, worker `RENDERERS`,
`captureHtml`, `htmlCaptureUnavailableReason`, `capture-html`, `apps/worker/html-capture-render.test.ts`. Research
trials: `lib/studio/trial-batch.ts`, `lib/server/trial-queue.ts`, `app/(app)/studio/trial-queue.tsx`,
`lib/studio/research-trials.test.ts`, `db/migrations/0018_lab_trials.sql`, and in `style-registry.ts` `styleFromPack`,
`packSeedTemplate`, `styleGroup`, `researchGroupOf`, `labTrialOption`, `researchVariantFor`, `labTrialCounts`.
Workflows: `lib/studio/recipes.ts`, `lib/studio/scene-spec.ts`, `lib/studio/skill-brief.ts`, `lib/studio/plan-review.ts`,
`lib/studio/plate.ts`, `lib/server/plate.ts`, `db/migrations/0019_workflow_stages.sql`, `fixtures/prompts/`, and the
tests `recipes.test.ts`, `scene-spec.test.ts`, `skill-brief.test.ts`, `image-sequence-golden.test.ts`. html-design and
the preview: `lib/studio/html-design.ts`, `lib/studio/frame-preview.ts`, `lib/server/html-page.ts`, the preview stage in
`lib/server/production.ts`, `db/migrations/0020_html_design.sql`, `lib/studio/html-design.test.ts`, and worker
`preview-frames`, `parsePageBundle`, `HTML_PAGE_CSP`, `HTML_PAGE_GUARD_SOURCE` (`apps/worker/html-design.test.ts`).
Environments and engine command: `lib/env-packs.ts`, `servedEnvPacks` in `lib/server/style-packs.ts`,
`workerEnvironmentRows` in `lib/server/workers.ts`, `environmentLine`, `workerEnvironmentLabel` and `HANDOVER_REASON` in
`style-registry.ts`, `HANDOVER_TEXT` in `lab-study.ts`, `app/api/worker/claim/route.ts` (`environments`),
`db/migrations/0021_environments.sql`, `lib/environments.test.ts`, and worker `parseEnvironment`, `installEnvironment`,
`planExtraction`, `downloadPinned`, `runCommandRender`, `env-install`, `render-command`, `install-env-packs`
(`apps/worker/environments.test.ts`).
