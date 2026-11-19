#!/usr/bin/env bash
# End-to-end check: real portal + Postgres + the real worker installer, on one machine.
# Needs: a built portal (npm run build), DATABASE_URL pointing at an empty database, psql, ffmpeg, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3100}"
export APP_URL="http://localhost:$PORT"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -base64 32)}"
export SETUP_TOKEN="e2e-setup-token"
export ARTIFACT_DIR="$ROOT/.e2e/artifacts"
export WORKER_DIR="$ROOT/apps/worker"
WORK="$ROOT/.e2e"
rm -rf "$WORK" && mkdir -p "$WORK"

fail() { echo "E2E FAIL: $*" >&2; [ -f "$WORK/portal.log" ] && tail -n 80 "$WORK/portal.log" >&2; exit 1; }
q() { psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

echo "== migrate"
node "$ROOT/apps/portal/scripts/migrate.mjs"
node "$ROOT/apps/portal/scripts/migrate.mjs" | grep -q "up to date" || fail "second migrate run not idempotent"

echo "== start portal"
(cd "$ROOT/apps/portal" && PORT=$PORT npx next start -p "$PORT" > "$WORK/portal.log" 2>&1) &
PORTAL_PID=$!
trap 'kill $PORTAL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -fsS "$APP_URL/api/health" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && fail "portal did not become healthy"
done

echo "== pages and security headers"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/setup")" = "200" ] || fail "/setup not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/")" = "307" ] || fail "/ should redirect to /login when signed out"
curl -sI "$APP_URL/setup" | grep -qi "content-security-policy" || fail "CSP header missing"
curl -sI "$APP_URL/setup" | grep -qi "x-frame-options: DENY" || fail "X-Frame-Options missing"
curl -fsS "$APP_URL/install/SETUP.md" | grep -q "$APP_URL/install/install.sh" || fail "SETUP.md not templated"
curl -fsS "$APP_URL/install/AGENT_DEPLOY.md" | grep -q "VenStudio worker setup" || fail "old setup link broken"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/install/../../etc/passwd")" != "200" ] || fail "install path traversal"

echo "== worker API rejects bad tokens and codes"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/api/worker/claim" -H 'authorization: Bearer nope-nope-nope-nope-nope' -d '{}')" = "401" ] || fail "claim without valid token not 401"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/api/worker/enroll" -H 'content-type: application/json' \
  -d '{"code":"VS-AAAA-BBBB-CCCC","name":"x","capabilities":[],"version":"0"}')" = "403" ] || fail "bad enrollment code not 403"

echo "== create owner, channel, enrollment code (SQL, as the UI would)"
OWNER=$(q "INSERT INTO users (email, name, role, password_hash) VALUES ('owner@e2e.test','Owner','owner','scrypt\$1\$1\$1\$x\$x') RETURNING id")
CHANNEL=$(q "INSERT INTO channels (name, niche, format) VALUES ('E2E Channel','testing','other') RETURNING id")
CODE="VS-E2E2-TEST-CODE"
q "INSERT INTO enrollment_codes (code_hash, label, host, channel_id, created_by, expires_at)
   VALUES (encode(sha256('$CODE'::bytea),'hex'), 'E2E worker', 'local', '$CHANNEL', '$OWNER', now() + interval '30 minutes')" >/dev/null

echo "== install + enroll worker via install.sh"
curl -fsSL "$APP_URL/install/install.sh" | bash -s -- --portal "$APP_URL" --code "$CODE" --name "E2E worker" --mode tick --home "$WORK/worker"
[ -f "$WORK/worker/config.json" ] || fail "worker config not written"
[ "$(stat -c '%a' "$WORK/worker/config.json")" = "600" ] || fail "config.json not chmod 600"
WORKER=$(q "SELECT id FROM workers WHERE name = 'E2E worker'")
[ -n "$WORKER" ] || fail "worker not registered"
[ "$(q "SELECT home_worker_id FROM channels WHERE id = '$CHANNEL'")" = "$WORKER" ] || fail "home worker not linked"
# Code is single-use.
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/api/worker/enroll" -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"again\",\"capabilities\":[],\"version\":\"0\"}")" = "403" ] || fail "enrollment code reused"

echo "== queue jobs and run one tick"
ECHO_JOB=$(q "INSERT INTO jobs (type, capability, payload, channel_id, preferred_worker_id) VALUES ('echo','echo','{\"e2e\":true}', '$CHANNEL', '$WORKER') RETURNING id")
SMOKE_JOB=$(q "INSERT INTO jobs (type, capability, payload) VALUES ('smoke-test','ffmpeg','{\"seconds\":3,\"width\":540,\"height\":960,\"fps\":30}') RETURNING id")
"$WORK/worker/run.sh" tick || { cat "$WORK/worker/logs/worker.log"; fail "tick exited non-zero"; }
cat "$WORK/worker/logs/worker.log"

[ "$(q "SELECT status FROM jobs WHERE id = '$ECHO_JOB'")" = "succeeded" ] || fail "echo job not succeeded"
[ "$(q "SELECT status FROM jobs WHERE id = '$SMOKE_JOB'")" = "succeeded" ] || fail "smoke-test job not succeeded: $(q "SELECT error FROM jobs WHERE id = '$SMOKE_JOB'")"
BYTES=$(q "SELECT bytes FROM artifacts WHERE job_id = '$SMOKE_JOB' AND name = 'smoke-test.mp4'")
[ "${BYTES:-0}" -gt 1000 ] || fail "smoke-test artifact missing"
FILE=$(q "SELECT storage_path FROM artifacts WHERE job_id = '$SMOKE_JOB'")
ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$FILE" | grep -q "540,960" || fail "artifact is not a 540x960 video"
q "SELECT result FROM jobs WHERE id = '$SMOKE_JOB'"
[ "$(q "SELECT jsonb_typeof(result) FROM jobs WHERE id = '$SMOKE_JOB'")" = "object" ] || fail "job result stored as $(q "SELECT jsonb_typeof(result) FROM jobs WHERE id = '$SMOKE_JOB'"), not object"
[ "$(q "SELECT result->>'resolution' FROM jobs WHERE id = '$SMOKE_JOB'")" = "540x960" ] || fail "result fields missing"

echo "== migration 0007 created the template and pipeline tables"
for T in templates template_versions template_trials pipeline_runs pipeline_stages work_orders qc_reports; do
  [ "$(q "SELECT to_regclass('public.$T') IS NOT NULL")" = "t" ] || fail "table $T missing after migration 0007"
done
[ "$(q "SELECT count(*) FROM templates")" = "0" ] || fail "templates should be empty until the Templates page seeds them"
[ "$(q "SELECT autonomy_level FROM channels WHERE id = '$CHANNEL'")" = "1" ] || fail "channel autonomy default is not 1"

echo "== migration 0008 created the director tables and columns"
[ "$(q "SELECT to_regclass('public.review_items') IS NOT NULL")" = "t" ] || fail "table review_items missing after migration 0008"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name = 'channels' AND column_name = 'plan'")" = "1" ] || fail "channels.plan missing after migration 0008"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name = 'pipeline_runs' AND column_name = 'config'")" = "1" ] || fail "pipeline_runs.config missing after migration 0008"
[ "$(q "SELECT count(*) FROM review_items")" = "0" ] || fail "review_items should start empty"

echo "== qc-video measures the smoke-test video"
QC_SHA=$(q "SELECT sha256 FROM artifacts WHERE job_id = '$SMOKE_JOB'")
QC_ASSET=$(q "INSERT INTO assets (title, kind, source, license, storage_path, bytes, sha256, content_type)
  VALUES ('E2E smoke clip','video','worker','self-generated','$FILE',$BYTES,'$QC_SHA','video/mp4') RETURNING id")
QC_PROD=$(q "INSERT INTO productions (title, channel_id, format, style_id) VALUES ('E2E QC production','$CHANNEL','short','explainer-flat-vector') RETURNING id")
QC_JOB=$(q "INSERT INTO jobs (type, capability, payload) VALUES ('qc-video','ffmpeg','{\"inputs\":[\"$QC_ASSET\"],\"productionId\":\"$QC_PROD\"}') RETURNING id")
"$WORK/worker/run.sh" tick || { cat "$WORK/worker/logs/worker.log"; fail "qc tick exited non-zero"; }
[ "$(q "SELECT status FROM jobs WHERE id = '$QC_JOB'")" = "succeeded" ] || fail "qc-video job not succeeded: $(q "SELECT error FROM jobs WHERE id = '$QC_JOB'")"
[ "$(q "SELECT result->>'width' FROM jobs WHERE id = '$QC_JOB'")" = "540" ] || fail "qc-video width is not 540"
[ "$(q "SELECT result ? 'hasAudio' FROM jobs WHERE id = '$QC_JOB'")" = "t" ] || fail "qc-video result has no hasAudio"
[ "$(q "SELECT result->>'integratedLufs' IS NOT NULL FROM jobs WHERE id = '$QC_JOB'")" = "t" ] || fail "qc-video integratedLufs is null"
[ "$(q "SELECT jsonb_typeof(result->'truePeakDb') FROM jobs WHERE id = '$QC_JOB'")" = "number" ] || fail "qc-video truePeakDb is not a number"
# The portal hook ran the technical gate on Postgres: one report, stored with the measure. The 540x960 3 s smoke clip
# is not a valid short, so the gate must fail on resolution and duration.
[ "$(q "SELECT count(*) FROM qc_reports WHERE job_id = '$QC_JOB' AND production_id = '$QC_PROD' AND gate = 'G-technical'")" = "1" ] || fail "G-technical report not stored for the production"
[ "$(q "SELECT passed FROM qc_reports WHERE job_id = '$QC_JOB'")" = "f" ] || fail "540x960 smoke clip should fail the short G-technical gate"
[ "$(q "SELECT jsonb_typeof(details->'measure'->'truePeakDb') FROM qc_reports WHERE job_id = '$QC_JOB'")" = "number" ] || fail "stored measure truePeakDb is not a number"
[ "$(q "SELECT count(*) FROM qc_reports WHERE job_id = '$QC_JOB' AND details->'issues'->>0 LIKE 'Resolution is 540x960%'")" = "1" ] || fail "stored issues do not name the resolution"
[ "$(q "SELECT count(*) FROM artifacts WHERE job_id = '$QC_JOB' AND name = 'qc.json'")" = "1" ] || fail "qc.json artifact missing"

echo "== migration 0009 created the production tables"
[ "$(q "SELECT to_regclass('public.asset_providers') IS NOT NULL")" = "t" ] || fail "table asset_providers missing after migration 0009"
[ "$(q "SELECT count(*) FROM asset_providers WHERE commercial_ok <> 'unknown'")" = "0" ] || fail "no provider may be cleared for commercial use by default"

echo "== migration 0010 created the capability scan table"
[ "$(q "SELECT to_regclass('public.capability_scans') IS NOT NULL")" = "t" ] || fail "table capability_scans missing after migration 0010"

echo "== render-video renders generated stills and a WAV, then qc-video measures the result"
STILLS="$WORK/stills"
mkdir -p "$STILLS"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x224466:s=540x960:d=1" -frames:v 1 "$STILLS/a.png"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=0x664422:s=540x960:d=1" -frames:v 1 "$STILLS/b.png"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=330:duration=4:sample_rate=24000" -ac 1 -c:a pcm_s16le "$STILLS/voice.wav"
asset_row() { # title kind file content-type
  # Files must live where the portal stores assets (<ARTIFACT_DIR>/assets/<id>/<name>), or openStored rejects them.
  local id dest sha bytes
  id=$(q "SELECT gen_random_uuid()")
  dest="$ARTIFACT_DIR/assets/$id/$(basename "$3")"
  mkdir -p "$(dirname "$dest")" && mv "$3" "$dest"
  sha=$(sha256sum "$dest" | cut -d' ' -f1); bytes=$(stat -c '%s' "$dest")
  q "INSERT INTO assets (id, title, kind, source, license, storage_path, bytes, sha256, content_type)
     VALUES ('$id','$1','$2','generated','Generated by scripts/e2e.sh for a render test','$dest',$bytes,'$sha','$4') RETURNING id"
}
IMG_A=$(asset_row "E2E still A" image "$STILLS/a.png" image/png)
IMG_B=$(asset_row "E2E still B" image "$STILLS/b.png" image/png)
VOICE=$(asset_row "E2E narration" audio "$STILLS/voice.wav" audio/wav)
RENDER_JOB=$(q "INSERT INTO jobs (type, capability, payload, channel_id) VALUES ('render-video','ffmpeg',
  '{\"inputs\":[\"$IMG_A\",\"$IMG_B\",\"$VOICE\"],\"format\":\"short\",\"width\":540,\"height\":960,\"fps\":30,
    \"shots\":[{\"shotRef\":\"s1\",\"assetId\":\"$IMG_A\",\"seconds\":2,\"motion\":\"zoom-in\"},{\"shotRef\":\"s2\",\"assetId\":\"$IMG_B\",\"seconds\":2,\"motion\":\"zoom-out\"}],
    \"narrationAssetId\":\"$VOICE\",\"narrationSec\":4,\"targetLufs\":-16,\"captions\":[{\"start\":0,\"end\":2,\"text\":\"First shot\"}]}', '$CHANNEL') RETURNING id")
"$WORK/worker/run.sh" tick || { cat "$WORK/worker/logs/worker.log"; fail "render tick exited non-zero"; }
[ "$(q "SELECT status FROM jobs WHERE id = '$RENDER_JOB'")" = "succeeded" ] || fail "render-video job not succeeded: $(q "SELECT error FROM jobs WHERE id = '$RENDER_JOB'")"
RENDER_FILE=$(q "SELECT storage_path FROM artifacts WHERE job_id = '$RENDER_JOB' AND name = 'video.mp4'")
[ -n "$RENDER_FILE" ] && [ -s "$RENDER_FILE" ] || fail "render-video artifact video.mp4 missing"
ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$RENDER_FILE" | grep -q "540,960" || fail "rendered video is not 540x960"
RENDER_SEC=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RENDER_FILE")
awk -v d="$RENDER_SEC" 'BEGIN { exit !(d > 3.5 && d < 4.6) }' || fail "rendered video is $RENDER_SEC s, expected about 4"
[ "$(q "SELECT result->>'narrationSec' IS NOT NULL FROM jobs WHERE id = '$RENDER_JOB'")" = "t" ] || fail "render result has no narrationSec"
R_BYTES=$(stat -c '%s' "$RENDER_FILE"); R_SHA=$(sha256sum "$RENDER_FILE" | cut -d' ' -f1)
R_ASSET=$(q "INSERT INTO assets (title, kind, source, license, storage_path, bytes, sha256, content_type)
  VALUES ('E2E rendered video','video','worker','self-generated from E2E stills','$RENDER_FILE',$R_BYTES,'$R_SHA','video/mp4') RETURNING id")
RQC_JOB=$(q "INSERT INTO jobs (type, capability, payload) VALUES ('qc-video','ffmpeg','{\"inputs\":[\"$R_ASSET\"]}') RETURNING id")
"$WORK/worker/run.sh" tick || { cat "$WORK/worker/logs/worker.log"; fail "render qc tick exited non-zero"; }
[ "$(q "SELECT status FROM jobs WHERE id = '$RQC_JOB'")" = "succeeded" ] || fail "qc-video on the render not succeeded: $(q "SELECT error FROM jobs WHERE id = '$RQC_JOB'")"
[ "$(q "SELECT result->>'width' FROM jobs WHERE id = '$RQC_JOB'")" = "540" ] || fail "qc-video on the render returned no width"
[ "$(q "SELECT result ? 'hasAudio' FROM jobs WHERE id = '$RQC_JOB'")" = "t" ] || fail "qc-video on the render has no hasAudio"
node "$ROOT/apps/portal/scripts/migrate.mjs" | grep -q "up to date" || fail "migrate not idempotent after the render steps"

echo "== artifacts require a signed-in user"
ART=$(q "SELECT id FROM artifacts WHERE job_id = '$SMOKE_JOB'")
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/artifacts/$ART")" = "401" ] || fail "artifact readable without session"

echo "== a failed qc-video job gets a failed report on the next completion (reconcile)"
FQC_JOB=$(q "INSERT INTO jobs (type, capability, status, error, finished_at, payload)
  VALUES ('qc-video','ffmpeg','failed','ffmpeg exploded', now(), '{\"inputs\":[\"$QC_ASSET\"],\"productionId\":\"$QC_PROD\"}') RETURNING id")

echo "== lease expiry requeues a job"
LEASE_JOB=$(q "INSERT INTO jobs (type, capability, status, worker_id, attempts, lease_expires_at)
  VALUES ('echo','echo','running','$WORKER',1, now() - interval '1 minute') RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$LEASE_JOB'")" = "succeeded" ] || fail "expired lease job not requeued and finished"
[ "$(q "SELECT passed FROM qc_reports WHERE job_id = '$FQC_JOB' AND gate = 'G-technical'")" = "f" ] || fail "failed qc-video job left no failed G-technical report"

echo "== hold mode: long-poll picks up a new job within seconds"
"$WORK/worker/run.sh" hold --max-minutes 0.4 &
HOLD_PID=$!
sleep 5
# A second scheduled run while the first is still holding must exit cleanly.
"$WORK/worker/run.sh" hold || fail "overlapping hold run exited non-zero"
tail -n 3 "$WORK/worker/logs/worker.log" | grep -q "already running" || fail "overlapping run not reported as already running"
[ "$(q "SELECT mode FROM workers WHERE id = '$WORKER'")" = "hold" ] || fail "worker mode not recorded as hold"
QUEUED_AT=$(date +%s%N)
HOLD_JOB=$(q "INSERT INTO jobs (type, capability) VALUES ('echo','echo') RETURNING id")
for i in $(seq 1 50); do
  [ "$(q "SELECT status FROM jobs WHERE id = '$HOLD_JOB'")" = "succeeded" ] && break
  sleep 0.2
done
[ "$(q "SELECT status FROM jobs WHERE id = '$HOLD_JOB'")" = "succeeded" ] || fail "held worker did not pick up the job"
LATENCY_MS=$(( ($(date +%s%N) - QUEUED_AT) / 1000000 ))
echo "hold pickup latency: ${LATENCY_MS} ms"
[ "$LATENCY_MS" -lt 6000 ] || fail "hold pickup too slow (${LATENCY_MS} ms)"
wait $HOLD_PID || fail "hold run exited non-zero"
grep -q "time budget used" "$WORK/worker/logs/worker.log" || fail "hold run did not end on its budget"

echo "== urgent jobs skip another worker's home queue"
OTHER=$(q "INSERT INTO workers (name, host, status, last_seen_at) VALUES ('Other Muse','muse','active', now()) RETURNING id")
NORMAL_JOB=$(q "INSERT INTO jobs (type, capability, preferred_worker_id) VALUES ('echo','echo','$OTHER') RETURNING id")
URGENT_JOB=$(q "INSERT INTO jobs (type, capability, preferred_worker_id, priority) VALUES ('echo','echo','$OTHER', 10) RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$URGENT_JOB'")" = "succeeded" ] || fail "urgent job not taken by a free worker"
[ "$(q "SELECT status FROM jobs WHERE id = '$NORMAL_JOB'")" = "queued" ] || fail "normal job jumped the home-worker wait"
q "DELETE FROM jobs WHERE id = '$NORMAL_JOB'" >/dev/null

echo "== drained worker gets no new jobs; revoked worker is rejected"
q "UPDATE workers SET status = 'draining' WHERE id = '$WORKER'" >/dev/null
DRAIN_JOB=$(q "INSERT INTO jobs (type, capability) VALUES ('echo','echo') RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$DRAIN_JOB'")" = "queued" ] || fail "draining worker took a job"
q "UPDATE workers SET status = 'revoked', token_hash = NULL WHERE id = '$WORKER'" >/dev/null
if "$WORK/worker/run.sh" tick; then fail "revoked worker tick should fail"; fi
tail -n 2 "$WORK/worker/logs/worker.log" | grep -q "revoked" || fail "revoked message missing"

echo "E2E PASS"
