# Production styles, engines and Muse capabilities

Date: 2026-11-19. Status: research notes plus the build plan. Items marked **unverified** still need a test.

## 1. What I could and could not read

- **gerak.in**: the server returns HTTP 403 to every fetch, and search returned no page content. I could not see what it does, so it is not used as a model here. Please describe the features you liked, or send screenshots.
- **threads.com/@thegoodsvisual**: no indexed content. Same request: describe the style or send examples.

## 2. Style families seen in current faceless and AI-video practice

| Family | Examples found | Notes |
|---|---|---|
| Explainer, flat vector | Kurzgesagt-style channels: calm narrator, flat illustration, tight argument ([Revid](https://www.revid.ai/blog/best-faceless-youtube-channels)) | Clippie ranks explainers first for monetization; Reddit read-alouds last ([Clippie](https://clippie.ai/blog/best-short-form-video-formats-monetization-2026)) |
| Ranking, list, quiz | Top-10 and quiz formats ([Clippie](https://clippie.ai/blog/anonymous-content-ideas-faceless-videos)) | Each item needs its own research, or it reads as generic |
| Narrated documentary, history, mystery, horror, kids, ambience, travel | Faceless niches: history, science, space, true mysteries, finance, kids stories, ambience, travel ([Seedance](https://www.seedance.tv/blog/faceless-youtube-channel-ideas)) | Mysteries and true crime need care about real people |
| AI character comedy | Absurdist AI hybrid characters with synthetic narration ([Opus](https://www.opus.pro/blog/viral-ai-video-styles-2026)) | Trend-driven, weak monetization fit; keep as experimental with IP cautions |
| Markdown-driven AI video workspace | Each video is a folder of briefs, shot lists and per-shot prompts; reusable characters, locations and styles in a shared library ([Hugovdd](https://github.com/Hugovdd/ai-video-workspace)) | Informs the asset library and per-shot storyboard design |
| Re-renderable video as a plan file | A video is a diffable plan.json; changing one line re-renders only that piece ([Orkas VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)) | Informs production plans: stored as data, re-runnable per stage |

**Design consequence:** the studio should store each production as a plan (stages, engines, shot list) rather than a one-off job. Changing one stage then re-runs only that stage.

## 3. Rendering engines and what Muse can do

Muse VM facts (sources: [Stark Insider](https://www.starkinsider.com/2026/09/meta-muse-specs-what-it-runs-on.html), [Zima](https://shop.zimaspace.com/en-ca/blogs/tech-ai-hub/meta-muse-secure-vm-always-on-ai-agent)):
- About 2 vCPU, about 8 GB RAM, no GPU. The VM has enough CPU, memory and storage to compile code, develop Skills, run sub-agents and execute cron jobs.
- Only `/home/hatch` persists. Our worker design already relies on this.

| Engine | Muse placement | Basis |
|---|---|---|
| ffmpeg stills, camera moves | muse-ok | Our smoke test rendered 1080x1920 at 1.86x realtime on 2 CPUs (test clip, not a real workload) |
| Remotion 2D, kinetic type, charts | muse-ok | Remotion renders frames in headless Chrome; Chrome Headless Shell is the faster CPU option ([Remotion](https://remotion.dev/docs/miscellaneous/chrome-headless-shell)) |
| Sprite characters with lip sync | muse-ok | Rhubarb Lip Sync generates mouth timings from audio. **Unverified:** the binary must run on the VM |
| Manim | muse-ok | CPU rendering; LaTeX needed for formulas. **Unverified** |
| Godot 2D (Movie Maker) | muse-test | `--write-movie` records offline; software OpenGL (Mesa llvmpipe under Xvfb) works but is slow ([Godot docs](https://docs.godotengine.org/en/4.4/tutorials/animation/creating_movies.html), [benchmark notes](https://forum.godotengine.org/t/can-godot-render-directly-to-frame-buffer-without-x-on-linux/55812)). **Unverified** on Muse |
| Remotion three.js (3D) | muse-slow | Works without a GPU, but Remotion's docs say headless software rendering is slow ([GL options](https://www.remotion.dev/docs/gl-options)) |
| Blender Cycles (3D) | muse-slow | Headless CPU Cycles works; on cloud Linux, EEVEE has headless issues ([Blender issue](https://projects.blender.org/blender/blender/issues/61164)). Expect very long renders on 2 cores |
| Godot 3D | gpu-preferred | Software rendering is too slow for series |
| Provider AI video (Kling, Veo, etc.) | external | Rendered at the provider. Check per-output commercial terms |

**Conclusion:** Muse can run every 2D and 2.5D engine. It can also run 3D, but only as a slow batch. The planner must show this as a time cost, not as impossible. Plan 3D series on a GPU worker (a VPS or your PC), and keep Muse for batch 3D.

## 4. Analysis tools for the learning module

- **PySceneDetect**: content, adaptive and threshold detectors; CLI and Python API; Docker image available ([PySceneDetect](https://www.scenedetect.com/), [repo](https://github.com/Breakthrough/PySceneDetect)). It handles fast cuts and fades, and is the upgrade path for camera-heavy footage.
- **ffmpeg `select=gt(scene,…)` + `showinfo`** (what we will use first): already installed on workers, no extra Python dependency, and gives cut times. Less accurate than adaptive detection on camera motion.
- **Loudness**: ffmpeg `ebur128` gives integrated LUFS.

Copy-cat rule: the analysis copies **structure only** (cut times, shot lengths, hook time, loudness). It never copies script, footage, characters or music.

## 5. Licence and policy checks

- **Remotion** is free for individuals and small companies up to three people; larger teams need a company licence ([Remotion licence](https://www.remotion.pro/license)). The "Automate" page lists a paid tier for batch-rendering products ([Remotion automate](https://www.remotion.dev/automate)). **Confirm** that an internal studio for your own channels stays on the free terms before scaling.
- **Content ID** (music) and **inauthentic content** rules are covered in `01-video-automation-research.md`.

## 6. Build plan (this round)

1. Style catalog: families, engines with Muse placement, themes, about 20 styles with keywords, cautions and sources (pure data).
2. Planner: suggest styles from a brief, and build a production plan with stages, executors, warnings and "runs now" flags.
3. Asset library: table with provenance (source, licence, origin), upload API, list page, and "save worker output to Assets".
4. Reference analysis: worker job `analyze-video` (ffprobe, scene cuts, loudness) with input download for assigned assets only.
5. Studio page: format, theme, style picker, suggest, preview plan, save production.
6. Tests: planner, provenance, analysis parsing, worker analysis against a generated clip, browser flow.

Not in this round: running Hermes stages, Muse render pipelines, YouTube upload. The plan marks these as planned, not runnable.

## 7. Open questions for you

1. Names of the Hermes skills in the `creative` category (paste the list from Settings → Brain).
2. What gerak.in and @thegoodsvisual do (features or screenshots).
3. Which of the 10 channels get which style first.
