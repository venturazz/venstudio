# html-capture renderer (worker 0.10.0; page mode and preview-frames in 0.11.0)

Phase 2 of `docs/plans/style-system.md`. html-capture renders an HTML page, animated with GSAP, CSS or three.js,
frame by frame in headless Chromium and encodes the frames with ffmpeg. It is the approach of
`github.com/artemnovitckii/claude-animation-skills` (MIT); nothing from that repo is copied, and nothing is downloaded
at render time. The page format for pack authors is in `styles/FORMAT.md` ("html-capture render projects").

## Ringkasan (Bahasa Indonesia)

- Renderer baru `html-capture`: halaman HTML (GSAP/CSS/three.js) dari sebuah style pack direkam per frame di
  Chromium headless milik proyek Remotion yang sudah terpasang, lalu di-encode ffmpeg (H.264, yuv420p, faststart).
- Halaman tidak boleh memakai jaringan: semua permintaan selain file pack dan input job digagalkan, dan job gagal.
- Waktu di halaman virtual: Date, performance.now, requestAnimationFrame, timer dan Math.random dikendalikan worker,
  jadi render yang sama selalu menghasilkan gambar yang sama.
- Worker melaporkan `html-capture` hanya setelah halaman uji 1 detik berhasil di-render di mesin itu.
- Tidak ada env baru yang wajib. Worker 0.10.0 sampai ke Muse lewat update otomatis bertanda tangan (Phase 0).

## What a worker needs

Nothing new. html-capture uses the Chrome Headless Shell that the Remotion renderer installs
(`install.sh --with-remotion`, `docs/remotion-worker.md`) and the worker's ffmpeg. A worker without the Remotion
project simply does not report html-capture. `VENSTUDIO_CHROMIUM_PATH` (optional) names another Chromium.

## How a render runs

1. **Dispatch.** `render-video` picks the renderer plugin by the payload's `engine` (`RENDERERS` in the worker):
   `ffmpeg-stills`, `remotion-2d` or `html-capture`. Each plugin has an id, the capability jobs without a pack are
   queued under (`ffmpeg`/`xfade`, `remotion-2d`, `html-capture`), a probe, a check of what it needs from the spec
   (before any download), a render step, and a declaration of what runs after it. An engine without a plugin is
   refused by name (`hermes` says it is rendered by the portal) and is never rendered as stills.
2. **The pack.** The page comes from the installed bundle: `<remotion>/html/<pack id>/`, listed in
   `<remotion>/html/packs.json` with its version, `drawsCaptions` and the digest of its files. A pack whose files do
   not match the digest is not used. The scene plan's `template` names the pack.
3. **Serving.** A loopback HTTP server (127.0.0.1, random port, random path prefix) serves the pack's files and the
   job's inputs (`../in/<file>` from the page). Only GET and HEAD, no dot files, nothing outside those two folders.
4. **Isolation.** Every request the page makes goes through DevTools request interception. Only the capture server's
   origin and `data:`, `blob:`, `about:` URLs load; any other request is failed, recorded, and fails the job by name
   ("The template tried to use the network while rendering (...)"). WebSocket, EventSource, WebRTC, sendBeacon and
   service workers throw in the page and are reported the same way. Chromium also runs with a dead proxy and a host
   resolver that resolves nothing but 127.0.0.1, so a request that slipped past interception still goes nowhere.
5. **Virtual clock.** A script injected before the page's own scripts replaces `Date`, `performance.now`,
   `requestAnimationFrame`, `setTimeout`/`setInterval` and `Math.random`. Time starts at 2026-01-01T00:00:00Z and
   moves by exactly one frame before each `renderFrame`; CSS and Web Animations are paused and held to the clock.
   While `init` runs the clock stays at 0, but zero-delay timers and frame callbacks still run.
6. **Capture.** The page gets `init(props)` (it must answer the job's size, fps and frame count), then for each frame
   `renderFrame(frame)` and a screenshot of the fixed viewport at device scale 1. Frames are piped into ffmpeg one at
   a time (libx264, yuv420p, faststart, muted), so memory stays flat.
7. **After capture.** Captions: drawn by the page when the pack declares `drawsCaptions: true`, otherwise burned with
   the shared 0.7.0 drawtext chain (with `captionStyle`) while ffmpeg encodes. Sound: the shared mux adds the
   narration and the audio mix exactly as for Remotion.

## Limits (Muse: 2 vCPU, about 8 GB)

One page per render. 30 s at most per frame, 60 s for `init`, 30 s for the page load, and an overall limit of ten
minutes or 40 s per second of video, whichever is longer (the Remotion limit). Progress is reported every 2 s. The
browser profile is a fresh temporary folder, removed afterwards with the browser's whole process group.

## Pages Hermes writes (html-design, worker 0.11.0)

A run of an html-design pack (`docs/style-packs.md`, "html-design"; research only) uploads the page Hermes wrote as a
job input: a page bundle `{ format: 1, kind: "venstudio-html-page", files }`, `payload.page.assetId` for render-video
and `payload.preview.page` for preview-frames. The portal validated it before queueing; the worker treats it as
untrusted code all the same:

- **Checked again.** `parsePageBundle`: `index.html` present, at most 20 text files and 300 KB together, plain relative
  names (`.html` only for index.html, `.js`, `.css`, `.svg`). It is written to `<job>/page/`, outside `<job>/in/`.
- **Served alone.** The loopback server serves `page/` (the page), `pack/` (the pack's installed, digest-checked files,
  `../pack/` from the page) and `in/` (the run's media: the plate, the font, `../in/`), nothing else: never the job
  folder, the bundle file or another job's files. Every response carries
  `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:`
  plus `worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'`
  (`HTML_PAGE_CSP`; `worker-src` and `child-src` would otherwise fall back to `script-src 'self'`), with `nosniff`,
  `no-referrer` and a `same-origin` resource policy (`captureHeaders`). `eval` is refused because `'unsafe-eval'` is
  not granted.
- **Guarded.** Besides the virtual clock, `HTML_PAGE_GUARD_SOURCE` runs before the page's own scripts: `fetch`,
  `XMLHttpRequest`, `Worker`, `SharedWorker`, `window.open`, `sendBeacon` and `createElement` of frames, objects and
  embeds are refused and reported, `navigator.serviceWorker` is replaced by one that refuses to register, and every CSP
  violation (an image or font from another host, a frame, eval, a form) is reported through the same binding as a
  blocked request, by a listener the guard adds first on `window` in the capture phase. The worker also reads
  Chromium's own security log (`Log.entryAdded`, source `security`/`violation`), which page code cannot silence. After load, after init and at the end the worker also
  looks for `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv>` and `<form action>` in the DOM.
- **Budgeted.** 20 s for `init`, 10 s per frame, at most 54 000 frames (30 minutes at 30 fps, the render limit), and
  the overall limit of a render. A fresh temporary browser profile, no extensions, the dead proxy and the resolver that
  resolves nothing (unchanged from 0.10.0).
- **Chromium's own sandbox.** Signed packs keep 0.10.0's `--no-sandbox` (as Remotion launches the same browser). For an
  uploaded page the worker first checks, once per process, whether this Chromium starts with its process sandbox on
  here (`chromiumSandboxWorks`: user namespaces or the setuid helper) and then runs the page sandboxed; where the host
  does not allow it, the page runs without it and the job result says `sandboxed: false`. The other layers hold either
  way; a Muse VM or CI runner that refuses unprivileged user namespaces is the case to watch.
- **Named failures.** "The Hermes-designed page tried to use the network or a blocked feature while rendering (...)",
  "The Hermes-designed page threw in init(props): ...", "... threw in renderFrame(12): ...", "... did not finish
  init(props) within 20 s". Nothing is rendered.
- **Pack and page agree.** An html-design pack is marked `designed` in `html/packs.json`; the worker renders it only
  with an uploaded page and renders an uploaded page only with such a pack (`htmlPageModeFor`). Its own
  `render/index.html` is a reference page: `capture-html` renders it in page mode (CSP and guard on), so CI proves the
  sandbox lets a well-behaved page draw.

## Still frames (preview-frames, worker 0.11.0)

The job type `preview-frames` takes still frames of an html-capture page before the voice and the render: the
installed pack's page (scene-spec) or the uploaded page (html-design). Its payload is a render-video payload without
the narration (the run has none yet; `durationSec` is the planned or narrated length) plus `preview: { times, page? }`,
at most 12 times. `parsePreviewPayload` parses it with `parseRenderSpec`, so the props are exactly the render's. The
worker downloads only the shots' pictures and the font into `in/`, draws every frame up to the last asked one in order
(a page that keeps state renders as in the video), captures the asked frames as JPEG (`still-01.jpg` ...), uploads them,
and returns `{ stills: [{ name, atSec, frame }], consoleErrors, blocked, page, htmlPack, drawsCaptions }`. An uploaded
page fails on any blocked attempt, as at render; a pack's page only reports it. Captions burned by the worker are not
in the stills. No ffmpeg runs.

The worker reports `preview-frames` only after the html-capture probe passed and one still of the probe page came back
as a JPEG (`previewFramesUnavailableReason`, cached per process); the handler checks it again. It also names the
`preview-frames` job type in its claims only then (`claimJobTypes`), so a worker that has the pack but cannot take
stills never claims a preview queued under that pack. A 0.10.0 worker never names the job type at all. Worker 0.11.0 reaches Muse through the signed self-update.

## Probe

The worker reports `html-capture` only after it rendered a 1-second probe page (10 frames, 160x90) whose one network
request was seen and blocked, and ffprobe counted exactly 10 frames of that size. The result is cached per process
(and cleared after a Remotion bundle update). A pack is reported as `pack:<id>@<version>` only when the probe passed
and that exact version is installed with matching files. `node venstudio-worker.ts status` prints both.

## DevTools transport

The worker talks to Chromium over the DevTools protocol through `--remote-debugging-pipe` (file descriptors 3 and 4),
with Node built-ins only. The brief asked for Node 22's built-in WebSocket and fetch against a debugging port; the
pipe was kept instead because Muse runs the worker with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY`, under which Node's
fetch and WebSocket go through the proxy unless `NO_PROXY` covers 127.0.0.1, and because a debugging port could be
reached by any local process while the browser runs. Both are zero-dependency; switching is local to `CdpPipe`.

## For pack authors and CI

```
node scripts/remotion-project.mjs /tmp/vs-remotion        # runtime + Remotion packs + html/<id>/ for html packs
(cd /tmp/vs-remotion && npm install && npx remotion browser ensure)
node apps/worker/venstudio-worker.ts capture-html --pack styles/packs/probe-line-graph --out /tmp/p.mp4 \
  --remotion /tmp/vs-remotion --font /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
node styles/tools/check-video.mjs /tmp/p.mp4 styles/packs/probe-line-graph/fixtures/expect.json
VENSTUDIO_REMOTION_DIR=/tmp/vs-remotion node --test apps/worker/html-capture-render.test.ts
```

`capture-html` renders a fixture muted, with plain-colour pictures, the way a worker draws it. CI here runs all of
the above; the styles repo's CI runs `capture-html` with its vendored copy of this worker
(`runtime/html-capture/venstudio-worker.ts`) and `check-video.mjs`.

## The packs

`animated-line-graph` and `minimal-line-art` (status `trial` 0.1.2, rendered on venstudio CI run 44981421800 and styles CI run 44980615532 at 0.1.0 with the same render/; 0.1.2 adds the scene-spec workflow) adapt the `graph` and
`minimalistic-graphics` skills of github.com/artemnovitckii/claude-animation-skills (MIT, fonts OFL; commit
`86f70106c9ae`) to this contract: data from the render payload, plain JavaScript and SVG with a small frame-driven
timeline instead of GSAP, fonts embedded as `data:` URLs. CI renders every vendored html-capture pack the same way
(`html-capture-render.test.ts` loops over `styles/lock.json`). See `docs/template-lab.md`.

### The first pack

`probe-line-graph` (status `lab`): an original line graph written for VenStudio, with a heading, a line that draws
itself with its points popping in, and a counter. Its page is plain JavaScript and SVG driven by the frame number:
GSAP is not vendored in it, because the sandbox it was written in had no network to fetch GSAP from. A pack that
uses GSAP or three.js vendors the library under `render/vendor/<name>/` with its licence file (the validator checks)
and seeks a paused timeline to `frame / fps` in `renderFrame`.

### Runs of an html-capture pack (scene-spec workflow)

A run of `animated-line-graph`, `minimal-line-art` or `probe-line-graph` follows the `scene-spec` workflow
(`docs/style-packs.md` "Workflows"): Hermes writes a scene spec from sourced research numbers, and the spec is the
scene plan this page draws. No picture is generated: every shot of the payload points at one plain-colour plate the
portal draws, because the render contract carries a picture per shot. The worker contract is unchanged.
