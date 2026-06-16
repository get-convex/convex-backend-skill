#!/usr/bin/env bash
# Fast launcher: kicks off run-bootstrap-bg.sh in the background and returns
# IMMEDIATELY, so the model regains control while the scaffold installs.
# Invoked from the /quickstart-passkeys command's `!` pre-execution block,
# BEFORE the model reasons. Idea is $1 (may be empty).
set -uo pipefail

IDEA="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=".quickstart-bootstrap.log"

# No idea yet → don't launch; tell the model to ask the user, then launch itself.
if [ -z "${IDEA//[[:space:]]/}" ]; then
  echo "NO_IDEA"
  exit 0
fi

# Detach the heavy work. nohup + disown + </dev/null so it survives the
# pre-exec shell exiting and keeps writing to the log the model will poll.
nohup bash "$DIR/run-bootstrap-bg.sh" "$IDEA" > "$LOG" 2>&1 </dev/null &
PID=$!
disown 2>/dev/null || true
echo "SCAFFOLD_LAUNCHED pid=$PID log=$LOG"
