// node --test suite for hooks/convex-typecheck.mjs.
//
// Scope here is deliberately narrow: this hook shells out to `tsc`, which
// makes full behavioral tests slow/environment-dependent. The regression
// this PR must guard is Finding 4 (fast no-op path) — the hook must return
// instantly, without ever invoking tsc, when the target isn't a convex/*.ts
// file or there's no tsconfig/convex dir to typecheck against. That's cheap
// and deterministic to test directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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

function writePayload(filePath, content) {
  return {
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
    cwd: dirname(filePath),
  };
}

test("stays silent for a non-convex path", () => {
  const result = runHook(writePayload("/tmp/proj/README.md", "# hi\n"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("stays silent for a _generated/ file under convex/", () => {
  const result = runHook(
    writePayload("/tmp/proj/convex/_generated/server.ts", "export {};\n"),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("stays silent for a .d.ts file under convex/", () => {
  const result = runHook(
    writePayload("/tmp/proj/convex/types.d.ts", "export {};\n"),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("stays silent when there's no convex/tsconfig.json to find (no convex dir in cwd)", () => {
  // cwd points somewhere with no convex/ directory at all — the tsconfig
  // walk should find nothing and exit without ever shelling out to tsc.
  const result = runHook(writePayload("/tmp/hookfix-nonexistent-project/convex/foo.ts", "export {};\n"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});

test("no-op path (non-convex file) completes in well under 200ms", () => {
  const start = process.hrtime.bigint();
  const result = runHook(writePayload("/tmp/proj/README.md", "# hi\n"));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result.status, 0);
  assert.ok(
    elapsedMs < 200,
    `no-op path should be fast (<200ms), took ${elapsedMs.toFixed(1)}ms`,
  );
});

test("no-op path (missing tsconfig) completes in well under 200ms", () => {
  const start = process.hrtime.bigint();
  const result = runHook(
    writePayload("/tmp/hookfix-nonexistent-project/convex/foo.ts", "export {};\n"),
  );
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(result.status, 0);
  assert.ok(
    elapsedMs < 200,
    `no-op path should be fast (<200ms), took ${elapsedMs.toFixed(1)}ms`,
  );
});
