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

# No idea yet → don't launch; tell the model to ask the user, then launch itself.
if [ -z "${IDEA//[[:space:]]/}" ]; then
  echo "NO_IDEA"
  exit 0
fi

# Idempotency guard. This pre-exec fires on EVERY /quickstart-passkeys
# invocation; if the user re-runs the command (e.g. after a plugin reload),
# a second background scaffold would race the first in the same dir — spawning
# duplicate `convex dev` / `next dev` / `convex run --watch` processes and
# colliding ports. Don't launch a second one.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "SCAFFOLD_ALREADY_RUNNING pid=$(cat "$LOCK") log=$LOG"
  exit 0
fi
if [ -f "$LOG" ] && grep -q "BOOTSTRAP_COMPLETE" "$LOG" 2>/dev/null; then
  echo "SCAFFOLD_ALREADY_DONE log=$LOG"
  exit 0
fi

# Detach the heavy work. nohup + disown + </dev/null so it survives the
# pre-exec shell exiting and keeps writing to the log the model will poll.
nohup bash "$DIR/run-bootstrap-bg.sh" "$IDEA" > "$LOG" 2>&1 </dev/null &
PID=$!
disown 2>/dev/null || true
echo "$PID" > "$LOCK"
echo "SCAFFOLD_LAUNCHED pid=$PID log=$LOG"
