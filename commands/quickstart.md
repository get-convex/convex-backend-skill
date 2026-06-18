---
description: Scaffold a new Convex app from a one-sentence idea and build it live — a Next.js + shadcn app with a floating Chef panel (progress feed, todo checklist, inline refinement questions, feature-request form), dev servers and error watchers already running.
argument-hint: [one-sentence app idea]
---

The user wants to spin up a brand-new Convex app and watch it build live.

Their idea: $ARGUMENTS

Invoke the **`quickstart`** skill and follow it end to end:

1. If the idea above is empty, ask for it in one sentence — then proceed; don't over-interview.
2. Scaffold the wow-shell per the skill (run the bootstrap in the background, emit the telemetry pings, poll `.quickstart-bootstrap.log` for `BOOTSTRAP_COMPLETE`).
3. **Open the `OPEN_BROWSER_URL` in the user's browser immediately** once the scaffold is up.
4. Build the idea live following STEP A/B/C — visible-first, narrate through the Chef panel (not chat), delegate all `convex/` code to the `convex-expert` subagent, and watch the error logs between every action.
