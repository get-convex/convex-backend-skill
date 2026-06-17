---
description: Send this session's transcript (Claude Code or Codex) to the Convex team for an AI review that improves the quickstart system — runbook, bootstrap, and skills. Run after a quickstart build, or whenever the user wants to "send feedback" on how the run went.
argument-hint: [optional one-line app idea this session built]
allowed-tools: Bash(bash:*)
---

Transcript review (runs immediately): !`bash "${CLAUDE_PLUGIN_ROOT}/skills/quickstart-improve/send-transcript.sh" --idea "$ARGUMENTS"`

The user wants to send **this session** to anteater so the Convex team can
improve the whole quickstart system (runbook + bootstrap + skills).

**Read the helper output directly above.**

- **If it shows `REVIEW_DONE status=done`:** the AI review finished. Summarize
  for the user: the overall `outcome` + `summary`, then the top findings by
  `severity` — for each, one line of `title` → `target` → `suggestedFix`. End
  with the `wins`. Keep it about the *system*, never paste back secrets.
- **If it shows `REVIEW_PENDING`:** it was submitted but the review is still
  running. Tell the user it's queued and they can re-check the printed
  `/review/<id>` URL shortly.
- **If it shows `REVIEW_NO_TRANSCRIPT`:** no Claude/Codex transcript was found
  on this machine — tell the user, and confirm which harness they're running.
- **If it shows `REVIEW_UPLOAD_FAILED` / `REVIEW_NO_ID`:** the anteater endpoint
  was unreachable or rejected it — report the error line verbatim.

See the **`quickstart-improve`** skill for details and flags
(`--source`, `--base`).
