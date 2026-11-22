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
WORK="$ROOT/.e2e"
rm -rf "$WORK" && mkdir -p "$WORK"
# The portal serves the worker from a copy, so the self-update steps below can change what it serves (an older
# version, a broken one) without touching the repo. Same files as apps/worker, the Remotion runtime and the vendored
# style packs (found at <WORKER_DIR>/../styles, as in the image).
mkdir -p "$WORK/src/render-remotion"
cp -r "$ROOT/apps/worker" "$WORK/src/worker"
cp -r "$ROOT/apps/render-remotion/package.json" "$ROOT/apps/render-remotion/tsconfig.json" "$ROOT/apps/render-remotion/scripts" "$ROOT/apps/render-remotion/src" "$WORK/src/render-remotion/"
cp -r "$ROOT/styles" "$WORK/src/styles"
export WORKER_DIR="$WORK/src/worker"

fail() { echo "E2E FAIL: $*" >&2; [ -f "$WORK/portal.log" ] && tail -n 80 "$WORK/portal.log" >&2; exit 1; }
q() { psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
# A pack's version as vendored in styles/lock.json, so these checks follow pack bumps instead of hard-coding them.
pack_version() { node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const p=(l.packs||[]).find((x)=>x.id===process.argv[2]) || (l.packs&&l.packs[process.argv[2]]); if(!p||!p.version){process.exit(1)} console.log(p.version)' "$ROOT/styles/lock.json" "$1"; }

echo "== migrate"
node "$ROOT/apps/portal/scripts/migrate.mjs"
node "$ROOT/apps/portal/scripts/migrate.mjs" | grep -q "up to date" || fail "second migrate run not idempotent"

echo "== start portal"
(cd "$ROOT/apps/portal" && PORT=$PORT npx next start -p "$PORT" > "$WORK/portal.log" 2>&1) &
PORTAL_PID=$!
PROXY_PID=""
trap 'kill $PORTAL_PID $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -fsS "$APP_URL/api/health" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && fail "portal did not become healthy"
done

echo "== pages and security headers"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/setup")" = "200" ] || fail "/setup not 200"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/")" = "307" ] || fail "/ should redirect to /login when signed out"
SETUP_HEADERS=$(curl -sI "$APP_URL/setup")
grep -qi "content-security-policy" <<<"$SETUP_HEADERS" || fail "CSP header missing"
grep -qi "x-frame-options: DENY" <<<"$SETUP_HEADERS" || fail "X-Frame-Options missing"
SETUP_BODY=$(curl -fsS "$APP_URL/install/SETUP.md") || fail "SETUP.md not served"
grep -qF "$APP_URL/install/install.sh" <<<"$SETUP_BODY" || fail "SETUP.md not templated"
AGENT_BODY=$(curl -fsS "$APP_URL/install/AGENT_DEPLOY.md") || fail "old setup link broken"
grep -qF "VenStudio worker setup" <<<"$AGENT_BODY" || fail "old setup link broken"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/install/../../etc/passwd")" != "200" ] || fail "install path traversal"
curl -fsS "$APP_URL/install/render-remotion.json" -o "$WORK/render-remotion.json" || fail "render-remotion.json not served"
node "$ROOT/apps/worker/venstudio-worker.ts" unpack-bundle --file "$WORK/render-remotion.json" --dir "$WORK/remotion-unpacked" >/dev/null || fail "render-remotion.json does not unpack"
# The served project is the runtime plus the vendored packs' render projects, exactly as scripts/remotion-project.mjs builds it.
node "$ROOT/scripts/remotion-project.mjs" "$WORK/remotion-expected" >/dev/null || fail "could not build the expected Remotion project"
diff -r "$WORK/remotion-expected/src" "$WORK/remotion-unpacked/src" >/dev/null || fail "unpacked Remotion project differs from the runtime plus the vendored packs"
[ -f "$WORK/remotion-unpacked/src/packs/explainer-flat-vector/FlatVectorExplainer.tsx" ] || fail "the explainer composition is not served from its pack"
grep -q '"flat-vector-explainer"' "$WORK/remotion-unpacked/src/packs/packs.json" || fail "packs.json does not list the explainer composition"
# html-capture packs (worker 0.10.0+) travel in the same signed bundle, under html/.
diff -r "$WORK/remotion-expected/html" "$WORK/remotion-unpacked/html" >/dev/null || fail "unpacked html/ differs from the vendored html-capture packs"
[ -f "$WORK/remotion-unpacked/html/probe-line-graph/index.html" ] || fail "the probe-line-graph page is not in the served bundle"
HTML_LIST=$(cat "$WORK/remotion-unpacked/html/packs.json")
grep -q '"id": "probe-line-graph"' <<<"$HTML_LIST" || fail "html/packs.json does not list probe-line-graph"
curl -fsS "$APP_URL/install/style-packs.json" -o "$WORK/style-packs.json" || fail "style-packs.json not served"
for P in explainer-flat-vector documentary-stills mystery-narration horror-story ambient-loop travel-documentary story-read-aloud probe-line-graph hermes-research-explainer; do
  grep -q "\"id\": \"$P\"" "$WORK/style-packs.json" || fail "style-packs.json does not list $P"
done
grep -q "\"commit\": \"$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).source.commit)' "$ROOT/styles/lock.json")\"" "$WORK/style-packs.json" || fail "style-packs.json does not name the vendored styles commit"

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
cmp -s "$WORK/worker/styles/style-packs.json" "$WORK/style-packs.json" || fail "install.sh did not install the served style packs index"
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

echo "== the worker reports each installed stills pack once its probe (ffmpeg with xfade) passes, and no Remotion pack without Remotion"
CAPS=$(q "SELECT array_to_string(capabilities, ',') FROM workers WHERE id = '$WORKER'")
for P in documentary-stills mystery-narration horror-story ambient-loop travel-documentary story-read-aloud; do
  PV=$(pack_version "$P") || fail "styles/lock.json has no version for $P"
  grep -qF "pack:$P@$PV" <<<"$CAPS" || fail "the worker does not report pack:$P@$PV (capabilities: $CAPS)"
done
if grep -qF "pack:explainer-flat-vector@" <<<"$CAPS"; then fail "a worker without Remotion reports the Remotion pack"; fi
# A render queued under a pack capability is claimed only by a worker reporting it.
PACK_JOB=$(q "INSERT INTO jobs (type, capability) VALUES ('echo','pack:explainer-flat-vector@$(pack_version explainer-flat-vector)') RETURNING id")
"$WORK/worker/run.sh" tick || fail "tick with a pack job exited non-zero"
[ "$(q "SELECT status FROM jobs WHERE id = '$PACK_JOB'")" = "queued" ] || fail "a worker without the pack claimed its job"
q "UPDATE jobs SET status = 'cancelled' WHERE id = '$PACK_JOB'" >/dev/null

echo "== migration 0015: the trial curation log, additive only"
[ "$(q "SELECT to_regclass('public.style_trial_outcomes') IS NOT NULL")" = "t" ] || fail "table style_trial_outcomes missing after migration 0015"
for col in run_id pack_id pack_version qc_passed qc_gates presentation_score owner_decision decided_by decided_at video_asset_id created_at updated_at; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'style_trial_outcomes' AND column_name = '$col'")" = "1" ] || fail "column style_trial_outcomes.$col missing after migration 0015"
done
[ "$(q "SELECT count(*) FROM style_trial_outcomes")" = "0" ] || fail "style_trial_outcomes should start empty"
TRUN=$(q "INSERT INTO pipeline_runs (topic, config) VALUES ('e2e trial', '{\"styleId\":\"documentary-stills\",\"stylePack\":{\"id\":\"documentary-stills\",\"version\":\"1.0.0\",\"status\":\"trial\",\"trial\":true}}') RETURNING id")
q "INSERT INTO style_trial_outcomes (run_id, pack_id, pack_version, qc_passed, qc_gates, presentation_score, owner_decision)
   VALUES ('$TRUN', 'documentary-stills', '1.0.0', true, '[{\"gate\":\"G-technical\",\"passed\":true,\"score\":null}]', 84, 'approved')" >/dev/null || fail "style_trial_outcomes refused a valid outcome"
q "INSERT INTO style_trial_outcomes (run_id, pack_id, pack_version, qc_passed, owner_decision) VALUES ('$TRUN', 'documentary-stills', '1.0.0', true, 'maybe')" >/dev/null 2>&1 && fail "style_trial_outcomes accepted an unknown owner decision"
q "UPDATE style_trial_outcomes SET pack_version = 'latest' WHERE run_id = '$TRUN'" >/dev/null 2>&1 && fail "style_trial_outcomes accepted a version that is not semver"
q "UPDATE style_trial_outcomes SET presentation_score = 101 WHERE run_id = '$TRUN'" >/dev/null 2>&1 && fail "style_trial_outcomes accepted a presentation score above 100"
q "DELETE FROM pipeline_runs WHERE id = '$TRUN'" >/dev/null
[ "$(q "SELECT count(*) FROM style_trial_outcomes")" = "0" ] || fail "a run's trial outcome must go with the run"

echo "== migration 0016: the presentation score on the curation log, additive only"
for col in owner_rubric presentation_by hermes_advisory renderer; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'style_trial_outcomes' AND column_name = '$col' AND is_nullable = 'YES'")" = "1" ] || fail "column style_trial_outcomes.$col missing (or not nullable) after migration 0016"
done
TRUN=$(q "INSERT INTO pipeline_runs (topic, config) VALUES ('e2e trial 0016', '{\"styleId\":\"documentary-stills\",\"stylePack\":{\"id\":\"documentary-stills\",\"version\":\"1.0.0\",\"status\":\"trial\",\"trial\":true}}') RETURNING id")
q "INSERT INTO style_trial_outcomes (run_id, pack_id, pack_version, qc_passed) VALUES ('$TRUN', 'documentary-stills', '1.0.0', true)" >/dev/null || fail "a 0015-shaped outcome is refused after migration 0016"
q "UPDATE style_trial_outcomes SET presentation_score = 80, owner_rubric = '{\"hook\":5,\"pacing\":4,\"legibility\":4,\"polish\":4,\"audio\":4}', presentation_by = 'owner',
     hermes_advisory = '{\"score\":70,\"notes\":\"advisory\"}', renderer = 'html-capture' WHERE run_id = '$TRUN'" >/dev/null || fail "style_trial_outcomes refused an owner score with its rubric and advisory"
q "UPDATE style_trial_outcomes SET presentation_by = 'hermes' WHERE run_id = '$TRUN'" >/dev/null 2>&1 && fail "style_trial_outcomes accepted a presentation score that is not the owner's"
q "UPDATE style_trial_outcomes SET owner_rubric = '[5,4]' WHERE run_id = '$TRUN'" >/dev/null 2>&1 && fail "style_trial_outcomes accepted a rubric that is not an object"
q "UPDATE style_trial_outcomes SET renderer = 'Not A Renderer' WHERE run_id = '$TRUN'" >/dev/null 2>&1 && fail "style_trial_outcomes accepted a malformed renderer"
q "DELETE FROM pipeline_runs WHERE id = '$TRUN'" >/dev/null

echo "== migration 0017: Template Lab studies and sources, additive only"
for T in lab_studies lab_sources; do
  [ "$(q "SELECT to_regclass('public.$T') IS NOT NULL")" = "t" ] || fail "table $T missing after migration 0017"
done
for col in id title goal base_pack notes draft draft_state draft_error draft_at revision revisions created_by created_at updated_at; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lab_studies' AND column_name = '$col'")" = "1" ] || fail "column lab_studies.$col missing after migration 0017"
done
for col in id study_id type ref ref_path licence asset_id analysis_job_id status reason findings created_by created_at updated_at; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lab_sources' AND column_name = '$col'")" = "1" ] || fail "column lab_sources.$col missing after migration 0017"
done
[ "$(q "SELECT count(*) FROM lab_studies")" = "0" ] || fail "lab_studies should start empty"
LSTUDY=$(q "INSERT INTO lab_studies (title, notes) VALUES ('e2e study', 'calm pace') RETURNING id")
[ "$(q "SELECT goal || ' ' || draft_state || ' ' || revision || ' ' || jsonb_array_length(revisions) FROM lab_studies WHERE id = '$LSTUDY'")" = "new none 0 0" ] || fail "a new study does not start as a new style with no draft and no revision"
q "INSERT INTO lab_sources (study_id, type, ref, licence) VALUES ('$LSTUDY', 'link', 'https://www.youtube.com/watch?v=e2e', 'unknown')" >/dev/null || fail "lab_sources refused a YouTube link with an unknown licence"
q "INSERT INTO lab_sources (study_id, type, ref, licence, status) VALUES ('$LSTUDY', 'owner-note', 'slower cuts', 'owner', 'analyzed')" >/dev/null || fail "lab_sources refused an owner note"
q "INSERT INTO lab_sources (study_id, type, ref, licence) VALUES ('$LSTUDY', 'link', 'www.youtube.com/watch?v=e2e', 'unknown')" >/dev/null 2>&1 && fail "lab_sources accepted a link that is not an http(s) URL"
q "INSERT INTO lab_sources (study_id, type, ref, licence) VALUES ('$LSTUDY', 'link', 'https://example.org/x', '')" >/dev/null 2>&1 && fail "lab_sources accepted a source without a licence"
q "INSERT INTO lab_sources (study_id, type, ref, licence) VALUES ('$LSTUDY', 'frames', 'x', 'unknown')" >/dev/null 2>&1 && fail "lab_sources accepted an unknown source type"
q "UPDATE lab_sources SET status = 'failed' WHERE study_id = '$LSTUDY' AND type = 'link'" >/dev/null 2>&1 && fail "lab_sources accepted a failed source without a reason"
q "UPDATE lab_studies SET revision = 6 WHERE id = '$LSTUDY'" >/dev/null 2>&1 && fail "lab_studies accepted more than 5 revisions"
q "UPDATE lab_studies SET draft_state = 'maybe' WHERE id = '$LSTUDY'" >/dev/null 2>&1 && fail "lab_studies accepted an unknown draft state"
q "DELETE FROM lab_studies WHERE id = '$LSTUDY'" >/dev/null
[ "$(q "SELECT count(*) FROM lab_sources")" = "0" ] || fail "a study's sources must go with the study"

echo "== migration 0018: lab trials on the curation log, additive only"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'style_trial_outcomes' AND column_name = 'lab_trial' AND is_nullable = 'NO' AND column_default = 'false'")" = "1" ] || fail "column style_trial_outcomes.lab_trial missing (or not 'not null default false') after migration 0018"
LRUN=$(q "INSERT INTO pipeline_runs (topic, config) VALUES ('e2e lab trial 0018', '{\"styleId\":\"probe-line-graph\",\"stylePack\":{\"id\":\"probe-line-graph\",\"version\":\"0.1.0\",\"status\":\"lab\",\"trial\":true,\"lab\":true}}') RETURNING id")
q "INSERT INTO style_trial_outcomes (run_id, pack_id, pack_version, qc_passed) VALUES ('$LRUN', 'probe-line-graph', '0.1.0', true)" >/dev/null || fail "a 0016-shaped outcome is refused after migration 0018"
[ "$(q "SELECT lab_trial::text FROM style_trial_outcomes WHERE run_id = '$LRUN'")" = "false" ] || fail "an outcome written without lab_trial is not a normal trial"
q "UPDATE style_trial_outcomes SET lab_trial = true WHERE run_id = '$LRUN'" >/dev/null || fail "style_trial_outcomes refused lab_trial"
q "DELETE FROM pipeline_runs WHERE id = '$LRUN'" >/dev/null

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

echo "== migration 0011 created the Hermes gate, endpoint health and wait columns"
[ "$(q "SELECT to_regclass('public.hermes_gate') IS NOT NULL")" = "t" ] || fail "table hermes_gate missing after migration 0011"
[ "$(q "SELECT count(*) FROM hermes_gate WHERE id = 'hermes' AND busy_until IS NULL AND consecutive = 0")" = "1" ] || fail "hermes_gate should start with one idle row"
[ "$(q "SELECT to_regclass('public.endpoint_health') IS NOT NULL")" = "t" ] || fail "table endpoint_health missing after migration 0011"
for col in pipeline_stages.not_before work_orders.not_before work_orders.wait_reason; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${col%%.*}' AND column_name = '${col#*.}'")" = "1" ] || fail "column $col missing after migration 0011"
done
# A 4xx must be storable as a quarantine, and an unknown failure class must be refused.
q "INSERT INTO endpoint_health (endpoint, model, kind, last_failure_at, failure_class, quarantined_at, failures) VALUES ('9router', 'e2e/check', 'image', now(), 'client', now(), 1)" >/dev/null
q "INSERT INTO endpoint_health (endpoint, model, kind, failure_class) VALUES ('9router', 'e2e/bad', 'image', 'nonsense')" >/dev/null 2>&1 && fail "endpoint_health accepted an unknown failure class"
q "DELETE FROM endpoint_health WHERE model = 'e2e/check'" >/dev/null

echo "== migration 0012 widened both kind CHECKs to video, leaving exactly one CHECK on kind per table"
for tbl in asset_providers endpoint_health; do
  DEFS=$(q "SELECT conname || ': ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = '$tbl'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~* '\\mkind\\M' ORDER BY conname")
  echo "$tbl CHECK on kind:"; echo "$DEFS" | sed 's/^/   /'
  [ "$(echo "$DEFS" | grep -c .)" = "1" ] || fail "$tbl should have exactly one CHECK on kind after 0012, found: $DEFS"
  echo "$DEFS" | grep -q "'video'" || fail "$tbl CHECK on kind does not allow video: $DEFS"
done
q "INSERT INTO asset_providers (name, kind) VALUES ('e2e-video', 'video')" >/dev/null || fail "asset_providers refused kind video"
q "INSERT INTO endpoint_health (endpoint, model, kind) VALUES ('hermes', 'e2e/video', 'video')" >/dev/null || fail "endpoint_health refused kind video"
q "INSERT INTO endpoint_health (endpoint, model, kind) VALUES ('hermes', 'e2e/bad-kind', 'audio')" >/dev/null 2>&1 && fail "endpoint_health accepted an unknown kind"
q "DELETE FROM asset_providers WHERE name = 'e2e-video'" >/dev/null
q "DELETE FROM endpoint_health WHERE model = 'e2e/video'" >/dev/null

echo "== migration 0013 created the speech rate table, additive only"
[ "$(q "SELECT to_regclass('public.voice_speech_rates') IS NOT NULL")" = "t" ] || fail "table voice_speech_rates missing after migration 0013"
for col in voice_key provider model voice language words seconds wpm source run_id created_at; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'voice_speech_rates' AND column_name = '$col'")" = "1" ] || fail "column voice_speech_rates.$col missing after migration 0013"
done
q "INSERT INTO voice_speech_rates (voice_key, words, seconds, wpm, source) VALUES ('e2e|check|voice', 119, 55.01, 129.8, 'narration')" >/dev/null || fail "voice_speech_rates refused a valid sample"
q "INSERT INTO voice_speech_rates (voice_key, words, seconds, wpm, source) VALUES ('e2e|check|voice', 10, 5, 120, 'guess')" >/dev/null 2>&1 && fail "voice_speech_rates accepted an unknown source"
q "INSERT INTO voice_speech_rates (voice_key, words, seconds, wpm, source) VALUES ('e2e|check|voice', 10, 0, 120, 'test')" >/dev/null 2>&1 && fail "voice_speech_rates accepted a zero length"
q "DELETE FROM voice_speech_rates WHERE voice_key = 'e2e|check|voice'" >/dev/null
[ "$(q "SELECT count(*) FROM voice_speech_rates")" = "0" ] || fail "voice_speech_rates should start empty: no pace is assumed learned"

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

echo "== migration 0014: update signing key, settings and worker columns, additive only"
for T in update_signing_keys worker_update_settings; do
  [ "$(q "SELECT to_regclass('public.$T') IS NOT NULL")" = "t" ] || fail "table $T missing after migration 0014"
done
for col in update_offered_version update_offered_release update_approved_release update_key_id update_checked_at update_status update_detail update_result_version update_result_at; do
  [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workers' AND column_name = '$col'")" = "1" ] || fail "column workers.$col missing after migration 0014"
done
[ "$(q "SELECT mode FROM worker_update_settings WHERE id = 'default'")" = "auto" ] || fail "update mode should default to auto"
[ "$(q "SELECT pinned_version IS NULL FROM worker_update_settings")" = "t" ] || fail "no version should be pinned by default"
q "UPDATE workers SET update_status = 'maybe' WHERE id = '$WORKER'" >/dev/null 2>&1 && fail "workers accepted an unknown update status"
q "UPDATE worker_update_settings SET mode = 'sometimes'" >/dev/null 2>&1 && fail "worker_update_settings accepted an unknown mode"

echo "== the signing key: made on first use, private half encrypted, public half carried by install.sh and pinned"
[ "$(q "SELECT count(*) FROM update_signing_keys")" = "1" ] || fail "serving install.sh should have created exactly one signing key"
KEY_ID=$(q "SELECT key_id FROM update_signing_keys")
PUB=$(q "SELECT public_key FROM update_signing_keys")
KEY_ENC=$(q "SELECT private_key_enc FROM update_signing_keys")
[[ "$KEY_ENC" == v1.* ]] || fail "the private key is not stored encrypted"
# Every Ed25519 PKCS#8 key in base64 starts like this; it must not appear in the stored value.
[[ "$KEY_ENC" != *MC4CAQAwBQYDK2VwBCIEI* ]] || fail "the private key is stored in plain text"
INSTALL_BODY=$(curl -fsS "$APP_URL/install/install.sh") || fail "install.sh not served"
grep -qF "UPDATE_KEY=\"$PUB\"" <<<"$INSTALL_BODY" || fail "install.sh does not carry the signing key"
if grep -qF "{{UPDATE_PUBLIC_KEY}}" <<<"$INSTALL_BODY"; then fail "install.sh still has the key placeholder"; fi
cfg_get() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(c[process.argv[2]] ?? "")' "$WORK/worker/config.json" "$1"; }
[ "$(cfg_get updateKey)" = "$PUB" ] || fail "install.sh did not pin the update key in config.json"
[ "$(stat -c '%a' "$WORK/worker/config.json")" = "600" ] || fail "config.json not chmod 600 after pinning the key"
[ "$(q "SELECT update_key_id FROM workers WHERE id = '$WORKER'")" = "$KEY_ID" ] || fail "the worker did not report the key it pinned"
[ -z "$(q "SELECT update_offered_version FROM workers WHERE id = '$WORKER'")" ] || fail "a current worker is shown an update"

echo "== signed self-update: a worker of the previous version updates itself from the portal"
SRC="$WORKER_DIR/venstudio-worker.ts"
PRISTINE="$WORK/pristine-worker.ts"
cp "$SRC" "$PRISTINE"
CURRENT=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$PRISTINE")
[ -n "$CURRENT" ] || fail "no VERSION in the worker"
LIVE="$WORK/worker/app/venstudio-worker.ts"
LOGF="$WORK/worker/logs/worker.log"
fsha() { sha256sum "$1" | cut -d' ' -f1; }
wq() { q "SELECT $1 FROM workers WHERE id = '$WORKER'"; }
run_tick() { "$WORK/worker/run.sh" tick || { tail -n 40 "$LOGF"; fail "$1: tick exited non-zero"; }; }
# patch_worker <version> <output file> [line added after VERSION]: the pristine worker with another VERSION.
patch_worker() {
  node -e 'const fs=require("fs"); const [src,v,out,inj]=process.argv.slice(1); const s=fs.readFileSync(src,"utf8");
    const t=s.replace(/^export const VERSION = ".*";$/m, `export const VERSION = "${v}";` + (inj ? "\n" + inj : "")); if (t===s) process.exit(1); fs.writeFileSync(out,t)' \
    "$PRISTINE" "$1" "$2" "${3:-}" || fail "could not patch the worker to $1"
}
expect_live() { # <expected sha> <what>
  [ "$(fsha "$LIVE")" = "$1" ] || { tail -n 30 "$LOGF"; fail "$2"; }
}
patch_worker 0.7.99 "$LIVE"
OLD_SHA=$(fsha "$LIVE")
run_tick "self-update"
expect_live "$(fsha "$PRISTINE")" "the worker did not install the version the portal serves"
[ "$(wq version)" = "$CURRENT" ] || fail "the worker reports v$(wq version), expected v$CURRENT after updating"
[ "$(wq update_status)" = "ok" ] || fail "update not reported ok: $(wq update_status) $(wq update_detail)"
[ "$(wq update_result_version)" = "$CURRENT" ] || fail "update result names v$(wq update_result_version)"
[ "$(fsha "$WORK/worker/app/prev/venstudio-worker.ts")" = "$OLD_SHA" ] || fail "the previous version was not kept in app/prev"
[ ! -e "$WORK/worker/app/update-pending" ] || fail "the update is still pending after the new version's first claim"
grep -q "signature and checksum verified" "$LOGF" || fail "the log does not show the verification"
grep -q "update to v$CURRENT confirmed (from v0.7.99)" "$LOGF" || fail "the new version did not confirm itself"
[ -z "$(wq update_offered_version)" ] || fail "an installed update is still shown as offered"
[ "$(q "SELECT count(*) FROM audit_log WHERE worker_id = '$WORKER' AND action = 'worker.update.ok'")" -ge 1 ] || fail "no audit entry for the update"

echo "== approve mode: offered and shown, installed only after the owner approves"
q "UPDATE worker_update_settings SET mode = 'approve'" >/dev/null
patch_worker 0.7.99 "$LIVE"
OLD_SHA=$(fsha "$LIVE")
run_tick "approve mode"
expect_live "$OLD_SHA" "approve mode installed an update nobody approved"
[ "$(wq update_offered_version)" = "$CURRENT" ] || fail "approve mode does not show the offered version"
[ "$(wq version)" = "0.7.99" ] || fail "the waiting worker should still run v0.7.99"
# What the Approve button does (approveWorkerUpdate).
q "UPDATE workers SET update_approved_release = update_offered_release WHERE id = '$WORKER'" >/dev/null
run_tick "approved"
expect_live "$(fsha "$PRISTINE")" "the approved update was not installed"
[ -z "$(wq update_offered_version)" ] || fail "the installed update is still shown as available"

echo "== off: nothing installs by itself"
q "UPDATE worker_update_settings SET mode = 'off'" >/dev/null
patch_worker 0.7.99 "$LIVE"
OLD_SHA=$(fsha "$LIVE")
run_tick "updates off"
expect_live "$OLD_SHA" "an update installed while updates are off"
[ "$(wq update_offered_version)" = "$CURRENT" ] || fail "updates off should still show what is available"
q "UPDATE worker_update_settings SET mode = 'auto'" >/dev/null

echo "== tampered file, bad signature, expired manifest: refused, reported, nothing run"
PROXY_PORT=$((PORT + 7))
MODE_FILE="$WORK/proxy-mode"
echo pass > "$MODE_FILE"
SIGNING_KEY_ENC="$KEY_ENC" SIGNING_KEY_ID="$KEY_ID" node "$ROOT/scripts/e2e-update-proxy.mjs" "$PROXY_PORT" "$APP_URL" "$MODE_FILE" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://localhost:$PROXY_PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" = 30 ] && { cat "$WORK/proxy.log"; fail "update proxy did not start"; }
done
set_portal() {
  node -e 'const fs=require("fs"); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,"utf8")); c.portalUrl=process.argv[2]; fs.writeFileSync(f, JSON.stringify(c, null, 2))' "$WORK/worker/config.json" "$1"
}
set_portal "http://localhost:$PROXY_PORT"
for CASE in "tamper-file|checksum mismatch" "bad-signature|bad signature" "expired|expired"; do
  M=${CASE%%|*}
  WANT=${CASE#*|}
  echo "$M" > "$MODE_FILE"
  patch_worker 0.7.99 "$LIVE"
  OLD_SHA=$(fsha "$LIVE")
  run_tick "$M"
  expect_live "$OLD_SHA" "$M: the worker installed a refused update"
  [ ! -e "$WORK/worker/app/next/venstudio-worker.ts" ] || fail "$M: a refused file was left staged"
  [ "$(wq update_status)" = "refused" ] || fail "$M: not reported as refused: $(wq update_status) $(wq update_detail)"
  DETAIL=$(wq update_detail)
  grep -qF "$WANT" <<<"$DETAIL" || fail "$M: the reason should mention '$WANT', got: $DETAIL"
  [ "$(wq version)" = "0.7.99" ] || fail "$M: the old version did not keep working"
  echo "   $M refused: $DETAIL"
done
grep -q "tampered /install/venstudio-worker.ts" "$WORK/proxy.log" || fail "the proxy never tampered with the file"
echo pass > "$MODE_FILE"
set_portal "$APP_URL"
kill "$PROXY_PID" 2>/dev/null || true
PROXY_PID=""

echo "== downgrade: refused, unless the owner pins exactly that version"
cp "$PRISTINE" "$LIVE"
patch_worker 0.7.50 "$SRC"
run_tick "downgrade"
expect_live "$(fsha "$PRISTINE")" "an unpinned downgrade was installed"
[ "$(wq update_status)" = "refused" ] || fail "the downgrade was not reported as refused"
grep -qF "older than this worker" <<<"$(wq update_detail)" || fail "downgrade reason: $(wq update_detail)"
q "UPDATE worker_update_settings SET pinned_version = '0.7.50'" >/dev/null
run_tick "pinned downgrade"
expect_live "$(fsha "$SRC")" "the pinned downgrade was not installed"
[ "$(wq version)" = "0.7.50" ] || fail "the worker reports v$(wq version) after the pinned downgrade"
q "UPDATE worker_update_settings SET pinned_version = NULL" >/dev/null
cp "$PRISTINE" "$SRC"
run_tick "back to current"
expect_live "$(fsha "$PRISTINE")" "the worker did not update from v0.7.50 back to v$CURRENT"

echo "== rollback: a version whose self-test fails is never swapped in, and not tried again"
patch_worker 9.9.0 "$SRC" 'if (process.argv[2] === "selftest") { console.log(JSON.stringify({ ok: false, reason: "injected e2e failure" })); process.exit(3); }'
run_tick "self-test failure"
expect_live "$(fsha "$PRISTINE")" "a version that failed its self-test was installed"
[ "$(wq update_status)" = "rolled_back" ] || fail "self-test failure not reported as rolled back: $(wq update_status)"
grep -qF "injected e2e failure" <<<"$(wq update_detail)" || fail "self-test failure reason: $(wq update_detail)"
[ ! -e "$WORK/worker/app/next" ] || fail "the failed version was left staged"
run_tick "self-test failure, again"
tail -n 5 "$LOGF" | grep -q "failed here before" || fail "the failed release was tried again"

echo "== rollback: a version that exits with an error twice before its first claim is restored by the old process"
patch_worker 9.9.1 "$SRC" 'if (process.argv[2] === "tick") process.exit(4);'
run_tick "start failure"
expect_live "$(fsha "$PRISTINE")" "the old process did not restore the previous version"
[ "$(wq update_status)" = "rolled_back" ] || fail "start failure not reported as rolled back: $(wq update_status)"
grep -qF "before its first claim" <<<"$(wq update_detail)" || fail "start failure reason: $(wq update_detail)"
[ "$(wq version)" = "$CURRENT" ] || fail "the previous version did not carry on"
[ ! -e "$WORK/worker/app/update-pending" ] || fail "update-pending left after the rollback"
cp "$PRISTINE" "$SRC"

echo "== rollback: run.sh restores the previous version when the new one crashed with no process left to supervise it"
patch_worker 9.9.2 "$WORK/broken.ts" 'if (process.argv[2] === "tick") process.exit(4);'
cp "$PRISTINE" "$WORK/worker/app/prev/venstudio-worker.ts"
cp "$WORK/broken.ts" "$LIVE"
echo 0 > "$WORK/worker/app/update-pending"
node -e 'const fs=require("fs"); const [f,sha,from]=process.argv.slice(1); const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};
  s.pending={version:"9.9.2",from,sha256:sha,at:new Date().toISOString()}; fs.writeFileSync(f, JSON.stringify(s))' \
  "$WORK/worker/app/update-state.json" "$(fsha "$WORK/broken.ts")" "$CURRENT"
if "$WORK/worker/run.sh" tick; then fail "the broken version should exit with an error"; fi
[ "$(cat "$WORK/worker/app/update-pending")" = "1" ] || fail "run.sh did not count the failed start"
if "$WORK/worker/run.sh" tick; then fail "the broken version should exit with an error again"; fi
expect_live "$(fsha "$PRISTINE")" "run.sh did not restore the previous version after two failed starts"
[ ! -e "$WORK/worker/app/update-pending" ] || fail "run.sh left update-pending after the rollback"
tail -n 3 "$LOGF" | grep -q "restored the previous version" || fail "run.sh did not log the rollback"
run_tick "after run.sh rollback"
[ "$(wq update_status)" = "rolled_back" ] || fail "the run.sh rollback was not reported"
grep -qF "v9.9.2" <<<"$(wq update_detail)" || fail "run.sh rollback reason: $(wq update_detail)"
expect_live "$(fsha "$PRISTINE")" "the worker changed after the run.sh rollback"

echo "== style packs travel through the signed update: a worker without them gets them, verified, without a version bump"
rm -f "$WORK/worker/styles/style-packs.json"
run_tick "style packs update"
cmp -s "$WORK/worker/styles/style-packs.json" "$WORK/style-packs.json" || { tail -n 20 "$LOGF"; fail "the signed update did not install the style packs index"; }
grep -q "style packs [0-9a-f]\{12\}: signature and checksum verified" "$LOGF" || fail "the log does not show the packs verification"
[ "$(wq version)" = "$CURRENT" ] || fail "installing packs changed the worker version"
expect_live "$(fsha "$PRISTINE")" "installing packs changed the worker file"
run_tick "after the packs update"
grep -qF "pack:documentary-stills@$(pack_version documentary-stills)" <<<"$(q "SELECT array_to_string(capabilities, ',') FROM workers WHERE id = '$WORKER'")" || fail "the worker does not report its packs after the update"

echo "== drained worker gets no new jobs; revoked worker is rejected"
q "UPDATE workers SET status = 'draining' WHERE id = '$WORKER'" >/dev/null
DRAIN_JOB=$(q "INSERT INTO jobs (type, capability) VALUES ('echo','echo') RETURNING id")
"$WORK/worker/run.sh" tick
[ "$(q "SELECT status FROM jobs WHERE id = '$DRAIN_JOB'")" = "queued" ] || fail "draining worker took a job"
q "UPDATE workers SET status = 'revoked', token_hash = NULL WHERE id = '$WORKER'" >/dev/null
if "$WORK/worker/run.sh" tick; then fail "revoked worker tick should fail"; fi
tail -n 2 "$WORK/worker/logs/worker.log" | grep -q "revoked" || fail "revoked message missing"

echo "E2E PASS"
