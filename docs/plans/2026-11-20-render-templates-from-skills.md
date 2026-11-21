# Render templates, derived from the Hermes skills

Date: 2026-11-20. Status: design note plus the phased plan. **Phase 0's portal half is implemented**
(`bc4f9c8`, CI green): `lib/studio/render-engine.ts` holds the engine gate, the cross-fade arithmetic
and the variation gate, and the render payload now carries `engine` and `transitionSec`. The worker
half — dispatch, capability report, `xfade` — is Kiro's, specified in `docs/kiro-tasks.md`. Phases 1
onward are not started.

## Why this document

A render came back as a narrated slideshow. The studio is not short of ambition or of style
vocabulary — it is short of one link. This note records the diagnosis, and then the thing that makes
the fix smaller than it looks: **the template contracts are already written down, in the Hermes
skills, as prose and as data.**

The owner's framing is the requirement: templates must be *customised*, not generic. Each skill
below is already a customisation — it names the parameters, the compositor and the failure modes of
one specific look.

## 1. Diagnosis (verified in this repo)

`apps/portal/lib/studio/catalog.ts` declares six engines, each with the capability a worker must
report and a Muse placement:

| Engine | Capability | Muse | Implemented |
|---|---|---|---|
| `ffmpeg-stills` | `ffmpeg` | muse-ok | **yes** |
| `remotion-2d` | `remotion-2d` | muse-ok | no |
| `sprite-rig` | `remotion-2d` | muse-ok | no |
| `manim` | `manim` | muse-ok | no |
| `godot-2d` | `godot` | muse-test | no |
| `remotion-3d` | `remotion-3d` | muse-slow | no |

`packages/protocol/src/index.ts` already declares all of them as valid `Capability` values.

`apps/worker/venstudio-worker.ts` does not mention `engine` at all. It has one render path,
`buildRenderArgs`, and that path cannot express anything but stills:

```ts
if (paths.images.length !== spec.shots.length) throw new NonRetryableError("There must be one image file per shot");
```

One image per shot, required. Its entire motion vocabulary is four linear `zoompan` variants
(`zoom-in`, `zoom-out`, `pan-left`, `pan-right`) joined by a hard `concat`. No transition, no
overlay, no shape, no text animation, no easing, no rig, no sprite.

So the slideshow is not a bad choice by the planner. The planner gates on reported capabilities, the
worker reports only `ffmpeg`, and the one implemented engine produces stills. **Six engines are
planned, one exists, and nothing dispatches.**

Note also that our own skill `narrated-video-from-images` asks for `xfade` transitions in step 6.
The worker has none. The gap already exists inside the studio, before any new engine.

## 2. The contracts are already written

This is the part that changes the size of the job. The skills do not describe styles in adjectives;
they describe them as parameters, and several already ship the reference documents that a renderer
would implement.

**`flat-vector-explainer-video`** defines a per-beat motion grammar, and its own QC rule:

> Each beat declares a motion-token list (`draw:`, `pop`, `gauge:`, `counter:`, `bar:`, `arrow:`,
> `tally:`, `particles:`, `pull:`, `push:`, `whip:`, `shake:`, `drift:`, `parallax`, `scribble`,
> `blot`, `flicker`, `morph`, `dim`) and the renderer interprets them. Count coverage in the build
> step and make it fail loudly if a beat has neither an animated diagram nor a camera move.

That last sentence is the variation gate, already specified. Supporting file:
`references/max-motion-remotion.md` (primitive table, token grammar, camera math).

**`photoreal-cutout-puppet`** defines a formal layer model, where the *per-layer frame rate is the
look*:

> | Layer | Frames | Clock |
> |---|---|---|
> | plate | 1 | never changes |
> | person | 40-60 | 30 fps |
> | prop A | 6-12 | 5-10 fps |
> | prop B | 6-12 | its own, unrelated |

It also states the architecture is a directory listing (`layers/L2_person/000.png`), that the
compositor indexes those directories, and that "nothing here needs a game engine — PIL + numpy
composites 13 s in about a minute". Its nine reference files include `layer-stack-compositor.md`,
`motion-vocabulary.md` and `shot-grammar-measurement.md`.

**Consequence:** a template is not something to invent. A template is the executable form of one
skill, and the skill's `references/` are its spec.

## 3. Mapping

Roles: **render** = the worker executes it; **assets** = Hermes generates what a template needs;
**gate** = a check, not a renderer.

| Skill | Engine | Role | What makes it custom |
|---|---|---|---|
| `narrated-video-from-images` | `ffmpeg-stills` | render (exists) | Ken Burns + `xfade`; renderer chosen before images |
| `long-form-narrated-video` | `remotion-2d` | render | scene holds many lines; per-line sequences, speaker labels; atmosphere layer sidechain-ducked; two-pass render |
| `flat-vector-explainer-video` | `remotion-2d` | render | per-beat motion-token list; SVG diagrams drawn in code |
| `photoreal-cutout-puppet` | `remotion-2d` | render | layer stack with independent clocks; PIL/numpy compositor |
| `sprite-video-production` | `sprite-rig` | render | animation bible + tracks; Godot exports data, Python renders frames |
| `godot-sprite-film` | `godot-2d` | render | one pose folder per character + `story.json`; Xvfb |
| `manim-video` | `manim` | render | palettes, animation speed, typography scale |
| `threejs-3d-short` | `remotion-3d` | render | voice sets the clock; rig rules; QC probes |
| `cast-2d-billboards` | `remotion-3d` | render | billboarded 2D cast inside a 3D scene |
| `ascii-video` | `ffmpeg-stills` | render (new) | per-section variation; ascii conversion |
| `stickman-chikoomollian` | — | assets | two-layer model, silhouette test, named body shapes |
| `sprite-sheet-shorts` | — | assets | sprite sheet layout and slicing |
| `character-design-sets`, `restyle-film-cast` | — | assets | cast consistency across a production |
| `architecture-diagram`, `baoyu-infographic` | — | assets | diagram/plate sources |
| `design-md`, `popular-web-designs`, `claude-design` | — | assets | theme tokens for the templates |
| `video-continuity-rhythm` | — | gate | "an explainer video feels monotonous" |
| `short-form-video-qa`, `viral-video-engagement` | — | gate | pre-delivery checks |
| `video-forensics`, `look-match-study`, `image-backend-sweep` | — | analysis | reverse-engineer and match an existing look |

Every row's parameters still need a full read of that skill before its template is built. The table
records the shape, not the finished schema.

## 4. Gaps in the worker, in the order they block

1. **No dispatch.** The worker never reads `engine` from the job payload. Until it does, every
   engine lands on `ffmpeg-stills`.
2. **No capability report.** `detectCapabilities()` reports `ffmpeg` and optionally `tts-kokoro`,
   plus `VENSTUDIO_EXTRA_CAPS`. Without a reported `remotion-2d`, the planner's gate can never
   choose it.
3. **`RenderSpec` is one still per shot.** A template needs scenes with elements, per-layer clocks
   and in/out transitions. Keep the current spec as the private params of `ffmpeg-stills` so nothing
   breaks.
4. **No variation gate.** The explainer skill already specifies the rule; nothing enforces it.

## 5. Phased plan

Owner's decision: curated templates first, codegen later once there are many. So phase 0 and 1 are
hand-written template code, versioned like any other source.

**Phase 0 — the link.** Worker dispatches on `engine`; `RenderSpec` becomes the params of
`ffmpeg-stills`; a `renderTemplate` result shape that all engines share; `xfade` added so the
existing skill contract is met. Evidence: a render of the same production through
`ffmpeg-stills`, unchanged output, and one with transitions.

**Phase 1 — the first two real templates.** `remotion-2d` reportable as a capability, plus:
- `flat-vector-explainer` — implement the motion-token grammar from
  `references/max-motion-remotion.md`, and the coverage gate from the skill. This is the family the
  research ranks first for monetisation, it is `muse-ok`, and Chromium is already a dependency at
  the repo root (`playwright`).
- `cutout-puppet` — the layer-stack compositor with per-layer clocks. Proven cheap by the skill
  itself (PIL + numpy, 13 s of video in about a minute), so it can run on Muse without Remotion if
  that turns out to be the cheaper path.

Evidence for each: the template's own QC — token coverage per beat, and the layer listing — plus a
rendered clip whose analysis (cut rate, motion) differs measurably from a stills render.

**Phase 2 — capabilities that come nearly free.** `sprite-rig` shares the `remotion-2d` capability,
so it is the next cheapest: sprite sheets plus Rhubarb mouth timings, per
`sprite-video-production`.

**Phase 3 — the others as the work needs them.** `manim` (passthrough to a Manim project),
`godot-2d` (still `muse-test`; the Xvfb blocker is already solved in `godot-sprite-film`), and
`remotion-3d` marked as the slow batch it is.

**Later — codegen.** Model-authored TSX per job, behind a compile and smoke gate. Not before there
is a template library to imitate, and not as the main path.

## 6. Gates, taken from the skills rather than invented

- Explainer: every beat has an animated diagram or a camera move (coverage count, fails loudly).
- Cutout: at least two independently animated layers on different clocks, plus a debug strip.
- Sprite: cut hygiene and outlier detection before animating; never slice a sheet on a guessed grid.
- Three.js: measure before rendering; QC probes.
- Whole studio: `video-continuity-rhythm` for monotony, `short-form-video-qa` before delivery.

## 7. What is already done

Not on the critical path here, but relevant to variation: `planClipRequests` plus the
`hermes-video` executor give shots with *real* generative motion from a video provider. The final
portfolio is three layers — moved stills (`ffmpeg-stills`), templated animation (`remotion-2d` and
friends), generative clips (provider video) — not one renderer for everything.
