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
| **Lint-on-save hook** | PreToolUse gate that blocks Convex anti-patterns *before they reach disk* (and before `convex dev` can push them): `.filter(q => q.field(...))` on db queries and old positional function syntax are denied with the correct pattern in the message; missing `args`/`returns` validators surface as advisories. |
| **End-of-turn verify hook** | Stop hook that enforces the "self-verify before you stop" rule: when a turn leaves uncommitted `convex/*.ts` changes, it runs `convex codegen`, `tsc --noEmit`, and — only when `.env.local` already names a `CONVEX_DEPLOYMENT` (never provisions one) — `convex dev --once`. Real errors block the stop (exit 2) so the agent fixes them before finishing; loop-guarded via `stop_hook_active`, with a hard ~90s budget that allows rather than wedges on timeout. |
| **Runtime-error monitor** | Streams `npx convex logs` and surfaces matched errors (TS / schema validation / runtime exceptions / OCC conflicts) as Claude notifications, so you find out about server-side failures the moment they happen. Self-guards on unlinked projects. |
| **OCC / insights monitor** | Polls `npx convex insights` every 10 minutes and notifies only on *new* OCC conflicts or read-limit insights, with the fix playbook (shrink transactions, `@convex-dev/aggregate` for hot counters, `.withIndex()`/`.paginate()` for read limits). Cloud deployments with user-level auth only; silent otherwise. |
| **Feature-request monitor** | During a `quickstart` build, watches the Chef panel's `featureRequests:listPending` and pushes a notification the moment the user submits a new request — even across turns — so the agent picks it up without babysitting a log. Notifies only on *new* requests; works on local/anonymous deployments too. |

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

The plugin connects to remote services and collects anonymous usage data. See the [Convex privacy policy](https://convex.dev/legal/privacy). There are two separate data flows:

### Anonymous usage telemetry

The plugin's hooks can emit anonymous usage telemetry to PostHog: a random device id (stored at `~/.convex/plugin-device-id`), the plugin version, your OS platform, and coarse event names (session start, lint findings by rule, typecheck failure counts). This telemetry **never** includes your code, file paths, prompts, or any personal identifiers.

Telemetry is **on by default** (it ships with Convex's public, write-only PostHog project key). To opt out, set `CONVEX_PLUGIN_TELEMETRY=0` or `DO_NOT_TRACK=1`; to redirect it to your own project, set `CONVEX_PLUGIN_POSTHOG_KEY` (an empty value disables sending entirely). Sending is fire-and-forget in a detached process and never delays Claude.

### Quickstart & `/add` scaffolding service

The `quickstart` (`/quickstart`) and `/add` flows connect to the Convex scaffolding service to build your app, so they send and receive more than the anonymous telemetry above:

- When you run `/quickstart`, the one-sentence app idea you provide is sent to the Convex scaffolding endpoint (and logged as a run start) so the service can scaffold and build the app.
- Both flows download and execute setup scripts from that endpoint at scaffold time.

This happens only when you invoke those flows. If you don't run `quickstart` or `/add`, no prompt or app idea leaves your machine.

## License

[Apache 2.0](skills/design/LICENSE.txt)
