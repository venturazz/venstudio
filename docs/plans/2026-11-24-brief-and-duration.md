# Brief and duration: the two decisions Studio does not have

Status: **phase 1 merged (#28); phase 2 in `feat/brief-object`; phase 3 in `feat/one-picker` (stacked on 2); phase 4 is still a plan.**
Audited against `apps/portal` at `1fd4d48` on 2026-11-24.

## Ringkasan (Bahasa Indonesia)

Studio sekarang meminta sepuluh keputusan di satu layar, tapi tidak punya dua keputusan yang paling menentukan:

1. **Brief** cuma kotak teks bebas (`topicHint`, maks 2000 karakter). Bentuknya tidak ada, jadi Hermes yang mengarang
   bentuknya tiap run, dan pack tidak bisa tahu field apa yang dijamin ada.
2. **Durasi tidak bisa dipilih.** `buildRunConfig` selalu menulis `DEFAULT_DURATION_SEC[format]` — **45 detik untuk
   short, 600 detik untuk long**, apa pun maunya pemilik. Padahal `VIDEO_FORMATS` sudah mendeklarasikan rentang
   `[15, 60]` dan `[480, 1200]`, dan setiap pack mendeklarasikan `contract.pacing.shotSeconds`. Dua data itu tidak
   pernah dipakai untuk memilih. Akibatnya naskah ditulis ke target kata `wpm × 45 / 60`, dan tidak ada short yang
   pendek atau panjang.

Selain itu satu keputusan (gaya) punya **empat kontrol** yang menumpuk: dropdown `#templateId`, daftar baris Trial
dengan tombol "Use for research", grid checkbox "Try these styles", lalu tombol "Suggest from brief" dengan deretan
tombol hasil. Itu yang membuat Studio terasa tidak efektif: memilih satu gaya berarti melewati empat tempat.

Usul: **Studio memiliki brief terstruktur dan durasi**, gaya dipilih di **satu** kontrol, dan semua yang bersifat
percobaan/riset pindah ke halaman sendiri. Empat fase, tiap fase berdiri sendiri. Fase 1 sudah dikerjakan karena itu
bug: semua short 45 detik.

## 1. What happens today, with the code

| Symptom | Where |
| --- | --- |
| The brief is one free-text box, optional | `apps/portal/app/(app)/studio/runs/run-form.tsx:209` ("What is the video about? (optional)", `MAX_BRIEF_CHARS = 2000` in `lib/studio/run-config.ts:16`) |
| The brief is stored as `topicHint`, a string, with no fields | `lib/studio/run-config.ts:179` |
| The run's length is a constant per format, not a choice | `lib/studio/run-config.ts:175` → `DEFAULT_DURATION_SEC` in `lib/studio/engine.ts:59` (`short: 45`, `long: 600`) |
| `RunRequest` has no duration field at all | `lib/studio/run-config.ts:130-140` |
| The server action has no duration field either | `app/(app)/studio/runs/actions.ts:21-34` (`startSchema`) |
| The declared ranges are never used to choose | `lib/studio/catalog.ts:73-76` (`short: [15, 60]`, `long: [480, 1200]`) |
| The pack's own range is parsed but never offered | `lib/studio/style-registry.ts:105` (`contract.shotSeconds`) |
| The length does drive the script: `target = wpm × durationSec / 60` | `lib/studio/director.ts:678-688`, prompt line at `:523` ("about 45 seconds") |
| One decision, four controls | `run-form.tsx:242` (select), `:319` (Trial rows), `:337` (batch grid), `:390-405` (suggest button + results) |
| Four vocabularies for "may I use this?" | Listed / Trial / `Hermes render: …` / `Lab trial`, all in the same select's optgroups (`:247-286`) |

Two smaller things that cost more than they look:

- `themeSource` and `themeId` duplicate what the brief should own: a theme picked here is a *hint* to the idea stage,
  and it is easy to set it to something the brief contradicts.
- The lifecycle text (three lines) plus the Trial queue plus "Start from a saved plan" sit around the form, so the
  screen answers questions nobody asked at that moment.

## 2. The target flow: four decisions, then Review

```
1. Channel + topic          one select, one textarea (topic may be empty: Hermes proposes)
2. Length                   chips: 15 · 30 · 45 · 60 s | 8 · 12 · 20 min   -> format follows the length
3. Style                    ONE picker, already filtered by length and format
4. Language + purposes      (purposes optional, collapsed)
                -> Review: three brief proposals (theme, title, angle) -> pick one -> brief is frozen
```

Decisions that disappear from this screen: batch trials, lab trials, research styles, saved plans, trial queue,
lifecycle text. Each becomes a link (`/studio/research`, `/studio/plans`), reachable when the owner is doing that,
not while starting a normal video.

**Format becomes derived, not asked.** A 30 s video is vertical 9:16; a 12 min video is 16:9. Asking "Format" and then
"duration" leaks the same decision twice, which is how the current screen got its extra field.

## 3. The brief object

The brief is the contract between Studio and every stage. Model it once, in `lib/studio/brief.ts`, and let the pack,
Hermes and the worker read the same shape.

```json
{
  "version": 1,
  "topic": "a lesser known myth from Nias",
  "angle": "told as a mystery, no narrator voice",
  "audience": "curious adults, no prior knowledge",
  "durationSec": 45,
  "language": "en",
  "mustInclude": ["the name of the village", "one oral source"],
  "mustAvoid": ["gore", "claims without a source"],
  "frozenAt": "2026-11-24T10:00:00Z",
  "proposedBy": "hermes"
}
```

Rules:

1. **Studio owns the shape.** Stages may add notes; they may not add fields.
2. **Three proposals, one choice.** The idea stage returns three `{theme, title, angle}` for the topic; the owner picks
   one; only then is the brief frozen (`frozenAt`). The script stage reads the frozen brief and nothing else.
3. **Packs consume, never define.** A pack's `hermes.input` names which brief fields its skill reads. It may not
   invent fields — that is how a style turns into a script (see
   [venstudio-styles docs/style-vs-script.md](https://github.com/venturazz/venstudio-styles/blob/main/docs/style-vs-script.md)).
4. **Migration:** `topicHint` stays readable. A run started before this change reads back as
   `{version: 0, topic: topicHint, durationSec: <stored>, language, ...}`; nothing is rewritten, new runs write `brief`.
5. **Stored where:** `pipeline_runs.config.brief` (additive). `topicHint` keeps being written for one release so old
   readers do not break, then stops.

## 4. Duration

- `RunRequest.durationSec?: number`; validated as an integer inside `VIDEO_FORMATS[format].durationSec`, else the action
  returns "A short is 15 to 60 seconds; pick a length in that range."
- Chips, not a number field: 15 · 30 · 45 · 60 s for short, 8 · 12 · 20 min for long. Default 45 s / 10 min.
- The chosen length reaches the script stage as it already does (`director.ts:678`), so it is not a new mechanism —
  it is the mechanism, finally fed by the owner.
- **Fit against the style.** When a style is chosen, the picker shows what it can do
  (`contract.pacing.shotSeconds × scene count`, e.g. "16–48 s") and marks a mismatch instead of hiding it: a 60 s
  request on a style whose scenes allow 16–48 s is a warning with the number, not a silent overflow.
- **QC reports the drift.** `durationSec` (target) next to the finished video's measured length, so a style that always
  overshoots is visible in the curation record instead of being discovered on YouTube.

## 5. One picker for one decision

What dies, what replaces it:

| Today | Becomes |
| --- | --- |
| `<Select id="templateId">` with 4–5 optgroups (`:242-287`) | the **only** picker: one list, one row per style, status as a badge |
| Trial rows with "Use for research" buttons (`:319-336`) | gone; the row in the picker *is* selectable, its status is a badge |
| Batch grid "Try these styles" (`:337-383`) | `/studio/research` (one brief, several styles) |
| "Suggest from brief" button + result buttons (`:390-405`) | the picker ranks its own list from the topic, live — no button, no second list |
| "Waiting for a worker…" paragraph, lab-trial notes | one line under the picker, only for the chosen style |
| Saved plans card, trial queue card (right column) | links in the Studio nav |

Selection model stays `templateId` + `batchTemplateIds` in the form, so the server actions do not change.

**Test impact, and what was done with it.** `scripts/ui-e2e.mjs` runs in CI against a live portal and asserted the old
structure (`trial-styles`, `research-group`, `trial-style-*` rows, `batch-trial`). The rewrite carries every one of those
checks to the new DOM instead of deleting them: a style is chosen from the select and its panel is then asserted
(badges, credit, skill path), the research group is asserted by its optgroup and by each option's panel, and the batch
block is opened by its summary before the boxes are ticked. The requirement each test protected — provenance visible
before a trial starts, research styles marked, batch from one brief — is unchanged.

## 6. Phases

| Phase | What | Proves |
| --- | --- | --- |
| **1. Duration** (merged, #28) | `durationSec` in `RunRequest`, `startSchema`, `buildRunConfig`; chips in the form; range validated | unit tests in `run-config.test.ts`; a 15 s short and a 60 s short store different `config.durationSec` and different script word targets |
| **2. Brief object** (built, `feat/brief-object`) | `lib/studio/brief.ts` (`briefFromInput`, `freezeBrief`, `parseBrief`, `briefParagraph`); `config.brief` written at start and frozen in `approveStage` when an idea is approved; `topicHint` kept for one release | `brief.test.ts` (7): the owner's words survive, freezing happens once, a run from before the change still reads back |
| **3. One picker** (built, `feat/one-picker`) | one select, the chosen style's detail (badges, credit, skill path, engine, workflow), research collapsed behind one summary line | `ui-e2e` still drives a video start end to end; no selector asserts a surface that no longer exists |
| **4. Research page** | batch trials, lab trials and research styles moved out of New Video | a batch of three trials still starts from one brief |

Phases 1 and 2 are additive and can ship separately. Phase 3 is the one that answers "Studio feels ineffective"; it is
also the one that touches every UI test, so it goes last and alone.

## 7. Out of scope

- The worker, the pack format version, QC scoring.
- One optional style-side field: a pack may declare `durationHint: [min, max]` in its contract for the picker's
  "16–48 s" line. Until it exists, the picker computes it from `shotSeconds` and the scene count of the current plan.
- Anything about publishing, channels' autonomy levels, or the Trial/Listed lifecycle itself.

## 8. Open questions for the owner

1. Duration chips: 15 · 30 · 45 · 60 s enough for shorts, or 10 · 20 · 30 · 45 · 60?
2. Batch trials: keep them (moved to `/studio/research`) or drop them?
3. May the brief be edited after it is frozen, or does a change mean a new run? (A new run is cleaner to compare.)
4. Purposes (7 checkboxes) — keep on this screen or move next to the brief in Review?