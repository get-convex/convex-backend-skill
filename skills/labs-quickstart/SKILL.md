---
name: "labs-quickstart"
description: "LABS — the FULL Convex quickstart experience: scaffold a running Next.js + shadcn app from one sentence with passkey (WebAuthn) sign-in and a live in-app Chef feedback panel pre-baked, build the idea live narrating through the panel, then PUBLISH it to a public https://<app>.convex.app URL (with the user's confirmation before publishing). For a plain local-only scaffold, use the `quickstart` skill instead."
when_to_use: "TRIGGER when the user wants to START a new Convex app from scratch with the full experience — they ran `/labs-quickstart`, asked for the 'full' or 'labs' quickstart, or their from-scratch ask includes publishing/a public URL, sign-in/login/passkeys, or the in-app feedback panel (e.g. 'build and publish an app where users can ___', 'new app with login'). SKIP when the user wants a plain local scaffold (use `quickstart`), when there's already a Convex project in the cwd (use `design` + `convex-expert`), or when they explicitly don't want a scaffold."
license: "Apache-2.0"
---

# Convex Labs Quickstart — full wow-shell, built live, published

The **full** quickstart experience (labs): a running Next.js + shadcn "wow-shell"
Convex app from one sentence, with **passkey sign-in** and the **Chef feedback
panel** pre-baked, built live in front of the user — and, once v1 works and **the
user confirms**, **published to a public `https://<app>.convex.app` URL**.

> Want just a plain, local-only scaffold (no login, no panel, no publishing)?
> That's the **`quickstart`** skill — use it instead.

> **You are reading this skill right now — its full instructions are below.** Do NOT
> `find`/`grep` the filesystem for `SKILL.md` or "the skill file"; you already have it.
> The canonical runbook you fetch in step 2 (and the bootstrap log tail) is the *same*
> content with different section headings — don't re-hunt for it either.


## 1. Get the idea

One sentence describing the app. If the user gave one, use it. If not, ask once:
*"Tell me the idea in one sentence — I'll have a running app with passkey login up in
about a minute."* Don't over-interview; refinement questions sharpen scope after there
are pixels on screen.


## 2. Scaffold the wow-shell (and emit telemetry)

Run this block with the Bash tool **in the background** (`run_in_background: true`),
redirecting to `.quickstart-bootstrap.log` in the cwd. Keep the three telemetry calls.
`node` is always available in this harness; no `jq` needed.

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

# [telemetry 2/3] run WITH the slug — LABS = the FULL profile (passkeys + Chef
# feedback panel + *.convex.app publishing), EXCEPT custom domains (QB_DOMAIN=0).
QB_PROFILE=full QB_DOMAIN=0 QB_ARGS_BASE="$BASE" QB_FEEDBACK_URL="$BASE/feedback" bash "$QB" $SLUG
```

Poll `.quickstart-bootstrap.log` until it contains `BOOTSTRAP_COMPLETE` (~45–120s).
`BOOTSTRAP_FETCH_FAILED` → server unreachable; tell the user and stop. **Do not touch
the scaffold directory until `BOOTSTRAP_COMPLETE` appears.** While you wait, read
STEP A0 below.

### Read the personalized runbook (telemetry 3/3)

Once `BOOTSTRAP_COMPLETE` is logged, WebFetch the runbook (bespoke if you got a SLUG,
else generic):

- bespoke: `https://basic-anteater-667.convex.site/q/<SLUG>.md?telemetry=1`
- generic: `https://basic-anteater-667.convex.site/quickstart-with-telemetry.md`

That runbook is the canonical rule set — production gotchas, code patterns,
log-watcher details. **It uses its own section names** (e.g. `## End-to-end runbook`,
`### Build features…`) — same rules, different headings; don't treat the absence of
this skill's exact labels as a failed fetch. Follow it, plus STEP A0 here. (The same
runbook is also printed to the tail of `.quickstart-bootstrap.log` from the
`═══ STEP A` marker onward — a fine fallback if WebFetch is unavailable, though
WebFetching the URL is what fires the telemetry-3 signal, so prefer it. One
exception: this labs release keeps **custom domains OFF** — if the runbook mentions
offering/registering domains or `.quickstart-domains.json`, skip that part.)


## 3. Open the browser

The log prints `OPEN_BROWSER_URL: http://localhost:PORT`. Open it immediately (before
building) — the whole point is the user watches the app come together. **Note this
URL** — it's the local `SITE_URL` for auth.


## STEP A0 — wire auth (passkeys are pre-baked unless the idea asked otherwise)

**First check `AUTH_MODE` in the launch log:**
- **`AUTH_MODE=custom`** — the user's idea asked for a different auth method
  (OAuth, password-only, magic link, a specific auth component/`.tgz`, Clerk/WorkOS/Auth0).
  The bootstrap **did NOT** pre-bake passkeys (no `authTables`, no auth files). Wire the
  **requested** provider instead — delegate the `convex/` wiring to the `convex-expert`
  subagent, follow that provider's own README, and skip the passkey steps below.
- **`AUTH_MODE=passkeys`** (default) — passkeys are pre-baked; continue below.

**The passkeys bootstrap already did the heavy, identical-every-run wiring for you:**
installed the pinned `@convex-dev/auth` build + peers, wrote `convex/auth.ts`,
`convex/auth.config.ts`, `convex/http.ts`, spread `...authTables` into
`convex/schema.ts`, swapped the provider to `ConvexAuthProvider`, and set
`JWT_PRIVATE_KEY` / `JWKS` / `SITE_URL` on the dev deployment.

**So A0 is just two quick things:**
1. **Verify** the pre-bake: those `convex/auth*.ts` + `http.ts` files exist,
   `schema.ts` has `...authTables`, and `…/convex-errors.log` is clean. If the
   bootstrap log printed a `passkeys: … failed` warning, follow the runbook's
   passkey-fallback wiring for *only that* step.
2. **Add the `PasskeyButton`** (below) and gate your feature's content on auth state.

Narrate "Passkey login ready" through the Chef panel (a `progress:post` + seed a todo
via `todos:plan`) so the user sees it.

### The email-first passkey UI

Add a sign-in UI using `signInOrRegisterWithPasskey`. The pinned build enables
credential enumeration **by email**: a single call signs the user in if they already
have a passkey for that email, or registers a new passkey + account if they don't —
and tells you which happened via the returned `registered` flag. Gate the app's
content on auth state with `useConvexAuth`.

```tsx
"use client";
import { useState } from "react";
import { usePasskeyAuth, useConvexAuth, useAuthActions } from "@convex-dev/auth/react";

export function PasskeyButton() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signInOrRegisterWithPasskey } = usePasskeyAuth();
  const { signOut } = useAuthActions();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (isLoading) return null;
  if (isAuthenticated) return <button onClick={() => void signOut()}>Sign out</button>;

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setBusy(true); setMsg(null);
    try {
      const { registered } = await signInOrRegisterWithPasskey({ email });
      setMsg(registered ? "Account created — welcome!" : "Welcome back!");
    } catch {
      setMsg("Passkey prompt was dismissed — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={go}>
      <input
        type="email" required value={email} placeholder="you@example.com"
        autoComplete="username webauthn"
        onChange={(ev) => setEmail(ev.target.value)}
      />
      <button disabled={busy} type="submit">
        {busy ? "Waiting for your passkey…" : "Continue with a passkey"}
      </button>
      {msg && <p>{msg}</p>}
    </form>
  );
}
```

Notes that matter:
- **`autoComplete="username webauthn"`** on the input turns on WebAuthn **conditional
  UI (autofill)** — returning users get a one-tap passkey suggestion right in the
  email field.
- **⚠️ Email is self-asserted and NEVER verified.** A passkey proves possession of a
  credential, not ownership of an email. The identity of record is the Convex user
  `_id` from `getAuthUserId(ctx)` — **authorize off that, never off `user.email`**.
  If the feature needs a genuinely verified email, add an out-of-band step
  (OTP / magic link).
- Passkeys require a **secure context** — `http://localhost` counts, so local dev
  works. Publishing (STEP C) rebinds the passkey env vars to the `.convex.app` origin.
- **Verify it compiled before moving on:** watch `…/convex-errors.log` and
  `…/next-errors.log`. Don't advance the todo until both logs are clean and the
  running page renders the sign-in UI.
- **Do not unmount or move `<ChefPanel />`** while wiring the UI — the panel lives in
  `app/layout.tsx`; the provider wraps it.


## STEP A / B — build the idea live

From here, follow the served runbook **exactly** (the one you fetched in step 2):
watch the error logs between every action, build visible-first with the backend in
parallel (delegate all `convex/` code to the `convex-expert` subagent), and
**narrate through the Chef feedback panel**. When you gate features on the signed-in
user, read it from `getAuthUserId(ctx)` in your Convex functions.

**Narrate through the panel, not chat.** The scaffold mounts a live `<ChefPanel />`
(the `FeatureRequestPanel`) in `app/layout.tsx` and pre-wires the backend functions
that drive it. As you build, drive the panel instead of dumping status into the chat:

- `progress:post` — short status lines as you complete each visible chunk ("Passkey
  login ready", "Live feed wired up").
- `todos:plan` / `todos:setState` — seed the build plan up front, then advance each
  todo `pending → in_progress → done` as you land it, so the user watches the plan
  burn down.
- `refinementQuestions:post` — when scope is genuinely ambiguous, ask **in the panel**
  (not chat); read the answers back with `refinementQuestions:*`.
- `featureRequests:setState` — as the user files feature requests in the panel, triage
  them (`accepted` / `building` / `done`) so they see their requests move.

> **Never unmount, move, or break `<ChefPanel />`.** It is the user's window into the
> build — keep it mounted in `app/layout.tsx` for the whole session.

Pre-yield checklist: `npx tsc --noEmit` clean, error logs re-read and clean,
`metadata.title` names *this* app, and the running page shows the passkey sign-in UI
and (after you register a test passkey) the authed view.


## STEP C — publish to *.convex.app (ASK THE USER FIRST)

When v1 works, **offer to publish** — do not publish silently, and don't treat it as
mandatory:

> "v1 is working locally. Want me to publish it to a public
>  `https://<app>.convex.app` URL anyone can open?"

Publish **only on a clear yes**. On a no, the app keeps running locally — done.

This publishes the static site to `https://<app>.convex.app` through the hosting
**gateway** (build → zip → moderated upload). `<app>` = your deployment name (the
subdomain of `NEXT_PUBLIC_CONVEX_URL`). The passkey **auth HTTP routes stay on the
deployment's `*.convex.site`**; only the page moves to `*.convex.app`. WebAuthn is
origin-bound, so the passkey env vars must point at the **`.convex.app` page
origin**, not `.convex.site`.

**1. Rebind auth env vars to the `.convex.app` page origin.** Use the `NAME=VALUE`
form (never `env set NAME "$VALUE"` — a value starting with `-` parses as a flag).
For a dev-deployment trial omit `--prod`; for prod add `--prod`, export a
`CONVEX_DEPLOY_KEY`, and set fresh `JWT_PRIVATE_KEY`/`JWKS` on it too (the runbook
has the key-gen snippet):

```bash
npx convex env set "SITE_URL=https://<app>.convex.app"
npx convex env set "AUTH_PASSKEY_RP_ID=<app>.convex.app"        # the page's host — NOT .convex.site
npx convex env set "AUTH_PASSKEY_ORIGIN=https://<app>.convex.app"
```

A passkey is bound to its RP ID; it MUST equal the host the page is served from
(`<app>.convex.app`) even though the auth endpoints live on `<app>.convex.site`. A
mismatch means registration/sign-in fails.

**2. Next.js static export** — `next.config.ts` is exactly:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = { output: "export", images: { unoptimized: true } };
export default nextConfig;
```
⚠️ **Never silence the linter or type-checker to force a build** (`eslint.ignoreDuringBuilds`
is also removed in Next 16, so it errors). Fix the real cause. Export emits to **`out/`**; the
client env var is **`NEXT_PUBLIC_CONVEX_URL`**.

**3. Push the backend, then publish through the gateway.** No
`@convex-dev/static-hosting` component is needed — serving is the gateway's job. Keep
`auth.addHttpRoutes(http)` in `convex/http.ts` as-is:

```bash
npx convex deploy                      # for a dev trial, the running `convex dev` already pushed — skip
curl -fsSL https://basic-anteater-667.convex.site/publish-convex-app -o publish-convex-app.mjs
npm install -D fflate
node publish-convex-app.mjs            # build → zip out/ → moderated gateway upload
```

It prints `https://<app>.convex.app` — pass it back to the user. **If the gateway
returns 403 (content moderation),** it prints the reasons. A legitimate app sign-in
page should pass; report a false positive to the user, don't evade it.

**4. Verify the passkey ceremony works cross-origin** — page on `.convex.app`, auth
API on `.convex.site`. Open the URL, register a passkey, confirm the authed view
loads. If registration fails with an RP-ID / origin error, the three env vars in
step 1 don't match the `.convex.app` host — fix them and re-publish.

**Custom domains are NOT part of this release** — don't brainstorm, offer, or
register domains, and don't look for `.quickstart-domains.json`. (If the user
already owns a domain and asks to wire it, that's the separate `domains` skill.)


## On failure / friction — offer to self-report (WITH the user's permission)

If the run doesn't go smoothly — you give up, hit a blocker you can't resolve, the
build takes way too long, or the user is clearly frustrated — do NOT just yield
silently. **Ask first, then send only on a yes**:

> "That didn't go as smoothly as it should have. May I send this session — the
>  transcript, with secrets redacted — to the Convex team so they can fix what went
>  wrong? [yes / no]"

- **On yes** → ship the redacted transcript to the review endpoint:
  `curl -fsSL "https://basic-anteater-667.convex.site/send-transcript" | bash -s -- --base https://basic-anteater-667.convex.site --idea "<what broke>"`
- **On no** → respect it; do not send anything.
- Either way, give the user an honest, specific summary of where it got stuck.

Never send the transcript without an explicit yes.
