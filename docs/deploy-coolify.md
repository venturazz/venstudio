# Deploy VenStudio on Coolify

Uses `docker-compose.coolify.yml` in the repository root: Postgres + the portal. Coolify's proxy gives the domain
and HTTPS, so the Caddy container from `deploy/docker-compose.yml` is not used.

## 1. Add the app

1. In Coolify: your project → **+ New** → **Private Repository (with GitHub App)** (or with a deploy key) →
   pick `venturazz/venstudio`, branch `feat/portal-foundation`.
2. **Build pack:** Docker Compose.
   - **Base Directory:** `/`
   - **Docker Compose Location:** `/docker-compose.coolify.yml`
3. Save. Coolify loads the file and shows two services, `db` and `portal`.

## 2. Domain

Under **Domains**, set the `portal` service to your domain **with port 3000**:

```
https://studio.yourdomain.com:3000
```

The `:3000` only tells Coolify which container port to use; visitors use normal HTTPS. Point the domain's DNS
A record at the Coolify server. Leave `db` without a domain.

## 3. Environment variables

Coolify generates these on first load (shown under **Environment Variables**):

| Variable | What it is |
|---|---|
| `SERVICE_PASSWORD_POSTGRES` | Database password |
| `SERVICE_REALBASE64_PORTAL` | `ENCRYPTION_KEY`. **Copy it somewhere safe.** |
| `SERVICE_HEX_32_SETUP` | `SETUP_TOKEN` for the first sign-up |

Fill in yourself:

| Variable | Value |
|---|---|
| `NINEROUTER_BASE_URL` | 9router on the same server outside Docker: `http://host.docker.internal:20128`. 9router deployed in Coolify: its internal URL, e.g. `http://<container-name>:20128`, with **Connect to Predefined Network** enabled on both resources |
| `NINEROUTER_API_KEY` | your 9router key |

## 4. Allow long video uploads (once per server)

Coolify's Traefik proxy cuts off a request after **60 seconds** by default
([Coolify docs](https://coolify.io/docs/troubleshoot/applications/gateway-timeout)). Workers upload rendered videos
that can take longer. Go to **Servers → your server → Proxy → Configuration** and add to the `command:` list of the
`traefik` service:

```yaml
      - '--entrypoints.https.transport.respondingTimeouts.readTimeout=30m'
      - '--entrypoints.https.transport.respondingTimeouts.writeTimeout=30m'
      - '--entrypoints.https.transport.respondingTimeouts.idleTimeout=30m'
```

Save, then **Restart Proxy**. This affects all apps on the server; 30 minutes is a ceiling, not a delay.

## 5. Deploy and create the owner

1. **Deploy** and wait for both containers to be healthy. The portal runs database migrations on start.
2. Check `https://studio.yourdomain.com/api/health` returns `{"ok":true}`.
3. Open `https://studio.yourdomain.com/setup`, enter the `SERVICE_HEX_32_SETUP` value as the setup token,
   and create your account.
4. In **Settings**, turn on two-factor.

The setup page closes by itself once the owner account exists, so the token can't be reused.

## Updates, backups, logs

- **Updates:** enable **Auto Deploy** (GitHub App) or click **Redeploy** after pushing. Migrations run automatically.
- **Backups:** the database and rendered videos are in the volumes `venstudio-db` and `venstudio-artifacts`.
  Back up the database from the server with
  `docker exec $(docker ps -qf name=db- | head -1) pg_dump -U venstudio venstudio > backup-$(date +%F).sql`
  (check the container name with `docker ps` first), for example from a daily cron job.
- **Logs:** the `portal` service's **Logs** tab.
