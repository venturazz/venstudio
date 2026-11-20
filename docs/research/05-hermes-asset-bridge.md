# 05 — Hermes as the asset door: the measured contract

Date: 2026-11-20. Follow-up to `04-autonomous-studio-workflow.md` and `03-production-styles-and-muse-capabilities.md`.

Every number and every message below was measured **from inside the Hermes container**, by calling the
real services. Nothing here is inferred from a config file or from memory.

## What was measured

### 1. The Hermes API server

- `http://<hermes container>:8642`, OpenAI-compatible. `GET /v1/models` lists exactly one model,
  `hermes-agent`, and that is what `hermesText()` sends.
- **Auth is case-sensitive.** `Authorization: Bearer <API_SERVER_KEY>` → 200.
  `authorization: bearer <API_SERVER_KEY>` → 401 `gateway_auth_error`. `hermes.ts` already sends the
  capital `Bearer`, so this is only a trap for anyone hand-testing.
- `GET /v1/capabilities` → 200.
- **`GET /v1/skills` → 500 on every call**, three times in a row:
  ```
  TypeError: find_all_skills() got an unexpected keyword argument 'include_editorial'
    gateway/platforms/api_server.py:2881  ->  tools/skills_tool.py:277
  ```
  The installed `find_all_skills(*, skip_disabled: bool = False)` has no `include_editorial`. This is a
  version mismatch inside the Hermes install, not a settings problem. **The skill snapshot the studio
  reads can never load until it is fixed.** Fix needs root in the Hermes container.

### 2. The image chain works

Trace of one real `VENSTUDIO_STAGE: image` turn (`agent.log`):

```
Nano Banana (nb/nanobanana-pro)                                    -> 400 Bad Request
Nano Banana (nb/nanobanana-flash)                                  -> 400 Bad Request
Nano Banana: all models failed
Cloudflare cf/@cf/black-forest-labs/flux-2-klein-4b / -9b,
          cf/@cf/leonardo/lucid-origin, cf/@cf/leonardo/phoenix-1.0 -> 429 Too Many Requests
Cloudflare .../bytedance/stable-diffusion-xl-lightning,
          .../stabilityai/stable-diffusion-xl-base-1.0,
          .../lykon/dreamshaper-8-lcm                            -> 410 Gone
tool image_generate completed (9.07s, 268 chars)
```

Nano Banana is unfunded (`400 No credentials for provider: nanobanana` when probed directly on the
gateway). Cloudflare's 10,000 neurons/day are spent (reset 00:00 UTC / 07:00 WIB; three of its models were
also deprecated on 2026-11-20). **Canva wins.** The chain falls through exactly as
`docs/research/04` describes — it is not the problem.

Direct gateway probe for reference: only `ag/gemini-3.1-flash-image` answered `200` (8.5 s, `b64_json`);
`venice/*` answers `Provider 'venice' does not support image generation`, `sensenova-intl/*` `404`,
`gemini/*` `429`.

### 3. What `image_generate` actually returns

The tool result, verbatim (268 chars):

```json
{"success": true, "image": "/opt/data/cache/generated/images/canva_20261120_060311_8cb14b95.png",
 "model": "canva-default", "prompt": "...", "aspect_ratio": "portrait", "modality": "text",
 "provider": "9router", "source": "canva"}
```

`image` is an **absolute local path**. The tool's own description says so:

> Returns the result in the `image` field — a URL or an absolute file path; reference it in your response
> using the current platform's file-delivery convention.

On a chat platform that convention is `MEDIA:` and the gateway attaches the file. **On `api_server` there
is no such convention**, so the path dies there. That is the whole bug.

### 4. The two failure modes, both reproduced

**With `04`'s prompt** ("Do not return a file path. Return an https URL ... or base64 image data") the
agent tried to move the bytes: `execute_code` was refused —

```
BLOCKED: execute_code runs arbitrary local Python ... This session runs on an unattended platform
(api_server) with no user present to approve it.
```

— it fell back to `terminal`, produced a **51,007-character** base64 tool result, then entered a
repetition loop. The turn ended `"finish_reason": "error"` with
`"hermes": {"failed": true, "error_code": "agent_error", "error": "Model output entered a repetition
loop and the stream was cut"}`. The content was a warning banner, not JSON. `extractJson` found nothing,
so the studio retried and failed.

**With a pinned instruction** ("use image_generate once; do not read the file, do not convert to base64,
do not use terminal or execute_code; reply `DONE <path>`") the same turn is clean:

```
content: DONE /opt/data/cache/generated/images/canva_20261120_060311_8cb14b95.png
hermes: None
```

**Conclusion: the loop is caused by asking the model to carry bytes.** It is not a chain problem, not a
prompt-wording problem, and not fixable by retries.

### 5. There is no file endpoint

- `GET /api/sessions/{id}/messages?inline_images=true` returned **0** `data:image` URIs — for the failed
  turn *and* for the clean turn. An `api_server` session does not attach a generated image.
- The `/v1/artifacts/upload` and `/v1/artifacts/download/{id}` routes exist in `api_server.py` but are
  browser-control artifacts, gated behind the disabled `browser_extension_control` capability. Unusable.
- `POST /api/sessions/{id}/chat` and `POST /api/sessions/{id}/chat/stream` exist for session-scoped turns,
  but they change nothing about delivery.

So **text is the only thing that reaches the studio.** The bytes must travel by another route.

### 6. Cost per image turn

~150 s wall clock and ~102,000 prompt tokens (the tool + skill catalog is re-sent every turn), against a
180 s client timeout in `hermes-json.ts`. One image per turn is expensive and close to the limit.

### 7. What the studio accepts

`apps/portal/lib/studio/image-result.ts`:

- `sourceFrom()` accepts a `url` source for any `http(s)://…` and `downloads it with `fetchMedia()` against
  the trusted origins.
- It **explicitly rejects a path**:
  `PATH_ISSUE = "The reply gave a file path, which the studio cannot read. Return an https URL or base64
  data instead."`
- `fallbackSource()` also accepts a **bare URL anywhere in the reply**, so the reply does not have to be
  strict JSON.
- `imageIssues()` requires PNG/JPEG/WebP, short side ≥ 480 px, ≤ 20 MB. **It checks no aspect ratio.**
  Canva's 1200×1200 PNG (0.2–2.4 MB) passes. So does Cloudflare's 1024×1536 portrait.

## The contract

**Hermes answers with an https URL. The studio fetches the bytes itself. Bytes never pass through the
model.**

That is one change: the reply must carry a fetchable URL instead of a local path.

### Who serves that URL

The image cache is `/opt/data/cache/generated/images/`; audio lands in `/opt/data/cache/tts/` and
`/opt/data/cache/audio/`. Serve those read-only on the Coolify network at a stable origin (for example
`hermes-files:8000`) and set it in the portal:

```
HERMES_MEDIA_ORIGINS=http://hermes-files:8000
```

`hermesTrustedOrigins()` already merges `HERMES_MEDIA_ORIGINS`, and `fetchMedia()` will then download
from it. No Hermes code changes are needed for the serving side — the files are already written there.

### The reply to ask for

```
VENSTUDIO_STAGE: image
Generate one image for shot <id> (<beat>), vertical 9:16.
Use the image_generate tool exactly once. The plugin already falls through its own providers.
The tool returns the file as an absolute path in its "image" field. Take the BASE NAME only.
Do NOT read the file, do NOT convert anything to base64, do NOT use terminal or execute_code.
Reply with the JSON below and nothing else.
Media origin: <<<DATA media origin
http://hermes-files:8000
DATA media origin>>>
Schema: {"status":"ok"|"error","provider":string,"model":string,
         "image":{"type":"url","value":string,"mimeType":string},"error":string,"tried":[{"provider":string,"error":string}]}
image.value must be <media origin>/<base name>, for example
http://hermes-files:8000/canva_20261120_060311_8cb14b95.png
provider is the backend that really made the file (source: canva / cloudflare-9router / agnes / ...).
```

Audio works the same way: the CapCut/Kokoro plugin writes an MP3/WAV under `cache/tts/`, the agent replies
with `<media origin>/<file name>`, and `parseAudioReply()` + `fetchMedia()` pick it up.

## Interface notes the executor must not get wrong

- **Never let the studio ask for base64 again.** It cannot work, and it makes Hermes loop. Remove the
  "or base64 image data" wording; the `base64` branch in `sourceFrom()` stays as a fallback for other
  callers, but the image prompt must ask for a URL.
- **The studio must pass the media origin in the prompt** (as the DATA block above). Hermes holds no
  knowledge of the studio's addressing; the origin belongs to the studio's config.
- **`source` and `provider` are different fields.** `provider` is always the plugin id `9router`;
  `source` is `canva` / `cloudflare-9router` / `agnes` / `modelscope` / `free-fallback`. Provenance must
  record `source`.
- **Do not raise the timeout past ~180 s and expect stability.** Prefer one image per turn and treat a
  turn over ~150 s as expected, not as a hang.

## Still open (Hermes side, needs root or a config change)

1. **`/v1/skills` 500** — `find_all_skills()` called with an unknown `include_editorial=` kwarg. Blocks the
   skill snapshot entirely.
2. **`image_gen.model: nb/nanobanana-pro`** points at a model the gateway cannot serve, so every image
   burns ~9 s on 9 dead models before Canva. Either fund Nano Banana on the gateway, or set
   `image_gen.model: canva` so Canva leads the chain.
3. **The `api_server` surface runs on `Genevieve`** and degenerates on multi-step tool work. Pin a
   stronger model for that surface only, via `platforms.api_server.extra.model_routes`.
4. **9:16** — Canva returns 1200×1200 through the tool. Either let the studio crop/pad, or switch the
   Canva tier to `craft_v1_2k` (native 1536×2720).
