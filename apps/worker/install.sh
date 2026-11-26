#!/usr/bin/env bash
# VenStudio worker installer. Safe to run again: it updates the worker and keeps the existing enrollment.
#
# It also pins the portal's update signing key (below), so from worker 0.8.0 on the worker installs later updates by
# itself, but only files signed by this key (docs/worker-updates.md). Running this script again stays the manual way.
#
#   curl -fsSL {{PORTAL_URL}}/install/install.sh | bash -s -- --code VS-XXXX-XXXX-XXXX --name "Muse 01"
#
# Options:
#   --portal URL   portal address (default: {{PORTAL_URL}})
#   --code CODE    one-time enrollment code from the portal (only needed the first time)
#   --name NAME    worker name shown in the portal
#   --mode MODE    hold (Muse hourly task, default on Muse), tick, or daemon (always-on VPS)
#   --home DIR     install directory (default /home/hatch/venstudio on Muse, else ~/.venstudio)
#   --with-remotion
#                  also install the Remotion renderer for the remotion-2d engine into <home>/remotion: the templates
#                  from this portal, their npm packages and Remotion's own headless Chromium (about 400 MB, a few
#                  minutes). Safe to repeat; run it again after a portal update to refresh the templates.
#   --user NAME    the account the worker runs as (default venstudio). Started as root, this script installs the
#                  machine-level pieces first (Chromium's system libraries, the account, ownership) and then runs the
#                  rest as NAME. Environments refuse to install as root, so this is what makes full-frame and
#                  low-poly-shapes possible with no manual step.
#   --stay-root    keep running as root. The worker then refuses every environment install; only use it where the
#                  worker deliberately has no environments.
set -euo pipefail

PORTAL="{{PORTAL_URL}}"
# The portal's Ed25519 public key for signed worker updates, filled in by the portal that served this file. It is part
# of what the owner's sha256 check of this file covers.
UPDATE_KEY="{{UPDATE_PUBLIC_KEY}}"
CODE=""
NAME="$(hostname)"
MODE=""
HOME_DIR=""
WITH_REMOTION=0
# The worker runs as this account whenever the script is started as root (see "run as a normal user" below).
AS_USER="venstudio"
AS_USER_SET=0
STAY_ROOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-remotion) WITH_REMOTION=1; shift ;;
    --user) AS_USER="${2:-}"; AS_USER_SET=1; shift 2 ;;
    --stay-root) STAY_ROOT=1; shift ;;
    --portal) PORTAL="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -d /home/hatch ]; then
  HOME_DIR="${HOME_DIR:-/home/hatch/venstudio}"
  MODE="${MODE:-hold}"
else
  HOME_DIR="${HOME_DIR:-$HOME/.venstudio}"
  MODE="${MODE:-daemon}"
fi
case "$MODE" in tick|hold|daemon) ;; *) echo "--mode must be hold, tick or daemon" >&2; exit 2 ;; esac

say0() { printf '[venstudio] %s\n' "$*"; }

# --- run as a normal user -------------------------------------------------------------------
# An environment recipe downloads a binary and runs pip install; the worker refuses that as root on purpose, because
# pack code is not trusted. A root install therefore prepares the machine and then continues as the service account,
# which is exactly what a manual non-root install does. This is the supported path, not a workaround.
if [ "$(id -u)" -eq 0 ] && [ "$STAY_ROOT" = 0 ]; then
  AS_USER="${AS_USER:-venstudio}"
  # An existing install already has an owner; use it unless --user says otherwise, so its crontab keeps working and only
  # the root part changes.
  if [ "$AS_USER_SET" = 0 ] && [ -d "$HOME_DIR" ]; then
    _owner="$(stat -c %U "$HOME_DIR" 2>/dev/null || echo root)"
    if [ -n "$_owner" ] && [ "$_owner" != root ] && id -u "$_owner" >/dev/null 2>&1; then AS_USER="$_owner"; fi
  fi
  case "$AS_USER" in ""|*[!a-z0-9_-]*) echo "--user must be a plain account name" >&2; exit 2 ;; esac

  # System libraries headless Chromium needs (and a system ffmpeg) belong to the machine, not to the account: install
  # them once, as root, before dropping privileges. Best effort: a missing library fails the Remotion probe later,
  # never the install.
  install_system_deps() {
    say0 "system libraries for headless Chromium (once, as root)"
    if command -v npx >/dev/null 2>&1 && npx -y playwright@1.65.1 install-deps chromium >/dev/null 2>&1; then
      say0 "chromium system libraries: installed (playwright install-deps)"
      return 0
    fi
    if command -v apt-get >/dev/null 2>&1; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null 2>&1 || true
      # Debian 12 and Ubuntu 24.04 renamed some packages (t64); try the old names, then the new ones.
      if apt-get install -y -qq --no-install-recommends \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
        libpangocairo-1.0-0 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libpango-1.0-0 libcairo2 libatspi2.0-0 fonts-liberation fonts-dejavu-core >/dev/null 2>&1; then
        say0 "chromium system libraries: installed (apt)"
        return 0
      fi
      if apt-get install -y -qq --no-install-recommends \
        libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libasound2t64 \
        libpangocairo-1.0-0 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libpango-1.0-0 libcairo2 libatspi2.0-0t64 fonts-liberation fonts-dejavu-core >/dev/null 2>&1; then
        say0 "chromium system libraries: installed (apt, t64 names)"
        return 0
      fi
      echo "warning: could not install the Chromium system libraries; --with-remotion may fail its probe (install them by hand: npx playwright install-deps chromium)" >&2
      return 1
    fi
    echo "warning: no npx or apt-get here; install the Chromium system libraries by hand for --with-remotion" >&2
    return 1
  }

  if ! id -u "$AS_USER" >/dev/null 2>&1; then
    say0 "creating the service account $AS_USER (environments never install as root)"
    if ! useradd -m -s /bin/bash "$AS_USER"; then
      echo "could not create $AS_USER; pass --user <account> or --stay-root" >&2
      exit 2
    fi
  fi
  AS_HOME="$(getent passwd "$AS_USER" | cut -d: -f6)"
  [ -n "$AS_HOME" ] || AS_HOME="/home/$AS_USER"

  if [ "$WITH_REMOTION" = 1 ]; then install_system_deps || true; fi

  mkdir -p "$HOME_DIR"
  # The worker's files, its logs and the environments all belong to the account that runs it.
  chown -R "$AS_USER": "$HOME_DIR" 2>/dev/null || chown -R "$AS_USER" "$HOME_DIR"
  chmod 700 "$HOME_DIR" 2>/dev/null || true

  # Fetch this same script again and run it as the account: a piped script ($0 is the shell) cannot re-exec itself.
  _tmp="$(mktemp -d)"
  if curl -fsSL -o "$_tmp/install.sh" "$PORTAL/install/install.sh"; then
    chown -R "$AS_USER": "$_tmp" 2>/dev/null || true
    _args=(--portal "$PORTAL" --name "$NAME" --mode "$MODE" --home "$HOME_DIR")
    [ -n "$CODE" ] && _args+=(--code "$CODE")
    [ "$WITH_REMOTION" = 1 ] && _args+=(--with-remotion)
    say0 "continuing as $AS_USER"
    if command -v runuser >/dev/null 2>&1; then
      exec runuser -u "$AS_USER" -- env HOME="$AS_HOME" VENSTUDIO_SERVICE_USER="$AS_USER" bash "$_tmp/install.sh" "${_args[@]}"
    fi
    exec su -s /bin/bash "$AS_USER" -c "HOME='$AS_HOME' VENSTUDIO_SERVICE_USER='$AS_USER' bash $(printf '%q ' "$_tmp/install.sh" "${_args[@]}")"
  fi
  rm -rf "$_tmp"
  echo "could not fetch install.sh from $PORTAL as $AS_USER; run this script again" >&2
  exit 1
elif [ "$(id -u)" -eq 0 ]; then
  echo "warning: --stay-root: the worker will refuse every environment install (full-frame and low-poly-shapes stay unavailable)" >&2
fi
SERVICE_USER="$(id -un)"

mkdir -p "$HOME_DIR/app" "$HOME_DIR/bin" "$HOME_DIR/logs"
chmod 700 "$HOME_DIR"
cd "$HOME_DIR"
say() { printf '[venstudio] %s\n' "$*"; }

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64; FF_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; FF_ARCH=arm64 ;;
  *) echo "unsupported CPU architecture: $ARCH" >&2; exit 1 ;;
esac

# --- Node.js >= 22.18 (runs TypeScript directly) ---------------------------------
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}
NODE_BIN=""
if [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then
  NODE_BIN="$HOME_DIR/node/bin/node"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  say "installing Node.js 24 into $HOME_DIR/node"
  BASE="https://nodejs.org/dist/latest-v24.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" | head -1)"
  [ -n "$FILE" ] || { echo "could not find a Node.js build for linux-$NODE_ARCH" >&2; exit 1; }
  curl -fsSL -o "/tmp/$FILE" "$BASE/$FILE"
  EXPECTED="$(printf '%s\n' "$SUMS" | grep " $FILE\$" | awk '{print $1}')"
  ACTUAL="$(sha256sum "/tmp/$FILE" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node.js checksum mismatch" >&2; rm -f "/tmp/$FILE"; exit 1; }
  rm -rf "$HOME_DIR/node" && mkdir -p "$HOME_DIR/node"
  tar -xJf "/tmp/$FILE" -C "$HOME_DIR/node" --strip-components=1
  rm -f "/tmp/$FILE"
  NODE_BIN="$HOME_DIR/node/bin/node"
fi
say "node: $("$NODE_BIN" --version) ($NODE_BIN)"

# --- ffmpeg (static build if the system has none) ----------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_BIN="$(command -v ffmpeg)"
elif [ -x "$HOME_DIR/bin/ffmpeg" ]; then
  FFMPEG_BIN="$HOME_DIR/bin/ffmpeg"
else
  say "installing static ffmpeg into $HOME_DIR/bin"
  FF="ffmpeg-release-${FF_ARCH}-static.tar.xz"
  curl -fsSL -o "/tmp/$FF" "https://johnvansickle.com/ffmpeg/releases/$FF"
  curl -fsSL -o "/tmp/$FF.md5" "https://johnvansickle.com/ffmpeg/releases/$FF.md5"
  (cd /tmp && md5sum -c "$FF.md5") || { echo "ffmpeg checksum mismatch" >&2; exit 1; }
  mkdir -p /tmp/vs-ffmpeg && tar -xJf "/tmp/$FF" -C /tmp/vs-ffmpeg --strip-components=1
  cp /tmp/vs-ffmpeg/ffmpeg /tmp/vs-ffmpeg/ffprobe "$HOME_DIR/bin/"
  rm -rf /tmp/vs-ffmpeg "/tmp/$FF" "/tmp/$FF.md5"
  FFMPEG_BIN="$HOME_DIR/bin/ffmpeg"
fi
say "ffmpeg: $FFMPEG_BIN"

# --- worker code ----------------------------------------------------------------------
curl -fsSL -o "$HOME_DIR/app/venstudio-worker.ts.new" "$PORTAL/install/venstudio-worker.ts"
mv "$HOME_DIR/app/venstudio-worker.ts.new" "$HOME_DIR/app/venstudio-worker.ts"
# A manual install replaces whatever a self-update left half-done: no staged file and no pending start. The rest of the
# update state (releases that failed here, the last manifest time) is kept.
rm -rf "$HOME_DIR/app/next"
rm -f "$HOME_DIR/app/update-pending"
if [ -f "$HOME_DIR/app/update-state.json" ]; then
  "$NODE_BIN" -e 'const fs=require("fs"); const f=process.argv[1]; try { const s=JSON.parse(fs.readFileSync(f,"utf8")); delete s.pending; fs.writeFileSync(f, JSON.stringify(s, null, 2)); } catch { fs.rmSync(f, { force: true }); }' "$HOME_DIR/app/update-state.json"
fi

# run.sh: the one entry point for schedulers. Idempotent and quiet on success.
# After a self-update the worker starts the new version itself and rolls it back if it fails twice before its first
# claim. run.sh applies the same rule when that process is gone (VM restarted, killed): app/update-pending counts the
# new version's failed starts, and on the second one the previous file (app/prev/) is put back.
cat > "$HOME_DIR/run.sh" <<EOF
#!/usr/bin/env bash
# Generated by install.sh. Usage: run.sh [hold|tick|daemon|status] [--max-minutes N]
set -uo pipefail
export VENSTUDIO_HOME="$HOME_DIR"
export FFMPEG_PATH="$FFMPEG_BIN"
export PATH="$HOME_DIR/bin:$(dirname "$NODE_BIN"):\$PATH"
export NODE_USE_ENV_PROXY=1
# The account install.sh provisioned for (it hands off to it when started as root).
export VENSTUDIO_SERVICE_USER="\${VENSTUDIO_SERVICE_USER:-$SERVICE_USER}"
APP="$HOME_DIR/app"
LOG="$HOME_DIR/logs/worker.log"
# Keep the log under ~2 MB.
if [ -f "\$LOG" ] && [ "\$(wc -c < "\$LOG")" -gt 2000000 ]; then mv "\$LOG" "\$LOG.1"; fi
# Environments refuse to install as root, so a root start hands off to the service account instead of quietly losing
# capabilities. Started as a normal user this does nothing.
if [ "\$(id -u)" -eq 0 ]; then
  SVC="\${VENSTUDIO_SERVICE_USER:-$SERVICE_USER}"
  if id -u "\$SVC" >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
    H="\$(getent passwd "\$SVC" 2>/dev/null | cut -d: -f6)"
    [ -n "\$H" ] || H="/home/\$SVC"
    exec runuser -u "\$SVC" -- env HOME="\$H" VENSTUDIO_SERVICE_USER="\$SVC" bash "\$0" "\$@"
  fi
  echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) started as root and there is no service account '\$SVC' to hand off to; environments (full-frame, low-poly-shapes) will be refused — re-run install.sh" >> "\$LOG"
fi
CMD="\${1:-$MODE}"
[ \$# -gt 0 ] && shift
"$NODE_BIN" --no-warnings "\$APP/venstudio-worker.ts" "\$CMD" "\$@" >> "\$LOG" 2>&1
STATUS=\$?
if [ "\$STATUS" -ne 0 ] && [ -f "\$APP/update-pending" ]; then
  N=\$(tr -cd '0-9' < "\$APP/update-pending")
  N=\$(( \${N:-0} + 1 ))
  if [ "\$N" -ge 2 ] && [ -f "\$APP/prev/venstudio-worker.ts" ]; then
    mv -f "\$APP/prev/venstudio-worker.ts" "\$APP/venstudio-worker.ts"
    rm -f "\$APP/update-pending"
    echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) the new worker version exited with an error twice before its first claim; restored the previous version" >> "\$LOG"
  else
    echo "\$N" > "\$APP/update-pending"
  fi
fi
exit "\$STATUS"
EOF
chmod 700 "$HOME_DIR/run.sh"

# --- enroll (first time only) ---------------------------------------------------------
if [ -f "$HOME_DIR/config.json" ]; then
  say "already enrolled; kept existing config"
elif [ -n "$CODE" ]; then
  VENSTUDIO_HOME="$HOME_DIR" FFMPEG_PATH="$FFMPEG_BIN" NODE_USE_ENV_PROXY=1 \
    "$NODE_BIN" --no-warnings "$HOME_DIR/app/venstudio-worker.ts" enroll --portal "$PORTAL" --code "$CODE" --name "$NAME"
else
  echo "not enrolled yet: re-run with --code <enrollment code from the portal>" >&2
  exit 1
fi

# --- update key: pinned on every run (this file's sha256 is what the owner checked) ------------------------
if VENSTUDIO_HOME="$HOME_DIR" NODE_USE_ENV_PROXY=1 "$NODE_BIN" --no-warnings "$HOME_DIR/app/venstudio-worker.ts" pin-key --key "$UPDATE_KEY"; then
  say "automatic updates: possible (only files signed by this portal's key are installed; the owner chooses the mode on Workers)"
else
  echo "warning: could not pin the update key; automatic updates stay off until install.sh runs again" >&2
fi

# --- style packs: the portal's index of curated styles (worker 0.9.0+) ----------------------------------
# The worker reports pack:<id>@<version> for each pack whose renderer probe passes here, and the portal routes a
# style's renders only to a worker that reports it. Signed updates keep it current afterwards.
if curl -fsSL -o "$HOME_DIR/app/style-packs.json.new" "$PORTAL/install/style-packs.json" &&
  VENSTUDIO_HOME="$HOME_DIR" "$NODE_BIN" --no-warnings "$HOME_DIR/app/venstudio-worker.ts" install-packs --home "$HOME_DIR" --file "$HOME_DIR/app/style-packs.json.new"; then
  rm -f "$HOME_DIR/app/style-packs.json.new"
else
  rm -f "$HOME_DIR/app/style-packs.json.new"
  echo "warning: could not install the style packs index; the worker takes no style renders until a signed update installs it" >&2
fi

# --- Remotion renderer (opt-in) ---------------------------------------------------------
# After enrollment, so a failed Remotion install still leaves a working stills worker.
REMOTION_FAILED=0
if [ "$WITH_REMOTION" = 1 ]; then
  RDIR="$HOME_DIR/remotion"
  NPM_BIN="$(dirname "$NODE_BIN")/npm"
  [ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
  say "installing the Remotion renderer into $RDIR (about 400 MB with its browser; a few minutes)"
  if [ -z "$NPM_BIN" ]; then
    echo "npm not found next to $NODE_BIN; it is needed to install Remotion" >&2
    REMOTION_FAILED=1
  # Chained with &&: errexit does not apply inside a subshell whose status an if tests. npm and Remotion's browser
  # download go through the egress proxy, if any (both honour HTTPS_PROXY). The full probe renders one still of every
  # template through that browser; the worker reports remotion-2d only once it has passed.
  elif ! (
    curl -fsSL -o "$HOME_DIR/app/render-remotion.json.new" "$PORTAL/install/render-remotion.json" &&
      NODE_USE_ENV_PROXY=1 "$NODE_BIN" --no-warnings "$HOME_DIR/app/venstudio-worker.ts" unpack-bundle --file "$HOME_DIR/app/render-remotion.json.new" --dir "$RDIR" &&
      rm -f "$HOME_DIR/app/render-remotion.json.new" &&
      cd "$RDIR" &&
      export PATH="$(dirname "$NODE_BIN"):$PATH" &&
      "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error &&
      ./node_modules/.bin/remotion browser ensure &&
      "$NODE_BIN" scripts/probe.mjs --full
  ); then
    REMOTION_FAILED=1
  fi
  if [ "$REMOTION_FAILED" = 0 ]; then
    say "remotion: $("$NODE_BIN" "$RDIR/scripts/probe.mjs")"
  else
    echo "the Remotion install failed (see above). The worker runs without remotion-2d; the probe says: $("$NODE_BIN" "$RDIR/scripts/probe.mjs" 2>/dev/null || true)" >&2
  fi
fi

say "install complete (mode: $MODE)"
if [ "$MODE" != "daemon" ]; then
  say "schedule this command every hour: $HOME_DIR/run.sh $MODE"
  say "logs: $HOME_DIR/logs/worker.log"
else
  say "start it with: nohup $HOME_DIR/run.sh daemon >/dev/null 2>&1 &   (or a systemd service)"
fi
[ "$REMOTION_FAILED" = 0 ] || exit 1
