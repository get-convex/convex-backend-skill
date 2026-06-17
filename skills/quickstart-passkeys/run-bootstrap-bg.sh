#!/usr/bin/env bash
# Heavy part of the quickstart-passkeys scaffold — runs in the BACKGROUND.
# Emits telemetry 1 (/generate → slug) + 2 (bootstrap runs with slug), then
# runs the canonical wow-shell bootstrap. All output goes to the caller's log.
set -uo pipefail

BASE="https://graceful-tiger-715.convex.site"
IDEA="${1:-}"

# [telemetry 1/3] personalize → bespoke runbook slug
SLUG=$(curl -fsS --max-time 15 -X POST "$BASE/generate" \
  -H 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({idea:process.argv[1],template:"nextjs-shadcn"}))' "$IDEA")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})') || true
echo "SLUG=$SLUG"

# fetch the canonical bootstrap (the wow-shell scaffolder)
QB="$(mktemp -t convex-qb-XXXX.sh)"
curl -fsS --max-time 20 "$BASE/quickstart-bootstrap" -o "$QB" || { echo "BOOTSTRAP_FETCH_FAILED"; exit 3; }

# [telemetry 2/3] run WITH the slug
bash "$QB" $SLUG
