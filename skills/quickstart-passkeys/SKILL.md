---
name: quickstart-passkeys
description: "EXPERIMENTAL. Same live-scaffold flow as `quickstart` (Next.js + shadcn wow-shell, floating Chef panel, convex dev + next dev with error watchers), but it FORCES the passkeys-enabled Convex Auth build (`npm i https://pkg.pr.new/@convex-dev/auth@ed481f5`) and wires up WebAuthn passkey sign-up / sign-in before building the user's idea. Use when the user wants a new Convex app that starts with passkey auth baked in."
when_to_use: "TRIGGER when the user wants to START a new Convex app from scratch AND wants passkeys / WebAuthn / Face ID / Touch ID / passwordless sign-in baked in from the start — e.g. they ran `/quickstart-passkeys`, said 'new app with passkeys', 'scaffold something with passkey login', or accepted an offer to scaffold an app whose auth should be passkeys. This is the experimental passkeys variant of `quickstart`: it pins the pkg.pr.new auth build that ships the `Passkey` provider + `usePasskeyAuth` hook. SKIP when the user just wants a generic app (use `quickstart`), when there's already a Convex project in the cwd (use `design` + `convex-expert`), or when they want a different auth method (password-only, OAuth) — those work with the released `@convex-dev/auth`, not this pinned build."
license: Apache-2.0
---

# Convex Quickstart + Passkeys (experimental)

This is the `quickstart` skill with **one hard difference**: it force-installs the
passkeys-enabled Convex Auth build and wires up WebAuthn (passkey) sign-up / sign-in
**before** building the user's idea. Everything else — the wow-shell, the Chef panel,
the live narration, the log watchers — is identical to `quickstart`.

> **Why a pinned build?** Passkey support (`@convex-dev/auth/providers/Passkey` and the
> `usePasskeyAuth` React hook) is not yet in a released version. This skill pins the
> pkg.pr.new build **`https://pkg.pr.new/@convex-dev/auth@ed481f5`** (auth `0.0.94`).
> Do **not** swap it for `@convex-dev/auth@latest` — latest does not export the Passkey
> provider and the wiring below will fail to compile.

Read the base `quickstart` skill's STEP A / B / C — they apply verbatim. This file only
documents the get-idea step, the scaffold, and the **new mandatory passkey step (A0)**
that runs right after the scaffold and before you build the feature.

---

## 1. Get the idea

One sentence describing the app. If the user gave one, use it. If not, ask once:
*"Tell me the idea in one sentence — I'll have a running app with passkey login up in
about a minute."* Don't over-interview; refinement questions (STEP B) sharpen scope
after there are pixels on screen.

---

## 2. Scaffold the wow-shell (and emit telemetry)

Identical to `quickstart`. Run this in the background, redirect to
`.quickstart-bootstrap.log`, keep the three telemetry calls:

```bash
BASE="https://basic-anteater-667.convex.site"
IDEA='<the user'\''s one-sentence idea>'

# [telemetry 1/3] personalize → bespoke runbook slug
SLUG=$(curl -fsS --max-time 15 -X POST "$BASE/generate" \
  -H 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({idea:process.argv[1],template:"nextjs-shadcn"}))' "$IDEA")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).id||"")}catch{}})') || true

QB="$(mktemp -t convex-qb-XXXX.sh)"
curl -fsS --max-time 20 "$BASE/quickstart-bootstrap" -o "$QB" || { echo "BOOTSTRAP_FETCH_FAILED"; exit 3; }

# [telemetry 2/3] run WITH the slug
bash "$QB" $SLUG
```

Poll `.quickstart-bootstrap.log` until it contains `BOOTSTRAP_COMPLETE` (~45–120s).
`BOOTSTRAP_FETCH_FAILED` → server unreachable; tell the user and stop. **Do not touch
the scaffold directory until `BOOTSTRAP_COMPLETE` appears.** While you wait, read STEP A0
below and the base quickstart runbook.

### Read the personalized runbook (telemetry 3/3)

Once `BOOTSTRAP_COMPLETE` is logged, WebFetch the runbook (bespoke if you got a SLUG,
else generic):

- bespoke: `https://basic-anteater-667.convex.site/q/<SLUG>.md?telemetry=1`
- generic: `https://basic-anteater-667.convex.site/quickstart-with-telemetry.md`

That runbook is the canonical STEP A/B/C rule set. Follow it, plus STEP A0 here.

---

## 3. Open the browser

The log prints `OPEN_BROWSER_URL: http://localhost:PORT`. Open it immediately (before
building). **Note this URL — STEP A0 needs it for `SITE_URL`.** The whole point is the
user watches the app come together.

---

## STEP A0 — force the passkeys auth build and wire WebAuthn (MANDATORY, runs first)

Do this **immediately after `BOOTSTRAP_COMPLETE` and before building the feature**, in
the scaffold directory. Delegate all `convex/` file writes to the **`convex-expert`**
subagent (give it the exact contents below — they are version-pinned). Post a
`progress:post` ("Adding passkey login") and seed a todo for it so the user sees it.

### A0.1 — Install the pinned build + peer dep

```bash
npm i https://pkg.pr.new/@convex-dev/auth@ed481f5 @auth/core@0.41.1 jose
```

`@simplewebauthn/browser` and `@simplewebauthn/server` ship inside the auth build — no
extra install. `@auth/core@0.41.1` is the one peer dep the scaffold doesn't already have.
**Install `jose` explicitly** (even though the auth build depends on it): the scaffold may
use pnpm, whose strict `node_modules` does NOT hoist transitive deps to the top level, so
`jose` wouldn't be resolvable from your key-gen script otherwise.

### A0.2 — Generate auth keys and set deployment env vars

Convex Auth needs `JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` on the dev deployment. The
interactive `npx @convex-dev/auth` wizard is flaky in this harness — generate the keys
deterministically with `jose` (installed in A0.1), then set the env vars.

```bash
node -e '
import("jose").then(async ({ generateKeyPair, exportPKCS8, exportJWK }) => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
  process.stdout.write(JSON.stringify({
    JWT_PRIVATE_KEY: privateKey.trimEnd().replace(/\n/g, " "),
    JWKS: jwks,
  }));
}).catch(e => { console.error(e); process.exit(1); });
' > .auth-keys.json
```

This matches exactly what the auth wizard produces (PKCS8 with newlines → spaces; JWKS =
`{keys:[{use:"sig", ...publicJWK}]}`). Then set the three vars — **prefer the Convex MCP
`envSet` tool** (`mcp__convex__envSet`), one call per var, to avoid shell-quoting the
multi-line key and JSON:

- `JWT_PRIVATE_KEY` = `.auth-keys.json` → `.JWT_PRIVATE_KEY`
- `JWKS` = `.auth-keys.json` → `.JWKS`
- `SITE_URL` = the `OPEN_BROWSER_URL` from step 3 (e.g. `http://localhost:3000`)

(CLI fallback if MCP isn't wired: `npx convex env set SITE_URL http://localhost:3000`,
and for the key/JWKS read the JSON values and pass them quoted.) On localhost the passkey
Relying Party ID defaults to hostname `localhost` and the origin defaults to `SITE_URL`,
so **no `AUTH_PASSKEY_*` vars are needed for local dev.** Delete `.auth-keys.json` after.

### A0.3 — Backend wiring (hand these exact files to `convex-expert`)

`convex/auth.config.ts`:
```ts
export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: "convex" }],
};
```

`convex/auth.ts` — **`Passkey` is a NAMED export in this pinned build** (`export function Passkey`), so use a named import. ⚠️ The package's own JSDoc example shows `import Passkey from …` (default) — that is WRONG for `ed481f5` and fails to compile with *"No matching export … for import 'default'"*. Use the braces:
```ts
import { Passkey } from "@convex-dev/auth/providers/Passkey";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Passkey],
});
```

`convex/http.ts` — add the auth routes (merge if the scaffold already has an `http.ts`):
```ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
```

`convex/schema.ts` — spread `authTables` into the schema (this creates `authAccounts`,
`authSessions`, `users`, and the passkey-challenge table):
```ts
import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,
  // ...the app's own tables go here as you build the feature
});
```

### A0.4 — Frontend wiring

Find where the scaffold instantiates `ConvexReactClient` / mounts `ConvexProvider` (an
`app/providers.tsx`, or inline in `app/layout.tsx`). **Replace `ConvexProvider` with
`ConvexAuthProvider`** — same `client` prop:

```tsx
"use client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function Providers({ children }: { children: ReactNode }) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
```

> **Do not unmount or move `<ChefPanel />`** while doing this — same hard rule as the base
> quickstart. The panel lives in `app/layout.tsx`; the provider wraps it.

Add a **single-button, no-email** passkey UI. The `usePasskeyAuth` hook drives the full
WebAuthn ceremony (it wraps `@simplewebauthn/browser` for you — you never call the browser
API directly). Gate the app's content on auth state with `useConvexAuth`.

**Why one button and no email:** WebAuthn deliberately won't tell a site whether a passkey
exists before prompting (no credential enumeration, by design), so you can't *pre-detect*
and show "sign in" vs "sign up." The right pattern is **try to sign in, and if there's no
usable passkey, create one in the same click.** And since the email would be unverified
(see warning below), the safe default is to not collect it at all — identity is the Convex
user `_id`.

```tsx
"use client";
import { useState } from "react";
import { usePasskeyAuth, useConvexAuth, useAuthActions } from "@convex-dev/auth/react";

export function PasskeyButton() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { registerPasskey, signInWithPasskey } = usePasskeyAuth();
  const { signOut } = useAuthActions();
  const [busy, setBusy] = useState(false);

  if (isLoading) return null;
  if (isAuthenticated) {
    return <button onClick={() => void signOut()}>Sign out</button>;
  }

  async function continueWithPasskey() {
    setBusy(true);
    try {
      // Returning user: use an existing discoverable passkey for this site.
      await signInWithPasskey();
    } catch {
      // No usable passkey here (or the credential isn't known to the server)
      // → create a brand-new passkey + account in the same gesture.
      // NOTE: a user who *cancels* the sign-in prompt also lands here, so they
      // get a second (create) prompt; cancelling that too just leaves them
      // signed out. That's the accepted trade-off for a true one-button flow.
      try {
        await registerPasskey();
      } catch {
        /* user dismissed both prompts — stay on the sign-in screen */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button disabled={busy} onClick={() => void continueWithPasskey()}>
      {busy ? "Waiting for your passkey…" : "Continue with a passkey"}
    </button>
  );
}
```

Notes that matter:
- **No email/username is collected.** `registerPasskey()` with no args creates a new user
  with an empty profile (the `authTables` `users` columns are all optional, so this is
  valid). Identity is the Convex user `_id` from `getAuthUserId(ctx)` — use that everywhere.
- `signInWithPasskey()` — usernameless/discoverable-credential sign-in; works because the
  provider defaults to `residentKey: "preferred"`, so passkeys are discoverable.
- **⚠️ If you later add an email/name field, that value is NEVER verified** — it's
  self-asserted profile text, like a typed username. A passkey proves possession of a
  credential, not ownership of an email. Registering with someone else's email does NOT
  take over their account (each passkey is a new, separate user keyed by a unique
  credential ID; there is no email-based linking), but it DOES create an account that
  *claims* it. So **never authorize off `user.email`**, never present it as a verified
  identity, and don't assume it's unique. If the app genuinely needs a verified email, add
  an out-of-band verification step (email OTP / magic link). Tell the user this if their
  feature wants to trust email.
- **Optional polish (returning-user autofill):** for a smoother returning-user experience
  you can add WebAuthn *conditional UI* (passkey autofill) — but that requires an input
  with `autocomplete="username webauthn"`, which reintroduces a field. Skip it for the
  starter; the single button above is the clean default.
- Passkeys require a **secure context** — `http://localhost` counts as secure, so local
  dev works. When you publish (STEP C), set `SITE_URL` (and, if the host differs from the
  registrable domain, `AUTH_PASSKEY_RP_ID` / `AUTH_PASSKEY_ORIGIN`) on the prod
  deployment.

### A0.5 — Verify it compiled before moving on

Watch `…/convex-errors.log` and `…/next-errors.log` (STEP A). A passkey wiring mistake
shows up as a Convex schema/compile error or a Next import error. Don't advance the todo
until both logs are clean and the running page renders the sign-in UI.

---

## STEP A / B / C — build the idea live

From here, follow the base `quickstart` runbook **exactly** (the one you WebFetched in
step 2): watch the logs between every action (STEP A), build visible-first with backend
in parallel and narrate through the Chef panel (STEP B), publish only when asked
(STEP C). When you gate features on the signed-in user, read it from
`auth.getUserId(ctx)` in your Convex functions (delegate to `convex-expert`).

The base quickstart's pre-yield checklist applies, plus one extra: **the running page
shows the passkey sign-in UI and, after you register a test passkey, the authed view.**

---

## STEP C0 — deploying a passkey app (only when the user says "deploy"/"publish")

The base quickstart's STEP C (`@convex-dev/static-hosting`) is written for **Vite**, and
passkeys add prod-only config. Do NOT just run the bundled wizard — it's wrong for Next.js
and silently skips an existing `http.ts`. Wire it as below. (This is the recipe; only run
it when the user explicitly asks to deploy.)

**1. Prod env vars — generate FRESH keys for prod** (don't reuse the dev key pair). Re-run
the A0.2 `jose` snippet, then set FIVE vars on the prod deployment. Set them with the
`NAME=VALUE` form (or the MCP `envSet` tool) — **never** `env set NAME "$VALUE"`, because
`JWT_PRIVATE_KEY` starts with `-----BEGIN …` and the CLI parses a leading `-` as an
unknown flag:

```bash
npx convex env set --prod "JWT_PRIVATE_KEY=$JWT"      # NAME=VALUE form, not a separate arg
npx convex env set --prod "JWKS=$JWKS"
npx convex env set --prod "SITE_URL=https://your-app.convex.site"
npx convex env set --prod "AUTH_PASSKEY_RP_ID=your-app.convex.site"   # registrable domain, no scheme/port
npx convex env set --prod "AUTH_PASSKEY_ORIGIN=https://your-app.convex.site"
```

On localhost `RP_ID`/`ORIGIN` default from `SITE_URL`, but in prod set them explicitly —
a passkey is bound to its RP ID, so a mismatch means existing passkeys won't authenticate.

**2. Next.js static export** (the scaffold is Next, not Vite). In `next.config.*`:
`output: "export"`, `images: { unoptimized: true }`, `eslint: { ignoreDuringBuilds: true }`.
Static export emits to **`out/`** (not `dist/`), and the client env var is
**`NEXT_PUBLIC_CONVEX_URL`** (not `VITE_CONVEX_URL`).

**3. Wire static hosting manually** (the bundled `setup`/`deploy` CLI is Vite-only):
add the `staticHosting` component to `convex/convex.config.ts`, register its routes in
`convex/http.ts`, and upload the `out/` dir. The auth exact-path HTTP routes and the
static-hosting `/` pathPrefix **coexist** — auth's exact paths take precedence, so you do
NOT need to remove `auth.addHttpRoutes(http)`.

If anything here drifts from the installed `@convex-dev/static-hosting` version, read its
`dist/` to confirm the current dir/env-var names rather than guessing.
