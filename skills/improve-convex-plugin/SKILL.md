---
name: "improve-convex-plugin"
description: "Send THIS coding session's transcript (Claude Code or Codex) to the Convex quickstart backend (anteater) for an AI post-mortem that improves the whole system — the runbook, bootstrap script, and skills. Use after a quickstart run (success or failure), or whenever the user wants to \"send feedback\", \"report how that went\", or \"help improve the quickstart\"."
---

# improve-convex-plugin

This skill ships the current session transcript to anteater's `POST /review`
endpoint, which runs Claude over it and returns structured findings (ambiguous
or wrong instructions, places the agent got stuck or repeated work, tooling
failures, plus what worked) targeted at the runbook / bootstrap / skill /
component. It is a **system-improvement** loop, not end-user feature feedback.

## Consent — ask once, then remember

Sharing a session is **opt-in**, so you ask **once** and never nag again. Run the
helper (below). If it prints `CONSENT_REQUIRED` and exits non-zero, the user has not
yet chosen — **stop and ask them**, verbatim intent:

> "To improve Convex's tools, this sends a **redacted** copy of your session to
> the Convex team. Secrets are stripped first. Share it — **Always** (remember and
> never ask again), **Just this once**, or **Never**?"

Do NOT decide for them and do NOT send anything until they answer. Then re-run the
helper with exactly the flag matching their choice:

- **Always** → `--consent always` (persists to `~/.convex/improve-consent`; future
  sessions send with no prompt)
- **Just this once** → `--consent once` (shares only this session; not stored, so a
  later session will ask again)
- **Never** → `--consent never` (persists; never offered again; re-enable by
  deleting that file)

Once consent is `always`, later sessions skip the question entirely. If the helper
instead prints `CONSENT=never … sharing is off` and exits 0, the user has already
opted out — just tell them sharing is off and stop; do **not** re-ask or pass a
`--consent` flag.

## How to run it

The helper is **served from the Convex backend** (so consent-gate and redaction
fixes ship instantly, with no plugin update). Curl it and pipe to bash — it
auto-detects Claude vs Codex by finding the freshest transcript, compacts +
redacts it, uploads, and polls for the review:

```
curl -fsSL "https://basic-anteater-667.convex.site/send-transcript" | bash -s -- --idea "<the one-line app idea from this session>"
```

Append the consent flag once the user has chosen, e.g. `… | bash -s -- --idea "…" --consent always`.

- Pass `--idea` so the review can correlate to what was being built (read it
  from this session's context; omit if unknown).
- `--source claude|codex` forces the harness; otherwise it auto-detects.
- The URL above already targets the right anteater; `--base https://<anteater>.convex.site`
  (or `QB_REVIEW_BASE`) overrides it if needed.

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
