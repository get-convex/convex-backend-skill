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
//   no node_modules (walks ancestors for monorepo package-root checkouts), and
//   no uncommitted convex/*.ts changes (skips purely conversational turns).
// - Monorepo-aware: each touched convex/*.ts path is attributed to its nearest
//   enclosing Convex app (a dir with a convex/ subdir), and codegen/tsc/dev run
//   IN that app dir. Both codegen AND dev --once run only where the app's OWN
//   package.json declares convex, so a hoisted node_modules/convex can no
//   longer trigger a spurious "add convex to package.json" block.
// - Hard consent line: the `convex dev --once` leg runs ONLY when .env.local
//   already exists AND already contains CONVEX_DEPLOYMENT. This hook must
//   NEVER create or start a new Convex deployment/project as a side effect —
//   if the project isn't provisioned, the leg is skipped silently.
// - Hard ~90s overall budget, sliced per affected app so one slow app cannot
//   starve the rest. A per-leg timeout continues to the next app (does not
//   abandon the whole verify). If the overall budget is exhausted, remaining
//   apps are skipped; prior real failures still block.
// - Blocks (exit 2) only on REAL failures: a non-zero `convex codegen`, tsc
//   output containing `error TS\d+`, or a non-zero `convex dev --once`.
//   Missing binaries, null status (signal/OOM), warnings, and timeouts never
//   block. Never triggers a network fetch for tooling. Block messages name
//   the app dir; multi-app failures are aggregated.
// - `main()` is exported with injectable exec/fs/clock so the test suite can
//   fake the process boundary; the CLI entrypoint wires the real ones.

import { spawnSync } from "node:child_process";
import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capture as realCapture } from "./analytics.mjs";
import { hookEnabled, loadConvexPluginConfig } from "./config.mjs";
import {
  declaresConvexDependency,
  resolveAffectedApps,
  resolveAllowlistMode,
} from "./convex-apps.mjs";

const OVERALL_BUDGET_MS = 90_000;
const MIN_APP_BUDGET_MS = 15_000;
const GIT_TIMEOUT_MS = 10_000;
const TAIL_LINES = 40;
const NODE_MODULES_WALK_MAX = 10;

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

// Prefer a local bin under the app, then under any hoist root (monorepo root
// node_modules/.bin). Fall back to `npx --no-install` which refuses
// harmlessly when nothing is installed.
function resolveBin(appDir, name, args, existsSync, hoistRoots = []) {
  for (const root of [appDir, ...hoistRoots]) {
    if (!root) continue;
    const local = resolve(root, "node_modules", ".bin", name);
    if (existsSync(local)) return { file: local, args };
  }
  return { file: "npx", args: ["--no-install", name, ...args] };
}

// True when node_modules exists at startDir or an ancestor (hoisted monorepo
// when Claude's cwd is a package subdir without its own node_modules).
function hasNodeModulesAncestor(startDir, existsSync, maxHops = NODE_MODULES_WALK_MAX) {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxHops; i++) {
    if (existsSync(resolve(dir, "node_modules"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// Ancestors of cwd that have node_modules (for hoisted .bin lookup), nearest
// first after the app dir itself is tried by resolveBin.
function nodeModulesHoistRoots(startDir, existsSync, maxHops = NODE_MODULES_WALK_MAX) {
  const roots = [];
  let dir = resolve(startDir);
  for (let i = 0; i <= maxHops; i++) {
    if (existsSync(resolve(dir, "node_modules"))) roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

// Uncommitted convex/*.ts source changes (the "did this turn touch the
// backend?" signal), returned as the list of matching paths so each can be
// attributed to its enclosing Convex app. Skips _generated/ and .d.ts, matches
// .ts/.tsx. Strips git's C-style quoting around paths with special chars.
function touchedConvexTsFiles(porcelain) {
  const paths = [];
  for (const line of porcelain.split("\n")) {
    // Porcelain: `XY path` (or `XY old -> new` for renames — take the new).
    let path = line.slice(3).split(" -> ").pop()?.trim() ?? "";
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    // Normalize backslashes so monorepo attribution regexes match on Windows.
    path = path.replace(/\\/g, "/");
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

// Indeterminate child result (signal, OOM, etc.) — never treat as a real
// compile/codegen failure.
function isIndeterminate(result) {
  return result.status == null && !result.timedOut;
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

  // Installed tooling must be present somewhere in the tree. Walk ancestors so
  // a package-root cwd in a hoisted monorepo still proceeds; missing binaries
  // later are still handled leg-by-leg (never block).
  if (!hasNodeModulesAncestor(cwd, existsSync)) return ALLOW;

  const hoistRoots = nodeModulesHoistRoots(cwd, existsSync);
  const overallDeadline = now() + budgetMs;

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
  // verify only those app(s). When git is unavailable we cannot attribute by
  // touched paths; fall back carefully while still honoring convex_apps:
  //   - allow + empty set ([]) → verify nothing
  //   - allow + non-empty → only if cwd itself is an allowed app root
  //   - auto → prior beta behavior: verify cwd when it has convex/
  const allowMode = resolveAllowlistMode(cwd, config, fsDeps);
  let apps;
  if (gitWorked) {
    apps = resolveAffectedApps(touched, cwd, config, fsDeps);
  } else if (allowMode.mode === "allow") {
    const cwdApp = resolve(cwd);
    apps =
      allowMode.set.has(cwdApp) && existsSync(resolve(cwdApp, "convex"))
        ? [cwdApp]
        : [];
  } else {
    apps = existsSync(resolve(cwd, "convex")) ? [cwd] : [];
  }
  if (apps.length === 0) {
    // Empty intentional allowlist, or nothing attributed. Optional advisory
    // when a non-empty list was all-invalid (we already fell back to auto and
    // still found nothing — surface the misconfig once).
    if (allowMode.allInvalid) {
      return {
        exitCode: 0,
        stderr:
          "convex plugin: convex_apps listed no valid Convex app roots " +
          "(check paths in .claude/convex.local.md); skipped verify.\n",
      };
    }
    return ALLOW;
  }

  // Prefer a path relative to the hook cwd so multi-app block reports are
  // short and readable; fall back to the absolute app dir.
  const appLabel = (app) => {
    const rel = relative(cwd, app);
    if (!rel || rel === "") return ".";
    if (rel.startsWith("..")) return app;
    return rel;
  };

  const formatBlock = (leg, output, app) => {
    const report = tail(output.trim() || `(no output; ${leg} exited non-zero)`);
    const where = appLabel(app);
    try {
      capture("stop_verify_blocked", { leg, app: where });
    } catch {
      // telemetry must never affect the verify report
    }
    return (
      `convex plugin: end-of-turn verify failed at \`${leg}\` ` +
      `(app: ${where}) — fix these errors before finishing the turn:\n` +
      `${report}\n`
    );
  };

  // Per-app slice of the overall budget so one slow app cannot starve others.
  const perAppBudget = Math.max(
    MIN_APP_BUDGET_MS,
    Math.floor(budgetMs / Math.max(1, apps.length)),
  );

  const failureReports = [];
  let advisory = "";
  if (allowMode.allInvalid) {
    // Fell back to auto-discover after an all-invalid allowlist — mention it
    // once so the typo is visible even when verify proceeds.
    advisory =
      "convex plugin: convex_apps listed no valid Convex app roots; " +
      "falling back to auto-discover. Check .claude/convex.local.md.\n";
  }

  for (const app of apps) {
    const overallLeft = () => overallDeadline - now();
    if (overallLeft() <= 0) break;

    const appDeadline = now() + perAppBudget;
    const remaining = () =>
      Math.max(0, Math.min(overallDeadline - now(), appDeadline - now()));

    const canRunConvexCli = declaresConvexDependency(app, fsDeps);
    // On timeout/indeterminate for a leg, abandon remaining legs for THIS app
    // (free budget for other apps) but do not fail-open the whole hook.
    let abandonApp = false;

    // --- Leg A: `convex codegen` (only where the app declares convex). ------
    if (remaining() > 0 && canRunConvexCli) {
      const { file, args } = resolveBin(
        app,
        "convex",
        ["codegen"],
        existsSync,
        hoistRoots,
      );
      const r = exec(file, args, { cwd: app, timeout: remaining() });
      if (r.timedOut || isIndeterminate(r)) {
        abandonApp = true;
      } else if (!isMissingBinary(r) && r.status !== 0) {
        failureReports.push(
          formatBlock("convex codegen", `${r.stdout}${r.stderr}`, app),
        );
        continue; // next app — still report other apps' failures
      }
    }

    // --- Leg B: `tsc --noEmit`. --------------------------------------------
    if (!abandonApp && remaining() > 0) {
      const convexTsconfig = existsSync(
        resolve(app, "convex", "tsconfig.json"),
      );
      const rootTsconfig = existsSync(resolve(app, "tsconfig.json"));
      if (convexTsconfig || rootTsconfig) {
        const tscArgs = convexTsconfig
          ? ["--noEmit", "-p", resolve(app, "convex")]
          : ["--noEmit"];
        const { file, args } = resolveBin(
          app,
          "tsc",
          tscArgs,
          existsSync,
          hoistRoots,
        );
        const r = exec(file, args, { cwd: app, timeout: remaining() });
        if (r.timedOut || isIndeterminate(r)) {
          abandonApp = true;
        } else {
          const out = `${r.stdout}${r.stderr}`;
          if (r.status !== 0 && /error TS\d+/.test(out)) {
            failureReports.push(formatBlock("tsc --noEmit", out, app));
            continue;
          }
        }
      }
    }

    // --- Leg C: `convex dev --once` (declared-dep + consent-gated). ---------
    if (!abandonApp && remaining() > 0 && canRunConvexCli) {
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
          hoistRoots,
        );
        const r = exec(file, args, {
          cwd: app,
          timeout: remaining(),
          env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
        });
        if (r.timedOut || isIndeterminate(r)) {
          // next app
        } else if (!isMissingBinary(r) && r.status !== 0) {
          failureReports.push(
            formatBlock("convex dev --once", `${r.stdout}${r.stderr}`, app),
          );
        }
      }
    }
  }

  if (failureReports.length > 0) {
    return {
      exitCode: 2,
      stderr: advisory + failureReports.join("\n"),
    };
  }
  if (advisory) return { exitCode: 0, stderr: advisory };
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
