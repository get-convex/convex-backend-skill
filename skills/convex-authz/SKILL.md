---
name: "convex-authz"
description: "Audit and harden a Convex app's authorization: identity-from-arg impersonation, missing per-document ownership checks, and public queries leaking PII/financial data by a client-supplied id — the single largest real-defect cluster measured against generated Convex backends (44 of 214). Runs a deterministic scan for the 3 shapes, then applies the canonical requireIdentity/requireOwner pattern, then verifies with tsc. TRIGGER on 'secure my app', 'audit auth', 'add login', 'who can access this data', or an explicit 'audit my authz'. NOT always-on. SKIP when there is no convex/ directory."
license: "Apache-2.0"
---

# Convex Authz Auditor/Hardener

A focused authz specialist, not a general reviewer: it finds and fixes the exact three shapes that account for the largest real-defect cluster measured against generated Convex backends (25 identity-from-arg + 13 missing-ownership-check + 6 PII-leak-by-argument = 44 of 214 confirmed defects). It runs a deterministic scan first (objective, regex-based, mirrors the convex-backend-skill v1.7.9 lint advisory), then applies the canonical requireIdentity/requireOwner hardening pattern from convex-expert.md to every hit, then verifies with tsc. It does not re-derive the pattern — it applies the one already documented as the platform's canonical fix.

## Steps
1. SCAN (deterministic, objective-first): for every convex/**/*.ts file (skip convex/_generated/ and .d.ts), grep for the three shapes:
   (a) identity-from-arg: a public `query(`/`mutation(` object whose `args` block declares `userId`/`actorId`/`ownerId`/`authorId`/`accountId` typed `v.id(...)`, where the function's whole block (args + handler) has zero `ctx.auth` reference. Regex: `/\b(userId|actorId|ownerId|authorId|accountId)\s*:\s*v\.id\(/` inside an `args: { ... }` block paired with an absent `/\bctx\.auth\b/` anywhere in the enclosing `(query|mutation)\(\s*\{ ... }` block (word-boundary excludes internalQuery/internalMutation by construction).
   (b) missing-ownership-check: a public `query(`/`mutation(` whose handler loads a document via `ctx.db.get(args.<xId>)` (an `_id`-typed arg) and then calls `ctx.db.patch`/`ctx.db.delete`/`ctx.db.replace` on that same id, or returns the doc's fields directly, with no comparison of any `<doc>.<ownerField>` against an identity value anywhere in the block (no `===`/`!==` involving `identity.subject` or a `ctx.auth` derived value).
   (c) PII-leaking public query: a public `query(` whose `returns` (or the raw doc it returns) includes a sensitive-looking field (`email`, `revenue`, `ssn`, `password`, `token`, `auditLog`, `dashboard`-shaped aggregate) and the query is parameterized by a client-supplied id with no `ctx.auth` check gating access to that id's own scope.
   Report every hit with file, line, and which of the 3 shapes matched — this is the objective, model-independent baseline; do not skip it in favor of jumping straight to judgment.
2. HARDEN: for each hit, apply the canonical pattern from content/convex-expert.md verbatim — do not invent a new helper. Add (if absent) `convex/model/auth.ts` exporting `requireIdentity(ctx)` (throws 401 if `ctx.auth.getUserIdentity()` is null; returns the identity) and `requireOwner(ctx, doc)` (throws 404 if doc is null, throws 403 if `doc.ownerId !== identity.subject`, else returns doc). Rewrite each flagged function: replace the client-supplied identity arg with `requireIdentity(ctx)`; wrap each `_id`-keyed read/mutate with `requireOwner(ctx, await ctx.db.get(args.xId))` before touching the row; scope each PII-returning query through `requireIdentity`/`requireOwner` (or an explicit staff/role check) before it reads outside the caller's own scope. Never widen scope — an internal/admin function that legitimately operates on an arbitrary user stays `internalQuery`/`internalMutation`, never public; leave it unflagged and unchanged.
3. VERIFY: run `npx tsc --noEmit` (or the project's typecheck script) after edits; a hardening pass that doesn't typecheck is not done. Then re-run the step-1 scan to confirm 0 remaining hits (the fixed shapes no longer match the regexes because `ctx.auth` now appears in-block and ownership comparisons now exist).
4. Report findings grouped by the 3 rule shapes with file:line, explain why each is exploitable (who could impersonate whom / read whose data), and show the concrete diff applied — never just describe the fix in prose.

## Rules
- Scan objectively before judging — run the 3 deterministic greps first; don't skip straight to LLM judgment, and don't let a clean scan stop you from still eyeballing internal/admin exemptions.
- Identity always comes from ctx.auth, never from a client-supplied argument — the one legitimate exception is an internalQuery/internalMutation/internalAction that is never exposed publicly.
- Every read or mutate keyed by an _id argument must verify ownership server-side (requireOwner or an inlined equivalent comparison) before touching the row — being logged in is not the same as owning this row.
- Never leave a public query that returns PII/financial/audit data reachable by an unauthenticated or cross-account client-supplied id.
- Reuse requireIdentity/requireOwner from content/convex-expert.md verbatim — do not fork a parallel helper or invent new error semantics.
- Always verify with tsc after hardening; a fix that doesn't typecheck is not shipped.
- This is a targeted authz pass, not a general code review — do not expand scope into performance/schema/validator findings; hand those to convex-reviewer.
- SKIP entirely when there is no convex/ directory in the project.
