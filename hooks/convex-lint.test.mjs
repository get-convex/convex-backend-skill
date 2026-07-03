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
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({ path: "/health", method: "GET", handler: httpAction(async () => {\n` +
        `  const id = crypto.randomUUID();\n` +
        `  return new Response(id);\n` +
        `}) });\n` +
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

// --- Rule 10: httpRouter :param route (defect-review sample, confirmed) ---

test("denies http.route path with :param segment (forum/haiku http.ts:33 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/api/users/:userId",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    return new Response("ok");\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, "httpRouter :param route");
});

test("denies http.route path with :param segment (warehouse/haiku http.ts:56 repro, /items/:id)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/items/:id",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    return new Response("ok");\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, "httpRouter :param route");
});

test("allows the corrected form: pathPrefix + parse the trailing segment", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  pathPrefix: "/api/users/",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const id = new URL(request.url).pathname.split("/").pop();\n` +
        `    return new Response(id ?? "");\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not flag a plain http.route path with no colon segment", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/api/users",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    return new Response("ok");\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 11: http.route handler not wrapped in httpAction (confirmed) ----

test("denies a bare arrow-function handler in http.route (forum/haiku-plugin http.ts:10 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/health",\n` +
        `  method: "GET",\n` +
        `  handler: async () => {\n` +
        `    return new Response(JSON.stringify({ ok: true }));\n` +
        `  },\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, "http.route handler not wrapped in httpAction");
});

test("denies a bare async handler with (ctx, request) params (warehouse/haiku http.ts:14 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/items",\n` +
        `  method: "GET",\n` +
        `  handler: async (ctx, request) => {\n` +
        `    return new Response("[]");\n` +
        `  },\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, "http.route handler not wrapped in httpAction");
});

test("allows the corrected form: handler wrapped in httpAction(...)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/health",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async () => {\n` +
        `    return new Response(JSON.stringify({ ok: true }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 12: withIndex .range() is not a real method (confirmed) ---------

test("denies .range() chained inside a withIndex callback (warehouse/haiku dashboard.ts:10 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/dashboard.ts",
      `import { query } from "./_generated/server";\n` +
        `export const getDashboard = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  const alerts = await ctx.db\n` +
        `    .query("lowStockAlerts")\n` +
        `    .withIndex("by_unacknowledged", (q) =>\n` +
        `      q.eq("acknowledged", false).range((r) => r.lte("alertedAt", Date.now()))\n` +
        `    )\n` +
        `    .collect();\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertDenied(result, "withIndex .range() is not a method");
});

test("allows the corrected form: .lte(...) chained directly, no .range() wrapper", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/dashboard.ts",
      `import { query } from "./_generated/server";\n` +
        `export const getDashboard = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  const alerts = await ctx.db\n` +
        `    .query("lowStockAlerts")\n` +
        `    .withIndex("by_unacknowledged", (q) =>\n` +
        `      q.eq("acknowledged", false).lte("alertedAt", Date.now())\n` +
        `    )\n` +
        `    .take(50);\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 13: ctx.db.query(...).count() is not a real method (confirmed) --

test("denies .count() chained onto a ctx.db.query(...) builder (kanban/haiku-plugin board.ts:56 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/board.ts",
      `import { query } from "./_generated/server";\n` +
        `export const getBoard = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  const commentCount = await ctx.db\n` +
        `    .query("comments")\n` +
        `    .withIndex("by_card", (q) => q.eq("cardId", "abc"))\n` +
        `    .count();\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertDenied(result, "ctx.db.query .count() is not a method");
});

test("allows the corrected form: .collect() and .length instead of .count()", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/board.ts",
      `import { query } from "./_generated/server";\n` +
        `export const getBoard = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  const comments = await ctx.db\n` +
        `    .query("comments")\n` +
        `    .withIndex("by_card", (q) => q.eq("cardId", "abc"))\n` +
        `    .collect();\n` +
        `  const commentCount = comments.length;\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 14: ctx.db.query(...).skip() is not a real method (confirmed) ---

test("denies .skip() chained onto a ctx.db.query(...) builder (ledger/haiku accounting.ts:248 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/accounting.ts",
      `import { query } from "./_generated/server";\n` +
        `export const listJournalEntries = query({ args: {}, returns: null, handler: async (ctx) => {\n` +
        `  const entries = await ctx.db\n` +
        `    .query("journalEntries")\n` +
        `    .withIndex("by_postedAt", (q) => q.gte("postedAt", 0))\n` +
        `    .order("desc")\n` +
        `    .skip(0)\n` +
        `    .take(10)\n` +
        `    .collect();\n` +
        `  return null;\n` +
        `} });\n`,
    ),
  );
  assertDenied(result, "ctx.db.query .skip() is not a method");
});

test("allows the corrected form: .paginate(paginationOpts) instead of .skip()", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/accounting.ts",
      `import { query } from "./_generated/server";\n` +
        `import { paginationOptsValidator } from "convex/server";\n` +
        `export const listJournalEntries = query({\n` +
        `  args: { paginationOpts: paginationOptsValidator },\n` +
        `  returns: null,\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const entries = await ctx.db\n` +
        `      .query("journalEntries")\n` +
        `      .withIndex("by_postedAt", (q) => q.gte("postedAt", 0))\n` +
        `      .order("desc")\n` +
        `      .paginate(args.paginationOpts);\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Rule 15: ctx.runQuery/runMutation with a string literal (confirmed) --

test('denies ctx.runMutation("module:fn", ...) string literal (booking/haiku http.ts:22 repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/users",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const body = await request.json();\n` +
        `    const userId = await ctx.runMutation("users:getOrCreateUser", {\n` +
        `      email: body.email,\n` +
        `    });\n` +
        `    return new Response(JSON.stringify({ id: userId }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, 'ctx.runMutation with string literal');
});

test('denies ctx.runMutation("boards:createBoard", ...) string literal (kanban/haiku http.ts:31 repro)', () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/boards",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const body = await request.json();\n` +
        `    const boardId = await ctx.runMutation("boards:createBoard", body);\n` +
        `    return new Response(JSON.stringify({ id: boardId }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertDenied(result, 'ctx.runMutation with string literal');
});

test("allows the corrected form: api.* function reference instead of a string", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `import { api } from "./_generated/api";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/users",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const body = await request.json();\n` +
        `    const userId = await ctx.runMutation(api.users.getOrCreateUser, {\n` +
        `      email: body.email,\n` +
        `    });\n` +
        `    return new Response(JSON.stringify({ id: userId }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Advisory: ctx.runQuery/runMutation with a module ref, not api/internal

test("advises on ctx.runQuery(queries.getX, ...) module-ref (forum/haiku-plugin http.ts:2,27 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `import * as queries from "./queries";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/questions",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const result = await ctx.runQuery(queries.getQuestions, {});\n` +
        `    return new Response(JSON.stringify(result));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAdvisory(result, "is the raw exported function, not a Convex function");
});

test("does not advise when ctx.runQuery uses api.* (corrected form)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `import { api } from "./_generated/api";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/questions",\n` +
        `  method: "GET",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const result = await ctx.runQuery(api.queries.getQuestions, {});\n` +
        `    return new Response(JSON.stringify(result));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Advisory: ctx.runQuery/runMutation with a direct named-import ref ----

test("advises on ctx.runMutation(createAccount, ...) named-import ref (ledger/haiku http.ts:26,32 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `import { createAccount } from "./accounting";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/accounts",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const body = await request.json();\n` +
        `    const result = await ctx.runMutation(createAccount, {\n` +
        `      name: body.name,\n` +
        `    });\n` +
        `    return new Response(JSON.stringify({ accountId: result }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAdvisory(result, "the raw exported function, not a Convex function");
});

test("does not advise when ctx.runMutation uses api.* (corrected form, named-import case)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/http.ts",
      `import { httpRouter } from "convex/server";\n` +
        `import { httpAction } from "./_generated/server";\n` +
        `import { api } from "./_generated/api";\n` +
        `const http = httpRouter();\n` +
        `http.route({\n` +
        `  path: "/accounts",\n` +
        `  method: "POST",\n` +
        `  handler: httpAction(async (ctx, request) => {\n` +
        `    const body = await request.json();\n` +
        `    const result = await ctx.runMutation(api.accounting.createAccount, {\n` +
        `      name: body.name,\n` +
        `    });\n` +
        `    return new Response(JSON.stringify({ accountId: result }));\n` +
        `  }),\n` +
        `});\n` +
        `export default http;\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Advisory: unbounded numeric delta (vote/score/qty), confirmed --------

test("advises on unchecked v.number() vote value (forum/haiku votes.ts:30 repro)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/votes.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const voteOnQuestion = mutation({\n` +
        `  args: {\n` +
        `    userId: v.id("users"),\n` +
        `    questionId: v.id("questions"),\n` +
        `    value: v.number(),\n` +
        `  },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const question = await ctx.db.get(args.questionId);\n` +
        `    const scoreDelta = args.value;\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAdvisory(result, "has no visible bound");
});

test("does not advise when the vote value is bounded with v.union(v.literal(...))", () => {
  // ctx.auth check included so this fixture isolates the delta-bound
  // advisory only — without it, the identity-arg-no-ctx.auth advisory
  // (added later in this file) would also fire on `userId: v.id(...)` here.
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/votes.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const voteOnQuestion = mutation({\n` +
        `  args: {\n` +
        `    userId: v.id("users"),\n` +
        `    questionId: v.id("questions"),\n` +
        `    value: v.union(v.literal(1), v.literal(-1)),\n` +
        `  },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const identity = await ctx.auth.getUserIdentity();\n` +
        `    if (!identity) throw new Error("401");\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

// --- Advisory: public fn takes an identity arg with no ctx.auth anywhere ---
// (mechanically-detectable slice of FLYWHEEL.md turn 1 pattern 1 — "trusts
// client userId, no ctx.auth", 25 of 214 confirmed defects; the largest
// single real-defect cluster in the corpus.)

test("advises on userId: v.id() with zero ctx.auth in the function (forum votes.ts repro)", () => {
  // Real shape: forum-convex-claude-claude-fable-5-plugin-pv16-plugin-k1's
  // votes.ts `cast` mutation (and the haiku sibling's `voteOnQuestion`) takes
  // `userId: v.string()`/`v.id("users")` and normalizes/looks it up with zero
  // `ctx.auth` reference anywhere in the file — any caller can vote (or
  // downvote a victim's post) as any user id they can obtain from a public
  // list endpoint.
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/votes.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const cast = mutation({\n` +
        `  args: {\n` +
        `    userId: v.id("users"),\n` +
        `    targetType: v.union(v.literal("question"), v.literal("answer")),\n` +
        `    targetId: v.id("questions"),\n` +
        `    value: v.union(v.literal(1), v.literal(-1)),\n` +
        `  },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const user = await ctx.db.get(args.userId);\n` +
        `    if (!user) throw new Error("404: user not found");\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAdvisory(result, "lets any caller impersonate another user");
  const parsed = parseResponse(result.stdout);
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes("userId"),
    "advisory should name the offending field",
  );
});

test("advises on ownerId: v.id() taken by a public query with no ctx.auth (shop dashboard-style repro)", () => {
  // Real shape: shop-convex-claude-claude-haiku-4-5-plugin-pv16-plugin-k1's
  // `getSellerDashboard`/`getUserOrders` queries take a client-supplied
  // `userId` and return another party's revenue/order history with no auth
  // check — the same missing-ctx.auth shape on the read side, not just
  // mutations.
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/queries.ts",
      `import { query } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const getUserOrders = query({\n` +
        `  args: { ownerId: v.id("users") },\n` +
        `  returns: v.array(v.any()),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    return await ctx.db\n` +
        `      .query("orders")\n` +
        `      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))\n` +
        `      .collect();\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAdvisory(result, "ownerId");
});

test("does not advise when the handler checks ctx.auth (correct pattern)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/votes.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const cast = mutation({\n` +
        `  args: { userId: v.id("users"), value: v.union(v.literal(1), v.literal(-1)) },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const identity = await ctx.auth.getUserIdentity();\n` +
        `    if (!identity) throw new Error("401: not signed in");\n` +
        `    if (identity.subject !== args.userId) throw new Error("403: forbidden");\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not advise on internalMutation with a userId arg (internal fns exempt)", () => {
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/users.ts",
      `import { internalMutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const backfillUser = internalMutation({\n` +
        `  args: { userId: v.id("users") },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    await ctx.db.patch(args.userId, { migrated: true });\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not advise on a public mutation with an identity arg typed v.string() (only v.id() is in-scope)", () => {
  // Deliberately conservative per design: bare v.string() ids are the
  // broader corpus population (pattern 1 is 25 defects, most of them
  // v.string()) but out of scope for THIS rule — matching only v.id(...)
  // keeps the false-positive rate at zero at the cost of narrower recall,
  // per the same discipline that kept this pattern out of lint entirely in
  // turn 1.
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/answers.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const edit = mutation({\n` +
        `  args: { id: v.string(), editorId: v.string(), body: v.string() },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => { return null; },\n` +
        `});\n`,
    ),
  );
  assertAllowedSilent(result);
});

test("does not advise when ctx.auth appears elsewhere in the file but not this function (still conservative: whole-block scan)", () => {
  // This rule scans the whole matched function block (args + handler), not
  // the whole file — a ctx.auth check in a SIBLING function must not
  // suppress the advisory on a function that has none of its own.
  const result = runHook(
    writePayload(
      "/tmp/proj/convex/appointments.ts",
      `import { mutation } from "./_generated/server";\n` +
        `import { v } from "convex/values";\n` +
        `export const reschedule = mutation({\n` +
        `  args: { appointmentId: v.id("appointments"), newStart: v.number() },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    const identity = await ctx.auth.getUserIdentity();\n` +
        `    if (!identity) throw new Error("401");\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n` +
        `export const cancel = mutation({\n` +
        `  args: { appointmentId: v.id("appointments"), actorId: v.id("users") },\n` +
        `  returns: v.null(),\n` +
        `  handler: async (ctx, args) => {\n` +
        `    await ctx.db.patch(args.appointmentId, { status: "cancelled" });\n` +
        `    return null;\n` +
        `  },\n` +
        `});\n`,
    ),
  );
  assertAdvisory(result, "actorId");
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
