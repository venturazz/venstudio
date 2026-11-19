# Deploy VenStudio on Coolify

Uses `docker-compose.coolify.yml` in the repository root: Postgres + the portal. Coolify's proxy provides the
domain and HTTPS.

## 1. Add the app

1. **Sources → + Add → GitHub App**, install it on `venturazz/venstudio` (one time).
2. Project → **+ New → Private Repository (with GitHub App)** → `venstudio`, branch `feat/portal-foundation`.
3. **Build Pack:** Docker Compose · **Base Directory:** `/` · **Docker Compose Location:** `/docker-compose.coolify.yml`.

## 2. Domain

Set the `portal` service domain to `https://studio.yourdomain.com:3000` (the `:3000` is the container port; visitors
don't type it). Point the DNS A record at the server. No domain for `db`.

## 3. Environment variables

Open **Environment Variables**. If the list is empty, click **Reload Compose File** (or save the General settings)
so Coolify reads the file again. Then fill in:

| Variable | Value | How to make it |
|---|---|---|
| `APP_URL` | `https://studio.yourdomain.com` | Your domain, **without** `:3000` and without `/` at the end |
| `POSTGRES_PASSWORD` | random | `openssl rand -hex 16` |
| `ENCRYPTION_KEY` | random, **back it up** | `openssl rand -base64 32` (44 characters) or `openssl rand -hex 32` (64 characters) |
| `SETUP_TOKEN` | random | `openssl rand -hex 16` |
| `NINEROUTER_BASE_URL` | optional | `http://host.docker.internal:20128` if 9router runs on the same server outside Coolify |
| `NINEROUTER_API_KEY` | optional | your 9router key |
| `KOKORO_BASE_URL` | optional | Address of your Kokoro server on the coolify network, e.g. `http://kokoro:8880` (see below). Empty means narration is not configured |
| `KOKORO_API_KEY` | optional | Only if your Kokoro server asks for a key |
| `KOKORO_MODEL` | optional | `kokoro` |
| `KOKORO_VOICE` | optional | `af_heart` (a US English voice) |
| `TTS_BACKUP` | optional | `hermes-capcut` (default): if Kokoro cannot do a language or is down, Hermes runs its CapCut workflow. `off` disables the backup |
| `HERMES_IMAGE_PROVIDER_ORDER` | optional | Providers Hermes should try first for images, e.g. `cloudflare,qwen,minimax`. Also the list of provider names the portal records as is. Any other name, and every name when this is empty, is stored as `unlisted-<name>` and needs owner confirmation in Settings. While this is unset, confirming `cloudflare` in Settings does not clear `unlisted-cloudflare`; confirm that name too |
| `HERMES_MEDIA_ORIGINS` | optional | Extra origins (scheme, host, port) Hermes serves generated files from, e.g. `http://hermes-files:8000`. Needed only if file URLs differ from `HERMES_BASE_URL`. Exact match, first request only. The first request may use plain http and private hosts, so list only origins you control |
| `MUSE_AGENT_TASKS` | optional | `0` (default). `1` allows the unverified Muse agent task fallback |

### Kokoro server (example, verify before relying on it)

Kokoro is not part of this compose file. One way to run it is as its own Coolify app from a Kokoro-FastAPI image
(an OpenAI-compatible server). This is an example to check against the project's own instructions, not a tested recipe:

```yaml
services:
  kokoro:
    image: ghcr.io/remsky/kokoro-fastapi-cpu:latest   # verify the image name and tag
    restart: unless-stopped
    networks:
      - coolify
networks:
  coolify:
    external: true
```

Give it no public domain. The portal reaches it at `http://kokoro:8880` (the usual Kokoro-FastAPI port; verify). Only
English voices are treated as verified. Other languages show a warning, and the portal asks Hermes to use CapCut when Kokoro does not cover a language.

Run the `openssl` commands in **Servers → your server → Terminal** (or over SSH). If the list still doesn't show a
variable, add it yourself with **+ Add** using exactly the name above.

Don't change `POSTGRES_PASSWORD` after the first deploy: the database keeps the first one.

## 4. Allow long video uploads (once per server)

Coolify's Traefik proxy stops requests after 60 seconds by default. In **Servers → your server → Proxy**, add to the
`traefik` `command:` list, then **Save** and **Restart Proxy**:

```yaml
      - '--entrypoints.https.transport.respondingTimeouts.readTimeout=30m'
      - '--entrypoints.https.transport.respondingTimeouts.writeTimeout=30m'
      - '--entrypoints.https.transport.respondingTimeouts.idleTimeout=30m'
```

## 5. Deploy and create the owner

1. **Deploy**. `https://studio.yourdomain.com/api/health` should show `{"ok":true}`.
2. Open `/setup`, paste `SETUP_TOKEN`, create your account, then turn on two-factor in **Settings**.
   The setup page locks once the owner exists.

## Troubleshooting

| Problem | Fix |
|---|---|
| Deploy refuses to start, mentions a required variable | Fill in `APP_URL`, `POSTGRES_PASSWORD` and `ENCRYPTION_KEY`. |
| `/api/health` shows `{"ok":false}` | Read the **portal** logs; the message names the wrong variable. |
| Logs: `ENCRYPTION_KEY must be 32 random bytes` | Make a new key with one of the two commands above and redeploy. |
| Logs: password authentication failed | `POSTGRES_PASSWORD` was changed after the first deploy. Set it back, or (only if there's no data yet) delete the `venstudio-db` volume and redeploy. |
| Video uploads fail after ~1 minute | Step 4 wasn't applied or the proxy wasn't restarted. |
