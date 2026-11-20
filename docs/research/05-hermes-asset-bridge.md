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

## The chain, verified from the plugin source

`/opt/data/plugins/image_gen/9router/__init__.py` (a user plugin — outside packaged Hermes, so it can be
edited). `generate()` builds the order explicitly:

```python
_TAIL = ["agnes", "modelscope", "minimax", "9router"]
...
else:
    order = ["nanobanana", "cloudflare", "canva", "sensenova"] + _TAIL
```

So the default is: **Nano Banana → Cloudflare → Canva → SenseNova → Agnes → ModelScope → Minimax →
9router → free (Pollinations → Horde)**. That is the intended chain. A backend with no credential is
skipped silently, and a failing 9Router account is skipped for 30 minutes
(`_COOLDOWN_SECONDS = 1800`).

**Chain steering is not a config setting.** In `generate()`:

```python
picked = <prompt tag>  or  str(kwargs.get("model") or "")
model  = picked or _resolve_model()
```

`_resolve_model()` reads `NINEROUTER_IMAGE_MODEL` → `image_gen.9router.model` → the plugin default
(`gemini/gemini-3.1-flash-image-preview`). The config default feeds the *model id* for the generic tiers —
it does **not** reorder anything. Only an explicit picker model or a prompt tag reorders. The core image
tool exposes no `model` field, so the **prompt tag is the only lever the studio has**:

| tag on the first line | effect |
|---|---|
| *(none)* | the default order above |
| `[canva]` `[agnes]` `[modelscope]` `[sensenova]` `[cloudflare]` `[minimax]` | that backend **first**, then the rest of the chain |
| `[canva:]` `[agnes:]` `[modelscope:]` `[sensenova:]` `[cloudflare:]` `[minimax:]` | that backend **only**, no fallback |
| `[canva:batch]` `[cloudflare:batch]` … | the parallel variant (Canva ≤ 3 keys, Cloudflare ≤ 4) |

The tag is stripped from the prompt before any backend sees it.

> **Correction to the first draft of this file.** It said to set `image_gen.model: canva` so Canva leads
> the chain. That is wrong twice over. (a) The `image_gen/9router` plugin reads
> `image_gen.9router.model`, not the top-level `image_gen.model`. (b) Neither value reorders the chain —
> only a picker id or a prompt tag does. Worse, a backend name left in `...9router.model` is passed to the
> generic tiers as a model id (`_try_9router(..., model=…)`, `_try_sensenova(model=…)`) and fails there.
> **Leave the model setting alone; steer with the prompt tag if you steer at all.**

Sizes per aspect ratio (portrait), for the studio's 9:16 expectation:

- generic / 9router / SenseNova: `1024x1536`
- Agnes, free: `768x1024`
- Canva: no size parameter — template-driven, **1200x1200** in practice

All of them clear `MIN_IMAGE_SHORT_SIDE = 480`. Only Canva is not vertical.

#### Which tiers actually answer — measured 2026-11-20 06:2x UTC

Every row below was measured by calling that tier directly (or its own API), not read from config:

| # | tier | status | evidence |
|---|---|---|---|
| 1 | Nano Banana (`nb/`) | **no credentials** | `400 Bad Request` on `nb/nanobanana-pro` and `nb/nanobanana-flash` |
| 2 | Cloudflare via 9Router | **dry** | 429 on flux-2-klein-4b / -9b / lucid-origin / phoenix-1.0 (10 k neurons/day, reset 00:00 UTC); 410 Gone on bytedance/sdxl-lightning, stabilityai/sdxl-base-1.0, lykon/dreamshaper-8-lcm (deprecated 2026-11-20) |
| 3 | Canva | **alive** | 8.3 s → `canva_20261120_062133_5d167101.png`, 1200×1200 PNG |
| 4 | SenseNova GLOBAL | **up, moderation blocks** | 11 keys, endpoint answers; `400 {"error":{"message":"sensitive image","code":"18"}}` |
| 5 | Agnes | **alive** | 12.1 s → `agnes_20261120_062145_f0ba9e04.png` |
| 6 | ModelScope (Qwen-Image) | **alive** | 2 keys → `modelscope_20261120_062912_d62e9465.png`; raw API `200` |
| 7 | Minimax | **no credentials** | `400 Bad Request` on `minimax/image-01` and `minimax/image-01-turbo` |
| 8 | 9router gateway tier | **dry** | resolves to `nb/nanobanana-pro` (400); the plugin default `gemini/gemini-3.1-flash-image-preview` answers 429 |
| 9 | free (Pollinations → Horde) | **alive** | `free_flux_20261120_062804_935a8057.jpg` |

So of the six the studio expects — cloudflare, agnes, canva, qwen, minimax, sensenova — **agnes, canva and
qwen (ModelScope) answer; cloudflare is out of quota with three of its seven models already gone; minimax
and Nano Banana have no credentials on the gateway; sensenova is up but its moderation rejects the prompt.**

Two of these are decisions, not bugs: fund Nano Banana and/or Minimax on the gateway (both sit at the top of
the chain and are currently dead), and re-check Cloudflare after 00:00 UTC.

> **Second correction.** The first draft said every image "burns ~9 s on 9 dead models before Canva". The
> 9.07 s was the *whole tool call*, and 8.3 s of it was Canva's own generation. The dead tiers cost roughly
> **1–4 s** (Nano Banana fails instantly; the seven Cloudflare models fail in ~3.8 s). Canva is not being
> starved — it is simply where the chain lands. Send `[canva]` only if that ~4 s matters.

### Steering, proven by call order

Monkeypatching every `_try_*` tier and calling `provider.generate()` records which backend is attempted
first. Measured:

```
(no tag)        -> nanobanana -> cloudflare -> canva -> sensenova -> ...
[agnes]         -> agnes      -> canva      -> sensenova -> cloudflare -> ...
[canva]         -> canva      -> sensenova  -> cloudflare -> nanobanana -> ...
[modelscope]    -> modelscope -> nanobanana -> cloudflare -> canva -> ...
[canva:]        -> canva      (stop — no fallback)
```

So a tag moves one backend to the front and **leaves the whole chain behind it**. Only the `[x:]` form
disables fallback. This is what lets the skill choose per content without losing the safety net.

### Reference images / character consistency — present in the plugin, hidden from the tool

`NineRouterImageGenProvider.capabilities()` returns:

```python
{"modalities": ["text"], "max_reference_images": 0}
```

That `0` is why the core image tool describes itself as *"text-to-image only — the active model cannot edit
existing images"*. But `generate()` does implement it:

```python
_ref_arg = kwargs.get("reference_image_urls") or []
if not _refs and kwargs.get("image_url"):
    _refs = [str(kwargs["image_url"])]
if _refs and not _other_forced and _sn_parse_keys():
    image_ref, sn_used = _sn_edit(prompt, _refs, model=model, aspect=aspect)
    ...
    extra={"source": "sensenova-edit", "reference_images": len(_refs)}
```

**SenseNova U1.5 is the only editing backend in the chain** (`POST /v1/images/edits`), it accepts
`images: [{"image_url": "data:image/png;base64,..."}]`, it is rated "generate + edit with reference images,
4K, best text rendering", and there are 11 keys at 1,500 req/5 h each. Raising `max_reference_images` above
zero exposes that path through the same Hermes door.

That is the difference between a studio that makes *pictures* and one that makes *scenes with the same cast*
— i.e. the missing capability for consistent characters across shots. The plugin lives in
`/opt/data/plugins/` and is writable, so this is a one-line change once SenseNova's keys answer.

## Still open (Hermes side, needs root or a config change)

1. **`/v1/skills` 500** — `find_all_skills()` called with an unknown `include_editorial=` kwarg. Blocks the
   skill snapshot entirely.
2. **`image_gen.9router.model: nb/nanobanana-pro`** points at a model the gateway cannot serve
   (`400 No credentials for provider: nanobanana`), and Cloudflare's free neurons are spent, so every image
   burns ~9 s on 9 dead models before Canva wins. Nothing is misordered — the chain is correct, its top two
   tiers are just dry today. Either fund Nano Banana / wait for the Cloudflare reset, or send `[canva]` on
   the prompt's first line to start at Canva with the rest of the chain still behind it.
   **Do not try to fix this with a config model** — see the correction above.
3. **The `api_server` surface runs on `Genevieve`** and degenerates on multi-step tool work. Pin a
   stronger model for that surface only, via `platforms.api_server.extra.model_routes`.
4. **9:16** — Canva returns 1200×1200 through the tool. Either let the studio crop/pad, or switch the
   Canva tier to `craft_v1_2k` (native 1536×2720).
