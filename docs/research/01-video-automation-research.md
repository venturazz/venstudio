# VenStudio research: video pipelines, copyright safety, Muse connection

Date: 2026-11-18. Sources are linked inline. Content from sources was rephrased for compliance with licensing restrictions.

## 1. Hard constraints found

### Muse VM
| Fact | Source | Impact on VenStudio |
|---|---|---|
| About 2 vCPU, ~8 GB RAM, **no GPU** (AMD EPYC, Ubuntu 24.04) | [Stark Insider](https://www.starkinsider.com/2026/09/meta-muse-specs-what-it-runs-on.html), [Tom's Hardware](https://www.tomshardware.com/pc-components/cpus/meta-muse-runs-agents-on-amd-epyc-turin-hosts-with-two-cores-and-8gb-of-memory-ai-agent-can-pass-terminal-commands-to-ubuntu-host-system) | WebGL/3D renders (three.js, Godot 3D, Blender) are slow on CPU. 2D and ffmpeg pipelines suit Muse best. |
| No public IP; VM is destroyed when idle; only `/home/hatch` survives | [muse-console](https://github.com/lxrite/muse-console) | The portal cannot push commands in. The worker must call out. Renders must survive being killed mid-job. |
| Outbound traffic usually goes through an HTTP CONNECT egress proxy (`HTTPS_PROXY` env) | muse-console `docs/AGENT_DEPLOY.md` | Worker must honor proxy env vars. Plain HTTPS works through it; raw TCP needs a socat bridge. |
| A Muse scheduled task every ~5 min can wake the agent and boot the VM | muse-console `docs/AGENT_DEPLOY.md` | This is the keepalive and the recovery hook. Every wake is an agent run, so it uses your Muse usage limit. |
| Muse is free with limits; paid plans $20 and $100/month | [techjournal](https://techjournal.org/what-is-meta-muse) | 10 accounts x 288 wakes/day may hit free limits. Must be measured. |
| Reuters reported Muse mixing up data between accounts (Nov 2026) | [Economic Times](https://telecom.economictimes.indiatimes.com/news/internet/as-meta-bets-big-on-muse-ai-agent-early-safety-mishaps-surface/135961350) | Never store YouTube tokens, API keys for 9router, or payment data on Muse VMs. |

### YouTube
| Fact | Source | Impact |
|---|---|---|
| `videos.insert` now has its own bucket: 100 uploads/day per project, 1 unit each; 10,000 units/day for all other calls | [Google quota calculator](https://developers.google.com/youtube/data/determine_quota_cost), [dev.to summary](https://dev.to/aipredictions_dev/youtube-now-counts-uploads-in-their-own-bucket-100-a-day-one-unit-each-29gm) | One Google Cloud project is enough for 10 channels. |
| Uploads from unverified API projects are **no longer** locked to private (reverses the July 2020 rule) | [YouTube API revision history](https://developers.google.com/youtube/data/revision_history) | No compliance audit needed to publish publicly. |
| OAuth apps left in "Testing" get refresh tokens that expire in 7 days | [Google Ads API docs](https://developers.google.com/google-ads/api/docs/common-errors), [napkyn](https://napkyn.com/blog/youtube-api-refresh-token-expiring-fix) | Set the OAuth consent screen to "In production", or every channel disconnects weekly. |
| Only one AdSense account per payee; duplicates get monetization turned off | [YouTube Help](https://support.google.com/youtube/answer/9914702?hl=en-GB), [AdSense Help](https://support.google.com/adsense/answer/81904?hl=en) | All 10 channels link to **one** AdSense account, even across the 5 emails. |
| "Inauthentic content" (mass-produced, templated, repetitive) is not monetizable; AI as a tool is fine | [YouTube monetization policies](https://support.google.com/youtube/answer/1311392?hl=en-GB), [MilX](https://milx.app/en/trends/should-you-use-ai-generated-videos-and-how-will-it-impact-youtube-monetization) | Each channel needs a distinct format and real per-video variation. |
| YPP rewrite announced Aug 10, 2026, effective Feb 1, 2027 | [air.io](https://air.io/en/monetization/youtube-monetization-policy-changes-2026-a-complete-dated-timeline) | Re-check rules before channels apply for YPP. |

## 2. Pipeline catalog

"Muse fit" assumes 2 vCPU, no GPU. "GPU box" means a rented GPU VPS or your own PC running the same worker.

| Pipeline | What it produces | How it is automated | Muse fit | License |
|---|---|---|---|---|
| **ffmpeg filter graphs** | Image slideshows with camera moves (`zoompan`), overlays, transitions (`xfade`), burned-in styled captions (ASS), loudness (`loudnorm`) | One command per video, generated from a JSON timeline | Excellent | LGPL/GPL, free |
| **MoviePy** (Python on ffmpeg) | Same as above with easier compositing logic | Python script | Good | MIT |
| **Remotion 2D** (React) | Motion graphics, kinetic text, charts, rankings, captions, sprite puppets | `npx remotion render` with props JSON; frame ranges allow chunked renders | Good | Free for individuals and companies up to 3 people ([Remotion licensing](https://www.remotion.pro/license)); larger teams pay |
| **Remotion + three.js** ([claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts)) | 2D characters in a stylized 3D world, ink outlines, lens blur | Same as above; needs `--gl=swangle` without GPU, which Remotion warns is slow ([Remotion gl docs](https://www.remotion.dev/docs/gl-options)) | Poor to fair. Test real timings. Better on a GPU box. | Repo code MIT; reference frames for study only |
| **Motion Canvas / Revideo** | Code-driven 2D animation, good for explainers and diagrams | Revideo has a headless render API | Good | MIT |
| **Manim** | Math, science and diagram explainers | Python scene file per video | Good (Cairo renderer is CPU) | MIT |
| **Godot 4 Movie Maker** | Game-like 2D/3D scenes, pixel art, physics, crowds, sprite animation | `godot --path proj --write-movie out.avi --fixed-fps 30` ([Godot docs](https://github.com/godotengine/godot-docs/blob/master/tutorials/animation/creating_movies.rst)). Offline rendering, so slow hardware gives identical output, just slower. Needs a real renderer: `--headless` uses a dummy renderer, so run under Xvfb with Mesa software GL (Compatibility renderer). | 2D fair, 3D poor | MIT |
| **Blender headless** (`blender -b -P script.py`) | Full 3D, Grease Pencil 2D, cinematic lighting | Python `bpy` builds scenes from JSON | Poor (CPU Cycles on 2 cores is very slow). GPU box only. | GPL; your renders are yours |
| **Sprite / cutout puppet** | Recurring 2D characters that talk, blink, gesture | Character split into layers (head, eyes, mouths, arms); [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) turns voice audio into mouth-shape timings; render in Remotion or Godot. [synctoon](https://github.com/Automate-Animation/synctoon) is an existing open-source example where an LLM picks pose, gesture and zoom per word. | Excellent | Rhubarb MIT |
| **Lottie / Rive** | Polished vector character and UI animation | `@remotion/lottie` or Rive runtime inside Remotion; state machines drive poses | Good | Lottie open; Rive editor is a paid product, runtimes MIT |
| **AI video clips** (Kling, Veo, Runway, open Wan models) | Cinematic b-roll, short realistic or stylized shots | Provider API, then ffmpeg stitches | Rendering happens at the provider, so fit is fine; cost is per clip | Per provider terms; check commercial rights |
| **Stock-footage generators** (e.g. MoneyPrinterTurbo pattern) | Narration over stock clips | Script → search stock → ffmpeg | Good | Not recommended as a main format: stock-clip compilations are the type of content most exposed to the inauthentic/reused policies |

### Recommended format families

Each channel should own one primary format so channels don't look like copies of each other.

| Format | Pipeline | Why it works | Where to render |
|---|---|---|---|
| Animated story shorts (history, myths, "true story") | Remotion three.js, or a cheaper 2.5D version: AI-painted layered backgrounds with parallax + sprite characters | High watch value, clearly original | 2.5D on Muse; full 3D on GPU box |
| 2D character series (recurring cast) | Sprite puppet + Rhubarb + Remotion | Series bible keeps characters consistent; cheap to render | Muse |
| Narrated documentary / mystery / horror | AI stills in one consistent style + parallax + ffmpeg + sound design | Very cheap; quality depends on script and sound | Muse |
| Explainers (science, money, how things work) | Manim or Motion Canvas + voice | Original by construction, evergreen | Muse |
| Data / ranking / comparison | Remotion charts with sourced data | Fast to produce, easy to vary | Muse |
| Pixel-art / game-style stories | Godot 2D | Distinct look, few competitors | Muse (test), else GPU box |

### What makes the output professional

These are the checks the portal should enforce on every video:

1. **Hook:** the first 1 to 3 seconds show the payoff or the question. The LLM writes 3 hook variants and a scoring model picks one.
2. **Pacing:** new visual information every 2 to 4 seconds on Shorts. The shot planner enforces a maximum shot length.
3. **Captions:** word-level timed captions from TTS timestamps, styled per channel.
4. **Sound:** voice, music bed with ducking under speech, and sound effects on cuts and actions. Normalize to about -14 LUFS integrated.
5. **Style bible per channel:** palette, fonts, character sheets, camera rules, measured from reference videos. The claude-animated-shorts repo does this with its `STYLE_BIBLE.md` and measured reports.
6. **Automated QA:** render stills at key frames first. A vision model checks them against the style bible (off-model characters, text errors, artifacts) before the full render runs. Then check the final file (duration, resolution, loudness, black frames, silence).
7. **Human approval:** a review queue in the portal before anything is scheduled. This is also your evidence of human creative input for the inauthentic-content policy.

## 3. Copyright-safe production

### Rules
1. **Every asset gets a provenance record**: source URL or generator, license, date, file hash, and which videos use it. The portal blocks publishing if any asset in a video has no record.
2. **Prefer assets you generate or synthesize yourself.** Original script, your own TTS voice (with commercial rights from the provider), generated images, procedurally synthesized music and SFX. The claude-animated-shorts repo synthesizes its own march score and SFX in code, which avoids music licensing entirely.
3. **Prompt filters.** Block franchise names, real brand logos, living artists' names ("in the style of ..."), and real people's likeness in image/video prompts. Run a check on generated images for logos and text.
4. **Music is the biggest Content ID risk.** "Royalty-free" does not mean "Content ID safe": libraries and even AI tool vendors register tracks and claim them ([Thematic](https://hellothematic.com/ai-music-for-youtube/), [Foxi Music](https://www.foximusic.com/blog/content-id-safe-music-youtube-monetization-guide/)). Suno tracks are only monetizable if made on a paid plan ([dev.to](https://dev.to/akaranjkar08/suno-songs-on-youtube-2026-content-id-and-disclosure-40p7)). Safest order: procedural/self-composed music, then YouTube Audio Library, then paid AI music with commercial rights.
5. **Copy-cat analysis copies structure, never content.** Allowed: hook timing, pacing, shot types, story beat structure, title patterns. Not allowed: reusing footage, script text, characters, thumbnails or music from the reference.
6. **Upload private first.** YouTube runs its copyright checks after upload. Publishing on a schedule a few hours later gives time to catch claims.
7. **AI disclosure.** Tick YouTube's altered/synthetic content flag when content looks realistic.

### Asset sources (verify the license per asset; store it in the provenance record)
| Type | Source | License |
|---|---|---|
| 3D models, textures, HDRIs | Poly Haven, ambientCG, Kenney, Quaternius | CC0 |
| 2D sprites, UI, game art | Kenney | CC0 |
| 2D sprites (mixed) | OpenGameArt | Varies per asset; only accept CC0/CC-BY and record attribution |
| Fonts | Google Fonts | SIL OFL (free commercial use) |
| Sound effects | Freesound (filter to CC0), or synthesized | CC0 when filtered |
| Music | YouTube Audio Library; procedural generation | Per track terms |
| Characters / backgrounds | Your image models, with a fixed character sheet per series | Per provider terms |

## 4. Connecting the portal to Muse

Muse has no API, and the VM can't accept inbound connections. These are the options:

| Option | How it works | Verdict |
|---|---|---|
| **A. Pull worker (recommended)** | A small worker binary in `/home/hatch` long-polls the portal over HTTPS (through the egress proxy), claims a job, renders, uploads the result to object storage, reports status. The Muse scheduled task runs `/home/hatch/venstudio/keepalive.sh`, which restarts the worker if it died. | Simple, works through the proxy, no relay server, and the same worker runs on any VPS or GPU box. |
| B. Tunnel + push | rathole tunnel from VM to a relay VPS (the muse-console method); the portal calls an HTTP API on the worker. | Works, but adds a relay, TCP through a proxy bridge, and an exposed service. Useful only for a live web terminal for debugging. Can be added later on top of A. |
| C. Muse agent as executor | The scheduled task prompt tells the Muse agent to read a job file and run it. | The LLM is in the loop for deterministic work: slower, uses more Muse quota, less predictable. Use only for setup and recovery. |
| D. Drive the Muse chat UI with browser automation | Portal logs into muse.ai with Playwright and types commands. | Fragile, needs Meta login automation, likely against terms. Not recommended. |
| E. Email/messaging commands | Portal emails the Muse account; Muse reads it via a connector. | Slow and unreliable for job control. Not recommended. |

### Worker design for option A
- **Bootstrap:** a `AGENT_DEPLOY.md` in the worker repo. You paste the repo link into each Muse account once; the Muse agent installs the worker, registers it with a one-time enrollment code from the portal, and creates the 5-minute keepalive task.
- **Protocol:** `claim` → `heartbeat` (every 15 to 30 s, extends a lease) → `complete`/`fail`. If heartbeats stop, the lease expires and the job goes back to the queue.
- **Survive VM recycling:** render in chunks (Remotion frame ranges, ffmpeg segments). Keep finished chunks in `/home/hatch/jobs/<id>/` and upload each chunk as it finishes, so a restarted worker resumes where it stopped.
- **Capability tags:** each worker reports what it can run (`ffmpeg`, `remotion-2d`, `remotion-3d`, `godot`, `manim`) and measured speed. The scheduler sends heavy 3D jobs to GPU boxes and light jobs to Muse.
- **Security:** per-worker token with access only to its own jobs; signed short-lived upload/download URLs; no YouTube, 9router or storage master keys on the VM.

### Tests to run on one Muse account before building the fleet
1. Can the VM reach your portal domain and object storage through the egress proxy? (Some domains may be filtered.)
2. How long does a 60 s 1080x1920 render take for: an ffmpeg slideshow, Remotion 2D, Remotion three.js with `--gl=swangle`, Godot 2D under Xvfb?
3. Does a long-running background process survive between scheduled wakes, and for how long?
4. How much Muse usage does a 5-minute keepalive consume per day on the free plan?
5. How much disk is available in `/home/hatch`? (The claude-animated-shorts `public/` folder alone is about 1.3 GB.)

## 5. YouTube setup for 5 emails x 2 channels

- Each email (Google account) creates 2 **Brand Account** channels. Each channel can later get extra managers without sharing the password.
- One Google Cloud project, one OAuth client, consent screen set to **In production**. Connect each channel separately in the portal: during Google sign-in you pick which channel to authorize. The portal stores one refresh token per channel, encrypted.
- Upload limit is 100 videos/day per project, which covers 10 channels.
- All channels link to **one** AdSense account under your payee name.
- Each channel qualifies for YPP on its own, so give each one a distinct niche and format.

## 6. Open questions for the owner

1. You plan 5 emails for YouTube. How many Muse (Meta) accounts will you have, 10 or 5? Muse accounts are tied to Meta accounts, which have their own rules on multiple accounts.
2. Are you willing to add one GPU box or your own PC as a worker for 3D formats, or should all formats be CPU-friendly?
3. Which 10 niches or formats do you have in mind? This decides which pipelines to build first.
4. Which TTS and image providers do you use, and do their terms grant commercial rights?

## 7. Decisions after owner feedback (2026-11-18)

- **Fleet size:** start with 10 Muse workers, but workers are added and removed from the portal. Add = generate a one-time enrollment code and paste the bootstrap link into a Muse account. Remove = drain (finish current job, take no new ones) then revoke the worker token. Jobs never belong to a specific worker, so removing one only shrinks capacity.
- **Wake schedule: hourly instead of every 5 minutes.** Volume is low (about 2 videos/day without revisions), so up to 1 hour of waiting before a job starts is acceptable. This cuts agent wakes from 288/day to 24/day per account.
  - On each wake the Muse task runs `/home/hatch/venstudio/tick.sh` in the foreground. The script claims and renders jobs until the queue is empty, then exits. The agent stays busy while rendering, which should keep the VM alive. This needs testing, along with any limit on how long one agent task may run.
  - Chunked rendering still applies: if the VM stops mid-render, the next wake resumes from the last finished chunk.
  - Muse can't be triggered from outside, so an urgent job also waits for the next hourly wake.
- **No phone or device has to stay open.** Muse tasks run in Meta's cloud and keep working after the app is closed ([edapt](https://edapt.me/blogs/meta-muse-personal-ai-agent-explained), [getmusehelp](https://getmusehelp.com/)). The phone is only needed when Muse pauses for approval. Muse asks before sensitive actions (send, book, buy), and a separate Sentinel component approves outbound network traffic ([OpenReplay](https://blog.openreplay.com/meta-muse-first-look/)). The first connection to the portal domain may need a one-time approval; this is test #6.
- **TTS: Kokoro.** Kokoro-82M has Apache 2.0 weights (commercial use allowed) and runs fast on CPU ([Hugging Face](https://huggingface.co/hexgrad/Kokoro-82M)). Kokoro-FastAPI gives an OpenAI-compatible speech endpoint. TTS becomes a job step with a `tts-kokoro` capability tag, so it can run on a Muse worker, the portal server, or through 9router.
- **Images: use 9router providers, not Muse.** Diffusion models on 2 vCPU without a GPU take minutes per image, and Flux-class models don't fit well in 8 GB RAM. If Muse has built-in image generation, it is only reachable through the agent (no API) and its commercial-use terms need checking. Image steps run from the portal through 9router.

### Added Muse test
6. Does the first HTTPS call from the worker to the portal domain trigger a Sentinel approval prompt on the phone? After approving once, do later calls (including hourly wakes) go through without prompts?
7. With an hourly wake running `tick.sh` in the foreground, does a 30-minute render finish without the VM stopping?

### Update: volume and account mapping
- **Volume:** 2 videos/day per channel, 20/day across 10 channels.
- **One Muse worker per channel by default.** Each worker has a "home channel". The scheduler prefers the home worker but falls back to any idle worker if the home worker misses its wake or is offline, so one broken Muse account doesn't stop a channel. YouTube uploads still happen from the portal, so which worker rendered a video doesn't matter to YouTube.
- **No phone needed per account.** Muse also works in a desktop browser at muse.ai ([getmusehelp](https://getmusehelp.com/), [muse-faq](https://muse-faq.com/q/web-ban.html)). Plan: one computer, one browser profile per Muse account, used for setup and when the portal flags a worker as "needs attention". Muse has a "Web access" default in Settings > Permissions that controls which browser actions need approval ([Meta Help](https://www.meta.com/en-gb/help/superintelligence/2124746764949121/)). Approvals for terminal/network actions need testing.
- **Added test 8:** after setup, sign out of the browser profile. Do the hourly scheduled tasks keep running?
