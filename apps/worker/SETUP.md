# VenStudio worker setup

Reference for the owner of a VenStudio portal ({{PORTAL_URL}}). It describes what the worker is and the commands
that set it up. To set up a Muse VM, the owner sends the setup message from the portal's **Workers → Add a worker**
page; that message contains these same commands with a fresh one-time code.

## What the worker is

A single Node.js file (`venstudio-worker.ts`, readable at {{PORTAL_URL}}/install/venstudio-worker.ts) that:

- asks the portal for render jobs over outbound HTTPS, renders them with ffmpeg, and uploads the results;
- opens no ports and accepts no inbound connections;
- stores one secret, a worker token, in `/home/hatch/venstudio/config.json` (file mode 600);
- writes only under `/home/hatch/venstudio`.

The owner can revoke the token at any time in the portal under **Workers**.

## Install

```bash
mkdir -p /home/hatch/venstudio && cd /home/hatch/venstudio
curl -fsSL {{PORTAL_URL}}/install/install.sh -o install.sh
sha256sum install.sh      # compare with the value shown in the portal
bash install.sh --portal {{PORTAL_URL}} --code VS-XXXX-XXXX-XXXX --name "Muse 01" --mode hold
```

`install.sh` (readable before running) installs Node.js 24 from nodejs.org and a static ffmpeg build from
johnvansickle.com if the machine lacks them, verifying their published checksums, then downloads the worker and
enrolls it with the one-time code. It ends with `install complete`.

### Optional: the Remotion renderer (engine `remotion-2d`)

Animated styles such as the flat-vector explainer render with Remotion, not with ffmpeg alone. To let this worker
run them, add `--with-remotion` (on a first install or on an update):

```bash
bash install.sh --portal {{PORTAL_URL}} --mode hold --with-remotion
```

It downloads the templates from {{PORTAL_URL}}/install/render-remotion.json into `/home/hatch/venstudio/remotion`,
installs their npm packages from the npm registry and the headless Chromium Remotion downloads for itself (about
400 MB together, a few minutes; both go through the egress proxy), then renders one test still. The worker reports `remotion-2d` only once that
still rendered. `run.sh status` says whether it does, and why not. Remotion is free for individuals and companies of
up to three people; larger companies need a Remotion company licence.

## Hourly schedule (Muse)

A recurring hourly task runs:

```bash
/home/hatch/venstudio/run.sh hold
```

in the foreground. It stays online for up to about 55 minutes so new jobs start within seconds, finishes any render it
started, and exits. If the previous run is still rendering, it prints `already running` and exits at once. The log is
`/home/hatch/venstudio/logs/worker.log`; a line containing `fatal` means something needs the owner.

## Run now

```bash
/home/hatch/venstudio/run.sh tick
```

runs every queued job and exits when the queue is empty.

## Update or remove

- Update: run the install commands again without `--code`; the enrollment is kept.
- Remove: revoke the worker in the portal, delete the scheduled task, then `rm -rf /home/hatch/venstudio`.

## Job types and optional environment (worker 0.7.0)

| Job type | Always on | What it does |
|---|---|---|
| `render-video` | yes | Renders with the engine the job names. `ffmpeg-stills` (also any job without an engine): joins the storyboard pictures (slow zoom or pan), the narration and optional captions into an H.264/AAC mp4 with faststart, then uploads `video.mp4`. Narration length sets the timing. When the job asks for a `transitionSec`, the shots cross-fade (ffmpeg `xfade`, transition fixed by position) and the video is the shots less the overlaps; the worker reports the `xfade` capability only when its ffmpeg has that filter. Captions are burned in only when this ffmpeg has the `drawtext` filter and a font asset was sent; otherwise the result says why. `remotion-2d`: needs the Remotion renderer on this machine; without it the job fails and names the engine. Any other engine is refused by name. A job is never rendered as stills in place of the engine it asked for. Since 0.6.0: when the owner chose **Fit the narration to the video**, the job carries `narrationTempo` (0.9 to 1.15) and the narration is played at that tempo (ffmpeg `atempo`, pitch kept) on every engine; the worker reports the `narration-tempo` capability when its ffmpeg has `atempo`, and the portal offers the fit only when every render worker reports it. A job without `narrationTempo` renders exactly as in 0.5.0. Since 0.7.0: a job may carry `audio` (music bed looped or trimmed to the video, normalised and ducked 4:1 under the narration with `sidechaincompress`, brown-noise ambience made with `anoisesrc`, accents, and a master `loudnorm` to the target with a true-peak limit) and `captionStyle` (caption size, outline, shadow, line spacing, margins and wrap width, on both engines); the worker reports `audio-mix` only when its ffmpeg has every filter of the mix, and `caption-style` with ffmpeg; the portal sends either only when every render worker reports it. A job without them renders exactly as in 0.6.0. Up to 600 shots and 1200 caption lines (20 minutes at a 2 s cut): a stills job of more than 60 shots or 300 captions is rendered in parts of at most 60 inputs and joined without re-encoding, so no single ffmpeg opens hundreds of inputs. |
| `fetch-asset` | yes | Downloads one public-domain picture from an approved site (Wikimedia, NASA, Library of Congress, Met Museum, Openverse). https only, no redirect to another site, size limit, file type checked by its first bytes, uploaded as `asset.<ext>`. |
| `tts` | only with `VENSTUDIO_KOKORO_URL` | Sends text chunks to your Kokoro server (`POST /v1/audio/speech`, WAV), joins them and uploads `narration.wav`. The worker never receives a Kokoro key, so use an address that needs none. |
| `agent-task` | only with `VENSTUDIO_AGENT_TASKS=1`, hold mode | **UNVERIFIED.** Writes `/home/hatch/venstudio/inbox/<jobId>/TASK.md`, waits for the Muse agent to put files in `out/` and create `out/DONE`, then uploads them. Needs Muse tests 12 to 16 before anyone relies on it. |

Rendering variables: `VENSTUDIO_REMOTION_DIR` (where the Remotion project is, default `/home/hatch/venstudio/remotion`)
and `VENSTUDIO_REMOTION_CONCURRENCY` (browser tabs, default 1 on a 2 vCPU machine, 2 on larger ones).

A worker without those variables does not advertise `tts` or `agent-task`, so the portal never sends them. Set a
variable in the scheduled task command, for example
`VENSTUDIO_KOKORO_URL=http://kokoro.internal:8880 /home/hatch/venstudio/run.sh hold`.

Image generation (the Hermes `image_gen` chain) and the CapCut backup voice run in the portal through Hermes, not on
the worker.
