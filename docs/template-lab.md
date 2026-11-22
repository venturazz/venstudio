# Template Lab (style system Phase 3)

Plan: `docs/plans/style-system.md`. Studio → **Lab** (`/studio/lab`, editors and the owner, 390 px friendly) is where
the owner starts a **lab study** toward a new style pack or an improved one, collects sources, lets Hermes take notes,
gets a draft pack spec, downloads it for a PR in venstudio-styles, and starts trial videos from it.

## Ringkasan (Bahasa Indonesia)

- **Studi lab** = kumpulan sumber belajar menuju gaya baru atau perbaikan gaya: upload owner (dengan hak, diukur
  oleh job `analyze-video` di worker), link publik termasuk YouTube, repo publik, skill Hermes, artikel, catatan owner.
- **Link hanya disimpan sebagai link.** Portal tidak pernah mengambil, mengunduh, atau menyimpan frame, audio maupun
  naskah. Hermes yang menonton/membaca dengan alatnya sendiri lewat gate, dan hanya catatan pola (JSON tervalidasi)
  yang disimpan. Setiap sumber mencatat lisensinya ("unknown" untuk link/artikel) dan statusnya.
- **Sintesis**: Hermes menggabungkan temuan menjadi draft spesifikasi pack (kontrak, renderer yang disarankan,
  alasan, pack terdekat). Angka dari upload mengalahkan tebakan Hermes. Renderer yang tidak dilaporkan worker mana pun
  disebut terus terang: "needs a renderer that isn't installed: <x>".
- **Unduh draft pack**: satu file JSON (style.json + README.md + fixtures/expect.json + provenance + langkah PR).
  Portal tidak punya dan tidak butuh token GitHub.
- **Uji coba dari studi**: bila renderer dan pack terdekat ada di worker, tombol "Start a trial video with the closest
  pack" mengisi New Video; run ditandai trial dan tertaut ke studi; hasil QC dan skor presentasi tampil di halaman studi.
- **Revisi**: maksimal 5 kali; catatan owner dikirim ke Hermes dalam blok DATA.

## Sources

| Type | Stored | Looked at by | Licence recorded |
| --- | --- | --- | --- |
| Upload (with rights) | the asset id and its analyze-video job | the worker: cuts, shot lengths, first cut, loudness (numbers only, `lib/studio/template-lab.ts` fingerprint) | the licence on the asset; an asset without one cannot be added |
| Public link (YouTube included) | the URL | Hermes, with its own tools; for YouTube through YouTube's own player and features | `unknown` unless the owner names one |
| Public repository | the URL and an optional path | Hermes: techniques (renderer, libraries, timing) and the licence in its LICENSE file | what Hermes read, marked "(read by Hermes)" |
| Hermes skill | the name | Hermes reads the skill's instructions without running it | `not recorded` unless given |
| Article | the URL | Hermes | `unknown` unless given |
| Owner note | the text | nobody (analyzed when added) | `owner` |

Each source has a status: **pending** (with what it waits for), **analyzed**, or **failed** with the reason. A Hermes
rate limit leaves a source pending with the wait; "Ask Hermes about the waiting sources" and "Ask again" retry.

Rules, each in code:

- Links must be public `http(s)` URLs without credentials or local/private hosts (`publicUrlIssue`). The portal never
  fetches them: neither `lib/studio/lab-study.ts` nor `lib/server/lab-studies.ts` can make a request (a unit test
  checks the source), and CI's browser end-to-end runs the portal with a fetch canary
  (`scripts/e2e-fetch-canary.mjs`) that fails and records any request to YouTube or GitHub.
- Hermes is asked through the shared gate with `hermesJson` (validated JSON, retries, busy handling). The reference,
  the owner's notes, other sources' findings and revision notes go into DATA blocks only.
- Notes are validated (`parseSourceNotes`): short texts per field (pacing, transitions, text layout, motion, hook
  structure, audio feel, summary), optional estimates, and a licence for repositories. Text that embeds a file, links
  a media file or a video/caption stream is refused and fed back to Hermes.

## Synthesis and the revision loop

"Synthesize a draft pack" sends Hermes every analyzed source's findings, the blended upload numbers, the engines the
catalogue knows (with whether a worker reports each) and the existing packs. Its answer is validated by
`parseDraftSpec` against the pack format's vocabularies (a test checks they are the vendored validator's): contract
fields as in `style.json`, a recommended renderer from `ENGINES`, a rationale and the closest existing pack.
`applyMeasured` then overrides shot lengths, the first cut, cuts per minute and loudness with the numbers measured
from uploads (rounded as the Phase 1 lab does) and lists the overridden fields on the page.

The page says plainly whether the recommended renderer can render here (`rendererVerdict`, from stored worker
capabilities only): "A worker reports html-capture", or "needs a renderer that isn't installed: manim (VenStudio has
no manim renderer yet, so a pack for it stays a draft)". Hermes renders stay research only.

"Revise the draft" sends the owner's note with the current draft; at most 5 revisions (`MAX_LAB_REVISIONS`), then
the page says to edit the exported draft in the styles repository.

## Download draft pack (no GitHub token)

`/studio/lab/<id>/draft` returns one JSON file: `files` holds `packs/<id>/style.json` (status `draft`, empty curation,
every source in `provenance` with its licence), `packs/<id>/README.md` (with "## Provenance" and "## Status") and
`packs/<id>/fixtures/expect.json`; plus `provenance`, the renderer verdict and `steps`:

1. In a clone of venturazz/venstudio-styles: `git checkout -b draft/<id>`.
2. Save the file as `draft.json` and write its files (the page shows the one-line `node -e` command).
3. Add `fixtures/payload.json` and, for remotion-2d or html-capture, the render project.
4. `node tools/validate.mjs && node --test "tools/*.test.mjs"`.
5. Commit, push, open a PR (Hermes or Kiro may do it with their own access). The owner reviews and merges.
6. Here: `node scripts/sync-styles.mjs --from ../venstudio-styles --commit <merged commit>`, then "bump styles".

A unit test validates the exported files with the vendored validator for several renderers.

## Trials from a study

"Start a trial video with the closest pack" is offered when the recommended renderer is available and New Video
offers the closest pack (Listed or Trial, reported by a worker, with a template). It opens `/studio/new?study=<id>`
with the pack chosen and the study's notes and draft summary as the brief. `startRun` checks the study, sets
`config.labStudyId` and marks the run's `stylePack.trial` true whatever the pack's status, so it is never published
and its outcome goes to the curation log. The study page lists those runs with their state, G-technical, the owner's
presentation score and decision (`style_trial_outcomes`). Otherwise the page names the reason.

Nothing in the lab writes a channel's category, the worker mapping or autonomy.

## Storage

Migration 0017 (additive): `lab_studies` (title, goal, base pack, notes, current draft and its state, revision and
revision notes) and `lab_sources` (type, reference, path, licence, asset and analysis job, status and reason,
findings), plus an expression index on `pipeline_runs.config->>'labStudyId'`. `scripts/e2e.sh` asserts the tables,
columns and constraints.

## The first packs from claude-animation-skills

`animated-line-graph` and `minimal-line-art` (styles repo, status `draft` until CI renders them) adapt the `graph` and
`minimalistic-graphics` skills of github.com/artemnovitckii/claude-animation-skills at `86f70106c9ae` (MIT; fonts
OFL) to html-capture. Their READMEs say what was adapted and what changed; CI here renders every html-capture pack
through render-video (`apps/worker/html-capture-render.test.ts`) and with `capture-html` + `check-video.mjs`.

## Files

`lib/studio/lab-study.ts` (+ test), `lib/server/lab-studies.ts`, `lib/server/template-lab.ts` (`fingerprintOfJob`),
`app/(app)/studio/lab/` (list, study page, actions, `[id]/draft/route.ts`), `app/(app)/studio/new/page.tsx` and
`runs/run-form.tsx` (`?study=`), `lib/server/director.ts` (`labStudyId`), `lib/studio/run-config.ts`,
`db/migrations/0017_lab_studies.sql`, `scripts/e2e-fetch-canary.mjs`, `scripts/ui-e2e.mjs` (fake Hermes `lab-source`
and `lab-synthesis` stages, the YouTube tripwire), `scripts/e2e.sh`.
