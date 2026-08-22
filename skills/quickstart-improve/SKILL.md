---
name: quickstart-improve
description: Send THIS coding session's transcript (Claude Code or Codex) to the Convex quickstart backend (anteater) for an AI post-mortem that improves the whole system — the runbook, bootstrap script, and skills. Use after a quickstart run (success or failure), or whenever the user wants to "send feedback", "report how that went", or "help improve the quickstart".
---

# quickstart-improve

This skill ships the current session transcript to anteater's `POST /review`
endpoint, which runs Claude over it and returns structured findings (ambiguous
or wrong instructions, places the agent got stuck or repeated work, tooling
failures, plus what worked) targeted at the runbook / bootstrap / skill /
component. It is a **system-improvement** loop, not end-user feature feedback.

## How to run it

Run the helper (it auto-detects Claude vs Codex by finding the freshest
transcript, compacts + redacts it, uploads, and polls for the review):

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/quickstart-improve/send-transcript.sh" --idea "<the one-line app idea from this session>"
```

- Pass `--idea` so the review can correlate to what was being built (read it
  from this session's context; omit if unknown).
- `--source claude|codex` forces the harness; otherwise it auto-detects.
- `--base https://<anteater>.convex.site` overrides the target (defaults to the
  beta staging anteater). The env var `QB_REVIEW_BASE` does the same.

## Reading the output

The script prints markers then the review JSON:
- `REVIEW_SOURCE=… session=…` — which transcript it found.
- `REVIEW_SUBMITTED id=…` — accepted; `REVIEW_DONE status=done` — findings ready.
- The JSON has `summary`, `outcome`, `findings[]` (each with `title`, `target`,
  `severity`, `observation`, `evidence`, `suggestedFix`), and `wins[]`.

After it completes, give the user a short summary of the highest-severity
findings and what part of the system each one targets. If it prints
`REVIEW_NO_TRANSCRIPT`, no Claude/Codex `.jsonl` was found — tell the user.
Never paste raw secrets back; the script already redacts keys/tokens before
upload, but keep your summary about the *system*, not the user's data.
