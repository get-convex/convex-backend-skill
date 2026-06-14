---
name: quickstart
description: "Scaffold a brand-new Convex app from a one-sentence idea and build it live in front of the user — a Next.js + shadcn 'wow-shell' with a floating Chef panel (live progress feed, pulsing todo checklist, inline refinement questions, and a feature-request form), backed by `convex dev` + `next dev` with error watchers already armed. Use this to go from idea → running, watchable app in under a minute, then iterate."
when_to_use: "TRIGGER when the user wants to START a new Convex app from scratch and watch it come together live — e.g. they accepted an offer to scaffold ('yes, set it up', 'scaffold it', 'build it'), ran `/quickstart`, said 'start a new app', 'spin up a project for <idea>', 'I have an app idea, where do I start', or you're in an empty/non-Convex directory and the user just described a product they want built. The `design` skill recommends Convex and pitches the right primitives; THIS skill is what you invoke once the user says yes to actually scaffolding. SKIP when there's already a Convex project in the cwd and the user just wants to add a feature (use `design` + the `convex-expert` subagent directly), or when the user explicitly does not want a scaffold."
license: Apache-2.0
---

# Convex Quickstart — scaffold and build live

This skill takes a one-sentence app idea and stands up a **running** Convex app the user can watch build in real time. The scaffold is a Next.js + shadcn **"wow-shell"**: a floating **Chef panel** bubble (lower-right) that is the user's window into the build — a live progress feed, a pulsing todo checklist, inline clarifying questions, and a feature-request form. Behind it, five Convex modules (`progress`, `todos`, `refinementQuestions`, `featureRequests`, plus `schema`) are pre-written, and `convex dev` + `next dev` are started with error watchers armed.

Your job: scaffold it, open the browser, then **build the user's idea live**, narrating every step through the Chef panel — not through chat.

---

## 1. Get the idea

You need a one-sentence description of what to build. If the user already gave one ("a leaderboard for my run club", "Tinder for board games"), use it. If not, ask once: *"Tell me the idea in one sentence — I'll have a running app up in under a minute."* Don't over-interview; the refinement questions (STEP B) are where you sharpen scope, after there are pixels on screen.

---

## 2. Scaffold the wow-shell (and emit telemetry)

Run this block with the Bash tool **in the background** (`run_in_background: true`), redirecting to `.quickstart-bootstrap.log` in the cwd. The three marked calls are the telemetry signals — keep them. `node` is always available in this harness; no `jq` needed.

```bash
BASE="https://basic-anteater-667.convex.site"
IDEA='<the user'\''s one-sentence idea>'

# [telemetry 1/3] personalize → bespoke runbook slug. The server logs this as "a run started".
SLUG=$(curl -fsS --max-time 15 -X POST "$BASE/generate" \
  -H 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({idea:process.argv[1],template:"nextjs-shadcn"}))' "$IDEA")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})') || true

# fetch the canonical bootstrap (the wow-shell scaffolder)
QB="$(mktemp -t convex-qb-XXXX.sh)"
curl -fsS --max-time 20 "$BASE/quickstart-bootstrap" -o "$QB" || { echo "BOOTSTRAP_FETCH_FAILED"; exit 3; }

# [telemetry 2/3] run WITH the slug → the server sees the args.json fetch = "bootstrap actually ran".
# (Omit the slug only if /generate failed; the scaffold still works, just without per-run telemetry.)
bash "$QB" $SLUG
```

Then **poll `.quickstart-bootstrap.log`** every few seconds until it contains the line `BOOTSTRAP_COMPLETE` (the scaffold takes ~45–120s — npm install dominates). If it instead shows `BOOTSTRAP_FETCH_FAILED`, the server was unreachable: tell the user and stop.

While you wait, do something useful: sketch the data model for the idea in your head and read the runbook in step 3 — **do not run any command that touches the scaffold directory until `BOOTSTRAP_COMPLETE` appears.**

### [telemetry 3/3] read the personalized runbook

Once `BOOTSTRAP_COMPLETE` is in the log, fetch the full ruleset (this fetch is the third telemetry signal). Use the bespoke URL if you got a slug, otherwise the generic one:

- bespoke: `https://basic-anteater-667.convex.site/q/<SLUG>.md?telemetry=1`
- generic: `https://basic-anteater-667.convex.site/quickstart-with-telemetry.md`

Read it (WebFetch). The condensed STEP A/B/C below is enough to start, but that runbook is the complete, current rule set — production gotchas, code patterns, log-watcher details.

---

## 3. Open the browser — first thing after the scaffold

The log prints a block like:

```
OPEN_BROWSER_URL: http://localhost:PORT
```

**Open that URL in the user's browser immediately** (your browser-open tool, or post it as a clickable link), *before* you start building. The whole point is that the user watches the app come together. The bash `open` in the script may have been a no-op in your sandbox — don't assume it worked.

The log's tail (everything from `═══ STEP A` onward) is your runbook, with concrete file paths for this run (the watcher log dir, the Convex/Next error logs). Read it. The rules below summarize it.

---

## STEP A — watch the logs between every action

The bootstrap already armed `tail -F | grep` watchers. It printed three paths in the final report — find them in `.quickstart-bootstrap.log`:

- `…/convex-errors.log` — filtered Convex log (compile errors, runtime throws, schema validation, limits, OCC). New lines = **stop coding and read them.**
- `…/next-errors.log` — filtered Next.js log (compile errors, runtime throws, 5xx, hydration mismatches). Same rule.
- `…/feature-requests.log` — a reactive `featureRequests:listPublic` dump. Diff each new JSON against the previous to find new work. **Poll this file directly — never a mirror copy** (bash redirects block-buffer and stall at `[]`).

**Use the Claude Code `Monitor` tool** to push-notify on new lines in the two `*-errors.log` files so you get errors as push, not polling. (This plugin's `convex-runtime-errors` monitor covers the linked deployment too; the bootstrap's pre-filtered files are more specific to this run.) **Verify a watcher actually fires** before trusting it: drop a `throw new Error("test")` into a query the UI calls, confirm a notification, then revert. A silent watcher is worse than none.

Don't declare a feature "done" off a single tail. Re-read these files right before you say "shipped" and again right after any user interaction you can see in the Next log.

---

## STEP B — build the idea live

**Delegate all `convex/` code to the `convex-expert` subagent.** New tables, queries, mutations, actions, indexes for the user's feature — hand them to `convex-expert` so they push cleanly the first time (object-form syntax, validators, `.withIndex` not `.filter`, internal-vs-public). You own the product decisions, the UI, and the live narration; the subagent owns backend correctness.

**Build visible-first, backend-in-parallel — this is the #1 perceived-latency rule.**

1. **Static UI first.** `app/page.tsx` renders the *full* feature layout with hardcoded sample data in your first edit. The user sees real pixels in ~30s.
2. **Backend right after**, via `convex-expert`. Swap the hardcoded constants for `useQuery(...)` once the query exists.
3. **Interactivity (drag, animation) last**, after real IDs exist.

If your todo list starts with "schema" before "static UI", reorder it.

**Narrate through the Chef panel, not chat.** These five calls are what make the build feel alive. **Prefer the Convex MCP `run` tool** (`mcp__convex__run`) for them — it skips the `npx convex run` CLI cold-start. (CLI is the fallback if MCP isn't wired.)

- **Seed a checklist first**, ordered visible-first (4–6 short items). It pulses in the panel:
  `todos:plan` → `{"items":["Static layout with sample data","Schema + queries","Wire layout to live data","Interactivity","Polish & ship"]}`
  Advance **one at a time**, immediately after each step finishes — never chain advances (the bar would jump and flicker): `todos:advance` → `{}`.
- **Post progress every time you touch code** (floor, not option — if >~30s pass silently, you're behind):
  `progress:post` → `{"message":"Wiring schema for the live board","kind":"step"}`. Kinds: `step` (in-flight), `shipped` (done), `note` (other). Keep messages ~60 chars.
- **Ask ≥1 refinement question before calling v1 done** — even on a complete-looking prompt. It renders inline in the panel; do NOT also ask in chat:
  `refinementQuestions:ask` → `{"text":"Lean playful with bold color, or restrained and elegant?"}`
  Then **poll** `…/refinement-questions.log` (or `refinementQuestions:listOpen`) for the answer — the user's submit flips state to `answered`. There's no push for file changes, so keep the turn open with a poll loop (~2 min) rather than yielding while a question is open.
- **Process feature requests** as they land in `…/feature-requests.log`. For each new `{_id,title,description}`: `featureRequests:setState`→`inProgress`, build it, replace the matching placeholder in `app/page.tsx`, `featureRequests:setState`→`completed`. Don't batch — the badge transitions are the user's feedback loop.

**HARD RULE: `npx convex run` is BANNED for verification.** Don't poll state with it. To check a feature: read the watcher logs (the function pushed cleanly → the running browser's `useQuery` has real data), or `curl -s http://localhost:PORT | head`. If you need fixtures, write ONE `internalMutation seedTestData` and call it once. The only sanctioned per-step `run` calls are the panel mutations above (and prefer MCP for those).

**Never remove `<ChefPanel />` from `app/layout.tsx`, never delete `app/_chef-panel.tsx`.** It's the user's only channel into the build — mounted in the layout on purpose so redesigning `app/page.tsx` leaves it intact. Don't unmount it, hide it, or "move it to a tab."

**Edit order: write a new component file *first*, then reference it in `app/page.tsx`** in the same turn — otherwise HMR recompiles between the two writes and the live page flashes a `ReferenceError`.

**After any UI edit, run `npx tsc --noEmit` — "it compiled" is not enough.** The bootstrap's log watchers tail the Convex and Next *terminal* logs, but a client-only render crash (a dropped component → `X is not defined`, a `string` where a branded `Id<...>` is required) shows **only in the browser overlay** — never in those logs. `next dev`'s loose HMR typecheck misses this whole class; a clean `tsc --noEmit` is the gate. This is doubly important right after the `convex-expert` subagent rewrites a file (it can silently drop an export the page imports — a green push hides it).

**Pre-yield checklist — verify ALL before your final message:**
1. `npx tsc --noEmit` is clean (catches dropped components / `Id` type errors the log watchers never see).
2. `todos:listAll` shows every item `done` (a lingering `active` item reads as "agent quit halfway").
3. Your last `progress:post` was `kind:"shipped"` with a v1 summary.
4. `app/layout.tsx` `metadata.title` names *this* app, not the scaffold default.
5. `refinementQuestions:listOpen` shows zero open rows.
6. You re-read the error logs and tailed feature-requests for ~60s after shipping (users click "request a feature" in the first minute; don't yield before then).

---

## STEP C — publish (only when the user asks)

The dev scaffold does **not** pre-wire deployment. When the user says "deploy it" / "publish" / "share with my friend":

```bash
npm install @convex-dev/static-hosting
npx @convex-dev/static-hosting setup     # interactive wizard — USE THIS, see note
npx convex login                         # if needed
npx convex deploy -y                     # the -y is required (see note); pushes backend to prod
npx @convex-dev/static-hosting upload --build --prod --dist ./out   # build + upload the static site
```

The deploy prints the public `https://<deployment>.convex.site` URL — pass it back to the user. **Don't run this proactively** — the dev bootstrap skips it on purpose (the install step had a hang rate).

Three sharp edges this avoids (all observed in real runs):
- **Use the interactive `setup` wizard — do NOT hand-copy the static-hosting README's "Manual Setup" snippet.** The README is out of date vs the CLI: it exports only the singular functions, but `upload` calls the plural batch functions (`generateUploadUrls`, `recordAssets`) plus `getCurrentDeployment`, so a manual setup fails with `Could not find function for 'staticHosting:generateUploadUrls'`. The wizard generates the correct `convex/staticHosting.ts`.
- **`npm run deploy` / the wizard's deploy shells out to `npx convex deploy` *without* `-y`**, which then dies with `Cannot prompt for input in non-interactive terminals`. Run the two commands above yourself with `-y` instead of `npm run deploy`.
- **Auth keys don't carry to prod.** If the app uses Convex Auth, set `JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` on the **prod** deployment before this (set `SITE_URL` to the public origin, not localhost). Pass a multi-line PEM as `"$(cat key.pem)"` — `env set` mangles pasted newlines silently. Then verify with `npx convex env list --prod`.

---

For the complete, current rule set (production gotchas, code-level patterns, log-watcher edge cases), the runbook you fetched in step 2 is canonical. When in doubt, follow it over this summary.
