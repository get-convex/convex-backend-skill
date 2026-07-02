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
//   once, don't block again), no convex/ directory, no node_modules, and no
//   uncommitted convex/*.ts changes (skips purely conversational turns).
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

// Does this project declare (or have installed) the `convex` package?
function hasConvexDependency(cwd, { existsSync, readFileSync }) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (pkg[key] && typeof pkg[key] === "object" && "convex" in pkg[key]) {
        return true;
      }
    }
  } catch {
    // No/unparseable package.json — fall through to the installed check.
  }
  return existsSync(resolve(cwd, "node_modules", "convex", "package.json"));
}

// Prefer the local bin (no network, no npx startup); fall back to
// `npx --no-install` which refuses (harmlessly) when nothing is installed.
function resolveBin(cwd, name, args, existsSync) {
  const local = resolve(cwd, "node_modules", ".bin", name);
  if (existsSync(local)) return { file: local, args };
  return { file: "npx", args: ["--no-install", name, ...args] };
}

// Uncommitted convex/*.ts source changes (the "did this turn touch the
// backend?" signal). Skips _generated/ and .d.ts, matches .ts/.tsx.
function touchedConvexTs(porcelain) {
  return porcelain.split("\n").some((line) => {
    // Porcelain: `XY path` (or `XY old -> new` for renames — take the new).
    const path = line.slice(3).split(" -> ").pop()?.trim() ?? "";
    return (
      /(^|\/)convex\//.test(path) &&
      /\.tsx?$/.test(path) &&
      !path.endsWith(".d.ts") &&
      !path.includes("/_generated/")
    );
  });
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

  // Only act in a project with a Convex backend and installed tooling.
  if (!existsSync(resolve(cwd, "convex"))) return ALLOW;
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
  if (git.status === 0 && !touchedConvexTs(git.stdout)) return ALLOW;

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

  // --- Leg A: `convex codegen` (only when the convex dep is present). ------
  if (remaining() > 0 && hasConvexDependency(cwd, fsDeps)) {
    const { file, args } = resolveBin(cwd, "convex", ["codegen"], existsSync);
    const r = exec(file, args, { cwd, timeout: remaining() });
    if (r.timedOut) return ALLOW; // budget valve: never wedge the session
    if (!isMissingBinary(r) && r.status !== 0) {
      return block("convex codegen", `${r.stdout}${r.stderr}`);
    }
  }

  // --- Leg B: `tsc --noEmit`. ----------------------------------------------
  if (remaining() > 0) {
    const convexTsconfig = existsSync(resolve(cwd, "convex", "tsconfig.json"));
    const rootTsconfig = existsSync(resolve(cwd, "tsconfig.json"));
    if (convexTsconfig || rootTsconfig) {
      const tscArgs = convexTsconfig
        ? ["--noEmit", "-p", resolve(cwd, "convex")]
        : ["--noEmit"];
      const { file, args } = resolveBin(cwd, "tsc", tscArgs, existsSync);
      const r = exec(file, args, { cwd, timeout: remaining() });
      if (r.timedOut) return ALLOW;
      const out = `${r.stdout}${r.stderr}`;
      // Block ONLY on real tsc diagnostics; a missing tsc, warnings, or
      // other non-error output must not block the agent.
      if (r.status !== 0 && /error TS\d+/.test(out)) {
        return block("tsc --noEmit", out);
      }
    }
  }

  // --- Leg C: `convex dev --once` (consent-gated). --------------------------
  // HARD CONSENT LINE: only against an ALREADY-provisioned deployment.
  // .env.local must already exist and already name a CONVEX_DEPLOYMENT;
  // otherwise skip silently — never create/start a deployment from a hook.
  if (remaining() > 0) {
    let envLocal = null;
    try {
      envLocal = readFileSync(resolve(cwd, ".env.local"), "utf8");
    } catch {
      // No .env.local — leg skipped.
    }
    if (envLocal !== null && /(^|\n)\s*CONVEX_DEPLOYMENT\s*=/.test(envLocal)) {
      const { file, args } = resolveBin(
        cwd,
        "convex",
        ["dev", "--once"],
        existsSync,
      );
      const r = exec(file, args, {
        cwd,
        timeout: remaining(),
        env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      });
      if (r.timedOut) return ALLOW;
      if (!isMissingBinary(r) && r.status !== 0) {
        return block("convex dev --once", `${r.stdout}${r.stderr}`);
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
