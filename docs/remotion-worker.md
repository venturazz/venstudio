# Render engines on the worker: stills, cross-fades and Remotion

Worker 0.5.0 reads `engine` from every `render-video` job and renders with that engine, or refuses the job by
name. It never renders a job as stills in place of the engine it asked for: that fallthrough is what turned every
animated style into a narrated slideshow.

| Engine | Capability the worker reports | What renders it |
|---|---|---|
| `ffmpeg-stills` (also a job with no engine) | `ffmpeg` | `buildRenderArgs`: one picture per shot, slow zoom or pan. Byte-identical ffmpeg arguments to 0.4.0 when the job has no fade. |
| `ffmpeg-stills` with `transitionSec` > 0 | `xfade` | The same, with an `xfade` between shots (transition fixed by position: fade, slideup, fade, wipeleft, fade, circleopen). Reported only when the local ffmpeg has the filter. |
| `remotion-2d` | `remotion-2d` | The Remotion project in `apps/render-remotion`, one composition per template. Today: `explainer-flat-vector` → composition `flat-vector-explainer`. |
| anything else | none | Refused, with the engine named. |

## What the portal does with it

- `render-video` jobs are queued under the capability the engine needs (`ffmpeg`, `xfade` for faded stills,
  `remotion-2d`), so only a worker that can run the job claims it.
- Once any worker is enrolled, the render stage passes the reported capabilities to `buildRenderPayload`. A style
  whose engine no worker reports fails **at planning**, with a stage error on the Review card such as:

  > Engine "remotion-2d" needs capability "remotion-2d", which the worker does not report (it reports: echo,
  > ffmpeg, xfade). This style renders with "remotion-2d", and it is not rendered as a slideshow instead. Update the
  > worker to 0.5.0 or later and install the Remotion renderer on it (install.sh --with-remotion, see
  > docs/remotion-worker.md). Then press Retry.

  Retry on that card plans the render again, so after installing Remotion the same run continues. With no worker
  enrolled at all the job is queued as before and waits.
- Cross-fades switch on by themselves when a worker reports `xfade`. A storyboard whose shots have no room for the
  fade overlaps renders with hard cuts instead of failing.

**Consequence to know before updating:** the remotion-2d styles (`explainer-flat-vector`, `kinetic-facts`,
`ranking-list`, `chart-story`, `parallax-2-5d`, `product-review`, `news-recap`) rendered as stills until now. From
this portal version on they stop at the render stage with the error above until a worker reports `remotion-2d`.
Only `explainer-flat-vector` has a composition so far; the other six then fail on the worker with "Template ... has
no remotion-2d composition", by name. Use a stills style for those until their templates exist.

## Update the Muse workers

From worker 0.8.0 on, workers update themselves (signed releases, between jobs, including the Remotion templates);
see `docs/worker-updates.md`. The steps below are the manual fallback, and the one-time step for older workers.

On each Muse VM (or in the Muse agent's terminal), from `/home/hatch/venstudio`:

```bash
cd /home/hatch/venstudio
curl -fsSL https://<portal>/install/install.sh -o install.sh
sha256sum install.sh        # compare with Workers → Add a worker in the portal
sudo bash install.sh --portal https://<portal> --mode hold --with-remotion
```

No `--code`: the enrollment is kept. Without `--with-remotion` the worker updates to 0.18.0 and renders stills and
cross-fades only.

### The account and the system libraries

`install.sh` is meant to be **started as root and finished as an ordinary account**, and does that by itself:

1. as root it installs the machine-level pieces once — the system libraries headless Chromium needs
   (`npx playwright install-deps chromium`, with the plain `apt-get` list as a fallback, old and `t64` package names);
2. it hands `/home/hatch/venstudio` to an ordinary account and re-fetches itself to continue **as that account**: the
   account that already owns the directory when there is one, otherwise a new `venstudio` (`--user NAME` picks another,
   `--stay-root` opts out). An older root install therefore keeps its owner and its crontab, and only the root part
   changes.

That hand-off is not cosmetic. An environment recipe downloads a binary and runs `pip install`; the worker refuses that
as root on purpose, because pack code is not trusted. A worker that stays root reports no `env:*` capabilities, so
`pack:full-frame` and `pack:low-poly-shapes` never appear and those looks can never be rendered on it. Running the
installer as root and starting the worker as root is exactly how a worker ends up with only `ffmpeg` plus the stills
packs while its twin has `remotion-2d` and the html packs.

`run.sh` applies the same rule: started as root it hands off to `VENSTUDIO_SERVICE_USER` (default `venstudio`) before
running the worker, so an older root crontab keeps its capabilities after the installer has created the account. If the
account is missing, it says so in `logs/worker.log` instead of silently dropping them.

Check which account actually runs the worker:

```bash
ps -o user= -C node | sort -u      # must not print root
ls -ld /home/hatch/venstudio /home/hatch/venstudio/envs
```

`--with-remotion` puts everything under `/home/hatch/venstudio/remotion` (the only path that survives a recycle) and
is safe to run again; run it after every portal update so the templates match the portal's:

1. downloads the templates from `https://<portal>/install/render-remotion.json` (no GitHub access needed) and writes
   them with the worker's `unpack-bundle` command;
2. `npm install --omit=dev` there (Remotion 4.0.543, React 18; from the npm registry through the egress proxy);
3. `remotion browser ensure` (Remotion's own headless Chromium);
4. `node scripts/probe.mjs --full`: renders one still of every template and records the result in
   `remotion/.venstudio-probe.json`.

About 400 MB on disk and a few minutes. If a step fails, the install says so and exits non-zero, and the worker keeps
running without `remotion-2d`.

Check it:

```bash
/home/hatch/venstudio/run.sh status
tail -n 5 /home/hatch/venstudio/logs/worker.log
```

`status` ends with `remotion-2d: yes (...)` or `remotion-2d: no (<reason>)`. The next `hold` run reports the
capability; the log line `... v0.5.0 hold mode ..., capabilities: echo, ffmpeg, xfade, remotion-2d` confirms it, and
the portal's **Workers** page shows it.

Resource use on a 2 vCPU / 8 GB VM: one browser tab (`VENSTUDIO_REMOTION_CONCURRENCY` overrides it), H.264 at CRF 20,
a time limit of 10 minutes or 40 s per second of video, whichever is longer. A render that times out is retried
like any failed render.

## Check it live

1. Workers page: the Muse worker shows version 0.5.0 (no "out of date" flag) and the `remotion-2d` and `xfade`
   capabilities.
2. Start a run with the **Flat-vector explainer** template (`tpl-explainer-flat-vector`). After the voice is approved, the render job on the Jobs
   page shows capability `remotion-2d` and progress "Rendering flat-vector-explainer with Remotion", then "Adding the
   narration".
3. The finished job's result has `"engine": "remotion-2d"`, `"composition": "flat-vector-explainer"`,
   `"transitionSec": 0.5` and `sceneStarts`. The video on the Review card shows animated headings, counters and bars
   with cross-fades between scenes, not a slideshow.
4. A stills style (for example **Narrated documentary with stills**) renders as before, now with cross-fades
   (`"transitionSec": 0.5` in the result) on a worker that reports `xfade`.

## Worker 0.7.0: music, ambience, caption style, long videos

What changes in the videos once every render worker runs 0.7.0:

- **Sound.** The narration no longer plays alone. Under it: a music bed from your library (normalised to -20 LUFS,
  lifted 3.5 dB, ducked 4:1 under the voice with a 15 ms attack and a 350 ms release, so it dips while someone speaks
  and comes back in the pauses and after the last line), looped when it is shorter than the video; brown-noise
  ambience band-passed 90-3200 Hz at -26 dB, made by the worker, so there is never digital silence between beats; and
  the whole mix mastered to the template's loudness (-14 LUFS, true peak -1 dB). Without a music track the mix is the
  narration and the ambience.
- **Captions.** The size, outline, shadow, line spacing, side and bottom margins and wrap width the portal measured
  for the frame (a 1080×1920 short: 78 px white text, 7 px black outline, 5 px shadow, 154 px off the bottom, at most
  978 px wide) instead of one fixed size. Both engines: drawtext for stills, the template for Remotion.
- **Long videos.** Up to 600 shots and 1200 caption lines, the catalogue's 20 minutes at a 2 s cut. The portal refuses
  more at the storyboard and render plan, before images are made; the worker takes exactly the same numbers. A stills
  job of more than 60 shots is rendered in parts of at most 60 inputs (the size 0.6.0 ran on Muse) and joined without
  re-encoding, so ffmpeg never opens hundreds of inputs at once. Remotion renders frame by frame, so its memory does not
  grow with the shot count; only its time does (the limit is 40 s per second of video).

The portal sends the mix and the caption style only when **every** render worker reports `audio-mix` and
`caption-style`. While one older worker is enrolled, renders keep the 0.6.0 sound and captions, and the render's
result says why (`mixNote`). Nothing is lost by updating late.

### Add a music track (once, in the portal)

1. **Assets → Upload**: choose the audio file (WAV or MP3), kind **audio**, source **upload** (your own track) or
   **licensed**, the licence (for example "Own composition, all rights" or "Licensed from … , licence no. …") and the
   origin link (the page you got it from, or your own page for a self-made track).
2. Tick **This is a music track for video beds**, then **Upload**. The asset shows the tag `music`.
3. That is all. The next render takes the newest music track of the run's channel, else the newest shared one. A
   track qualifies only when it is tagged `music`, has a licence and an origin link, and fits the template's music
   policy; a track made by a provider also needs that provider's terms confirmed in **Settings → Asset providers**.
   Narration and Test voice files are never used, whatever their tags.
4. The render stage notes which track plays ("Music bed: … (licence)") or why none does, and the finished video's
   licence lists the track first, with its origin and licence.

### Update the Muse workers to 0.7.0

Same steps as any update, on each Muse VM from `/home/hatch/venstudio`:

```bash
cd /home/hatch/venstudio
curl -fsSL https://<portal>/install/install.sh -o install.sh
sha256sum install.sh        # must equal "install.sh sha256" under Workers → Add a worker in the portal
bash install.sh --portal https://<portal> --mode hold --with-remotion
```

Compare the hash before running the script: the portal computes it from the file it serves, so a different value
means the download is not the portal's file, and you stop there. `install.sh` then fetches `venstudio-worker.ts`
(0.7.0) and the Remotion templates from the same portal. The worker's ffmpeg must have `sidechaincompress`,
`anoisesrc`, `aloop` and the other mix filters (any distribution ffmpeg from 4.4 on, and the static build install.sh
falls back to, do); without them the worker simply does not report `audio-mix`.

### Check it live

1. **Workers**: each worker shows 0.7.0 (no "out of date" flag) and the capabilities `audio-mix` and `caption-style`.
   The log line reads `... v0.7.0 hold mode ..., capabilities: echo, ffmpeg, xfade, narration-tempo, audio-mix,
   caption-style, remotion-2d`.
2. Run a video. The render job's payload on its Jobs page has `"audio"` with `"bed": {"assetId": "<your track>"}` and
   `"captionStyle"`. The job's result has `"audioMix": {"bed": {"assetId": …, "cover": "loop"}, "ambient": true, …}`.
3. Listen to the end of the video: after the last line the music is still playing, louder than under the voice. The
   captions sit above the bottom strip, outlined, without the dark box.

## Licence (owner check)

Remotion is free for individuals and for companies of up to three people; larger companies need a company licence
from remotion.pro. Check this applies before relying on it. Nothing in the code checks it.

## html-capture uses this project's browser (worker 0.10.0)

The html-capture renderer (`docs/html-capture.md`) renders HTML style packs in the Chrome Headless Shell this project
installs, and its packs travel in the same bundle under `html/`. Nothing else is installed for it: a worker with the
Remotion renderer reports `html-capture` once its 1-second probe page renders.

The bundle carries every pack at once, so its size follows the pack set: 400 files, 2 MB a file, 32 MB in total
(`BUNDLE_LIMITS`, worker 0.18.0). Every skill becomes a style, and two 3D looks with their texture and face atlases
already take 7 MB of the 26 packs — the old 5 MB / 200 file / 1 MB limits refused that bundle outright. A worker older
than 0.18.0 rejects it with "it is larger than 5242880 bytes": update the worker first, then install.

## How the remotion-2d path works

- `apps/render-remotion/` is its own npm project, deliberately not a root workspace, so the portal's `npm install` and
  Docker build stay as light as before. The portal image carries only its sources, to serve the bundle.
- The worker writes the props (`remotion-props.json`: scenes from `payload.scenePlan`, the shot pictures by file name,
  captions, and the frame timeline) and renders with
  `node <cli> render src/index.ts <composition> --props=… --public-dir=<job>/in --concurrency=1 --gl=swangle --muted`.
- Remotion renders muted. ffmpeg then adds the narration with the same loudness chain as the stills path
  (`loudnorm` to the template target, 48 kHz stereo, padded to the video length), copies the video stream, and the
  usual checks and `video.mp4` upload follow, so qc-video and the portal hooks see the same kind of file.
- Scene timing: scene i starts at the shot's place on the cross-fade timeline (`planCrossFades` over
  `payload.shots[].seconds`, snapped to frames once), and overlaps the next scene by `transitionSec`. The scene plan's
  own `seconds` are the storyboard lengths before the portal stretched the shots for the fades, so they are not used
  for timing.
- The template draws only what the plan declares: a counter counts to `value` only when it has one (otherwise its
  label and a neutral ring); bars and gauges plot `series` only when declared (otherwise muted placeholder shapes and
  no numbers).

Developing a template: templates are style packs now (docs/style-packs.md). `apps/render-remotion` is the shared
runtime (package, root, shared props, probe) and has no composition of its own; a Remotion pack's `render/` in
venturazz/venstudio-styles holds the composition, and the portal installs it as `src/packs/<id>/` in the bundle it
serves. To work on one: `node scripts/remotion-project.mjs /tmp/remotion && cd /tmp/remotion && npm install && npx
remotion studio src/index.ts`; then `npx tsc -p tsconfig.json` and `node scripts/probe.mjs --full`. The probe renders
every composition listed in the generated `src/packs/packs.json`, and the worker maps a scene plan's template to its
composition from that list. A new runtime file goes into `REMOTION_RUNTIME_FILES` in
`apps/portal/lib/install-bundle.ts` (a unit test fails until it does) and into the styles repo's runtime copy.

## Preview stills are bounded

The still-frame preview (stage `preview`) is a check, not a render: the worker draws frames from 0 and stops at
`STILL_DRAW_BUDGET_MS` (3 min), keeping the stills it got, and the Review card says why
fewer arrived. A heavy WebGL page (`voxel-build` under llvmpipe) costs seconds per frame, so without that bound a
six-still preview of a 45 s video would draw a thousand frames to prove the look is right.

`Page.captureScreenshot` gets its own, longer budget on a pack page (`PACK_SHOT_TIMEOUT_MS`, 90 s): the capture waits
for a composited surface, which on a slow software rasterizer can outlast the 30 s a frame gets even when the page is
fine. Removing the preview is not the fix — it is the cheap gate that catches a broken page before the voice and the
render spend ten minutes finding out.

## A page that drew nothing never becomes the look (0.19.1)

A 3D pack page answers `init(props)` with the job's four numbers (`totalFrames`, `fps`, `width`, `height`) even when it
could not get a WebGL context; in that case it draws only its text. Captured, that is a caption on a blank plate — and
because the preview and the render are separate jobs, it could be captured by one machine and not the other, which is
how a video can disagree with its own preview.

The page now reports `degraded: true` in that state and the worker refuses the job: *"The page drew nothing: it could not
get a WebGL context on this machine... a worker with working WebGL must take this job."* `voxel-build@0.3.3` and
`blocky-story@0.1.2` report it.

## The finished video is checked against the still it was approved with (0.19.1)

The preview runs before the voice, so its seconds are the planned ones and the video's are fitted to the narration; both
name the same scenes. The qc job therefore carries each approved still with the time its scene's middle has in *that*
video, and the worker measures the two pictures with ffmpeg's ssim. Below 0.85 the technical gate fails by name, e.g.
*"The video at 12.4 s does not look like the approved still (similarity 0.41)"*.

Measured on `voxel-build@0.3.3`, 540x960: still against the video frame of the same moment 0.978, against another
scene 0.44-0.51 — the threshold sits in that gap, so encoding noise passes and a drifted render does not.

## The render is drawn by the machine that drew the preview (0.19.1)

The stills are a promise about the look, so the render-video job is queued with the preview job's worker as its
`preferred_worker_id` — when that worker is still active and still reports the run's pack version. If it is gone, the
job is not pinned and the render stage records `previewWorkerNote`: another worker draws it and the picture can differ.

## A worker installs the renderer itself (0.19.0)

A worker without `remotion-2d` installs it on its first run: it asks the portal for its own `/api/worker/update`, takes
the `installSha256` the portal names, downloads that `install.sh` and runs it as its own account (never root, so the
pack environments install too). Three attempts, six hours apart; after that it stops and logs why, so a box that cannot
run Remotion does not retry every hour. The capabilities and environments are re-read afterwards, and the next claim
reports `remotion-2d`, `html-capture`, `preview-frames` and the packs.

Turn it off with `install.sh --no-provision` (it writes `VENSTUDIO_NO_PROVISION=1` into `run.sh`) or with
`VENSTUDIO_NO_PROVISION=1` in the environment of one run. Use it on a machine that must never install a browser, and
in a test that stands for a worker without the renderer (`scripts/e2e.sh` does).
