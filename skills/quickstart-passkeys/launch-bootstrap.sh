#!/usr/bin/env bash
# Fast launcher: kicks off run-bootstrap-bg.sh in the background and returns
# IMMEDIATELY, so the model regains control while the scaffold installs.
# Invoked from the /quickstart-passkeys command's `!` pre-execution block,
# BEFORE the model reasons. Idea is $1 (may be empty).
set -uo pipefail

IDEA="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=".quickstart-bootstrap.log"
LOCK=".quickstart-bootstrap.lock"

# Idempotency guard FIRST — before the NO_IDEA check. This pre-exec fires on
# EVERY /quickstart-passkeys invocation, and the skill may re-emit the launch
# block; a re-fire often arrives with NO idea. If a scaffold is already running
# or done in this dir, say so clearly (never NO_IDEA, never a second scaffold) —
# a second one races the first and spawns duplicate convex dev / next dev /
# watchers and collides ports.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "SCAFFOLD_ALREADY_RUNNING pid=$(cat "$LOCK") log=$LOG — do NOT launch again; poll $LOG for BOOTSTRAP_COMPLETE"
  exit 0
fi
if [ -f "$LOG" ] && grep -q "BOOTSTRAP_COMPLETE" "$LOG" 2>/dev/null; then
  echo "SCAFFOLD_ALREADY_DONE log=$LOG — do NOT launch again; read the runbook from the log tail"
  exit 0
fi

# Resolve the idea from a spec file when the arg is empty or a "build the idea
# in this dir" meta-instruction. Without this, a vague arg like "implement the
# app idea in this directory" reaches personalization verbatim and comes back
# "<UNKNOWN>" — the app then scaffolds as `unknown/` with an <UNKNOWN> title.
is_meta_idea() {
  printf '%s' "$1" | grep -qiE 'this (dir|directory|folder|repo)|the (app )?idea (file|here|in)|implement.*(spec|idea|readme|file)|build (the|this|what).*(here|file|spec|idea)|in here'
}
if [ -z "${IDEA//[[:space:]]/}" ] || is_meta_idea "$IDEA"; then
  for f in irlappidea.md IDEA.md idea.md APPIDEA.md app-idea.md SPEC.md spec.md README.md; do
    if [ -f "$f" ]; then
      IDEA="$(head -c 4000 "$f")"
      echo "IDEA_FROM_FILE=$f (the arg was empty/meta; using this spec as the idea)"
      break
    fi
  done
fi

# Only now, with no scaffold in flight and the idea resolved, does empty matter.
if [ -z "${IDEA//[[:space:]]/}" ]; then
  echo "NO_IDEA"
  exit 0
fi

# Detach the heavy work. nohup + disown + </dev/null so it survives the
# pre-exec shell exiting and keeps writing to the log the model will poll.
nohup bash "$DIR/run-bootstrap-bg.sh" "$IDEA" > "$LOG" 2>&1 </dev/null &
PID=$!
disown 2>/dev/null || true
echo "$PID" > "$LOCK"
echo "SCAFFOLD_LAUNCHED pid=$PID log=$LOG"
