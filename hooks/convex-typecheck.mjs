#!/usr/bin/env node
// Stop hook: when the agent finishes its turn, VERIFY the Convex backend —
// `convex codegen`, then `tsc --noEmit`, then (consent-gated) a real
// `convex dev --once` push. Convex's push + Next HMR can both go green while
// `tsc --noEmit` is red (a dropped export, a bad Id<...>, a render-only
// crash), and tsc can be green while the deploy-time push is red (schema
// validation, analyze errors). This hook is the enforcement mechanism behind
// the skills' "self-verify before you stop" rule.
//
// Why Stop (not PostToolUse, where this hook used to live): any mid-turn
// trigger fires BETWEEN coupled multi-file edits — file A references a symbol
// that only exists once file B lands two edits later — so the check fails
// spuriously and trains the agent to ignore it. Stop runs when the turn is
// COMPLETE, i.e. after all coupled edits have landed. A Stop hook can still
// block/inform: exit 2 prevents the agent from stopping and feeds stderr back
// to it, so real errors get fixed before the turn ends.
//
// Design notes:
// - Self-guards short-circuit BEFORE any real work, each an instant silent
//   exit 0: `stop_hook_active` (loop guard — if we already blocked this stop
//   once, don't block again), the hook disabled via `.claude/convex.local.md`,
//   no node_modules, and no uncommitted convex/*.ts changes (skips purely
//   conversational turns).
// - Monorepo-aware: each touched convex/*.ts path is attributed to its nearest
//   enclosing Convex app (a dir with a convex/ subdir), and codegen/tsc/dev run
//   IN that app dir. codegen/dev run only where the app's OWN package.json
//   declares convex, so a hoisted node_modules/convex can no longer trigger a
//   spurious "add convex to package.json" block.
// - Hard consent line: the `convex dev --once` leg runs ONLY when .env.local
//   already exists AND already contains CONVEX_DEPLOYMENT. This hook must
//   NEVER create or start a new Convex deployment/project as a side effect —
//   if the project isn't provisioned, the leg is skipped silently.
// - Hard ~90s overall budget across all legs. If the budget is exhausted or
//   any child process hits its timeout, ALLOW (exit 0) — a slow verify must
//   never wedge the session.
// - Blocks (exit 2) only on REAL failures: a non-zero `convex codegen`, tsc
//   output containing `error TS\d+`, or a non-zero `convex dev --once`.
//   Missing binaries (`npx --no-install` refusing to run), warnings, and
//   timeouts never block. Never triggers a network fetch for tooling.
// - `main()` is exported with injectable exec/fs/clock so the test suite can
//   fake the process boundary; the CLI entrypoint wires the real ones.

import { spawnSync } from "node:child_process";
import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capture as realCapture } from "./analytics.mjs";
import { hookEnabled, loadConvexPluginConfig } from "./config.mjs";
import {
  declaresConvexDependency,
  resolveAffectedApps,
} from "./convex-apps.mjs";

const OVERALL_BUDGET_MS = 90_000;
const GIT_TIMEOUT_MS = 10_000;
const TAIL_LINES = 40;

const ALLOW = { exitCode: 0, stderr: "" };

// Real exec: run a child process synchronously, never throw. Timeouts and
// missing binaries are reported as flags rather than exceptions so the
// decision logic (and its tests) stay linear.
function realExec(file, args, { cwd, timeout, env } = {}) {
  const r = spawnSync(file, args, {
    cwd,
    timeout,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    timedOut: r.error?.code === "ETIMEDOUT",
    notFound: r.error?.code === "ENOENT",
  };
}

// Last N lines of combined output — the tail is where codegen/dev errors
// land, and it caps the report so a cascade can't flood the context.
function tail(output, n = TAIL_LINES) {
  const lines = output.split("\n").filter(Boolean);
  const kept = lines.slice(-n);
  const omitted =
    lines.length > n ? `… ${lines.length - n} earlier line(s) omitted.\n` : "";
  return omitted + kept.join("\n");
}

// `npx --no-install` refusing to run (no local install) must not block.
function isMissingBinary(result) {
  return (
    result.notFound ||
    /could not determine executable|command not found|not found/i.test(
      `${result.stdout}${result.stderr}`,
    )
  );
}

// Prefer the local bin (no network, no npx startup); fall back to
// `npx --no-install` which refuses (harmlessly) when nothing is installed.
function resolveBin(cwd, name, args, existsSync) {
  const local = resolve(cwd, "node_modules", ".bin", name);
  if (existsSync(local)) return { file: local, args };
  return { file: "npx", args: ["--no-install", name, ...args] };
}

// Uncommitted convex/*.ts source changes (the "did this turn touch the
// backend?" signal), returned as the list of matching paths so each can be
// attributed to its enclosing Convex app. Skips _generated/ and .d.ts, matches
// .ts/.tsx.
function touchedConvexTsFiles(porcelain) {
  const paths = [];
  for (const line of porcelain.split("\n")) {
    // Porcelain: `XY path` (or `XY old -> new` for renames — take the new).
    const path = line.slice(3).split(" -> ").pop()?.trim() ?? "";
    if (
      /(^|\/)convex\//.test(path) &&
      /\.tsx?$/.test(path) &&
      !path.endsWith(".d.ts") &&
      !path.includes("/_generated/")
    ) {
      paths.push(path);
    }
  }
  return paths;
}

export function main(payload, overrides = {}) {
  const {
    exec = realExec,
    existsSync = realExistsSync,
    readFileSync = realReadFileSync,
    now = Date.now,
    budgetMs = OVERALL_BUDGET_MS,
    capture = realCapture,
  } = overrides;
  const fsDeps = { existsSync, readFileSync };

  // --- Self-guards: each an instant silent allow, before any real work. ---

  // Loop guard: we already blocked this stop once; the agent has been
  // informed. Blocking again would spin forever on unfixable errors.
  if (payload.stop_hook_active) return ALLOW;

  const cwd = payload.cwd ?? process.cwd();

  // Per-project settings: honor an explicit disable of this hook (default on).
  const config = loadConvexPluginConfig(cwd, fsDeps);
  if (!hookEnabled(config, "typecheck_hook")) return ALLOW;

  // Installed tooling must be present somewhere in the tree. In a monorepo the
  // dependencies are hoisted to the repo root, so this fast guard checks the
  // root; missing binaries later are still handled leg-by-leg (never block).
  if (!existsSync(resolve(cwd, "node_modules"))) return ALLOW;

  const deadline = now() + budgetMs;
  const remaining = () => deadline - now();

  // Only verify when the turn actually touched convex/*.ts — skips purely
  // conversational turns. (If this isn't a git repo we can't tell; verify
  // anyway, matching the beta's Stop-hook behavior.)
  const git = exec("git", ["status", "--porcelain"], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  const gitWorked = git.status === 0;
  const touched = gitWorked ? touchedConvexTsFiles(git.stdout) : [];
  if (gitWorked && touched.length === 0) return ALLOW;

  // Attribute each touched convex/*.ts path to its enclosing Convex app and
  // verify only those app(s), the fix for monorepos with Convex backends in
  // subdirectories and/or multiple Convex apps. When git is unavailable we
  // cannot attribute, so fall back to verifying the repo root if it is itself a
  // Convex container (matches the beta's verify-anyway behavior).
  const apps =
    gitWorked
      ? resolveAffectedApps(touched, cwd, config, fsDeps)
      : existsSync(resolve(cwd, "convex"))
        ? [cwd]
        : [];
  if (apps.length === 0) return ALLOW;

  const block = (leg, output) => {
    const report = tail(output.trim() || `(no output; ${leg} exited non-zero)`);
    // Fire-and-forget telemetry on the block path only; never let it break
    // the hook.
    try {
      capture("stop_verify_blocked", { leg });
    } catch {
      // telemetry must never affect the verify report
    }
    return {
      exitCode: 2,
      stderr:
        `convex plugin: end-of-turn verify failed at \`${leg}\` — fix these ` +
        `errors before finishing the turn:\n${report}\n`,
    };
  };

  // Verify each affected app IN its own directory (where package.json declares
  // convex and the local .bin/tsconfig resolve). Legs share the one overall
  // budget across all apps.
  for (const app of apps) {
    // --- Leg A: `convex codegen` (only where the app declares convex). ------
    // Gating on the app's OWN package.json is the fix for the hoisted
    // node_modules/convex false positive: codegen only runs where the CLI
    // will actually work.
    if (remaining() > 0 && declaresConvexDependency(app, fsDeps)) {
      const { file, args } = resolveBin(app, "convex", ["codegen"], existsSync);
      const r = exec(file, args, { cwd: app, timeout: remaining() });
      if (r.timedOut) return ALLOW; // budget valve: never wedge the session
      if (!isMissingBinary(r) && r.status !== 0) {
        return block("convex codegen", `${r.stdout}${r.stderr}`);
      }
    }

    // --- Leg B: `tsc --noEmit`. --------------------------------------------
    if (remaining() > 0) {
      const convexTsconfig = existsSync(
        resolve(app, "convex", "tsconfig.json"),
      );
      const rootTsconfig = existsSync(resolve(app, "tsconfig.json"));
      if (convexTsconfig || rootTsconfig) {
        const tscArgs = convexTsconfig
          ? ["--noEmit", "-p", resolve(app, "convex")]
          : ["--noEmit"];
        const { file, args } = resolveBin(app, "tsc", tscArgs, existsSync);
        const r = exec(file, args, { cwd: app, timeout: remaining() });
        if (r.timedOut) return ALLOW;
        const out = `${r.stdout}${r.stderr}`;
        // Block ONLY on real tsc diagnostics; a missing tsc, warnings, or
        // other non-error output must not block the agent.
        if (r.status !== 0 && /error TS\d+/.test(out)) {
          return block("tsc --noEmit", out);
        }
      }
    }

    // --- Leg C: `convex dev --once` (consent-gated). ------------------------
    // HARD CONSENT LINE: only against an ALREADY-provisioned deployment.
    // .env.local must already exist and already name a CONVEX_DEPLOYMENT;
    // otherwise skip silently — never create/start a deployment from a hook.
    if (remaining() > 0) {
      let envLocal = null;
      try {
        envLocal = readFileSync(resolve(app, ".env.local"), "utf8");
      } catch {
        // No .env.local — leg skipped.
      }
      if (envLocal !== null && /(^|\n)\s*CONVEX_DEPLOYMENT\s*=/.test(envLocal)) {
        const { file, args } = resolveBin(
          app,
          "convex",
          ["dev", "--once"],
          existsSync,
        );
        const r = exec(file, args, {
          cwd: app,
          timeout: remaining(),
          env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
        });
        if (r.timedOut) return ALLOW;
        if (!isMissingBinary(r) && r.status !== 0) {
          return block("convex dev --once", `${r.stdout}${r.stderr}`);
        }
      }
    }
  }

  return ALLOW;
}

// --- CLI entrypoint (what Claude Code invokes on Stop) -----------------------
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  let payload = {};
  try {
    payload = JSON.parse(realReadFileSync(0, "utf8") || "{}");
  } catch {
    // Unparseable stdin → treat as an empty payload (guards will allow).
  }
  const result = main(payload);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
