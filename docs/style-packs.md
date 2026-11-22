# Style packs (Phases 1 and 2)

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
| Draft, Lab, Proven, Retired | Never | Refused by `startRun` |
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
with `renderer: hermes`. Rules, each in code with no bypass:

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
`captureHtml`, `htmlCaptureUnavailableReason`, `capture-html`, `apps/worker/html-capture-render.test.ts`.
