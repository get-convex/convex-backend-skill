#!/usr/bin/env bash
# Send THIS coding session's transcript (Claude Code or Codex) to anteater for
# an AI post-mortem that improves the whole quickstart system (runbook +
# bootstrap + skill). Finds the live transcript, compacts + lightly redacts it,
# POSTs to <anteater>/review, then polls <anteater>/review/<id> for findings.
#
# Usage: send-transcript.sh [--idea "<one-line idea>"] [--source claude|codex]
#                           [--base https://<anteater>.convex.site]
# Env overrides: QB_REVIEW_BASE (anteater base url), QB_IDEA, QB_SOURCE.
set -uo pipefail

BASE="${QB_REVIEW_BASE:-https://graceful-tiger-715.convex.site}"
IDEA="${QB_IDEA:-}"
SOURCE="${QB_SOURCE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --idea) IDEA="${2:-}"; shift 2;;
    --source) SOURCE="${2:-}"; shift 2;;
    --base) BASE="${2:-}"; shift 2;;
    *) shift;;
  esac
done

newest_jsonl() { # dir -> newest *.jsonl path (mtime), empty if none
  [[ -d "$1" ]] || return 0
  find "$1" -type f -name '*.jsonl' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1
}

# Locate the live transcript. The session being recorded right now is the most
# recently modified .jsonl, so newest-mtime is a robust locator (no fragile cwd
# encoding). Auto-detect source by whichever harness has the freshest file.
CLAUDE_T="$(newest_jsonl "$HOME/.claude/projects")"
CODEX_T="$(newest_jsonl "$HOME/.codex/sessions")"
[[ -z "$CODEX_T" ]] && CODEX_T="$(newest_jsonl "$HOME/.codex")"

pick_by_source() {
  case "$1" in
    claude) TRANSCRIPT="$CLAUDE_T";;
    codex)  TRANSCRIPT="$CODEX_T";;
  esac
}

if [[ -n "$SOURCE" ]]; then
  pick_by_source "$SOURCE"
else
  # newest of the two wins
  if [[ -n "$CLAUDE_T" && -n "$CODEX_T" ]]; then
    if [[ "$CLAUDE_T" -nt "$CODEX_T" ]]; then SOURCE=claude; else SOURCE=codex; fi
  elif [[ -n "$CLAUDE_T" ]]; then SOURCE=claude
  elif [[ -n "$CODEX_T" ]]; then SOURCE=codex
  fi
  pick_by_source "$SOURCE"
fi

if [[ -z "${TRANSCRIPT:-}" || ! -f "$TRANSCRIPT" ]]; then
  echo "REVIEW_NO_TRANSCRIPT — no Claude (~/.claude/projects) or Codex (~/.codex) .jsonl found"
  exit 2
fi
SESSION_ID="$(basename "$TRANSCRIPT" .jsonl)"
echo "REVIEW_SOURCE=$SOURCE  session=$SESSION_ID  file=$TRANSCRIPT"

# Compact + lightly redact into JSON {source,idea,sessionId,transcript}.
PAYLOAD="$(mktemp -t qb-review-XXXX.json)"
node - "$TRANSCRIPT" "$SOURCE" "$IDEA" "$SESSION_ID" > "$PAYLOAD" <<'NODE'
const fs = require("fs");
const [file, source, idea, sessionId] = process.argv.slice(2);
const CAP = 170_000;          // total chars sent to the model
const PER = 1_200;            // cap per tool result / long block

function redact(s) {
  return String(s)
    .replace(/sk-(ant-)?[A-Za-z0-9_-]{16,}/g, "sk-REDACTED")
    .replace(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "JWT-REDACTED")
    .replace(/([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=REDACTED")
    // strip long base64/data blobs so one screenshot doesn't eat the budget
    .replace(/[A-Za-z0-9+/]{300,}={0,2}/g, "[blob]");
}
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + `…[+${s.length - n}c]` : s; }

function blockToText(b) {
  if (typeof b === "string") return b;
  if (!b || typeof b !== "object") return "";
  if (b.type === "text" || typeof b.text === "string") return b.text || "";
  if (b.type === "tool_use") return `⏵ tool ${b.name || ""} ${clip(JSON.stringify(b.input ?? {}), PER)}`;
  if (b.type === "tool_result") {
    const c = Array.isArray(b.content) ? b.content.map(blockToText).join("\n") : (b.content ?? "");
    return `⏴ result ${clip(c, PER)}`;
  }
  if (b.content) return Array.isArray(b.content) ? b.content.map(blockToText).join("\n") : String(b.content);
  return "";
}

const lines = [];
for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
  if (!raw.trim()) continue;
  let o; try { o = JSON.parse(raw); } catch { lines.push(clip(raw, PER)); continue; }
  const msg = o.message || o;
  const role = msg.role || o.role || o.type || "event";
  if (role === "summary" && o.summary) { lines.push(`SUMMARY: ${o.summary}`); continue; }
  let content = msg.content ?? o.content ?? o.text ?? "";
  let text = Array.isArray(content) ? content.map(blockToText).filter(Boolean).join("\n") : blockToText(content);
  text = (text || "").trim();
  if (!text) continue;
  lines.push(`${String(role).toUpperCase()}: ${text}`);
}

let transcript = redact(lines.join("\n"));
if (transcript.length > CAP) {
  const head = Math.floor(CAP * 0.6), tail = CAP - head;
  transcript = transcript.slice(0, head) + `\n\n…[${transcript.length - CAP} chars elided]…\n\n` + transcript.slice(-tail);
}
process.stdout.write(JSON.stringify({
  source, idea: idea || undefined, sessionId,
  harness: source === "claude" ? "claude-code" : source === "codex" ? "codex" : "other",
  transcript,
}));
NODE

BYTES=$(wc -c < "$PAYLOAD" | tr -d ' ')
echo "REVIEW_PAYLOAD_BYTES=$BYTES"

# Guard against an empty/near-empty transcript (e.g. a freshly-created session
# file that auto-detect grabbed by mtime). Don't bother the endpoint with it.
if [[ "$BYTES" -lt 400 ]]; then
  echo "REVIEW_TRANSCRIPT_TOO_SMALL — '$TRANSCRIPT' has almost no content."
  echo "  Re-run with --source $([ "$SOURCE" = claude ] && echo codex || echo claude), or --source <claude|codex> to force the right harness."
  rm -f "$PAYLOAD"; exit 2
fi

RESP="$(curl -fsS --max-time 30 -X POST "$BASE/review" -H 'content-type: application/json' --data @"$PAYLOAD")" || {
  echo "REVIEW_UPLOAD_FAILED"; rm -f "$PAYLOAD"; exit 3; }
rm -f "$PAYLOAD"
ID="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})')"
if [[ -z "$ID" ]]; then echo "REVIEW_NO_ID resp=$RESP"; exit 3; fi
echo "REVIEW_SUBMITTED id=$ID"

# Poll for the AI review (usually ~10–25s).
for i in $(seq 1 40); do
  S="$(curl -fsS --max-time 15 "$BASE/review/$ID" 2>/dev/null)" || { sleep 3; continue; }
  ST="$(printf '%s' "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).status||"")}catch{}})')"
  if [[ "$ST" == "done" || "$ST" == "error" ]]; then
    echo "REVIEW_DONE status=$ST"
    printf '%s' "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})'
    exit 0
  fi
  sleep 3
done
echo "REVIEW_PENDING id=$ID — still reviewing; check $BASE/review/$ID later"
exit 0
