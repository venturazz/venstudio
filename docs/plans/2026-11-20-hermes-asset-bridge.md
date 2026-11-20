# Hermes asset bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the studio get real image and audio bytes from Hermes, so `VENSTUDIO_STAGE: image` and
`VENSTUDIO_STAGE: voice` stop failing.

**Architecture:** Hermes stays the single door for assets. It keeps deciding and generating — its chain
already falls through Nano Banana → Cloudflare → Canva and produced a file on every attempt. Only the last
mile changes: the image cache is served read-only over HTTP on the Coolify network, the agent replies with
a short URL instead of an unreadable local path, and the portal fetches the bytes itself. Bytes never pass
through the model.

**Tech Stack:** Next.js 16 + PostgreSQL portal (TypeScript, vitest), Hermes agent API server on port 8642,
Docker Compose on Coolify.

**Spec:** `docs/research/05-hermes-asset-bridge.md` — every value below comes from it. Read both.

## Global Constraints

- Portal talks to Hermes at `HERMES_BASE_URL` and authenticates with `Authorization: Bearer …`
  (capital `Bearer` — lowercase is 401).
- Hermes model name is exactly `hermes-agent`.
- Image acceptance: PNG/JPEG/WebP, short side ≥ 480 px, ≤ 20 MB (`MIN_IMAGE_SHORT_SIDE`,
  `MAX_IMAGE_BYTES`). No aspect-ratio rule. Audio: WAV/MP3/OGG, ≥ 1000 bytes, ≤ 60 MB.
- Reply schema: `{"status":"ok"|"error","provider":string,"model":string,"image"|"audio":{"type":"url"|"base64"|"data-uri","value":string,"mimeType":string},"error":string,"tried":[{provider,error}]}`.
- `provider` is always the plugin id `9router`; `source` (canva / cloudflare-9router / agnes / …) is the
  real backend and must be recorded as provenance.
- **The prompt must never ask for base64 image data again.** It makes the agent loop.
- One image per turn. A turn over ~150 s is expected; the client timeout stays at 180 s.

## Review Focus

- **The agent returns a base name that does not exist under the media root** (a hallucinated file name).
  Expected: the portal's fetch 404s and the stage fails with a readable issue, not a silent empty asset.
- **The media origin is reachable from the portal but not from the browser/Muse worker**, or vice versa.
  Expected: one origin string that works for every consumer, or an explicit second entry.
- **A turn succeeds but returns prose instead of the JSON object.** Expected: `fallbackSource()` still
  finds a bare URL in the text and the stage passes.
- **Two shots in one run race on the same file name.** Expected: names are unique per call.
- **The media root is browsable and its whole directory is exposed.** Expected: only the generated-asset
  directories are served, read-only.

---

### Task 1: Serve the Hermes asset caches over HTTP

**Files:**
- Create: `deploy/hermes-files.compose.yml` (or a Coolify service entry, per the deploy docs)
- Modify: `deploy/.env.example` (add `HERMES_MEDIA_ORIGINS`)
- Modify: `docs/deploy-coolify.md` (one section)

**Interfaces:**
- Produces: an origin reachable from the portal, e.g. `http://hermes-files:8000`. It serves exactly
  `/opt/data/cache/generated/images/`, `/opt/data/cache/tts/`, `/opt/data/cache/audio/` read-only, flat.

- [ ] **Step 1: Write the failing check**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "http://hermes-files:8000/$(ls -t <hermes-volume>/cache/generated/images | head -1)"
```
Expected now: `000` (connection refused).

- [ ] **Step 2: Add the service**

A read-only static server with the Hermes data volume mounted. Smallest correct shape — a `nginx:alpine`
with the volume mounted read-only at `/srv` and a `default.conf` that roots at `/srv/cache` and disables
directory listing. It must join the same Coolify network as the portal and Hermes.

- [ ] **Step 3: Verify**

```bash
curl -sS -o /tmp/p.png -w '%{http_code} %{size_download}\n' "http://hermes-files:8000/<the file from Step 1>"
file /tmp/p.png   # expect: PNG image data, 1200 x 1200
```
Expected: `200` and a valid PNG.

- [ ] **Step 4: Record the origin**

Add `HERMES_MEDIA_ORIGINS=http://hermes-files:8000` to `deploy/.env.example` and the Coolify env for the
portal, with one line of comment saying it must be reachable from the portal container.

- [ ] **Step 5: Commit**

```bash
git add deploy/hermes-files.compose.yml deploy/.env.example docs/deploy-coolify.md
git commit -m "feat(deploy): serve the Hermes asset caches over HTTP"
```

---

### Task 2: Ask Hermes for a URL, not a path

**Files:**
- Modify: `apps/portal/lib/server/executors/hermes-image.ts` (`imagePrompt()`)
- Modify: `apps/portal/lib/server/env.ts` (read `HERMES_MEDIA_ORIGINS` as a single required origin)
- Test: `apps/portal/lib/server/executors/hermes-image.test.ts` (create if absent)

**Interfaces:**
- Consumes: `MEDIA_ORIGIN` from Task 1.
- Produces: `imagePrompt(shot)` — same signature, new user-message text.

- [ ] **Step 1: Write the failing test**

```ts
import { imagePrompt } from "./hermes-image.ts";

test("image prompt asks for a URL under the media origin and forbids base64", () => {
  const { system, user } = imagePrompt(shot("S01", "hook"), { mediaOrigin: "http://hermes-files:8000" });
  expect(user).toContain("image_generate");
  expect(user).toContain("http://hermes-files:8000");
  expect(user).toMatch(/base name/i);
  expect(user).not.toMatch(/base64/i);
  expect(user).toMatch(/do not use terminal/i);
  expect(system).toMatch(/json/i);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- hermes-image`
Expected: FAIL — the current prompt contains "or base64 image data".

- [ ] **Step 3: Rewrite the user message**

Replace the `04` wording with the block from the spec: `image_generate` exactly once; the
`image` field is an absolute path; take the base name only; do not read, do not base64, do not use
terminal or execute_code; the media origin is `env.mediaOrigin`; the schema is the one in Global
Constraints with `"type":"url"`.

- [ ] **Step 4: Run it**

Run: `npm test -- hermes-image`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/lib/server/executors/hermes-image.ts apps/portal/lib/server/env.ts apps/portal/lib/server/executors/hermes-image.test.ts
git commit -m "feat(studio): ask Hermes for a media URL instead of base64"
```

---

### Task 3: Record `source` as provenance

**Files:**
- Modify: `apps/portal/lib/studio/image-result.ts` (`MediaReply.ok` gains `source`)
- Modify: `apps/portal/lib/server/executors/hermes-image.ts` (persist it)
- Test: `apps/portal/lib/studio/image-result.test.ts`

**Interfaces:**
- Consumes: `imagePrompt()` from Task 2.
- Produces: `MediaReply` ok-branch `{ ok: true; source: MediaSource; provider: string; model: string; backend: string }`.

- [ ] **Step 1: Write the failing test**

```ts
test("keeps the real backend apart from the plugin id", () => {
  const r = parseImageReply('{"status":"ok","provider":"9router","source":"canva","model":"canva-default","image":{"type":"url","value":"http://hermes-files:8000/a.png","mimeType":"image/png"}}');
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.provider).toBe("9router"); expect(r.backend).toBe("canva"); }
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- image-result`
Expected: FAIL — `backend` is undefined.

- [ ] **Step 3: Implement**

Read `parsed.source` in `parseMediaReply` alongside `parsed.provider` and return it as `backend`
(empty string when absent).

- [ ] **Step 4: Run it**

Run: `npm test -- image-result`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/lib/studio/image-result.ts apps/portal/lib/studio/image-result.test.ts apps/portal/lib/server/executors/hermes-image.ts
git commit -m "feat(studio): record the real image backend as provenance"
```

---

### Task 4: Audio through the same origin

**Files:**
- Modify: `apps/portal/lib/server/tts.ts`
- Test: `apps/portal/lib/studio/image-result.test.ts`

**Interfaces:**
- Consumes: the origin from Task 1, the prompt shape from Task 2.
- Produces: `audioPrompt()` asking for `{"status":"ok","audio":{"type":"url","value":"<origin>/<file name>"}}`.

- [ ] **Step 1: Write the failing test**

```ts
test("audio prompt asks for a URL under the media origin", () => {
  const { user } = audioPrompt("line one", { mediaOrigin: "http://hermes-files:8000" });
  expect(user).toContain("http://hermes-files:8000");
  expect(user).not.toMatch(/base64/i);
});
```

- [ ] **Step 2: Run it** — `npm test -- tts` → FAIL.

- [ ] **Step 3: Implement** — mirror Task 2 for the audio stage; the plugin writes WAV/MP3 under
  `cache/tts/`, so the reply is `<origin>/<file name>`.

- [ ] **Step 4: Run it** — `npm test -- tts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/lib/server/tts.ts apps/portal/lib/studio/image-result.test.ts
git commit -m "feat(studio): fetch narration audio through the Hermes media origin"
```

---

### Task 5: Make the skill snapshot work again (Hermes side)

**Files:**
- Modify: `/opt/hermes/gateway/platforms/api_server.py:2881` — remove the `include_editorial=True` kwarg
  from the `find_all_skills(...)` call.

This file is root-owned outside the agent's write-safe root. It ships as a **guarded paste block** run as
root in the Hermes container (see `docs/research/05`, "Still open" #1), asserting `count(old) == 1` before
replacing, followed by an s6 restart.

- [ ] **Step 1: Write the failing check** — the task is blocked until this passes.

```bash
curl -sS -H "Authorization: Bearer $API_SERVER_KEY" http://<hermes>:8642/v1/skills | head -c 120
```
Expected now: `500 {"error": {"message": "Failed to enumerate skills"…`.

- [ ] **Step 2: Apply the guarded patch as root, then restart**

```bash
s6-svc -r /run/service/gateway-default
```

- [ ] **Step 3: Verify**

```bash
curl -sS -H "Authorization: Bearer $API_SERVER_KEY" http://<hermes>:8642/v1/skills | head -c 200
```
Expected: `200 {"object": "list", "data": [{"name": …`.

- [ ] **Step 4: Turn the capability scan back on** in settings and confirm the snapshot is non-empty.

---

### Task 6: Take the dead providers out of the hot path (Hermes side)

**Files:** none — the studio's prompt only. No config change (see `docs/research/05`, correction).

- [ ] **Step 1: Measure the baseline.** One image turn logs 2 × Nano Banana `400` and 7 × Cloudflare
  `429`/`410` before Canva wins, ~9 s (`docs/research/05`, §2). The chain's *order* is correct.

- [ ] **Step 2: Start the prompt with a tag instead of editing config.** Prepending `[canva]` to the first
  line moves Canva first and leaves the rest of the chain behind it; `[canva:]` would disable fallback and
  must not be used. There is no config key that reorders the chain.

- [ ] **Step 3: Pin the API-server surface to a stronger model**

Set `platforms.api_server.extra.model_routes` so `hermes-agent` resolves to a strong model for this surface
only (the `api_server` turn currently runs `Genevieve` and degenerated on a 5-tool turn). Leave the
Telegram surface untouched, and leave `image_gen.9router.model` alone.

- [ ] **Step 4: Confirm** — one image turn returns clean JSON, `hermes` is `null`, no `agent_error`, and
  the wall clock is comfortably under 180 s.
