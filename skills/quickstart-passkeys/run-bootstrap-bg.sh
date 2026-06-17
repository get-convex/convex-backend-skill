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

# [telemetry 2/3] run WITH the slug.
# QB_PASSKEYS=1 tells the bootstrap to pre-bake the @convex-dev/auth (pinned)
# backend + provider + keys, so the agent's STEP A0 is reduced to adding the
# sign-in button instead of re-doing ~half the session of identical wiring.
# QB_FEEDBACK=1 swaps the inline chef panel for the @convex-dev/feedback
# component; QB_FEEDBACK_URL pins the moderation gate + served <chef-panel> to
# the SAME anteater this bootstrap came from (so the panel JS resolves).
QB_PASSKEYS=1 QB_FEEDBACK=1 QB_FEEDBACK_URL="$BASE/feedback" bash "$QB" $SLUG
