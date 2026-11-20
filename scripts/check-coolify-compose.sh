#!/usr/bin/env bash
# Checks compose files meant for Coolify against the rule that rejected deploy/hermes-files.coolify.yml:
# Coolify's validateShellSafePath refuses volume sources and targets that contain ${ $( ` | & ; < > or a
# newline/tab (bootstrap/helpers/shared.php). Reads the raw file, without interpolation, as Coolify does.
# Usage: scripts/check-coolify-compose.sh file.yml [file.yml ...]
set -euo pipefail
status=0
for f in "$@"; do
  json=$(docker compose -f "$f" config --no-interpolate --format json)
  if ! node -e '
    const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const bad = ["${", "$(", "`", "|", "&", ";", "<", ">", "\n", "\r", "\t"];
    let ok = true;
    for (const [name, svc] of Object.entries(cfg.services ?? {})) {
      for (const v of svc.volumes ?? []) {
        for (const part of [v.source, v.target]) {
          if (typeof part !== "string") continue;
          const hit = bad.find((c) => part.includes(c));
          if (hit) { console.error(`${process.argv[1]}: ${name} volume ${JSON.stringify(part)} contains ${JSON.stringify(hit)}, which Coolify refuses`); ok = false; }
        }
      }
    }
    process.exit(ok ? 0 : 1);
  ' "$f" <<<"$json"; then
    status=1
  else
    echo "$f: volume paths are Coolify-safe"
  fi
done
exit $status
