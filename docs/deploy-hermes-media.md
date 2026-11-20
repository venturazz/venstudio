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

Coolify: create a new service from this repository, Docker Compose location
`/deploy/hermes-files.compose.yml`, and set `HERMES_DATA_DIR` in its environment to the mountpoint above.
It must join the same Coolify network as `portal` and the Hermes container — that is how
`http://hermes-files:8000` resolves. Do **not** give it a public domain.

## 2. Point the portal at it

| variable | value | notes |
|---|---|---|
| `HERMES_IMAGE_MEDIA_ORIGIN` | `http://hermes-files:8000/img` | a path is allowed; the agent appends the bare file name |
| `HERMES_TTS_MEDIA_ORIGIN` | `http://hermes-files:8000/tts` | same host, different directory |
| `HERMES_MEDIA_ORIGINS` | `http://hermes-files:8000` | the fetch **allowlist** — origins only, any path stripped |

`HERMES_MEDIA_ORIGINS` is what makes `fetchMedia()` agree to download; the two `*_MEDIA_ORIGIN` values are
what Hermes is told to build its reply from. Miss the allowlist and the agent's URL is rejected even though
the server is fine. Both `*_MEDIA_ORIGIN` values fall back to the first `HERMES_MEDIA_ORIGINS` entry, so a
single flat origin also works.

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
`sensenova-edit`, `free-fallback`). `provider` is always the plugin id `9router`. Provenance records
`source`; if it says `9router` for everything, the reply lost the field.

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