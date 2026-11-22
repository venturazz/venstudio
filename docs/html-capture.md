# html-capture renderer (worker 0.10.0)

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

`animated-line-graph` and `minimal-line-art` (status `draft` until CI has rendered them) adapt the `graph` and
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
