# Style system: style packs, renderers, Template Lab

Status: agreed with the owner. Phase 0 (signed automatic worker updates) is implemented on
`feat/auto-update`; Phase 1 (pack format, vendored registry, Listed/Trial in New Video) on `feat/style-registry`,
described in `docs/style-packs.md`; Phase 2 (renderer plugins, html-capture, the hermes research renderer and the
owner's presentation score) on `feat/renderers`, described in `docs/style-packs.md` and `docs/html-capture.md`;
Phase 3 (the Template Lab and the first packs adapted from claude-animation-skills) on `feat/template-lab`, described
in `docs/template-lab.md`; research trials (a Hermes research pack per claude-animation-skills skill, lab trials of
Draft and Lab packs, batch trials) on `feat/research-trials`, described in `docs/style-packs.md`; workflows (each pack
names the recipe its runs follow: image-sequence, scene-spec, hermes-skill) on `feat/recipes`, described in
`docs/style-packs.md` "Workflows"; the html-design workflow (Hermes writes the page per video, research only, owner
decision) and the still-frame preview shared with scene-spec (worker 0.11.0 `preview-frames`) on `feat/html-design`,
described in `docs/style-packs.md` and `docs/html-capture.md`; phases 4 and 5 are the plan.

Phase 1 changes one thing in section 2 below, by owner decision (no new secrets): the portal has no GitHub token, so it
does not read signed releases from the styles repo. venstudio vendors a pinned copy (`styles/`, `styles/lock.json`)
through a normal PR that its CI must pass, and the portal signs what it serves to workers with its Phase 0 key.

## Ringkasan (Bahasa Indonesia)

- **Gaya video = "style pack"**: satu paket berisi kontrak gaya (tempo, elemen di layar, gerak, caption,
  audio; dari riset Hermes), renderer yang dibutuhkan (+versi), proyek render (template Remotion,
  template HTML/GSAP/three.js, scene Godot, skrip Manim, ...), contoh payload + tes render di CI dengan QC,
  asal-usul pembelajaran (sumber + lisensi) dan catatan kurasi (video uji, QC, penilaian Hermes dan owner).
  Status: Draft → Lab → Trial → Proven → Listed (+ Retired). New Video hanya menampilkan gaya **Listed**
  yang renderer-nya dilaporkan oleh salah satu worker (atau Hermes).
- **Gaya disimpan di repo terpisah** `venturazz/venstudio-styles` (privat, dibuat owner). Hermes bekerja di
  sana lewat PR, owner yang merge; CI di sana me-render setiap pack; pack yang lolos diterbitkan sebagai
  rilis bertanda tangan; portal membaca indeksnya; worker mengambil pack dan renderer secara otomatis.
- **Renderer = plugin dengan probe**, dipilih sesuai yang dipelajari. Sudah ada: ffmpeg-stills, remotion-2d.
  Berikutnya: html-capture (HTML+GSAP/three.js direkam di Chromium headless), manim, godot-2d, blender
  (CPU saja, sangat lambat), hermes (Hermes me-render dengan alatnya sendiri, **hanya untuk riset/uji**,
  bukan untuk video yang dipublikasikan). Tidak ada worker GPU untuk saat ini.
- **Sumber belajar di Template Lab**: upload owner (dengan hak), link publik termasuk YouTube (Hermes hanya
  menonton dan mencatat pola, tidak mengunduh apa pun), repo publik (diadaptasi lewat PR + CI, lisensi
  dicatat), skill Hermes, artikel, catatan Review owner. Sumber uji pertama:
  `artemnovitckii/claude-animation-skills` (MIT).
- **Fase**: 0 update worker otomatis bertanda tangan (sudah dikerjakan); 1 repo gaya + format pack +
  registry + New Video hanya Listed; 2 kerangka renderer + html-capture + renderer Hermes (riset);
  3 Template Lab dengan semua sumber dan loop kurasi; 4 renderer lain sesuai kebutuhan; 5 perbaikan terus.
  Ditunda sampai setelah fase 1: musik otomatis via Hermes, upload/klaim/metrik YouTube, publikasi otomatis.

## Why

Today a "style" is a catalogue entry in the portal code (`lib/studio/catalog.ts`) plus, for
remotion-2d, a template compiled into the worker's Remotion bundle. Adding a look means a portal
release, a worker reinstall on every Muse VM, and nothing records where the look came from or whether
it ever rendered well. The style system makes a look a versioned, tested, curated package that the
studio can pick up without a portal release, and that workers can render without the owner touching
the VMs.

## 1. The style pack

A style pack is a directory in the style repo with a manifest and its files. It holds:

| Part | What it is |
| --- | --- |
| Contract | The look as data: pacing (shot length range, cuts a minute), on-screen elements, motion vocabulary, caption style, audio layers. Written from Hermes research and measurements, in the same terms the studio already plans with (`scene-plan.ts`, `caption-spec.ts`, `audio-plan.ts`). |
| Renderer requirement | Renderer id and minimum version, e.g. `remotion-2d >= 1`, `html-capture >= 1`. |
| Render project | What the renderer runs: a Remotion template, an HTML/GSAP/three.js template, a Godot scene, a Manim script, or a stills recipe for ffmpeg-stills. |
| Sample payload | A payload the pack's CI renders, followed by the QC gate (`G-technical` and the pacing checks). A pack whose sample does not render and pass QC cannot be published. |
| Learning provenance | Every source the look was learned from, with its licence and what was taken from it (patterns only, see section 4). |
| Curation record | Trial videos, their QC reports, Hermes's verdict and the owner's verdict. |
| Status | `Draft → Lab → Trial → Proven → Listed`, plus `Retired`. |

Status meanings:

- **Draft**: written, not yet rendered.
- **Lab**: renders in CI from its sample payload and passes QC.
- **Trial**: used for trial videos that are not published; QC and verdicts are collected.
- **Proven**: trials passed QC and both Hermes and the owner approved.
- **Listed**: the owner listed it. Only Listed packs appear in New Video.
- **Retired**: no longer offered; kept so old runs stay explainable.

New Video shows a style only when it is Listed **and** some worker (or Hermes, for research runs)
reports the renderer it needs. The portal decides this from stored worker capabilities; it never calls a
worker while a page renders.

## 2. Where styles live and how they travel

- Repository: `venturazz/venstudio-styles` (private, created by the owner; currently only a README on
  `main`).
- Hermes works there through pull requests. The owner merges. Nothing reaches `main` without the owner.
- CI in that repo renders every pack's sample payload with the pack's renderer and runs QC. A failing pack
  blocks the merge.
- Passing packs are published as **signed releases** (same Ed25519 scheme as the worker updates in
  Phase 0, with its own key) with an index file listing each pack, its status, renderer requirement and
  file hashes.
- The portal reads the index (on a schedule, never during a page render) and stores it.
- Workers fetch packs and renderer projects automatically, verified by signature and hash, through the
  update channel built in Phase 0.

## 3. Renderers are plugins with probes

A renderer is a plugin on the worker: an install recipe, a probe that proves it can render on this
machine (as `scripts/probe.mjs` does for Remotion today), and a render entry point. The worker reports a
renderer only after its probe passes. Renderers are chosen by what the studio has learned, not up front.

| Renderer | State | Notes |
| --- | --- | --- |
| `ffmpeg-stills` | exists | Stills, motion, cross-fades, captions, audio mix. |
| `remotion-2d` | exists | Remotion templates in Remotion's headless Chromium. 24 s of video takes about 100 s in CI. |
| `html-capture` | next | HTML + GSAP / three.js templates captured frame by frame in headless Chromium. This is how `github.com/artemnovitckii/claude-animation-skills` works (MIT; its fonts are OFL). |
| `manim` | candidate | Manim scripts (Python, LaTeX optional). |
| `godot-2d` | candidate | Godot scenes. Headless rendering on Muse is unproven. |
| `blender` | candidate | CPU only, very slow on 2 vCPU. |
| `hermes` | candidate | Hermes renders with its own tools (CapCut, video_gen). **Owner decision: research and trials only for now, never for published videos.** |

No GPU worker for now (owner decision).

## 4. Learning sources (Template Lab)

| Source | How it is used |
| --- | --- |
| Owner uploads (with rights) | Measured precisely by the worker's `analyze-video` (cuts, shot lengths, loudness). |
| Public links, including YouTube | Hermes watches and takes notes. **Nothing is downloaded**: YouTube's terms forbid downloading except through YouTube's own features. Only patterns are kept (pacing, structure, element types), never frames, audio or script. |
| Public repositories | Adapted through a PR in the style repo with CI; the licence is recorded in the pack's provenance. |
| Hermes skills | The skills already written for the studio. |
| Articles | Notes and patterns, with the source recorded. |
| Owner Review notes | What the owner said about past videos. |

First trial source, chosen by the owner: `artemnovitckii/claude-animation-skills` (MIT; already
installed and working in Hermes).

## 5. Phases

0. **Signed automatic worker updates** (this branch). Workers update themselves from the portal, verifying
   an Ed25519 signature and file hashes, with an owner switch (Automatic / Approve each update / Off) and
   the old manual install.sh procedure as the fallback. See `docs/worker-updates.md`.
1. **Style repo, pack format, registry.** Define the pack manifest, the index and its signing; the portal
   registry reads it; New Video shows Listed packs only. Migrate the flat-vector explainer and the stills
   styles into packs.
2. **Renderer framework**, the `html-capture` renderer, and the `hermes` renderer (research only).
3. **Template Lab** with every source above and the curation loop (Draft → Listed), starting with
   `claude-animation-skills`.
4. More renderers, when a learned style needs one.
5. Continuous improvement: trial results and Review notes feed back into packs.

Parked, resumed after Phase 1: an automatic music stage through Hermes; YouTube upload, claims and
metrics; autonomous publishing.

## 6. Constraints

Muse VMs: 2 vCPU, about 8 GB RAM, no GPU, outbound HTTPS only, and only `/home/hatch` persists.
Remotion renders 24 s of video in about 100 s in CI; 3D in software GL is slow. Every renderer and pack
must fit these limits, or say clearly that it needs a different worker.
