# Worker updates: signed and automatic, with a manual fallback

Phase 0 of `docs/plans/style-system.md`. From worker **0.8.0** on, workers update themselves from the portal. The
old manual procedure (fetch `install.sh`, compare its sha256, ask the Muse agent to run it) stays as the fallback.

## Ringkasan (Bahasa Indonesia)

- Mulai worker 0.8.0, worker meng-update dirinya sendiri dari portal, **hanya** file yang ditandatangani kunci
  portal (Ed25519) dan cocok sha256-nya. Update dipasang di antara job, tidak pernah di tengah job; versi lama
  disimpan; kalau versi baru gagal self-test atau gagal start dua kali, worker kembali ke versi lama dan melapor.
- Owner memilih mode di **Workers → Worker updates**: Automatic (bawaan), Approve each update, atau Off.
- Yang perlu owner lakukan: **sekali saja** kirim pesan "Manual update" (ada di kartu worker di halaman
  Workers, beserta sha256 install.sh) ke akun Muse. Setelah itu tidak perlu apa-apa lagi; agen Muse tidak perlu
  menjalankan installer lagi.

## What the owner does

**Once per Muse worker** (workers older than 0.8.0, or any worker the page marks "Automatic updates are not on for
this worker yet"):

1. Open **Workers**. On the worker's card, open **Manual update (fallback)** and press **Copy message**.
2. Send it to that Muse account as your own message (app or WhatsApp). The message looks like this, with your portal
   address and the current sha256 filled in:

   ```text
   I'm updating the render worker for my own video production portal (https://studio.example.com) on this VM. It is
   already installed in /home/hatch/venstudio; this keeps its enrollment and replaces the worker program. Please run
   these commands and show me the output:

   cd /home/hatch/venstudio
   curl -fsSL https://studio.example.com/install/install.sh -o install.sh
   sha256sum install.sh
   bash install.sh --portal https://studio.example.com --mode hold

   The sha256 should be <64 hex characters shown on the Workers page>. If it's different, stop and tell me and run
   nothing.

   This is the last time I'll ask you to run an installer for it. The script pins my portal's update signing key in
   /home/hatch/venstudio/config.json. From now on the worker updates itself between jobs: it installs only files
   signed by that key, checks each file's sha256 before using it, tests the new version before switching, and
   switches back by itself if the new version fails. Nothing new needs your approval; the hourly "VenStudio worker"
   scheduled task stays as it is.

   When done, show me the last 5 lines of /home/hatch/venstudio/logs/worker.log.
   ```

   Workers that render with Remotion get `--with-remotion` on the `bash install.sh` line, and a note that it takes a
   few minutes.
3. **The hash check**: the agent runs `sha256sum install.sh` and compares it with the value in the message. The
   same value is printed under the message on the Workers page. If they differ, the agent stops; nothing runs.
   You can also check it yourself: `curl -fsSL <portal>/install/install.sh | sha256sum`.
4. The log ends with `update key <id> pinned` and `install complete`. The worker card shows the key id it trusts
   after its next run.

**After that: nothing.** New releases install themselves (Automatic mode), or wait for your **Approve** (Approve
each update mode).

### Why the Muse agent no longer needs to run installers

The Muse agent refused, rightly, to run installers it could not check. The one-time run above is the last one,
and it is checkable: the agent compares the script's sha256 with the value you sent in your own message. That
script contains the portal's public key and stores it on the VM. From then on the **worker process itself** does
the checking for every update: it verifies the Ed25519 signature against the pinned key and every file's sha256
before it runs anything, and it refuses anything that fails. The agent's only remaining job is the hourly scheduled
task it already runs (`run.sh hold`).

## The owner's controls (Workers page, owner only)

| Control | What it does |
| --- | --- |
| **Update mode: Automatic** (default) | Each worker installs a new release at its next check (every 10 minutes while idle, and when a run starts), between jobs. |
| **Update mode: Approve each update** | Each worker card shows "Update to v… available: waiting for your approval" with **Approve v…**; the card on the right has **Approve all (n)**. Nothing installs before that. An approval is for that exact release (version plus file hashes), including its Remotion templates; a newer release needs a new approval. |
| **Update mode: Off (manual only)** | Nothing installs by itself; cards still show what is available. Use the manual update. |
| **Allow a downgrade → Pin v…** | Workers refuse any version older than their own. Pinning the version this portal offers lets them install it anyway (for example after rolling the portal back). Remove the pin afterwards. |

Per worker the card shows the running version, the offered version, the last result (**Updated to v…**,
**Refused v…: reason**, **Rolled back from v…: reason**, **Update to v… failed: reason**) with its time, and the
**Manual update (fallback)** section when the worker is behind, has not pinned the key, or the last update was
refused or rolled back. Only the update mode, approvals and the pin are owner actions (`requireUser("owner")`,
audited). Updates never change a channel's category, worker mapping or autonomy.

## How it works

1. **Signing key.** The portal makes an Ed25519 key pair on first use and stores it in Postgres
   (`update_signing_keys`, migration 0014). The private key is encrypted with the existing `ENCRYPTION_KEY`
   (AES-256-GCM, AAD `update-signing-key:<key id>`), the same way TOTP secrets are. No new environment variable.
2. **Pinning.** `install.sh` is served with the public key filled in, and stores it in `config.json`
   (`updateKey`, file mode 600) through `venstudio-worker.ts pin-key`. Because the key is inside `install.sh`, the
   owner's sha256 check of `install.sh` covers the key too (trust on first use, but the first use is checked).
   Running `install.sh` again (no `--code`) keeps the enrollment and pins the key if missing.
3. **Update check.** Between jobs (at the start of each run, then every 10 minutes), the worker posts its version and
   the SHA-256 of its worker file and of the Remotion bundle it unpacked (or null without a Remotion project) to
   `POST /api/worker/update`, with its worker token. The portal records what it would offer and, if the mode allows,
   returns a **manifest**: `{format, keyId, workerId, version, pin, release, issuedAt, expiresAt, files:[{name,
   sha256, bytes}], signature}` for `venstudio-worker.ts`, `render-remotion.json` and (worker 0.9.0+)
   `style-packs.json`, the same files served at `/install/`. The style packs index is listed only for a worker that
   reports it (as its hash, or null when none is installed), so a 0.8.0 worker keeps getting the two files it accepts;
   once the worker file is current, a changed index is installed to `<home>/styles/` without a worker version bump
   (docs/style-packs.md). The signature is Ed25519 over `"venstudio-update-manifest-v1\n"` plus the canonical JSON of the
   manifest without `signature` (keys sorted, no whitespace).
4. **Verification on the worker** (`checkManifest`, `planUpdate`; `node:crypto` only), in this order: shape; key id is
   the pinned key's; signature; `workerId` is this worker; lifetime at most an hour and not expired (the portal
   signs for 10 minutes; 5 minutes of clock difference tolerated); not issued in the future; `issuedAt` newer than
   the last accepted manifest (no replay); version newer than its own, or exactly the owner's pinned version
   (`pin: true`). Same version with different content is refused too.
5. **Download and stage.** Each file is downloaded from `/install/` (no token sent), capped at the signed size, and
   its size and SHA-256 compared with the manifest before it is written to `<home>/app/next/`.
6. **Self-test.** `node app/next/venstudio-worker.ts selftest` loads the new file, checks the portal's health and the
   worker token (`GET /api/worker/update`), checks the key id, detects capabilities, claims nothing, and prints one
   JSON line. It must report the manifest's version.
7. **Swap, between jobs.** The current file is copied to `<home>/app/prev/`, the start counter
   `<home>/app/update-pending` is armed, and the new file is renamed into place. The old process then starts the new
   version with the same command and the rest of its time budget, and waits for it.
8. **Confirm or roll back.** The new version's first successful claim confirms it (counter removed, `ok` reported).
   If it exits with an error before that, it is started once more; after the second failure the previous file is put
   back and the old process carries on. `run.sh` applies the same rule when there is no old process left (VM restart,
   killed process). The restored version reports **rolled_back** with the reason and never retries that release.
   The new version runs in its own process group and the old process passes stop signals on, so a scheduler's stop
   reaches it once and it stops after its job. In daemon mode the old process stays as its parent (about 40 MB)
   until the daemon is restarted; hold mode starts fresh every hour.
9. **Remotion templates.** When only the bundle changed and the worker has a Remotion project in
   `<home>/remotion`, the worker builds the new project next to it (`remotion.next`: unchanged dependencies hard-linked,
   changed ones installed fresh), runs the full probe there in the background, and swaps it in between jobs only after
   the probe passed. Until then `remotion-2d` is reported from the old project. A project set with
   `VENSTUDIO_REMOTION_DIR` is never touched. A build still running when a hold-mode hour ends is stopped and starts
   again on the next run; in tick mode the run waits for it.

Every result goes to `POST /api/worker/update/report` and the audit log (`worker.update.ok`, `.refused`,
`.rolled_back`, `.failed`).

## Security reasoning

- **What a stolen database or a man in the middle cannot do.** The worker only runs files whose hashes are in a
  manifest signed by the pinned key. Tampering in transit changes the hash (refused), changing the manifest breaks
  the signature (refused), and an old manifest replayed later is expired or older than the last one (refused). A
  manifest fetched by one worker is refused by every other (`workerId`).
- **What the key protects.** The private key never leaves the portal and is encrypted at rest with
  `ENCRYPTION_KEY`. Someone with the database but not `ENCRYPTION_KEY` cannot sign. Someone who controls the portal
  process can sign, but could equally change `install.sh` today; the update channel does not widen that.
- **Downgrades** are refused by the worker, not only by the portal, so a replayed or mistaken older release cannot
  bring back a fixed bug. Only the owner's explicit pin of one exact version allows it.
- **Nothing that failed verification runs**: verification happens before the file is written to `next/`, and the
  self-test runs only a verified file.
- **No job is interrupted**: checks and swaps happen only between jobs in the worker's single job loop.
- **Rotation**: if `ENCRYPTION_KEY` changes, the key cannot be decrypted; updates stop with a clear error on the
  Workers page and workers keep running. If the key cannot be read at all, `install.sh` is still served, with an
  empty key, and the install says automatic updates stay off. Replacing the key means every worker runs the manual update once to pin the
  new one (the Workers page names workers that trust another key).

## Turning it off on one machine

Set `VENSTUDIO_AUTO_UPDATE=0` in that worker's environment (for example in `run.sh`), or set the mode to Off. A
worker run from anywhere other than `<home>/app/venstudio-worker.ts` (a repository checkout, tests) never updates
itself.

## Worker 0.10.0

0.10.0 (renderer plugins and html-capture, `docs/html-capture.md`) is delivered by this mechanism like any release:
workers on 0.8.0 or later update themselves (versions compare numerically, so 0.10.0 is newer than 0.9.0). The
html-capture packs ride in the signed `render-remotion.json`; no new file is added to the manifest.

## Worker 0.12.0

0.12.0 (environments and engine command, `docs/style-packs.md` "Environments") is delivered by this mechanism like any
release. It adds a fourth manifest file, `env-packs.json`: the packs with an environment and their files. The portal
lists it only for a worker that reports it in its update check (0.12.0 reports it, as null before the first install),
because 0.11.0 refuses a manifest that names a file it does not know. Like the packs index it is data, installed
whenever it differs once no worker file is about to replace the running one, and a bundle that does not parse is
remembered and not tried again. Nothing in it runs on arrival; environments install later, between jobs, and are
reported only after their probe. `install.sh` does not fetch it: a new worker gets it with its first signed update
check, so a worker with automatic updates off has no environments.

## Worker 0.13.0

0.13.0 (render-video engine `hermes-mux`: the run's narration laid on a picture Hermes rendered, `docs/style-packs.md`
"The run's narration on Hermes's picture") is delivered by this mechanism like any release; no manifest file is added.
It reports the `hermes-mux` capability only where its ffmpeg has the audio-mix chain and `tpad`, and the portal queues
hermes-mux jobs under that capability alone, so an older worker never claims one. Until a worker has updated, a hermes
render of a run with its own narration stops before Hermes is asked, with a stage error that says to update the worker.

## Tests

- `apps/portal/lib/update-manifest.test.ts`: canonical JSON, signing and verification, expiry, pin, key encryption,
  offer decisions for Automatic / Approve / Off.
- `apps/worker/self-update.test.ts`: the worker's canonical JSON and key id match the portal's; `checkManifest`
  (bad signature, other key, other worker, expired, future, replay, malformed); `planUpdate` (downgrade, pin, same
  version, failed releases, bundles); staging, swap, start-failure counting and rollback; the Remotion staging.
- `apps/worker/self-update-flow.test.ts`: the real worker process against a small signing fake portal: install,
  tampering, bad signature, expiry, downgrade and pin, self-test failure, start failure rollback.
- `scripts/e2e.sh` (CI, real portal and Postgres): migration 0014, the key in `install.sh` and `config.json`, a
  0.7.99 worker updating itself, Approve and Off modes, tampering / bad signature / expiry through
  `scripts/e2e-update-proxy.mjs`, downgrade and pin, both rollbacks, and `run.sh`'s rollback after a crash.
- `scripts/ui-e2e.mjs` (CI): the owner switches the update mode on the Workers page.
- `scripts/e2e.sh` (CI): `env-packs.json` reaches a worker through the signed update, its environment installs from
  the recipe, and the worker reports `env:` and `pack:` for the proof pack only after the probe.
