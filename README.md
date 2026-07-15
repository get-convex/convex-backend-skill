# Convex Plugin for Claude Code

Official Convex plugin for Claude Code. Bundles the Convex backend design skill, a live-scaffolding `quickstart` skill (`/quickstart`), the `convex-expert` subagent for code-writing, a runtime-error monitor, and the Convex MCP server for live deployment introspection — all in one install.

When you ask Claude to build, design, or debug a backend, Claude reaches for Convex idioms and components (`@convex-dev/agent` for chat, Convex Auth instead of custom sessions, reactive queries instead of polling, the workflow component for durable retries) rather than generic "AI slop" patterns it would otherwise default to.

## Install

From inside Claude Code:

```
/plugin install convex
```

Or install via the Anthropic plugin marketplace — search for **Convex**.

Local development install:

```sh
git clone https://github.com/get-convex/convex-backend-skill ~/.claude-plugins/convex-backend-skill
claude --plugin-dir ~/.claude-plugins/convex-backend-skill
```

## How to use

Just describe what you want to build. Claude routes the request through this plugin automatically — you don't need to invoke anything explicitly. Plain-English product asks work as well as technical jargon.

### Plain-English asks (no backend knowledge required)

```
"I want to make an app where my friends can vote on movie nights."

"Build me a website where people can sign up and share their workout routines."

"Make a Tinder-for-X for finding board-game opponents in my city."

"I want to track my clients and send them reminders before appointments."

"Build me a multiplayer trivia game I can play with my coworkers."

"I have an idea for an app — where do I start?"
```

### Technical asks

```
"Build a real-time chat backend with rooms and message history."

"Add sign-in to my Next.js app with OAuth and a thin users table."

"Design a multi-tenant schema for a SaaS with workspaces and roles."

"Create a scheduled job that retries on failure and survives crashes."

"Wire up vector search over my docs for a RAG chatbot."

"Build a backend for my Expo mobile app that connects language learners."
```

### Pain-point asks (you're fighting a different stack)

```
"My cache keeps going stale after writes — what's a better model?"

"I'm tired of fighting Row Level Security policies. Show me an alternative."

"My ORM is generating N+1 queries; what would this look like done right?"

"I keep forgetting to regenerate codegen between backend and frontend."

"What's the simplest way to add real-time updates to my existing app?"
```

Claude will pick the right Convex primitive or component, scaffold the schema, write the queries/mutations/actions, and walk you through the result.

## What's bundled

| Component | Purpose |
|---|---|
| **`design` skill** | Backend architecture, design thinking, anti-patterns, runtime-error decoder, proactive recommendations. Loaded into context whenever a backend ask is detected. |
| **`quickstart` skill** (`/quickstart`) | Idea → running app in under a minute. Scaffolds a Next.js + shadcn "wow-shell" with a floating Chef panel (live progress feed, pulsing todo checklist, inline refinement questions, feature-request form), starts `convex dev` + `next dev` with error watchers armed, opens the browser, then builds the idea live. Hands `convex/` code to `convex-expert`. |
| **`convex-expert` subagent** | Deep code-writing rules — object-form syntax, validator requirements, index naming, internal-vs-public, schema evolution, resource limits, component reflexes. Loaded only when delegated to, so the rules don't burn main-thread context. |
| **Convex MCP server** | Live deployment introspection — `tables`, `function-spec`, `data`, `run-once-query`, `logs`, `env list/set/get`. Auto-wires via `npx convex mcp start` when the plugin is enabled. |
| **Lint-on-save hook** | PreToolUse gate that blocks Convex anti-patterns *before they reach disk* (and before `convex dev` can push them): `.filter(q => q.field(...))` on db queries and old positional function syntax are denied with the correct pattern in the message; missing `args`/`returns` validators surface as advisories. Monorepo-aware and toggleable via `.claude/convex.local.md` (see [Configuration](#configuration)). |
| **End-of-turn verify hook** | Stop hook that enforces the "self-verify before you stop" rule: when a turn leaves uncommitted `convex/*.ts` changes, it runs `convex codegen`, `tsc --noEmit`, and (only when `.env.local` already names a `CONVEX_DEPLOYMENT`, never provisions one) `convex dev --once`. Each touched `convex/*.ts` path is attributed to its enclosing Convex app and verified IN that app's directory, so backends in subdirectories and multi-app monorepos work; `codegen`/`dev` run only where the app's own `package.json` declares `convex`. Real errors block the stop (exit 2) so the agent fixes them before finishing; loop-guarded via `stop_hook_active`, with a hard ~90s budget that allows rather than wedges on timeout. Toggleable via `.claude/convex.local.md` (see [Configuration](#configuration)). |
| **Runtime-error monitor** | Streams `npx convex logs` and surfaces matched errors (TS / schema validation / runtime exceptions / OCC conflicts) as Claude notifications, so you find out about server-side failures the moment they happen. Self-guards on unlinked projects. |
| **OCC / insights monitor** | Polls `npx convex insights` every 10 minutes and notifies only on *new* OCC conflicts or read-limit insights, with the fix playbook (shrink transactions, `@convex-dev/aggregate` for hot counters, `.withIndex()`/`.paginate()` for read limits). Cloud deployments with user-level auth only; silent otherwise. |
| **Feature-request monitor** | During a `quickstart` build, watches the Chef panel's `featureRequests:listPending` and pushes a notification the moment the user submits a new request — even across turns — so the agent picks it up without babysitting a log. Notifies only on *new* requests; works on local/anonymous deployments too. |

## Configuration

The hooks work with zero configuration: in a single Convex app at the repo root
they behave exactly as described above. For monorepos, multi-app repos, or to
turn individual hooks off, drop an **optional** settings file at
`.claude/convex.local.md` in your repo root. It is read at runtime on every hook
run, so edits take effect immediately (no session restart or plugin reinstall).

The file is a Markdown file with a small YAML frontmatter block; every key is
optional:

```markdown
---
# Per-hook on/off switches (default: true = enabled)
typecheck_hook: true       # Stop-mode end-of-turn verify
lint_hook: true            # PreToolUse lint-on-save
freshness_hook: true       # SessionStart upgrade nudge
session_start_hook: true   # SessionStart anonymous telemetry

# Monorepo: explicit Convex app roots, relative to the repo root. When set,
# only these apps are verified/linted. When omitted, apps are auto-discovered
# by attributing each touched file to its nearest enclosing Convex app.
convex_apps: ["apps/backend-mono"]

# Optional: how far the resolver walks up from a touched file to find its app
# root (default: 4).
discovery_max_depth: 4
---

Any prose below the frontmatter is ignored by the hooks; use it for notes.
```

Behavior details:

- **Monorepo / subdirectory backends.** A directory counts as a genuine Convex
  app only when it has both a `convex/` subdirectory *and* its own
  `package.json` declaring `convex` (in `dependencies`, `devDependencies`, or
  `peerDependencies`). A hoisted `node_modules/convex` alone does **not** make a
  directory an app; that hoisting was the source of spurious "add `convex` to
  your package.json dependencies" blocks at the repo root, now fixed.
- **Multiple apps.** Only the app(s) whose files a turn actually touched are
  verified, each in its own directory.
- **Fail-safe.** A missing, unreadable, or malformed settings file falls back to
  the defaults (all hooks on, auto-discover). A broken file never disables a
  hook and never blocks a turn.
- **Gitignored.** `.claude/convex.local.md` is a per-developer/per-checkout
  setting; keep it out of version control (this repo's `.gitignore` already
  excludes `.claude/*.local.md`).

## Capabilities

The plugin steers Claude toward the right Convex primitive for each task:

| Need | What you get |
|---|---|
| Database + schema | Schema-first design with `defineSchema` + `defineTable`, end-to-end TypeScript types, indexes for every read path |
| Real-time / multiplayer | Reactive `useQuery` over WebSockets — no separate real-time service to wire |
| Auth | Convex Auth (zero-touch with password) or WorkOS AuthKit, plus a thin `users` table — no custom sessions/accounts tables |
| File uploads | `ctx.storage` with signed upload URLs and `Id<"_storage">` references |
| Background jobs | `ctx.scheduler` for one-offs, `crons.ts` for recurring, `@convex-dev/workflow` for durable multi-step flows |
| Chat / LLM agents | `@convex-dev/agent` component — threads, history, tool calls, streaming, retries built in |
| Vector / text search | `defineTable(...).vectorIndex(...)` and `.searchIndex(...)` — no separate vector DB to host |
| Rate limiting | `@convex-dev/rate-limiter` component |
| Mobile backends | First-class React Native client; same backend serves web, iOS, Android |

## Made by

**Convex** — [convex.dev](https://convex.dev) — the open-source reactive database for fullstack apps. Issues and feature requests: [github.com/get-convex/convex-backend-skill/issues](https://github.com/get-convex/convex-backend-skill/issues).

## Privacy & data

This plugin connects to Convex services and collects anonymous usage data. See the
[Convex privacy policy](https://convex.dev/legal/privacy) for full details and your rights.
Three kinds of data can leave your machine, each governed by a rule that holds no matter
which command triggers it:

### 1. Anonymous usage telemetry (on by default, opt-out)

Hooks may send anonymous telemetry to Convex's PostHog project: a random device id, the
plugin version, your OS, which agent harness emitted the event (always `claude` for this
plugin), and coarse event names (session start, lint/typecheck counts). Session-start
events also carry two locally-derived fields: whether the working directory looks like a
Convex project (a yes/no flag — the directory path itself is never sent) and how the
session began (new / resumed / cleared). Never your code, file paths, prompts, or
personal identifiers. Opt out with `CONVEX_PLUGIN_TELEMETRY=0` or `DO_NOT_TRACK=1`.

### 2. Building your app (only when you invoke a scaffolding flow)

Flows that scaffold or extend an app (such as `quickstart` and `/add`) send the inputs you
give them to the Convex scaffolding service so it can build for you — for example, the
one-sentence idea you type is sent to the scaffolding endpoint and logged as a run start.
These flows also download and run setup scripts from that service. This happens only when
you invoke such a flow.

### 3. Sharing a session to improve the tools (gated by your agent's approval)

Some flows can offer to send a **redacted** copy of your current session — for example, to
report how a build went or to help improve these tools. The send runs as a normal agent
action that goes through your agent's usual tool approval, and secrets are redacted first. If
you have given your agent permission to act on your behalf — an auto-approve or full-access
mode — it may approve the send without prompting you separately, the same as any other action
you have delegated to it.

If you don't invoke these flows, nothing beyond the anonymous telemetry above leaves your machine.

## License

[Apache 2.0](skills/design/LICENSE.txt)
