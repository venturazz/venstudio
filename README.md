# VenStudio

Command center for automated YouTube production across 10 channels. The portal plans and tracks work;
render workers (Muse VMs, a VPS, or your own PC) pull jobs over HTTPS, render, and upload results.

Research and decisions: [docs/research/01-video-automation-research.md](docs/research/01-video-automation-research.md).
Autonomous studio workflow, templates and QC: [research](docs/research/04-autonomous-studio-workflow.md) and [architecture](docs/architecture-autonomous-studio.md).

## How it fits together

```
 Browser (phone/desktop) ──HTTPS──▶ Caddy ──▶ Portal (Next.js) ──▶ PostgreSQL
                                              │        ▲
                              9router ◀───────┘        │  claim / heartbeat / upload (outbound HTTPS only)
                    (scripts, images, TTS)             │
                                     Muse VM workers ──┘  hourly scheduled task: run.sh hold (~55 min online)
```

- **Portal** (`apps/portal`): Next.js 16 + PostgreSQL. Channels, workers, jobs, settings, worker API.
- **Worker** (`apps/worker/venstudio-worker.ts`): one TypeScript file, no npm dependencies, runs on Node ≥ 22.18.
  Modes: `hold` for Muse (the hourly task keeps it online ~55 min, picking up jobs within seconds), `tick`
  (run until the queue is empty, then exit; used for manual "run now"), `daemon` for always-on machines.
- **Protocol** (`packages/protocol`): shared types for the worker API.

### Job routing
- Each channel can have a **home worker**. Its jobs go there first.
- If the home worker hasn't taken a job within 75 minutes (it missed its hourly wake) or is drained/revoked,
  any idle worker with the right capability takes it.
- **Urgent** jobs skip the home-worker wait and go to the first free worker (e.g. an always-on VPS).
- Claims **long-poll**: the portal holds a worker's request up to 25 s, so a job starts as soon as it is queued.
- Workers hold a 2-minute **lease** renewed by heartbeats every 30 s. If a VM is recycled mid-job, the lease
  expires and the job returns to the queue (up to 3 attempts).

## Security

- Owner account created once via `/setup` with a `SETUP_TOKEN`; the page closes after that.
- Passwords hashed with scrypt; sessions are random tokens stored as SHA-256 hashes, in `HttpOnly`,
  `SameSite=Lax`, `__Host-` cookies.
- Optional TOTP two-factor (secrets encrypted with AES-256-GCM using `ENCRYPTION_KEY`), replay-protected.
- Login rate limiting per email and per IP; audit log of sign-ins and admin actions.
- Roles: owner (everything), editor (channels and jobs), viewer (read only).
- Workers get a single token from a one-time, 30-minute enrollment code. Tokens are stored hashed and can be
  revoked instantly. Workers never receive 9router keys, YouTube tokens or user credentials.
- Strict security headers (CSP, frame-ancestors none, HSTS in production, nosniff).

## Run locally

```bash
docker run -d --name vs-db -e POSTGRES_USER=venstudio -e POSTGRES_PASSWORD=venstudio -e POSTGRES_DB=venstudio -p 5432:5432 postgres:17-alpine
npm install
cp apps/portal/.env.example apps/portal/.env.local   # set ENCRYPTION_KEY: openssl rand -base64 32
set -a; . apps/portal/.env.local; set +a
npm run migrate
npm run dev        # http://localhost:3000 -> /setup
```

Tests: `npm test` (unit + worker), `bash scripts/e2e.sh` (needs a built portal, Postgres, ffmpeg).

## Deploy

```bash
cp deploy/.env.example deploy/.env    # fill in DOMAIN, POSTGRES_PASSWORD, ENCRYPTION_KEY, SETUP_TOKEN, 9router
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Open `https://$DOMAIN/setup`, create the owner, turn on two-factor in Settings, then remove `SETUP_TOKEN`
and restart.

### Coolify

Use `docker-compose.coolify.yml` (Docker Compose build pack). Step-by-step: [docs/deploy-coolify.md](docs/deploy-coolify.md).

## Add a Muse worker

1. Portal → **Workers** → *Add a worker*. Pick the home channel.
2. Copy the generated message and send it **as your own message** to that Muse account (browser profile, app or
   WhatsApp). It lists every command and the install script's sha256, so Muse can check them before running.
   (Muse refuses instructions it would have to fetch from a web page, which is correct.)
3. Muse runs the commands (reference: `/install/SETUP.md` on your portal): installs Node.js + ffmpeg under
   `/home/hatch/venstudio`, enrolls, and creates an hourly scheduled task running `run.sh hold`.
   If a Muse worker misses its runs, the Workers page marks it **Needs attention** with a "run now" message
   you can send to that Muse from the app or WhatsApp.
4. Queue an **Echo** job, then a **Render smoke test**, to check connectivity and render speed.

For a VPS or your own PC, use the `curl … install.sh … --mode daemon` command shown in the same dialog.

## Studio and Assets (planning and library)

- **Studio** (`/studio`): choose a format (short or long), a theme and a style. Suggest styles from a brief, preview the
  stage plan, and save it as a production. Stages marked *Runs now* can run today; the rest are planned until their
  workers are built. The style library is at `/studio/styles`.
- **Hermes runs and Review** (`/studio/runs`, `/review`): Hermes proposes ideas, researches, writes the script and
  the storyboard for a channel. You approve an idea, ask for a change with a note, or reject, from a phone-friendly
  inbox. Asset sourcing and rendering come in later phases.
- **Assets** (`/assets`): every reference, image, audio file or worker output, with its source, licence and origin.
  Publishing checks these notes. Reference videos can be analyzed for cuts, pacing, hook timing and loudness; they
  can never appear in a published video.
- Design and sources: [docs/research/03-production-styles-and-muse-capabilities.md](docs/research/03-production-styles-and-muse-capabilities.md).

## Owner recovery and YouTube keys

- Locked out? See the recovery command in the Coolify section of [docs/deploy-coolify.md](docs/deploy-coolify.md).
  It sets a new owner password from the server and signs every device out.
- Where the YouTube keys go, and why a service-account `key.json` doesn't work: [docs/youtube-credentials.md](docs/youtube-credentials.md).

## Roadmap

1. **Foundation (this):** auth, channels, worker fleet, job queue, smoke-test rendering, 9router status.
2. YouTube OAuth per channel (Brand Accounts), private-first uploads, scheduling.
3. Production pipelines: idea → script → TTS (Kokoro / 9router) → images → render (ffmpeg, Remotion) → review.
4. Series bible, characters, storyboard editor, asset provenance ledger.
5. Research / copy-cat structure analysis and analytics dashboard.
