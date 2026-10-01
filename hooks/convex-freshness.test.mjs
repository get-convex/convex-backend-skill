// node --test suite for hooks/convex-freshness.mjs (SessionStart upgrade nudge).
//
// Process-boundary only: spawn the hook as Claude Code does. The cases here
// pin the fail-open / early-exit guards (including the per-project settings
// toggle) so a disabled or opted-out freshness check never delays the session
// and never reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "convex-freshness.mjs",
);

function runHook(payload, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      // Keep the test hermetic: no accidental network / telemetry noise.
      CONVEX_PLUGIN_TELEMETRY: "0",
      CONVEX_PLUGIN_FRESHNESS: envOverrides.CONVEX_PLUGIN_FRESHNESS ?? "0",
      ...envOverrides,
    },
  });
}

test("freshness_hook: false → exits 0 silently (no network)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cvx-fresh-off-"));
  try {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "convex.local.md"),
      "---\nfreshness_hook: false\n---\n",
    );
    const start = process.hrtime.bigint();
    const result = runHook(
      { cwd: dir },
      // Even with freshness "enabled" via env, the settings file wins.
      { CONVEX_PLUGIN_FRESHNESS: "1" },
    );
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr.trim(), "");
    assert.ok(
      elapsedMs < 500,
      `disabled freshness hook should be fast (<500ms), took ${elapsedMs.toFixed(1)}ms`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONVEX_PLUGIN_FRESHNESS=0 → exits 0 silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cvx-fresh-env-"));
  try {
    const result = runHook({ cwd: dir }, { CONVEX_PLUGIN_FRESHNESS: "0" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
