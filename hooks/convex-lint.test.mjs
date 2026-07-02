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

// --- Rule 6: hallucinated convex/server symbol -----------------------------

test('denies `import { HttpResponse } from "convex/server"` (eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { HttpResponse } from "convex/server";\n` +
        `export function handler() { return new HttpResponse("ok"); }\n`,
    ),
  );
  assertDenied(result, "convex/server bad symbol");
});

test("allows the corrected httpAction import (./_generated/server) with web-standard Response", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpAction } from "./_generated/server";\n` +
        `export const handler = httpAction(async () => {\n` +
        `  return new Response("ok");\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("allows a legit convex/server import (httpRouter, defineSchema)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter, defineSchema } from "convex/server";\n` +
        `const http = httpRouter();\nexport default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- app.use() advisory: relative-path import into app.use() --------------

test('advises (does not deny) on `app.use(http)` with `import http from "./http"`', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/convex.config.ts",
      `import { defineApp } from "convex/server";\n` +
        `import http from "./http";\n` +
        `const app = defineApp();\n` +
        `app.use(http);\n` +
        `export default app;\n`,
    ),
  );
  assertAdvisory(result, "app.use(http)");
});

test("does not advise on app.use(agent) from a package convex.config subpath", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/convex.config.ts",
      `import { defineApp } from "convex/server";\n` +
        `import agent from "@convex-dev/agent/convex.config";\n` +
        `const app = defineApp();\n` +
        `app.use(agent);\n` +
        `export default app;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 7: reserved index names (schema.ts only) -------------------------

test('denies `.index("by_creation_time", ["userId"])` (eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  messages: defineTable({ userId: v.string() })\n` +
        `    .index("by_creation_time", ["userId"]),\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved index name");
});

test('denies `.index("by_id", ["userId"])`', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  messages: defineTable({ userId: v.string() })\n` +
        `    .index("by_id", ["userId"]),\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved index name");
});

test('denies `.index("by_user", ["userId", "_creationTime"])` (eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  messages: defineTable({ userId: v.string() })\n` +
        `    .index("by_user", ["userId", "_creationTime"]),\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved index name");
});

test('denies an index name starting with "_"', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  messages: defineTable({ userId: v.string() })\n` +
        `    .index("_byUser", ["userId"]),\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved index name");
});

test("allows the corrected index (by_user, [userId])", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  messages: defineTable({ userId: v.string() })\n` +
        `    .index("by_user", ["userId"]),\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not flag reserved-looking index names outside schema.ts", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `// just mentioning .index("by_id", ["x"]) in a comment/string elsewhere\n` +
        `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => null });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 7 (extension): reserved table names (schema.ts only) -------------

test('denies `_migrations: defineTable(...)` (f2 eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  users: defineTable({ email: v.string() }).index("by_email", ["email"]),\n` +
        `  notes: defineTable({ title: v.string() }).index("by_owner", ["ownerId"]),\n` +
        `  _migrations: defineTable({\n` +
        `    name: v.string(),\n` +
        `    completedAt: v.number(),\n` +
        `  }).index("by_name", ["name"]),\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved table name");
});

test("allows the corrected table name (migrations, no leading underscore)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/schema.ts",
      `import { defineSchema, defineTable } from "convex/server";\n` +
        `import { v } from "convex/values";\n` +
        `export default defineSchema({\n` +
        `  migrations: defineTable({ name: v.string() }).index("by_name", ["name"]),\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not flag a reserved-looking table name outside schema.ts", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `// just mentioning _migrations: defineTable( in a comment elsewhere\n` +
        `import { query } from "./_generated/server";\n` +
        `export const f = query({ args: {}, returns: null, handler: async () => null });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 8: reserved JS identifier as an export name -----------------------

test('denies `export const delete = mutation(...)` (f1 eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/projects.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const delete = mutation({\n` +
        `  args: { projectId: v.id("projects") },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => { await ctx.db.delete(args.projectId); return null; },\n` +
        `});\n`,
    ),
  );
  assertDenied(result, "reserved identifier");
});

test('denies `export const new = query(...)`', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query } from "./_generated/server";\n` +
        `export const new = query({ args: {}, returns: null, handler: async () => null });\n`,
    ),
  );
  assertDenied(result, "reserved identifier");
});

test("allows the corrected export name (remove instead of delete)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/projects.ts",
      `import { mutation } from "./_generated/server";\n` +
        `export const remove = mutation({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not flag an identifier that merely starts with a reserved word (e.g. `inbox`, `deleteMany`)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { query, mutation } from "./_generated/server";\n` +
        `export const inbox = query({ args: {}, returns: null, handler: async () => null });\n` +
        `export const deleteMany = mutation({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 9: Node builtin import without "use node" -------------------------

test('denies `import crypto from "crypto"` in a file without "use node" (f3 eval-failure repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { HttpRouter } from "convex/server";\n` +
        `import { api, internal } from "./_generated/api";\n` +
        `import crypto from "crypto";\n` +
        `const http: HttpRouter = httpRouter();\n` +
        `http.route({ path: "/health", method: "GET", handler: async () => new Response("ok") });\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, 'Node API without "use node"');
});

test('denies `import { createHmac } from "crypto"` (named import form)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { createHmac } from "crypto";\n` +
        `const http = httpRouter();\nexport default http;\n`,
    ),
  );
  assertDenied(result, 'Node API without "use node"');
});

test('denies `require("node:fs")` (node: prefix, require form)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/foo.ts",
      `import { mutation } from "./_generated/server";\n` +
        `const fs = require("node:fs");\n` +
        `export const f = mutation({ args: {}, returns: null, handler: async () => {} });\n`,
    ),
  );
  assertDenied(result, 'Node API without "use node"');
});

test('allows a Node builtin import in a file that starts with "use node"', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/cryptoActions.ts",
      `"use node";\n` +
        `import { action } from "./_generated/server";\n` +
        `import { createHmac } from "crypto";\n` +
        `export const verify = action({ args: {}, returns: v.null(), handler: async () => {\n` +
        `  createHmac("sha256", "x");\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("allows Web Crypto via globalThis.crypto with no import", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({ path: "/health", method: "GET", handler: async () => {\n` +
        `  const id = crypto.randomUUID();\n` +
        `  return new Response(id);\n` +
        `} });\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
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
