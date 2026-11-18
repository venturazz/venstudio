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
curl -fsS "$APP_URL/install/AGENT_DEPLOY.md" | grep -q "$APP_URL/install/install.sh" || fail "AGENT_DEPLOY.md not templated"
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

echo "== artifacts require a signed-in user"
ART=$(q "SELECT id FROM artifacts WHERE job_id = '$SMOKE_JOB'")
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/api/artifacts/$ART")" = "401" ] || fail "artifact readable without session"

echo "== lease expiry requeues a job"
LEASE_JOB=$(q "INSERT INTO jobs (type, capability, status, worker_id, attempts, lease_expires_at)
  VALUES ('echo','echo','running','$WORKER',1, now() - interval '1 minute') RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$LEASE_JOB'")" = "succeeded" ] || fail "expired lease job not requeued and finished"

echo "== drained worker gets no new jobs; revoked worker is rejected"
q "UPDATE workers SET status = 'draining' WHERE id = '$WORKER'" >/dev/null
DRAIN_JOB=$(q "INSERT INTO jobs (type, capability) VALUES ('echo','echo') RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$DRAIN_JOB'")" = "queued" ] || fail "draining worker took a job"
q "UPDATE workers SET status = 'revoked', token_hash = NULL WHERE id = '$WORKER'" >/dev/null
if "$WORK/worker/run.sh" tick; then fail "revoked worker tick should fail"; fi
tail -n 2 "$WORK/worker/logs/worker.log" | grep -q "revoked" || fail "revoked message missing"

echo "E2E PASS"
