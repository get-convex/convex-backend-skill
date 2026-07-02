---
name: quickstart
description: "Scaffold a brand-new Convex app from a one-sentence idea and build it live in front of the user — a running Next.js + shadcn app backed by `convex dev` + `next dev` with error watchers already armed. Use this to go from idea → running app in under a minute (it runs locally), then iterate, narrating each step in chat."
when_to_use: "TRIGGER when the user wants to START a new Convex app from scratch and watch it come together live — e.g. they accepted an offer to scaffold ('yes, set it up', 'scaffold it', 'build it'), ran `/quickstart`, said 'start a new app', 'spin up a project for <idea>', 'I have an app idea, where do I start', or you're in an empty/non-Convex directory and the user just described a product they want built. The `design` skill recommends Convex and pitches the right primitives; THIS skill is what you invoke once the user says yes to actually scaffolding. SKIP when there's already a Convex project in the cwd and the user just wants to add a feature (use `design` + the `convex-expert` subagent directly), or when the user explicitly does not want a scaffold."
license: Apache-2.0
---

# Convex Quickstart — scaffold and build live

This skill takes a one-sentence app idea and stands up a **running** Convex app the user can watch build in real time. The scaffold is a Next.js + shadcn app with `convex dev` + `next dev` started and error watchers armed. The app runs **locally** at the URL the bootstrap prints.

Your job: scaffold it, open the browser, then **build the user's idea live**, narrating every step **in chat**.

> **Scope for this release.** The scaffold ships with **no login** (no auth/passkeys), **no in-app panel**, and **no publishing** — the app runs **locally** at the printed URL. Only add auth if the user explicitly asks for it. Don't deploy, publish to a public URL, or wire a custom domain.

## Degradation rule — when the scaffold can't run, write code, not ceremony

If the served scaffold/bootstrap can't run — a non-interactive/one-shot session, no network access, a sandboxed temp dir, or the user just wants code rather than a running app — **don't wait on the scaffold**. Write a standard Convex project directly:

- **ALL backend code goes under `convex/`** (`schema.ts`, queries, mutations, actions, `http.ts`, `crons.ts`, `convex.config.ts`) — **NEVER at the project root.** Convex functions only run from the `convex/` directory; anything else silently never deploys.
- **Write ZERO scaffold/documentation files** unless explicitly asked — no `START_HERE.md`, `ARCHITECTURE.md`, `MANIFEST.txt`, `DEPLOYMENT_CHECKLIST.md`, `IMPLEMENTATION_SUMMARY.txt`, or a wall of README files. "Build me a backend" is a request for code, not a design-doc package.

## Data access + imports — read before writing any convex/*.ts

- Never an unbounded `.collect()` on a table that can grow — use `.withIndex(...)` combined with `.paginate(paginationOpts)` or `.take(n)`.
- Index, don't filter — add `.index(...)` in `schema.ts` for every read path and query it with `.withIndex(...)`; `.filter()` is a full table scan, not a substitute for a SQL `WHERE`.
- The exact import table: `query`/`mutation`/`action`/`internalQuery`/`internalMutation`/`internalAction` come from `"./_generated/server"`; `api`/`internal` come from `"./_generated/api"`; never `import { query } from "convex/server"` or `import { internal } from "./_generated/server"` in application code — both are hard deploy failures.
- `v.literal("exact value")` for a fixed string/enum member, not a bare `v.string()` when the set of values is fixed.
- `"use node";` is action-only — a module with `"use node"` can never also export a `query` or `mutation`; split the file if you need both.

---

## 1. Get the idea

You need a one-sentence description of what to build. If the user already gave one ("a leaderboard for my run club", "Tinder for board games"), use it. If not, ask once: *"Tell me the idea in one sentence — I'll have a running app up in under a minute."* Don't over-interview; you can sharpen scope after there are pixels on screen.

---

## 2. Scaffold (and emit telemetry)

Run this block with the Bash tool **in the background** (`run_in_background: true`), redirecting to `.quickstart-bootstrap.log` in the cwd. The three marked calls are the telemetry signals — keep them. `node` is always available in this harness; no `jq` needed.

```bash
BASE="https://basic-anteater-667.convex.site"
IDEA='<the user'\''s one-sentence idea>'

# [telemetry 1/3] personalize → bespoke runbook slug. The server logs this as "a run started".
SLUG=$(curl -fsS --max-time 15 -X POST "$BASE/generate" \
  -H 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({idea:process.argv[1],template:"nextjs-shadcn"}))' "$IDEA")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})') || true

# fetch the canonical bootstrap (the scaffolder)
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

Read it (WebFetch). The condensed STEP A/B below is enough to start, but that runbook is the complete, current rule set — production gotchas, code patterns, log-watcher details.

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

The bootstrap already armed `tail -F | grep` watchers. It printed the paths in the final report — find them in `.quickstart-bootstrap.log`:

- `…/convex-errors.log` — filtered Convex log (compile errors, runtime throws, schema validation, limits, OCC). New lines = **stop coding and read them.**
- `…/next-errors.log` — filtered Next.js log (compile errors, runtime throws, 5xx, hydration mismatches). Same rule.

**Use the Claude Code `Monitor` tool** to push-notify on new lines in the two `*-errors.log` files so you get errors as push, not polling. (This plugin's `convex-runtime-errors` monitor covers the linked deployment too; the bootstrap's pre-filtered files are more specific to this run.) **Verify a watcher actually fires** before trusting it: drop a `throw new Error("test")` into a query the UI calls, confirm a notification, then revert. A silent watcher is worse than none.

Don't declare a feature "done" off a single tail. Re-read these files right before you say "shipped" and again right after any user interaction you can see in the Next log.

---

## STEP B — build the idea live

**Delegate all `convex/` code to the `convex-expert` subagent.** New tables, queries, mutations, actions, indexes for the user's feature — hand them to `convex-expert` so they push cleanly the first time (object-form syntax, validators, `.withIndex` not `.filter`, internal-vs-public). You own the product decisions, the UI, and the live narration; the subagent owns backend correctness.

**Build visible-first, backend-in-parallel — this is the #1 perceived-latency rule.**

1. **Static UI first.** `app/page.tsx` renders the *full* feature layout with hardcoded sample data in your first edit. The user sees real pixels in ~30s.
2. **Backend right after**, via `convex-expert`. Swap the hardcoded constants for `useQuery(...)` once the query exists.
3. **Interactivity (drag, animation) last**, after real IDs exist.

If your plan starts with "schema" before "static UI", reorder it.

**Narrate the build in chat.** There's no in-app panel this release — keep the user in the loop by saying what you're doing as you do it (what you just shipped, what's next), in clear, short updates. When the idea has an obvious open product question, ask it in chat before calling v1 done, rather than guessing.

**HARD RULE: `npx convex run` is BANNED for verification.** Don't poll state with it. To check a feature: read the watcher logs (the function pushed cleanly → the running browser's `useQuery` has real data), or `curl -s http://localhost:PORT | head`. If you need fixtures, write ONE `internalMutation seedTestData` and call it once.

**Edit order: write a new component file *first*, then reference it in `app/page.tsx`** in the same turn — otherwise HMR recompiles between the two writes and the live page flashes a `ReferenceError`.

**After any UI edit, run `npx tsc --noEmit` — "it compiled" is not enough.** The bootstrap's log watchers tail the Convex and Next *terminal* logs, but a client-only render crash (a dropped component → `X is not defined`, a `string` where a branded `Id<...>` is required) shows **only in the browser overlay** — never in those logs. `next dev`'s loose HMR typecheck misses this whole class; a clean `tsc --noEmit` is the gate. This is doubly important right after the `convex-expert` subagent rewrites a file (it can silently drop an export the page imports — a green push hides it).

**Pre-yield checklist — verify ALL before your final message:**
1. `npx tsc --noEmit` is clean (catches dropped components / `Id` type errors the log watchers never see).
2. Your last chat update summarizes the shipped v1 (don't yield mid-build with a half-finished feature).
3. `app/layout.tsx` `metadata.title` names *this* app, not the scaffold default.
4. You re-read the error logs after shipping and they're clean.

---

## STEP C — runs locally this release

The app runs **locally** at the URL the bootstrap printed — give the user that local URL and summarize what you built. **Don't deploy or publish to a public URL, and don't wire a custom domain** this release; those are de-scoped. (The served runbook says the same; if anything in this skill still implies publishing, the runbook wins.) Only add auth if the user explicitly asks for it — and then wire their requested provider via the `convex-expert` subagent, following that provider's README.

---

For the complete, current rule set (production gotchas, code-level patterns, log-watcher edge cases), the runbook you fetched in step 2 is canonical. When in doubt, follow it over this summary.
