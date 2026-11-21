# Style packs (Phase 1)

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
  worker that has that pack claims it; with workers reporting but none reporting the pack, the render stage stops
  with a message and a Retry. Runs started before packs keep the engine routing they had.

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
`packCapabilitiesFor`, `installPacksIndex` and `install-packs`.
