# Handover to Kiro

Written 2026-11-20. Branch: **`feat/portal-foundation`**. Everything below is pushed; start with a pull.

## Why the work is split at all

Not by preference — by what each side can reach. The Hermes side runs in a container with the model
keys, the provider chains and the live gateway, but **no Node dependencies and no database**:

```
$ ls -d node_modules            -> TIDAK ADA
$ command -v psql pg_ctl        -> TIDAK ADA
$ node -e "import('./apps/portal/lib/server/executors/hermes-video.ts')"
  IMPORT GAGAL: Cannot find package 'server-only'
```

That is not specific to the video executor: `hermes-image.ts` fails the same way. So the Hermes side
can run only the pure modules, which is exactly why `node --test "apps/portal/lib/**/*.test.ts"`
passes there (287 tests) and why nothing under `lib/server/**` is exercised at all.

The consequence to keep in mind: **every executor in `lib/server/executors/` is unverified at
runtime by me.** The unit tests cover the pure logic they call, not the executors themselves.

## What I verified, and how

| Item | Evidence |
| --- | --- |
| Media reply parsing, image + audio + video | `node --test apps/portal/lib/studio/image-result.test.ts` |
| Video prompt contract, clip splitting | `node --test apps/portal/lib/studio/asset-plan.test.ts` |
| Whole suite | 287 tests, 0 failures |
| Agnes video API behaviour | live probes; findings in `docs/research/05-hermes-asset-bridge.md` |
| Hermes-side plugin registration | `agent.log`: `Plugin 'agnes' registered video_gen provider: agnes` |

## What only you can verify, in order

### 1. Typecheck (highest value: nothing has ever seen a typechecker)

The language server I get is stale — it reported `clipSecondsIssues`, `sniffVideo` and `videoIssues`
as missing for half an hour after the tests that import them started passing. So type errors in the
new files below would not have reached me.

```bash
pnpm install
pnpm -C apps/portal exec tsc -p tsconfig.json --noEmit
```

Files added or changed by this session, worth reading first if the check complains:

- `apps/portal/lib/server/executors/hermes-video.ts` (new, never compiled)
- `apps/portal/lib/server/endpoint-health.ts`, `env.ts`, `production.ts`
- `apps/portal/lib/server/executors/hermes-image.ts` (`recordHermesChain` now takes an `EndpointKind`)
- `apps/portal/lib/studio/{image-result,asset-plan,capabilities,endpoint-health}.ts`

### 2. Run the migration against a real database

`0012_video_assets.sql` has never executed. It widens two CHECK constraints that would otherwise
reject video rows mid-job:

- `asset_providers.kind` was `('image','tts','library')`
- `endpoint_health.kind` was `('image','tts')`

```bash
psql "$DATABASE_URL" -f apps/portal/db/migrations/0012_video_assets.sql
psql "$DATABASE_URL" -c "\d+ endpoint_health"   # CHECK must list video
psql "$DATABASE_URL" -c "\d+ asset_providers"   # CHECK must list video
```

The file drops the constraints by **definition**, not by assumed name, because a name mismatch would
have made `DROP ... IF EXISTS` match nothing while the `ADD` still ran — leaving the original narrower
CHECK in place and a migration that reports success while changing nothing. Confirm the old bounds
are actually gone, not merely that the script exited 0.

### 3. Then, and only then, the doors

Everything the video path needs on the Hermes side is configured but **not active**:

```bash
# inside the Hermes container
s6-svc -r /run/service/gateway-default
curl -sS localhost:8642/v1/toolsets -H "Authorization: Bearer $API_SERVER_KEY" | grep video_gen
```

`video_gen` reads `enabled: false` until that restart; it was `false` when the plugin was enabled,
because `platform_toolsets` is read at gateway start. The provider itself is registered already.

## Open items I could not close

1. **Agnes video end-to-end has never succeeded.** 59 submit attempts over 40 minutes answered
   `503 video_queue_full` on all 14 keys, then 13 more in a second window. Capacity, not credentials
   or payload. A text-only probe is still running.
2. **`/v1/skills` returns 500** on the Hermes side (`find_all_skills() got an unexpected keyword
   argument 'include_editorial'`). Low priority: the portal already routes around it in
   `lib/server/hermes.ts` by asking in a chat turn, and says so in its own error text.
3. **The media host is not deployed.** Without it no bytes reach the portal: Hermes can only hand
   back a name. `deploy/hermes-files.nginx.conf` now serves `/clip/` alongside `/img/`, `/tts/`,
   `/audio/`.
4. **The Muse agent-task path** (`MUSE_AGENT_TASKS=1`): worker 0.14.0 writes the per-video context into the inbox
   and the owner's Muse agent has a `venstudio-inbox` hook. Not yet run on the real VM: press **Send a test task to
   Muse** on the Workers page (`docs/muse-agent-tasks.md`).

## Still Hermes-side

`hermes/plugins/video_gen/agnes/` is versioned in this repo but must be copied into the Hermes runtime;
`hermes/README.md` has the install steps and lists the two runtime patches (`image_gen/9router`,
`tts/capcut`) that are not in this repo because they edit code that ships with Hermes.
