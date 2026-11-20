# Wiring the Hermes media host

The studio asks Hermes for images and narration, and Hermes makes them. The last mile is the problem: Hermes
writes the file **inside its own container** and its tool hands back an absolute path
(`/opt/data/cache/generated/images/canva_….png`). The portal runs in a different container and cannot read
that path, and it cannot be asked for base64 either — a model cannot carry a 100 KB+ blob in its reply, and
trying makes the turn loop until the stream is cut (`finish_reason: "error"`, `hermes.error_code:
"agent_error"`). Measured, both ways: `docs/research/05-hermes-asset-bridge.md`.

So the file is published over HTTP instead. Hermes replies with a **name**, the portal downloads the bytes.

```
Hermes container                     media host                 portal
/opt/data/cache/…  ──read-only──▶  nginx :8000  ──HTTP──▶  fetchMedia(trustedOrigins)
   generated/images/                 /img/<name>
   tts/                              /tts/<name>
   audio/                            /audio/<name>
```

## 1. Run the media host

Self-host (on top of the base compose file):

```bash
# HERMES_DATA_DIR = host path of the Hermes container's /opt/data
docker compose -f deploy/docker-compose.yml -f deploy/hermes-files.compose.yml \
  --env-file deploy/.env up -d
```

Find that host path with:

```bash
docker volume inspect <hermes data volume> --format '{{ .Mountpoint }}'
```

### Coolify

Use `deploy/hermes-files.coolify.yml`. It builds nginx with the config baked in, mounts the Hermes data
read-only, runs as the Hermes user (uid 10000), and joins the `coolify` network as `hermes-files`. CI starts
it and checks the four prefixes, the 404s and the user on every push.

Coolify refuses `${...}` and shell characters in volume paths ("Invalid volume source: contains forbidden
character"), so the file mounts a fixed path, `/data/venstudio/hermes-data`, which you point at the Hermes data
once with a symlink. `scripts/check-coolify-compose.sh` checks the file against that rule in CI.

1. On the VPS, link the fixed path to the Hermes `/opt/data`:
   ```bash
   SRC=$(docker inspect hermes-<id> --format '{{range .Mounts}}{{if eq .Destination "/opt/data"}}{{.Source}}{{end}}{{end}}')
   echo "$SRC"; ls "$SRC/cache"            # must list generated/, tts/ ...
   sudo mkdir -p /data/venstudio && sudo ln -sfn "$SRC" /data/venstudio/hermes-data
   ls /data/venstudio/hermes-data/cache    # same listing
   ```
2. Coolify: **+ New → Resource → Private Repository (with GitHub App)** → this repo, branch
   `feat/portal-foundation`, Build Pack **Docker Compose**, Base Directory `/deploy`, Docker Compose Location
   `/hermes-files.coolify.yml`. No environment variables are needed. Leave the domain empty. Deploy.
3. Portal environment: `HERMES_MEDIA_ORIGINS=http://hermes-files:8000`. Redeploy the portal.

Do **not** give it a domain. It runs as uid 10000 (the Hermes user); if yours differs, edit `user:` in the file.

## 2. Point the portal at it

One variable is enough:

| variable | value | notes |
|---|---|---|
| `HERMES_MEDIA_ORIGINS` | `http://hermes-files:8000` | origin only. It is the fetch allowlist, and the portal adds `/img`, `/tts` and `/clip` to it to tell Hermes where each kind is published |

Optional overrides, only when one kind is served somewhere else: `HERMES_IMAGE_MEDIA_ORIGIN`,
`HERMES_TTS_MEDIA_ORIGIN`, `HERMES_VIDEO_MEDIA_ORIGIN` (full URL with path, e.g. `http://x:9000/pics`). An
override wins, and a `HERMES_MEDIA_ORIGINS` entry that already has a path is used as is. An override on a
different host must also be listed in `HERMES_MEDIA_ORIGINS`, or the download is refused.

Use the container or service name, never an IP: container IPs change on restart.

## 3. Check it

```bash
# from inside the portal container
wget -qO- http://hermes-files:8000/healthz                    # ok
curl -sS -o /tmp/x.png -w '%{http_code} %{size_download}\n' \
  "http://hermes-files:8000/img/$(ls -t <hermes-data>/cache/generated/images | head -1)"
file /tmp/x.png                                               # PNG image data, 1200 x 1200
```

Then one turn on **Settings → test Hermes image**. Expected reply from Hermes:

```json
{"status":"ok","provider":"9router","source":"canva","model":"canva-default",
 "image":{"type":"url","value":"http://hermes-files:8000/img/canva_20261120_060311_8cb14b95.png","mimeType":"image/png"}}
```

`source` is the backend that really made the file (`canva`, `agnes`, `cloudflare-9router`, `modelscope`,
`sensenova-edit`, `free-fallback`). `provider` is always the plugin id `9router`. Provenance and Asset providers record
`source` (as `unlisted-<source>` unless it is listed in `HERMES_IMAGE_PROVIDER_ORDER`); a reply without `source` is
recorded as `unlisted-9router`. If Settings lists only `unlisted-9router`, the reply lost the field. See "Provider
identity" in `docs/architecture-autonomous-studio.md`.

## Security

**Never root the server at `/opt/data/cache`.** That directory also holds `canva_tokens/` — live Canva OAuth
credentials — plus `scratch/` and other working state. The supplied `hermes-files.nginx.conf` publishes
exactly three directories, `autoindex off`, and answers 404 for everything else. Keep the mount read-only
(`:ro`); nothing needs to write through this service.

## Why not the other routes

- **`GET /api/sessions/{id}/messages?inline_images=true`** — an `api_server` session does not attach a
  generated image. Measured: 0 data URIs, on a turn that did make one.
- **`/v1/artifacts/*`** — exists in `api_server.py` but is gated behind the disabled browser-extension
  capability. Unusable.
- **Base64 in the reply** — the loop above. Never ask for it.

## Known limits

- Canva returns **1200×1200** through the tool regardless of `aspect_ratio`; Cloudflare/Agnes/ModelScope/
  SenseNova return a real portrait (`1024×1536`, Agnes `768×1024`). All clear the studio's 480 px short-side
  floor, so a 9:16 short gets cropped by the renderer rather than rejected.
- Names are unique per call (`canva_20261120_060311_8cb14b95.png`), so parallel shots do not collide.
- The media host has no auth. It is an internal-only origin: never route it through Traefik/Caddy to a public
  domain, or every generated asset becomes public.