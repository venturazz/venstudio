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
