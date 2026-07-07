---
name: "env"
description: "Set + wire deployment env vars / secrets (API keys) for a Convex app — stored in Convex env, read in actions, never hardcoded. TRIGGER when the user needs an API key/secret/env var ('add my OpenAI key', 'set an env var')."
---

# Manage env vars + secrets

Store secrets as Convex deployment env vars (npx convex env set), read them with process.env in actions, never commit them.

## Steps
1. `npx convex env set KEY value` (per deployment).
2. Read via process.env.KEY inside actions (not queries/mutations).
3. Never hardcode or commit secrets; add to .env.local only for local.
4. Confirm with `npx convex env list`.

## Rules
- Secrets live in Convex env vars, never in code or git.
- process.env only in actions ('use node' if needed), not queries/mutations.
- Different deployments need their own values.
