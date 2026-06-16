---
description: EXPERIMENTAL passkeys variant — scaffold a new Convex app with passkey (WebAuthn) login and build it live. Fires the background scaffold IMMEDIATELY (before any reasoning), then preps the passkey wiring while it installs.
argument-hint: [one-sentence app idea]
allowed-tools: Bash(bash:*)
---

Scaffold launch (runs before anything else): !`bash "${CLAUDE_PLUGIN_ROOT}/skills/quickstart-passkeys/launch-bootstrap.sh" "$ARGUMENTS"`

The user wants an **experimental passkeys-enabled** Convex app, built live.

Their idea: $ARGUMENTS

**Read the launch output directly above before doing anything.**

- **If it shows `SCAFFOLD_LAUNCHED`:** the wow-shell bootstrap is ALREADY running in the background, writing to `.quickstart-bootstrap.log` (telemetry 1+2 already fired inside it). **Do NOT run the bootstrap again** — that's the whole point of the head start. Instead, use the time productively: invoke the **`quickstart-passkeys`** skill, read it, and prep STEP A0 (the passkey wiring) in your head while the scaffold installs (~45–120s). Then **poll `.quickstart-bootstrap.log`** until `BOOTSTRAP_COMPLETE` appears. Sanity-check the log is actually growing within ~10s; if it's empty/stalled or shows `BOOTSTRAP_FETCH_FAILED`, the background job died or the server was unreachable — fall back to launching it yourself per the skill's step 2.
- **If it shows `NO_IDEA`:** the idea was empty. Ask the user for a one-sentence idea, then follow the `quickstart-passkeys` skill from step 2 (you launch the bootstrap yourself).

Then follow the **`quickstart-passkeys`** skill end to end: do STEP A0 (force-install the pinned passkeys auth build `https://pkg.pr.new/@convex-dev/auth@ed481f5` and wire WebAuthn) right after `BOOTSTRAP_COMPLETE`, read the personalized runbook (telemetry 3 — use the `SLUG=` printed in the log), open `OPEN_BROWSER_URL` immediately, then build the idea live per STEP A/B/C — narrate through the Chef panel (not chat), delegate all `convex/` code to the `convex-expert` subagent, and watch the error logs between every action.
