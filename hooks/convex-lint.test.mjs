// node --test suite for hooks/convex-lint.mjs.
//
// Invokes the hook exactly as Claude Code does: spawn `node convex-lint.mjs`,
// write the PreToolUse JSON payload to stdin, read the JSON (or empty)
// response from stdout. No mocking of the hook internals — this exercises
// the real process boundary, including the stdin-parsing and exit-code
// discipline the hook's design notes promise (exit 0 always).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "convex-lint.mjs");

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CONVEX_PLUGIN_TELEMETRY: "0" },
  });
  return result;
}

function writePayload(filePath, content) {
  return {
    tool_name: "Write",
    tool_input: { file_path: filePath, content },
    cwd: dirname(filePath),
  };
}

function parseResponse(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function assertDenied(result, ruleSubstring) {
  assert.equal(result.status, 0, "hook must always exit 0");
  const parsed = parseResponse(result.stdout);
  assert.ok(parsed, "expected a JSON response on deny, got empty stdout");
  assert.equal(
    parsed.hookSpecificOutput.permissionDecision,
    "deny",
    `expected deny, got: ${result.stdout}`,
  );
  if (ruleSubstring) {
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes(
        ruleSubstring,
      ),
      `deny reason should mention "${ruleSubstring}": ${parsed.hookSpecificOutput.permissionDecisionReason}`,
    );
  }
}

function assertAllowedSilent(result) {
  assert.equal(result.status, 0, "hook must always exit 0");
  const parsed = parseResponse(result.stdout);
  assert.equal(parsed, null, `expected silent allow, got: ${result.stdout}`);
}

function assertAdvisory(result, contextSubstring) {
  assert.equal(result.status, 0, "hook must always exit 0");
  const parsed = parseResponse(result.stdout);
  assert.ok(parsed, "expected a JSON response for advisory, got empty stdout");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes(contextSubstring),
    `advisory should mention "${contextSubstring}": ${parsed.hookSpecificOutput.additionalContext}`,
  );
}

// --- Finding 3: convex/server import of a function constructor ------------

test("denies `import { query } from \"convex/server\"`", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "convex/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertDenied(result, "convex/server import");
});

test("denies `import { internalMutation } from \"convex/server\"`", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { internalMutation } from "convex/server";\n`,
    ),
  );
  assertDenied(result, "convex/server import");
});

test("allows the corrected convex/server import (./_generated/server)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not flag unrelated named imports from convex/server (e.g. httpRouter)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `const http = httpRouter();\nexport default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Finding 3: internal/api imported from the wrong generated module -----

test('denies `import { internal } from "./_generated/server"`', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { internal } from "./_generated/server";\n`,
    ),
  );
  assertDenied(result, "_generated/server import");
});

test('denies `import { api } from "./_generated/server"`', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { api } from "./_generated/server";\n`,
    ),
  );
  assertDenied(result, "_generated/server import");
});

test("allows the corrected generated imports (internal/api from ./_generated/api)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { internal, api } from "./_generated/api";\n` +
        `import { query, mutation } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Finding 3: "use node" combined with query/mutation -------------------

test('denies "use node" file that defines a query(', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `"use node";\n` +
        `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertDenied(result, "use node");
});

test('denies "use node" file that defines a mutation(', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `'use node';\n` +
        `import { mutation } from "./_generated/server";\n` +
        `export const f = mutation({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertDenied(result, "use node");
});

test('allows "use node" file that only defines an action(', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `"use node";\n` +
        `import { action } from "./_generated/server";\n` +
        `export const f = action({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

test('allows a query/mutation file that does NOT have "use node"', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- unbounded .collect() advisory -----------------------------------------

test("advises (does not deny) on ctx.db.query(...).collect() with no bound", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  return await ctx.db.query("messages").collect();\n` +
        `} });\n`,
    ),
  );
  assertAdvisory(result, "unbounded `.collect()`");
});

test("does not advise when .withIndex(...) is in the chain before .collect()", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  return await ctx.db.query("messages").withIndex("by_author", q => q.eq("author", "a")).collect();\n` +
        `} });\n`,
    ),
  );
  const parsed = parseResponse(result.stdout);
  if (parsed) {
    assert.ok(
      !parsed.hookSpecificOutput.additionalContext?.includes(
        "unbounded `.collect()`",
      ),
      "should not warn about .collect() when .withIndex is in the chain",
    );
  }
});

test("does not advise when .take(n) replaces .collect()", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  return await ctx.db.query("messages").take(20);\n` +
        `} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

test(".collect() advisory never denies", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  return await ctx.db.query("messages").collect();\n` +
        `} });\n`,
    ),
  );
  const parsed = parseResponse(result.stdout);
  assert.notEqual(
    parsed?.hookSpecificOutput?.permissionDecision,
    "deny",
    ".collect() must be advisory-only, never a deny",
  );
});

// --- pre-existing rules still work (regression guard) ----------------------

test("still denies .filter(q => q.field(...)) on a db query", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  return await ctx.db.query("messages").filter(q => q.eq(q.field("author"), "a")).collect();\n` +
        `} });\n`,
    ),
  );
  assertDenied(result, ".filter on a db query");
});

test("still denies old positional function syntax", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const f = query(async (ctx) => { return null; });\n`,
    ),
  );
  assertDenied(result, "old positional function syntax");
});

// --- fast no-op path (Finding 4) -------------------------------------------

test("stays silent for a non-convex path", () => {
  const result = runHook(writePayload("/tmp/proj/README.md", "# hi\n"));
  assertAllowedSilent(result);
});

test("stays silent for a _generated/ file under convex/", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/_generated/server.ts",
      `import { query } from "convex/server";\n`,
    ),
  );
  assertAllowedSilent(result);
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
