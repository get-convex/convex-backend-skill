// node --test suite for hooks/convex-typecheck.mjs (Stop-mode verify hook).
//
// Two layers, mirroring the hook's own structure:
//
// 1. Process-boundary tests: spawn `node convex-typecheck.mjs` exactly as
//    Claude Code does on Stop, write the Stop JSON payload to stdin, assert
//    on exit code + stderr. Used for the self-guards, which must short-circuit
//    silently (and fast) before any real work.
//
// 2. Injected-exec tests: import { main } and pass a fake `exec` (plus fake
//    existsSync/readFileSync/clock), so the codegen → tsc → dev-once decision
//    logic is exercised deterministically without shelling out to real
//    toolchains. This is the fake-exec-injection seam the hook exports for
//    exactly this purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./convex-typecheck.mjs";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "convex-typecheck.mjs",
);

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CONVEX_PLUGIN_TELEMETRY: "0" },
  });
}

// --- Layer 1: self-guards at the real process boundary ----------------------

test("stop_hook_active (loop guard) exits 0 silently", () => {
  const result = runHook({ stop_hook_active: true, cwd: "/tmp/anywhere" });
  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), "");
});

test("no convex/ directory exits 0 silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cvx-hook-"));
  try {
    const result = runHook({ cwd: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no node_modules exits 0 silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cvx-hook-"));
  try {
    mkdirSync(join(dir, "convex"));
    const result = runHook({ cwd: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean git tree (no uncommitted convex/*.ts changes) exits 0 silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cvx-hook-"));
  try {
    mkdirSync(join(dir, "convex"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "convex", "foo.ts"), "export {};\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    execSync(
      "git init -q && git add -A && " +
        'git -c user.email=t@t -c user.name=t commit -qm init',
      { cwd: dir, stdio: "ignore" },
    );
    const result = runHook({ cwd: dir });
    assert.equal(result.status, 0);
    assert.equal(result.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard path (loop guard) completes in well under 200ms", () => {
  const start = process.hrtime.bigint();
  const result = runHook({ stop_hook_active: true, cwd: "/tmp/anywhere" });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result.status, 0);
  assert.ok(
    elapsedMs < 200,
    `guard path should be fast (<200ms), took ${elapsedMs.toFixed(1)}ms`,
  );
});

test("guard path (no convex dir) completes in well under 200ms", () => {
  const start = process.hrtime.bigint();
  const result = runHook({ cwd: "/tmp/hookfix-nonexistent-project" });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result.status, 0);
  assert.ok(
    elapsedMs < 200,
    `guard path should be fast (<200ms), took ${elapsedMs.toFixed(1)}ms`,
  );
});

// --- Layer 2: verify pipeline via the injected-exec seam --------------------

const CWD = resolve(sep, "proj");
const p = (...parts) => resolve(CWD, ...parts);

// A fake project: `files` maps absolute path → contents (existsSync = key
// present; readFileSync = value or throw). `execScript` maps a command tag
// ("git" | "codegen" | "tsc" | "dev") to a spawnSync-shaped result; every
// call is recorded for order/arg assertions.
function makeDeps({ files = {}, execScript = {}, now } = {}) {
  const calls = [];
  const tag = (file, args) => {
    const joined = `${file} ${args.join(" ")}`;
    if (file === "git") return "git";
    if (joined.includes("codegen")) return "codegen";
    if (joined.includes("tsc")) return "tsc";
    if (joined.includes("dev --once")) return "dev";
    return "unknown";
  };
  const deps = {
    exec: (file, args, opts = {}) => {
      const t = tag(file, args);
      calls.push({ tag: t, file, args, opts });
      return {
        status: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        notFound: false,
        ...(execScript[t] ?? {}),
      };
    },
    existsSync: (path) => path in files,
    readFileSync: (path) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    },
    capture: () => {},
    ...(now ? { now } : {}),
  };
  return { deps, calls };
}

// Baseline fake project: convex dir + node_modules + convex dep + local bins
// + convex/tsconfig.json, with one uncommitted convex/*.ts change.
function baseFiles(extra = {}) {
  return {
    [p("convex")]: true,
    [p("node_modules")]: true,
    [p("package.json")]: JSON.stringify({ dependencies: { convex: "^1.0.0" } }),
    [p("node_modules", ".bin", "convex")]: true,
    [p("node_modules", ".bin", "tsc")]: true,
    [p("convex", "tsconfig.json")]: "{}",
    ...extra,
  };
}

const DIRTY_GIT = { git: { status: 0, stdout: " M convex/foo.ts\n" } };

test("runs codegen then tsc (in order) when convex/*.ts changed", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git", "codegen", "tsc"],
    "expected git status, then codegen, then tsc (and no dev-once)",
  );
  assert.ok(calls[1].file.endsWith("convex"), "codegen uses local convex bin");
  assert.deepEqual(calls[1].args, ["codegen"]);
  assert.ok(calls[2].args.includes("--noEmit"));
});

test("skips codegen when no convex dependency, still runs tsc", () => {
  const files = baseFiles();
  files[p("package.json")] = JSON.stringify({ dependencies: {} });
  delete files[p("node_modules", ".bin", "convex")];
  const { deps, calls } = makeDeps({ files, execScript: DIRTY_GIT });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git", "tsc"],
  );
});

test("does not verify when the turn only touched non-convex files", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: { git: { status: 0, stdout: " M src/app/page.tsx\n" } },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git"],
    "only the git-status probe should run",
  );
});

test("ignores _generated/ and .d.ts churn under convex/", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: {
      git: {
        status: 0,
        stdout: " M convex/_generated/api.ts\n M convex/types.d.ts\n",
      },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git"],
  );
});

test("dev --once runs (as CONVEX_AGENT_MODE=anonymous) when .env.local has CONVEX_DEPLOYMENT", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles({
      [p(".env.local")]: "CONVEX_DEPLOYMENT=dev:happy-otter-123\n",
    }),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git", "codegen", "tsc", "dev"],
  );
  const dev = calls[3];
  assert.deepEqual(dev.args, ["dev", "--once"]);
  assert.equal(
    dev.opts.env?.CONVEX_AGENT_MODE,
    "anonymous",
    "dev --once must run in anonymous agent mode",
  );
});

test("dev --once is SKIPPED when .env.local is missing (consent gate)", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.ok(
    !calls.some((c) => c.tag === "dev"),
    "no .env.local → dev --once must never run",
  );
});

test("dev --once is SKIPPED when .env.local lacks CONVEX_DEPLOYMENT (consent gate)", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles({
      [p(".env.local")]: "NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud\n",
    }),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  assert.ok(
    !calls.some((c) => c.tag === "dev"),
    "no CONVEX_DEPLOYMENT in .env.local → dev --once must never run",
  );
});

test("codegen failure blocks: exit 2 with the error tail", () => {
  const { deps } = makeDeps({
    files: baseFiles(),
    execScript: {
      ...DIRTY_GIT,
      codegen: {
        status: 1,
        stderr: "✖ Error: Unable to generate code:\nschema.ts is invalid\n",
      },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /convex codegen/);
  assert.match(result.stderr, /schema\.ts is invalid/);
});

test("real tsc diagnostics block: exit 2 with the error tail", () => {
  const { deps } = makeDeps({
    files: baseFiles(),
    execScript: {
      ...DIRTY_GIT,
      tsc: {
        status: 2,
        stdout:
          "convex/foo.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /error TS2322/);
});

test("tsc non-zero WITHOUT real diagnostics does not block (warnings discipline)", () => {
  const { deps } = makeDeps({
    files: baseFiles(),
    execScript: {
      ...DIRTY_GIT,
      tsc: { status: 1, stderr: "some non-diagnostic noise\n" },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
});

test("dev --once failure blocks: exit 2 with the error tail", () => {
  const { deps } = makeDeps({
    files: baseFiles({
      [p(".env.local")]: "CONVEX_DEPLOYMENT=dev:happy-otter-123\n",
    }),
    execScript: {
      ...DIRTY_GIT,
      dev: {
        status: 1,
        stderr: "✖ Error: Hit an error while pushing:\nindex name invalid\n",
      },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /convex dev --once/);
  assert.match(result.stderr, /index name invalid/);
});

test("missing binary (npx --no-install refusal) never blocks", () => {
  const files = baseFiles();
  delete files[p("node_modules", ".bin", "convex")];
  delete files[p("node_modules", ".bin", "tsc")];
  const { deps } = makeDeps({
    files,
    execScript: {
      ...DIRTY_GIT,
      codegen: { status: 1, stderr: "npx: could not determine executable\n" },
      tsc: { status: 1, stderr: "npx: could not determine executable\n" },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
});

test("overall 90s budget exhausted → allow (exit 0), later legs never run", () => {
  // Fake clock: the git probe "takes" 100s, blowing the whole budget.
  let t = 0;
  const clock = () => t;
  const { deps, calls } = makeDeps({
    files: baseFiles({
      [p(".env.local")]: "CONVEX_DEPLOYMENT=dev:happy-otter-123\n",
    }),
    execScript: DIRTY_GIT,
    now: clock,
  });
  const innerExec = deps.exec;
  deps.exec = (file, args, opts) => {
    const r = innerExec(file, args, opts);
    t += 100_000; // every command costs 100s on the fake clock
    return r;
  };
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0, "budget exhaustion must allow, not block");
  assert.deepEqual(
    calls.map((c) => c.tag),
    ["git"],
    "no verify leg may start once the budget is spent",
  );
});

test("a child process timeout → allow (exit 0), never a block", () => {
  const { deps } = makeDeps({
    files: baseFiles(),
    execScript: {
      ...DIRTY_GIT,
      codegen: { status: null, timedOut: true },
    },
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
});

test("legs receive a timeout no larger than the remaining budget", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD }, deps);
  assert.equal(result.exitCode, 0);
  for (const call of calls) {
    if (call.tag === "git") continue;
    assert.ok(
      typeof call.opts.timeout === "number" && call.opts.timeout <= 90_000,
      `${call.tag} must be bounded by the 90s budget, got ${call.opts.timeout}`,
    );
  }
});

test("stop_hook_active short-circuits before any exec (injected seam)", () => {
  const { deps, calls } = makeDeps({
    files: baseFiles(),
    execScript: DIRTY_GIT,
  });
  const result = main({ cwd: CWD, stop_hook_active: true }, deps);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 0, "loop guard must run before any child process");
});
