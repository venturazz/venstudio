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

On each Muse VM (or in the Muse agent's terminal), from `/home/hatch/venstudio`:

```bash
cd /home/hatch/venstudio
curl -fsSL https://<portal>/install/install.sh -o install.sh
sha256sum install.sh        # compare with Workers → Add a worker in the portal
bash install.sh --portal https://<portal> --mode hold --with-remotion
```

No `--code`: the enrollment is kept. Without `--with-remotion` the worker updates to 0.5.0 and renders stills and
cross-fades only.

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

## Licence (owner check)

Remotion is free for individuals and for companies of up to three people; larger companies need a company licence
from remotion.pro. Check this applies before relying on it. Nothing in the code checks it.

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

Developing a template: `cd apps/render-remotion && npm install && npx remotion studio src/index.ts` previews the
sample props; `npm run typecheck`; `node scripts/probe.mjs --full` before committing. Add new files to
`REMOTION_PROJECT_FILES` in `apps/portal/lib/install-bundle.ts` (a unit test fails until you do), and a new template
to `src/Root.tsx`, `COMPOSITIONS` in `scripts/probe.mjs` and `REMOTION_COMPOSITIONS` in the worker.
