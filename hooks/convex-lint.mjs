#!/usr/bin/env node
// PreToolUse hook: before Claude writes or edits a file under convex/, lint
// the PROJECTED file content for unambiguous Convex anti-patterns and DENY the
// write before it ever lands on disk. This matters because `convex dev`
// pushes on save — a bad pattern written to disk is a bad pattern deployed.
//
// Design notes:
// - Exits 0 in every case. A deny is expressed through the documented
//   `hookSpecificOutput.permissionDecision: "deny"` JSON on stdout, never via
//   a non-zero exit, so an internal hook failure can never block a write.
// - Self-guards: silent unless the target file is a real `convex/*.ts` source
//   file (skips `_generated/` and `.d.ts`), same regex discipline as the
//   convex-typecheck.mjs PostToolUse hook.
// - Computes projected content: `Write` carries it directly; `Edit` and
//   `MultiEdit` are simulated by reading the current file from disk and
//   applying the replacement(s) in order. If the file is missing or an
//   old_string doesn't match, we stay silent — the tool itself will surface
//   that error; it is not the linter's job.
// - Hard denies are limited to patterns that are unambiguous in a convex/
//   source file:
//     1. `.filter(q => … q.field(…))` on a db query — the `q.field(` call
//        inside the filter callback is the discriminator; JS array `.filter`
//        callbacks never contain `q.field(`. Fix: `.withIndex(...)`.
//     2. Old positional function syntax `query(async (ctx, …)` — Convex
//        functions must use the object form with `args`/`returns`/`handler`.
//     3. `import { ... } from "convex/server"` where the import list contains
//        query|mutation|action|internal{Query,Mutation,Action} — those are
//        exported from the generated `./_generated/server`, not the package
//        entrypoint. A hard deploy failure (Finding 3).
//     4. `import { internal } from "./_generated/server"` or
//        `import { api } from "./_generated/server"` — `internal`/`api` live
//        in `./_generated/api`, not `./_generated/server`. Hard deploy failure.
//     5. A file with `"use node"` that also defines `query(`/`mutation(` —
//        queries and mutations cannot run in the Node.js runtime. Hard deploy
//        failure.
//     6. `import { ... } from "convex/server"` naming a symbol that isn't a
//        real export of the `convex/server` package entrypoint (e.g.
//        `HttpResponse`, which doesn't exist — the fix is `httpAction` from
//        `./_generated/server` plus a web-standard `Response`). Grounded
//        against the actual installed package's export list (see
//        `CONVEX_SERVER_EXPORTS` below) so this can never drift into a false
//        positive as the SDK evolves in this repo's own dependency.
//     7. `.index("by_id", ...)`, `.index("by_creation_time", ...)`, an index
//        name starting with `_`, or `_creationTime` listed as a column in an
//        index's fields array, inside a schema file — all four are
//        `IndexNameReserved` hard deploy failures (`_creationTime` is an
//        automatic implicit tiebreaker Convex appends to every index). A
//        table name starting with `_` (e.g. `_migrations: defineTable(...)`)
//        is the same reserved-prefix rule applied to `TableNameReserved`
//        instead of `IndexNameReserved` — same file scope, same discriminator.
//     8. `export const <jsReservedWord> = ...` in a convex/*.ts file, where
//        the identifier is a JS reserved word (`delete`, `new`, `class`,
//        `function`, `return`, `import`, `default`, `typeof`, `void`, …) —
//        esbuild fails with "Expected identifier but found ...". Unambiguous:
//        no valid JS export can use a reserved word as its binding name.
//     9. `import ... from "<node builtin>"` / `require("<node builtin>")`
//        (crypto, fs, path, http, child_process, os, …, with or without the
//        `node:` prefix) in a convex/*.ts file that does not start with
//        `"use node"` — Convex's default (non-Node) runtime is a V8 isolate
//        with no Node builtins; esbuild fails to resolve the import. Every
//        non-`"use node"` file in convex/ (queries, mutations, http routers,
//        schema, etc.) runs in that isolate, so this is unambiguous
//        regardless of what the file defines.
//     10. `path: "/…/:param"` inside an `http.route({...})` call — Convex's
//        `httpRouter` has no Express-style dynamic-segment syntax, only exact
//        match or `pathPrefix`. A `:param` route is permanently dead code,
//        matching only its own literal string. Confirmed real defect from
//        the defect-review sample (forum/haiku `http.ts:33`, warehouse/haiku
//        `http.ts:56` — every parameterized route in both files unreachable).
//     11. `handler:` inside an `http.route({...})` call that isn't wrapped in
//        `httpAction(...)` — a bare `async (ctx, request) => {...}` compiles
//        but isn't a valid Convex HTTP action. Confirmed real defect (forum/
//        haiku-plugin `http.ts:10`, warehouse/haiku `http.ts:14`).
//     12. `.range(...)` chained inside a `withIndex(...)` index-range builder
//        callback — not a real method on Convex's `IndexRangeBuilder` (only
//        `eq`/`gt`/`gte`/`lt`/`lte` exist, chained directly; verified against
//        the package's `.d.ts`). Confirmed real defect (warehouse/haiku
//        `dashboard.ts:10`).
//     13. `.count()` chained onto a `ctx.db.query(...)` builder — not a real
//        method (`Query`/`OrderedQuery` expose `collect`/`take`/`first`/
//        `unique`/`paginate`, verified against the package's `.d.ts`).
//        Confirmed real defect (kanban/haiku-plugin `board.ts:56`).
//     14. `.skip(...)` chained onto a `ctx.db.query(...)` builder — not a
//        real method; there is no offset-based pagination in Convex.
//        Confirmed real defect (ledger/haiku `accounting.ts:248`).
//     15. `ctx.runQuery`/`runMutation`/`runAction` called with a string
//        literal first argument (e.g. `ctx.runMutation("users:getOrCreateUser",
//        ...)`) — a string can never satisfy the `FunctionReference` type
//        these calls require, so this is always a hard TypeScript/deploy
//        failure. Confirmed real defect (booking/haiku `http.ts:22`, kanban/
//        haiku `http.ts:31`).
// - `app.use(X)` in `convex.config.ts` where `X`'s import comes from a
//   relative path (e.g. `./http`) is an ADVISORY, not a deny — legitimate
//   components are mounted via a package's `convex.config` subpath
//   (`app.use(agent)` from `@convex-dev/agent/convex.config`), but a
//   same-file relative import isn't unambiguously wrong (could be a local
//   sub-app in rare setups), so this stays soft per the deny discipline below.
// - Everything else (missing `args:` / `returns:` on a function object, an
//   unbounded `.collect()`, `ctx.runQuery`/`runMutation`/`runAction` called
//   with a bare module-namespace reference instead of `api.*`/`internal.*`
//   (confirmed defect: forum/haiku-plugin `http.ts:2,27`), the sibling shape
//   where a *named* (non-namespace) import is passed directly instead of an
//   `api.*`/`internal.*` reference (confirmed defect: ledger/haiku
//   `http.ts:26,32` — `ctx.runMutation(createAccount, ...)`), a numeric
//   `args` field named like a score/vote/qty delta with no visible bound
//   (confirmed defect: forum/haiku `votes.ts:30`, warehouse/opus-plugin
//   `stock.ts:20`), and a public `query`/`mutation` whose `args` declare an
//   identity-shaped `v.id(...)` field (`userId`/`actorId`/`ownerId`/
//   `authorId`/`accountId`) with zero `ctx.auth` reference anywhere in the
//   function body (the mechanically-detectable slice of the corpus's #1
//   real-defect cluster — "trusts client userId, no ctx.auth", 25 of 214
//   confirmed defects; confirmed repros: forum/haiku-plugin `votes.ts`
//   `cast`/`voteOnQuestion`, shop/haiku-plugin `orders.ts` `checkout`,
//   booking `bookings.ts`/`appointments.ts` `cancel`) is a soft advisory
//   delivered via `additionalContext` on an "allow" decision — each of these
//   needs more context than a regex can safely turn into a hard deny without
//   false-positive risk (an internal/admin tool or trusted server-to-server
//   call can legitimately take a userId arg with no ctx.auth in sight).
// - Edge discipline: a hard-deny false positive is the worst outcome. When in
//   doubt, allow; any internal error → exit 0 silent (try/catch everywhere).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { capture } from "./analytics.mjs";

// Fire-and-forget telemetry (one event per hook run, primary finding only).
// `capture` already swallows every error and spawns a detached child, but
// wrap it anyway so an analytics failure can never change hook behavior.
// (`analytics.mjs` only pulls in cheap Node builtins — node:child_process,
// node:crypto, node:fs, node:os, node:path, node:url — so the static import
// costs single-digit milliseconds; a lazy `import()` here would race
// `process.exit(0)` in `emit()` and could silently drop the detached-spawn
// telemetry call, which is worse than the import cost. See Finding 4: the
// no-op path's real cost is the `isConvexTs` check happening first, not this
// import — verified below, that check runs before any file I/O or tsc call.)
function track(rule, action) {
  try {
    capture("lint_hook_fired", { rule, action });
  } catch {
    // never let telemetry affect the lint decision
  }
}

function emit(obj) {
  if (obj) {
    try {
      process.stdout.write(JSON.stringify(obj));
    } catch {
      // ignore — fall through to a clean exit
    }
  }
  process.exit(0);
}

function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function allowWithWarnings(warnings) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "convex-lint: advisory only",
      additionalContext: warnings.join("\n"),
    },
  });
}

// Ground truth for Rule 6: the real named exports of `convex/server`. We DERIVE
// this live from the target project's own installed `convex` instead of a
// hardcoded snapshot. The old snapshot was generated with
// `Object.keys(require("convex/server"))`, which erases every type-only export —
// so `DeploymentMetadata`, `UserIdentity`, `GenericQueryCtx`, `Auth`, `Scheduler`
// and ~140 others were missing and false-positived. Deriving from the `.d.ts`
// captures types + values, self-updates with the project's Convex version, and
// costs a few file reads. If `convex` can't be resolved we return null and Rule 6
// no-ops (a genuinely bad import still fails tsc/build), so it can never
// false-positive.
function collectServerExports(file, names, depth) {
  if (depth > 6 || !existsSync(file)) return;
  const src = readFileSync(file, "utf8");
  // named re-exports: export [type] { A, B as C, type D } from "..."
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (let part of m[1].split(",")) {
      part = part.trim().replace(/^type\s+/, "");
      const name = (part.split(/\s+as\s+/).pop() || "").trim(); // exported name (after `as`)
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // local declarations
  for (const m of src.matchAll(
    /export\s+declare\s+(?:const|function|class|let|var|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g))
    names.add(m[1]);
  // star re-exports: export * from "./x.js"
  for (const m of src.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    let t = m[1].replace(/\.js$/, ".d.ts");
    if (!/\.d\.ts$/.test(t)) t += ".d.ts";
    collectServerExports(resolve(dirname(file), t), names, depth + 1);
  }
}

// Complete fallback, used only when the target project’s `convex` can’t be
// resolved (e.g. before `npm install`). Regenerate from the .d.ts (NOT
// `Object.keys(require())`, which drops types) — snapshot of convex@1.42.1.
const FALLBACK_SERVER_EXPORTS = new Set([
  "ActionBuilder", "ActionMeta", "AdvancedRunQueryOptions", "AnyApi",
  "AnyChildComponents", "AnyComponents", "AnyDataModel", "ApiFromModules",
  "AppDefinition", "ArgsAndOptions", "ArgsArray", "ArgsArrayForOptionalValidator",
  "ArgsArrayToObject", "AuditLogBody", "AuditLogValue", "Auth",
  "AuthConfig", "AuthProvider", "BaseTableReader", "BaseTableWriter",
  "BetterOmit", "ComponentDefinition", "CronJob", "Crons",
  "Cursor", "DataModelFromSchemaDefinition", "DefaultArgsForOptionalValidator", "DefaultFunctionArgs",
  "DefineSchemaOptions", "DeploymentMetadata", "DocumentByInfo", "DocumentByName",
  "EnvDefinition", "EnvFromAppDefinition", "EnvFromDefinition", "Expand",
  "Expression", "ExpressionOrValue", "FieldPaths", "FieldTypeFromFieldPath",
  "FieldTypeFromFieldPathInner", "FileMetadata", "FileStorageId", "FilterApi",
  "FilterBuilder", "FilterExpression", "FunctionArgs", "FunctionHandle",
  "FunctionMetadata", "FunctionReference", "FunctionReturnType", "FunctionType",
  "FunctionVisibility", "GenericActionCtx", "GenericDataModel", "GenericDatabaseReader",
  "GenericDatabaseReaderWithTable", "GenericDatabaseWriter", "GenericDatabaseWriterWithTable", "GenericDocument",
  "GenericFieldPaths", "GenericIndexFields", "GenericMutationCtx", "GenericMutationCtxWithTable",
  "GenericQueryCtx", "GenericQueryCtxWithTable", "GenericSchema", "GenericSearchIndexConfig",
  "GenericTableIndexes", "GenericTableInfo", "GenericTableSearchIndexes", "GenericTableVectorIndexes",
  "GenericVectorIndexConfig", "HttpActionBuilder", "HttpRouter", "IdField",
  "IndexNames", "IndexRange", "IndexRangeBuilder", "IndexTiebreakerField",
  "Indexes", "MutationBuilder", "MutationBuilderWithTable", "MutationMeta",
  "NamedIndex", "NamedSearchIndex", "NamedTableInfo", "NamedVectorIndex",
  "OptionalRestArgs", "OrderedQuery", "PaginationOptions", "PaginationResult",
  "PartialApi", "PublicHttpAction", "Query", "QueryBuilder",
  "QueryBuilderWithTable", "QueryInitializer", "QueryMeta", "ROUTABLE_HTTP_METHODS",
  "RegisteredAction", "RegisteredMutation", "RegisteredQuery", "RequestMetadata",
  "ReturnValueForOptionalValidator", "RoutableMethod", "RouteSpec", "RouteSpecWithPath",
  "RouteSpecWithPathPrefix", "SchedulableFunctionReference", "Scheduler", "SchemaDefinition",
  "SearchFilter", "SearchFilterBuilder", "SearchFilterFinalizer", "SearchIndexConfig",
  "SearchIndexNames", "SearchIndexes", "StorageActionWriter", "StorageId",
  "StorageReader", "StorageWriter", "SystemDataModel", "SystemFields",
  "SystemIndexes", "SystemTableNames", "TableDefinition", "TableNamesInDataModel",
  "TransactionLimits", "TransactionMetric", "TransactionMetrics", "UnvalidatedFunction",
  "UserIdentity", "UserIdentityAttributes", "ValidatedFunction", "ValidatorTypeToReturnType",
  "VectorFilterBuilder", "VectorIndexConfig", "VectorIndexNames", "VectorIndexes",
  "VectorSearch", "VectorSearchQuery", "WithOptionalSystemFields", "WithoutSystemFields",
  "actionGeneric", "anyApi", "componentsGeneric", "createFunctionHandle",
  "cronJobs", "defineApp", "defineComponent", "defineSchema",
  "defineTable", "filterApi", "getFunctionAddress", "getFunctionName",
  "httpActionGeneric", "httpRouter", "internalActionGeneric", "internalMutationGeneric",
  "internalQueryGeneric", "log", "makeFunctionReference", "mutationGeneric",
  "paginationOptsValidator", "paginationResultValidator", "queryGeneric",
]);

let _serverExports; // memoized per process
function convexServerExports(cwd) {
  if (_serverExports !== undefined) return _serverExports;
  try {
    const req = createRequire(join(cwd, "package.json"));
    const pkgPath = req.resolve("convex/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const sub = pkg.exports?.["./server"];
    const dtsRel =
      sub?.types ?? sub?.import?.types ?? (typeof sub === "string" ? sub : null);
    if (!dtsRel) return (_serverExports = null);
    const names = new Set();
    collectServerExports(resolve(dirname(pkgPath), dtsRel), names, 0);
    _serverExports = names.size ? names : FALLBACK_SERVER_EXPORTS;
  } catch {
    _serverExports = FALLBACK_SERVER_EXPORTS;
  }
  return _serverExports;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Truncate a matched snippet for inclusion in a one-paragraph deny reason.
function snippet(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

// Given the index of an opening `(` (or `{`), return the index just past its
// matching close, by counting all three bracket kinds so a `{`/`(`/`[` inside
// a string/template literal or comment doesn't desync the count for the
// common cases (validators, object literals) this hook actually scans. Not a
// full parser — good enough to bound a function-call block (e.g. the whole
// `query({ ... })` call) whose length varies too much for a fixed-size slice,
// which the pre-existing fixed-slice rules (12/13/14, the delta-field
// advisory) rely on for shorter chains. Returns `text.length` if unbalanced
// (never throws), so a caller can always safely `.slice(start, end)`.
function findMatchingClose(text, openIndex) {
  const opener = text[openIndex];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

try {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    emit(null);
  }

  const toolName = payload.tool_name ?? "";
  const toolInput = payload.tool_input ?? {};
  const filePath = toolInput.file_path ?? "";
  const cwd = payload.cwd ?? process.cwd();
  // Real exports of convex/server, derived from the project's installed convex
  // (null if unresolvable — Rule 6 then no-ops rather than guessing).
  const serverExports = convexServerExports(cwd);

  // Only act on TypeScript source inside a convex/ directory.
  // Skip generated code and declaration files.
  const normalized = String(filePath).replaceAll("\\", "/");
  const isConvexTs =
    /(^|\/)convex\//.test(normalized) &&
    normalized.endsWith(".ts") &&
    !normalized.endsWith(".d.ts") &&
    !normalized.includes("/_generated/");
  if (!isConvexTs) emit(null);

  // --- Compute the projected file content -------------------------------
  let projected = null;
  if (toolName === "Write") {
    projected = typeof toolInput.content === "string" ? toolInput.content : null;
  } else if (toolName === "Edit" || toolName === "MultiEdit") {
    let current;
    try {
      current = readFileSync(resolve(cwd, filePath), "utf8");
    } catch {
      // File missing/unreadable: the tool will error on its own. Not our job.
      emit(null);
    }
    const edits =
      toolName === "MultiEdit"
        ? toolInput.edits
        : [
            {
              old_string: toolInput.old_string,
              new_string: toolInput.new_string,
              replace_all: toolInput.replace_all,
            },
          ];
    if (!Array.isArray(edits)) emit(null);
    projected = current;
    for (const edit of edits) {
      const oldStr = edit?.old_string;
      const newStr = edit?.new_string;
      if (typeof oldStr !== "string" || typeof newStr !== "string") emit(null);
      if (!projected.includes(oldStr)) {
        // old_string not found: the tool will surface that error itself.
        emit(null);
      }
      projected = edit?.replace_all
        ? projected.replaceAll(oldStr, newStr)
        : projected.replace(oldStr, newStr);
    }
  }
  if (typeof projected !== "string") emit(null);

  // --- HARD DENY rules ---------------------------------------------------

  // Rule 1: `.filter(q => … q.field(…))` on a Convex db query. The
  // `q.field(` token inside the filter callback (same param name) is the
  // discriminator — a JS array `.filter` callback never calls `q.field(`.
  const dbFilterRe =
    /\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>[\s\S]{0,200}?\b\1\.field\(/;
  const dbFilterMatch = dbFilterRe.exec(projected);
  if (dbFilterMatch) {
    track("db_filter", "deny");
    deny(
      `convex-lint rule ".filter on a db query": this write contains ` +
        `\`${snippet(dbFilterMatch[0])}\` — \`.filter\` scans the whole ` +
        `table on every call. Use ` +
        `\`.withIndex("by_...", q => q.eq(...))\` with an index defined in ` +
        `convex/schema.ts instead. Define the index with ` +
        `\`.index("by_<field>", ["<field>"])\` on the table, then query it ` +
        `via \`.withIndex\`.`,
    );
  }

  // Rule 2: old positional function syntax, e.g. `query(async (ctx, …) => …)`.
  const positionalRe =
    /\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\s*async\s*\(/;
  const positionalMatch = positionalRe.exec(projected);
  if (positionalMatch) {
    track("positional_syntax", "deny");
    deny(
      `convex-lint rule "old positional function syntax": this write ` +
        `contains \`${snippet(positionalMatch[0])}\` — passing a bare async ` +
        `handler to \`${positionalMatch[1]}\` is the deprecated positional ` +
        `form. Convex functions use the object form: ` +
        `${positionalMatch[1]}({ args: {...}, returns: ..., ` +
        `handler: async (ctx, args) => {...} }).`,
    );
  }

  // Rule 3: `import { ... } from "convex/server"` where the import list
  // contains a function constructor. Those live in the generated
  // `./_generated/server`, not the package entrypoint — this is a hard
  // deploy failure (Finding 3), and the pattern is unambiguous: an import
  // statement literally naming the "convex/server" module specifier.
  const serverPkgImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']convex\/server["']/g;
  let serverPkgMatch;
  while ((serverPkgMatch = serverPkgImportRe.exec(projected)) !== null) {
    const names = serverPkgMatch[1];
    const fnNameRe =
      /(^|[,\s])(query|mutation|action|internalQuery|internalMutation|internalAction)($|[,\s:])/;
    if (fnNameRe.test(names)) {
      track("server_pkg_import", "deny");
      deny(
        `convex-lint rule "convex/server import": this write contains ` +
          `\`${snippet(serverPkgMatch[0])}\` — \`query\`/\`mutation\`/` +
          `\`action\` (and their internal* variants) are exported from the ` +
          `generated \`./_generated/server\`, not the \`convex/server\` ` +
          `package entrypoint. Fix: ` +
          `\`import { ${names.trim()} } from "./_generated/server";\`.`,
      );
    }
  }

  // Rule 4: `import { internal } from "./_generated/server"` or
  // `import { api } from "./_generated/server"`. `internal`/`api` are
  // exported from `./_generated/api`, not `./_generated/server` — a hard
  // deploy failure (Finding 3), unambiguous because it names the exact
  // generated module specifier.
  const genServerImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']\.\/_generated\/server["']/g;
  let genServerMatch;
  while ((genServerMatch = genServerImportRe.exec(projected)) !== null) {
    const names = genServerMatch[1];
    const badNameRe = /(^|[,\s])(internal|api)($|[,\s:])/;
    if (badNameRe.test(names)) {
      track("generated_server_import", "deny");
      deny(
        `convex-lint rule "_generated/server import": this write contains ` +
          `\`${snippet(genServerMatch[0])}\` — \`internal\`/\`api\` are ` +
          `exported from \`./_generated/api\`, not \`./_generated/server\`. ` +
          `Fix: import them from ` +
          `\`import { internal, api } from "./_generated/api";\` (keep any ` +
          `other names from this import, e.g. \`query\`/\`mutation\`, on ` +
          `\`./_generated/server\`).`,
      );
    }
  }

  // Rule 5: `"use node"` in a file that also defines `query(` or
  // `mutation(`. Queries and mutations cannot run in the Node.js runtime —
  // a hard deploy failure. Unambiguous: the directive plus a query/mutation
  // constructor call in the same projected file.
  const useNodeRe = /^\s*["']use node["'];?\s*$/m;
  if (useNodeRe.test(projected)) {
    const queryOrMutationRe = /\b(query|mutation)\s*\(/;
    const qmMatch = queryOrMutationRe.exec(projected);
    if (qmMatch) {
      track("use_node_query_mutation", "deny");
      deny(
        `convex-lint rule "\\"use node\\" with query/mutation": this file ` +
          `has \`"use node"\` at the top and also defines \`${snippet(qmMatch[0])}` +
          `…)\` — queries and mutations cannot run in the Node.js runtime, ` +
          `only actions can. Move ${qmMatch[1]} definitions to a file ` +
          `without \`"use node"\`, or convert this to an \`action\` that ` +
          `calls a query/mutation via \`ctx.runQuery\`/\`ctx.runMutation\`.`,
      );
    }
  }

  // Rule 6: `import { ... } from "convex/server"` naming a symbol that
  // isn't a real export of that package entrypoint. Grounded against
  // CONVEX_SERVER_EXPORTS above. Unambiguous: any named import whose
  // identifier isn't in the real export set is a hallucinated symbol that
  // will fail at build time. Skip default/namespace imports and `as`
  // aliases (check the local-facing bound name would be wrong; instead we
  // check the exported name, i.e. the part before `as` if present).
  const serverPkgAnyImportRe =
    /import\s*\{([^}]*)\}\s*from\s*["']convex\/server["']/g;
  let serverAnyMatch;
  while ((serverAnyMatch = serverPkgAnyImportRe.exec(projected)) !== null) {
    const names = serverAnyMatch[1];
    const parts = names
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      // `Foo`, `type Foo`, or `Foo as Bar` — the exported name is the part
      // before `as` (with an inline `type` modifier stripped).
      const exportedName = part.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!exportedName) continue;
      // Only flag when we actually know the real export set; otherwise no-op.
      if (serverExports && !serverExports.has(exportedName)) {
        track("server_pkg_bad_symbol", "deny");
        const hint =
          exportedName === "HttpResponse"
            ? ` \`HttpResponse\` doesn't exist — use \`httpAction\` from ` +
              `\`./_generated/server\` and return a web-standard \`Response\`.`
            : ` \`${exportedName}\` is not exported by \`convex/server\`.`;
        deny(
          `convex-lint rule "convex/server bad symbol": this write ` +
            `contains \`${snippet(serverAnyMatch[0])}\` —${hint} Real ` +
            `exports of \`convex/server\` include \`defineSchema\`, ` +
            `\`defineTable\`, \`httpRouter\`, \`defineApp\`, ` +
            `\`defineComponent\`, and the generic function-constructor ` +
            `variants (\`queryGeneric\`, \`mutationGeneric\`, etc.) — but ` +
            `\`query\`/\`mutation\`/\`action\`/\`httpAction\`/\`internal\`/` +
            `\`api\` all come from \`./_generated/server\` or ` +
            `\`./_generated/api\` instead.`,
        );
      }
    }
  }

  // Rule 7 (schema files only): reserved index names. Convex auto-appends
  // `_creationTime` as the implicit tiebreaker on every index, and reserves
  // `by_id` / `by_creation_time` / any name starting with `_` — all four are
  // unambiguous `IndexNameReserved` hard deploy failures documented in this
  // plugin's own skills (agents/convex-expert.md, skills/design/SKILL.md).
  // Scoped to files named `schema.ts` so a `.index(` call elsewhere (e.g. in
  // generated typing examples) can't false-positive.
  const normalizedForSchema = normalized;
  const isSchemaFile = /(^|\/)schema\.ts$/.test(normalizedForSchema);
  if (isSchemaFile) {
    const indexCallRe = /\.index\(\s*(["'`])((?:(?!\1).)*)\1\s*,\s*(\[[^\]]*\])/g;
    let indexMatch;
    while ((indexMatch = indexCallRe.exec(projected)) !== null) {
      const indexName = indexMatch[2];
      const fieldsLiteral = indexMatch[3];
      if (indexName === "by_id" || indexName === "by_creation_time") {
        track("reserved_index_name", "deny");
        deny(
          `convex-lint rule "reserved index name": this write contains ` +
            `\`${snippet(indexMatch[0])}\` — \`${indexName}\` is a ` +
            `reserved index name (Convex auto-appends \`_creationTime\` as ` +
            `the implicit tiebreaker on every index, and \`by_id\` / ` +
            `\`by_creation_time\` are reserved). Rename the index to ` +
            `describe the field(s) it covers, e.g. \`.index("by_<field>", ` +
            `[...])\`.`,
        );
      }
      if (indexName.startsWith("_")) {
        track("reserved_index_name", "deny");
        deny(
          `convex-lint rule "reserved index name": this write contains ` +
            `\`${snippet(indexMatch[0])}\` — index names starting with ` +
            `\`_\` are reserved. Rename the index to describe the ` +
            `field(s) it covers, e.g. \`.index("by_<field>", [...])\`.`,
        );
      }
      if (/_creationTime/.test(fieldsLiteral)) {
        track("reserved_index_name", "deny");
        deny(
          `convex-lint rule "reserved index name": this write contains ` +
            `\`${snippet(indexMatch[0])}\` — \`_creationTime\` cannot be ` +
            `listed as an index field; Convex auto-appends it as the ` +
            `implicit tiebreaker on every index. Remove it from the ` +
            `fields array.`,
        );
      }
    }

    // Reserved TABLE names: a top-level schema property (or a `defineTable`
    // call assigned to one) whose name starts with `_`, e.g.
    // `_migrations: defineTable({...})`. This is `TableNameReserved`, the
    // table-level twin of the `IndexNameReserved` checks above (eval-failure
    // repro: f2-schema-migration, `_migrations is a reserved table name.`).
    // Discriminator: an object-key (quoted or bare identifier) starting with
    // `_`, immediately followed by `:` and (eventually) `defineTable(` as the
    // value — scoped to schema.ts so this can't false-positive on an
    // unrelated object literal elsewhere.
    const reservedTableRe =
      /(^|[{,]\s*)(["'`]?)(_[A-Za-z0-9_]*)\2\s*:\s*defineTable\s*\(/g;
    let tableMatch;
    while ((tableMatch = reservedTableRe.exec(projected)) !== null) {
      const tableName = tableMatch[3];
      track("reserved_table_name", "deny");
      deny(
        `convex-lint rule "reserved table name": this write contains ` +
          `\`${snippet(`${tableName}: defineTable(`)}\` — \`${tableName}\` ` +
          `is a reserved table name (table names starting with \`_\` are ` +
          `reserved by Convex, same rule as reserved index names). Rename ` +
          `the table to drop the leading underscore, e.g. ` +
          `\`${tableName.replace(/^_+/, "")}: defineTable(...)\`.`,
      );
    }
  }

  // Rule 8: `export const <jsReservedWord> = ...` in a convex/*.ts file.
  // esbuild fails with "Expected identifier but found <word>" — no valid JS
  // binding can use a reserved word as its name. Unambiguous: this is a
  // fixed, closed set of ECMAScript reserved words (the ones a model
  // realistically reaches for as a CRUD verb — `delete` above all — plus the
  // rest of the keyword set that breaks esbuild the same way), matched only
  // as the identifier immediately after `export const`.
  const jsReservedWords = [
    "delete", "new", "class", "function", "return", "import", "default",
    "typeof", "void", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "try", "catch", "finally", "throw", "instanceof",
    "in", "this", "super", "extends", "export", "const", "let", "var",
    "null", "true", "false", "yield", "await", "static", "enum",
  ];
  const reservedWordAlt = jsReservedWords.join("|");
  const reservedIdentifierRe = new RegExp(
    `export\\s+const\\s+(${reservedWordAlt})\\s*=`,
    "g",
  );
  let reservedIdMatch;
  while ((reservedIdMatch = reservedIdentifierRe.exec(projected)) !== null) {
    const word = reservedIdMatch[1];
    track("reserved_identifier", "deny");
    deny(
      `convex-lint rule "reserved identifier": this write contains ` +
        `\`${snippet(reservedIdMatch[0])}\` — \`${word}\` is a JS reserved ` +
        `word and can't be used as an export name (esbuild fails with ` +
        `"Expected identifier but found \\"${word}\\""). Rename the export ` +
        `to a non-reserved synonym, e.g. \`export const remove = ...\` or ` +
        `\`export const destroy = ...\` instead of \`export const ${word} = ...\`.`,
    );
  }

  // Rule 9: a Node.js builtin module imported (or required) in a
  // convex/*.ts file that does not start with `"use node"`. Convex's default
  // runtime is a V8 isolate with no Node builtins — bundling fails with
  // "Could not resolve '<module>' ... built into node" (eval-failure repro:
  // f3-billing-entitlements, `import crypto from "crypto"` in convex/http.ts,
  // a file with no `"use node"` directive). Unambiguous regardless of what
  // the file defines (query/mutation/httpRouter/schema/etc.) — every
  // non-`"use node"` file in convex/ runs in the isolate, so any Node
  // builtin import there is always a hard deploy failure. Matches both the
  // bare specifier (`"crypto"`) and the `node:` prefix (`"node:crypto"`).
  const nodeBuiltins = [
    "crypto", "fs", "path", "http", "https", "child_process", "os", "net",
    "tls", "dns", "stream", "zlib", "util", "buffer", "events", "url",
    "querystring", "assert", "cluster", "dgram", "readline", "repl", "vm",
    "worker_threads", "perf_hooks",
  ];
  const builtinAlt = nodeBuiltins.join("|");
  if (!useNodeRe.test(projected)) {
    const nodeImportRe = new RegExp(
      `(?:import\\s+(?:[\\w*{}\\s,]+\\s+from\\s+)?|require\\(\\s*)` +
        `["'](?:node:)?(${builtinAlt})["']`,
      "g",
    );
    let nodeImportMatch;
    while ((nodeImportMatch = nodeImportRe.exec(projected)) !== null) {
      const mod = nodeImportMatch[1];
      track("node_api_without_use_node", "deny");
      deny(
        `convex-lint rule "Node API without \"use node\"": this write ` +
          `contains \`${snippet(nodeImportMatch[0])}\` — \`${mod}\` is a ` +
          `Node.js builtin, but this file has no \`"use node"\` directive. ` +
          `Convex's default runtime is a V8 isolate with no Node builtins, ` +
          `so esbuild will fail to resolve \`${mod}\`. Fix: either move the ` +
          `code that needs \`${mod}\` into a separate action file that ` +
          `starts with \`"use node";\` (actions are the only functions that ` +
          `can run in the Node.js runtime), or — for \`crypto\` ` +
          `specifically — use the Web Crypto API via \`globalThis.crypto\` ` +
          `(e.g. \`crypto.subtle\`, \`crypto.randomUUID()\`), which needs no ` +
          `import and works in the default runtime.`,
      );
    }
  }

  // Rule 10: an `httpRouter` route `path:` containing an Express-style
  // `:param` dynamic segment (e.g. `path: "/api/users/:userId"`). Convex's
  // `httpRouter` only supports exact-string match or `pathPrefix` — it has no
  // colon-param syntax, so a route registered this way only ever matches the
  // literal path string `/api/users/:userId` and is permanently dead code
  // (confirmed real defect from the defect-review sample: forum/haiku's
  // `http.ts:33` `/api/users/:userId`, `/api/questions/:questionId`, plus 6
  // more routes in the same file; warehouse/haiku's `http.ts:56`
  // `/items/:id`). Unambiguous: a `path:` string literal inside an
  // `http.route({...})` call containing a `/:` segment can never be a valid
  // dynamic Convex route regardless of file contents around it.
  const httpParamRouteRe =
    /\bpath\s*:\s*(["'`])((?:(?!\1).)*\/:[A-Za-z_][A-Za-z0-9_]*(?:(?!\1).)*)\1/g;
  let httpParamMatch;
  while ((httpParamMatch = httpParamRouteRe.exec(projected)) !== null) {
    const routePath = httpParamMatch[2];
    track("http_router_param_route", "deny");
    deny(
      `convex-lint rule "httpRouter :param route": this write contains ` +
        `\`${snippet(httpParamMatch[0])}\` — Convex's \`httpRouter\` does ` +
        `NOT support Express-style \`:param\` path segments. A route ` +
        `registered as \`path: "${routePath}"\` only ever matches that ` +
        `literal string — it never matches a real dynamic value, so the ` +
        `route is permanently unreachable dead code. Fix: use ` +
        `\`pathPrefix\` and parse the trailing segment yourself, e.g. ` +
        `\`http.route({ pathPrefix: "${routePath.split("/:")[0]}/", method: ` +
        `"GET", handler: httpAction(async (ctx, request) => { const id = ` +
        `new URL(request.url).pathname.split("/").pop(); ... }) })\`.`,
    );
  }

  // Rule 11: an `http.route({...})` call whose `handler:` is a bare
  // function (`async (ctx...) => {...}` or `async function(...)  {...}`)
  // instead of being wrapped in `httpAction(...)`. Confirmed real defect
  // (forum/haiku-plugin `http.ts:10`, warehouse/haiku `http.ts:14`) — an
  // unwrapped handler doesn't get Convex's `httpAction` request/response
  // plumbing and fails to deploy as a valid HTTP action. Scoped to the
  // `handler:` key immediately inside an `http.route({` call: walk forward
  // from each `http.route({` to its matching `handler:` and check whether
  // `httpAction(` appears before the handler's arrow/function keyword.
  const httpRouteBlockRe = /\bhttp\.route\(\s*\{/g;
  let httpRouteBlockMatch;
  while ((httpRouteBlockMatch = httpRouteBlockRe.exec(projected)) !== null) {
    const blockStart = httpRouteBlockMatch.index;
    const blockSlice = projected.slice(blockStart, blockStart + 400);
    const handlerMatch = /\bhandler\s*:\s*(httpAction\s*\(|async\s*(?:\([^)]*\)|\w+)\s*=>|async\s+function\b|function\b)/.exec(
      blockSlice,
    );
    if (handlerMatch && !/^httpAction\s*\(/.test(handlerMatch[1])) {
      track("http_route_handler_not_wrapped", "deny");
      deny(
        `convex-lint rule "http.route handler not wrapped in httpAction": ` +
          `this write contains \`${snippet(handlerMatch[0])}\` inside an ` +
          `\`http.route({...})\` call — the \`handler:\` of an HTTP route ` +
          `must be wrapped in \`httpAction(...)\` (imported from ` +
          `\`./_generated/server\`), e.g. \`handler: httpAction(async ` +
          `(ctx, request) => { ... return new Response(...); })\`. A bare ` +
          `\`async (ctx, request) => {...}\` without the \`httpAction(...)\` ` +
          `wrapper is not a valid HTTP action.`,
      );
    }
  }

  // Rule 12: `.range(` chained as a method call inside a `withIndex(...)`
  // index-range builder callback (e.g. `q.eq("acknowledged", false).range((r)
  // => r.lte("alertedAt", Date.now()))`). Confirmed real defect (warehouse/
  // haiku `dashboard.ts:10`) and verified against the `convex` package's
  // `IndexRangeBuilder` type: the only methods on that builder are `eq`,
  // `gt`, `gte`, `lt`, `lte`, chained directly on the callback param — there
  // is no `.range(...)` method anywhere in the chain, and calling one method
  // (e.g. `.eq(...)`) returns a terminal `IndexRange` with no further
  // methods, so `.range(` after it is always a type error / hallucinated
  // API, never a real pattern. Scoped to inside a `withIndex(` callback so a
  // same-named `.range(` on an unrelated object elsewhere can't false-positive.
  const withIndexBlockRe = /\.withIndex\(\s*(["'`])(?:(?!\1).)*\1\s*,\s*\(?\s*(\w+)\s*\)?\s*=>/g;
  let withIndexMatch;
  while ((withIndexMatch = withIndexBlockRe.exec(projected)) !== null) {
    const param = withIndexMatch[2];
    const bodyStart = withIndexMatch.index + withIndexMatch[0].length;
    const bodySlice = projected.slice(bodyStart, bodyStart + 300);
    // Trim at the callback's likely end (matching close paren for withIndex
    // is hard with regex; a generous slice + terminator scan is enough since
    // we only need to detect the discriminator token, not fully parse it).
    const terminatorMatch = /\n\s*\)\s*\.|\n\s*\)\s*;|\n\s*\}\s*\)/.exec(bodySlice);
    const body = terminatorMatch ? bodySlice.slice(0, terminatorMatch.index) : bodySlice;
    const rangeCallRe = new RegExp(`\\b${param}\\.[a-zA-Z]+\\([^)]*\\)\\.range\\(`);
    const rangeMatch = rangeCallRe.exec(body) || /\)\.range\(/.exec(body);
    if (rangeMatch) {
      track("withindex_range_method", "deny");
      deny(
        `convex-lint rule "withIndex .range() is not a method": this write ` +
          `contains \`${snippet(rangeMatch[0])}\` inside a \`.withIndex(...)\` ` +
          `callback — \`.range(...)\` is not a method on Convex's ` +
          `\`IndexRangeBuilder\`. The only methods are \`eq\`, \`gt\`, ` +
          `\`gte\`, \`lt\`, \`lte\`, chained directly on the callback param, ` +
          `e.g. \`q.eq("acknowledged", false).lte("alertedAt", Date.now())\` ` +
          `— no \`.range(...)\` wrapper and no nested callback.`,
      );
    }
  }

  // Rule 13: `.count()` chained onto a `ctx.db.query(...)` builder. Not a
  // real method — verified against the installed `convex` package's
  // `Query`/`OrderedQuery` types (`.d.ts`), which expose `collect`, `take`,
  // `first`, `unique`, `paginate`, but no `.count()`. Confirmed real defect
  // (kanban/haiku-plugin `board.ts:56` — `ctx.db.query("comments")
  // .withIndex("by_card", ...).count()` throws a TypeError on every
  // `getBoard` call for a card with any comments). Unambiguous: scoped to a
  // `ctx.db.query(` chain (same discriminator style as Rule 12's
  // `.withIndex` scoping) so an unrelated same-named `.count()` on a
  // different object (e.g. a plain array or a third-party client) can't
  // false-positive.
  const dbQueryCountRe = /ctx\.db\s*\.query\(/g;
  let dqc;
  while ((dqc = dbQueryCountRe.exec(projected)) !== null) {
    const chainEnd = Math.min(projected.length, dqc.index + 500);
    let chain = projected.slice(dqc.index, chainEnd);
    const terminatorMatch = /;|\n\s*\n/.exec(chain);
    if (terminatorMatch) chain = chain.slice(0, terminatorMatch.index);
    const countMatch = /\.count\(\s*\)/.exec(chain);
    if (countMatch) {
      track("db_query_count_method", "deny");
      deny(
        `convex-lint rule "ctx.db.query .count() is not a method": this ` +
          `write contains \`${snippet(chain.slice(0, countMatch.index + countMatch[0].length))}\` ` +
          `— \`.count()\` is not a method on Convex's query builder ` +
          `(\`Query\`/\`OrderedQuery\` expose \`collect\`, \`take\`, ` +
          `\`first\`, \`unique\`, \`paginate\` — no \`.count()\`). This ` +
          `throws a TypeError at runtime on every call. Fix: materialize ` +
          `the rows with \`.collect()\` (or a bounded \`.take(n)\`/` +
          `\`.paginate(...)\`) and read \`.length\`, or maintain a running ` +
          `counter field on the parent document if the table can grow ` +
          `large.`,
      );
    }
  }

  // Rule 14: `.skip(` chained onto a `ctx.db.query(...)` builder. Not a real
  // method — Convex's query builder has no offset-based pagination; use an
  // index range (`.withIndex`) or the cursor-based `.paginate(paginationOpts)`
  // instead. Confirmed real defect (ledger/haiku `accounting.ts:248` —
  // `.order("desc").skip(skip).take(limit).collect()` throws `TypeError:
  // skip is not a function` on every call, and even if it existed,
  // `.take(n)` already returns an array, which has no further `.collect()`).
  // Unambiguous for the same reason as Rule 13: scoped to a `ctx.db.query(`
  // chain so it can't collide with an unrelated `.skip(` on some other API
  // (e.g. a test-runner or stream object) outside that chain.
  const dbQuerySkipRe = /ctx\.db\s*\.query\(/g;
  let dqs;
  while ((dqs = dbQuerySkipRe.exec(projected)) !== null) {
    const chainEnd = Math.min(projected.length, dqs.index + 500);
    let chain = projected.slice(dqs.index, chainEnd);
    const terminatorMatch = /;|\n\s*\n/.exec(chain);
    if (terminatorMatch) chain = chain.slice(0, terminatorMatch.index);
    const skipMatch = /\.skip\(\s*[^)]*\)/.exec(chain);
    if (skipMatch) {
      track("db_query_skip_method", "deny");
      deny(
        `convex-lint rule "ctx.db.query .skip() is not a method": this ` +
          `write contains \`${snippet(chain.slice(0, skipMatch.index + skipMatch[0].length))}\` ` +
          `— \`.skip(...)\` is not a method on Convex's query builder; ` +
          `there is no offset-based pagination. This throws a TypeError at ` +
          `runtime on every call. Fix: use cursor-based pagination via ` +
          `\`.paginate(paginationOpts)\` (returns \`{ page, isDone, ` +
          `continueCursor }\`), or an index range with \`.withIndex(...)\` ` +
          `plus \`.take(n)\` if you only need a bounded page from a known ` +
          `starting point.`,
      );
    }
  }

  // Rule 15: `ctx.runQuery(...)` / `ctx.runMutation(...)` / `ctx.runAction(...)`
  // whose first argument is a string literal (e.g.
  // `ctx.runMutation("users:getOrCreateUser", {...})`). Confirmed real
  // defect (booking/haiku `http.ts:22` — `ctx.runMutation("users:getOrCreateUser",
  // ...)`; kanban/haiku `http.ts:31` — `ctx.runMutation("boards:createBoard",
  // ...)`). Convex's `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` require
  // a `FunctionReference` object produced by codegen (`api.foo.bar` /
  // `internal.foo.bar`); a plain string can never satisfy that type, so this
  // is a hard deploy-blocking TypeScript error every time, stronger than the
  // module-namespace-reference case below (which at least *could* look like
  // a valid reference to a naive regex) — no false-positive risk at all: a
  // string literal is never a valid first argument to any of these three
  // calls.
  const runCallStringRe =
    /\bctx\.(runQuery|runMutation|runAction)\(\s*(["'`])([^"'`]*)\2/g;
  let runCallStringMatch;
  while ((runCallStringMatch = runCallStringRe.exec(projected)) !== null) {
    const [full, runFn, , literalName] = runCallStringMatch;
    track("run_call_string_literal", "deny");
    deny(
      `convex-lint rule "ctx.${runFn} with string literal": this write ` +
        `contains \`${snippet(full)}\` — \`ctx.${runFn}\` requires a ` +
        `\`FunctionReference\` object from \`./_generated/api\` ` +
        `(\`api.*\`/\`internal.*\`), not a string like \`"${literalName}"\`. ` +
        `A string can never satisfy that type, so this is a hard ` +
        `TypeScript/deploy failure. Fix: split \`"${literalName}"\` on \`:\` ` +
        `to find the module and export (e.g. \`"users:getOrCreateUser"\` → ` +
        `\`api.users.getOrCreateUser\`), import ` +
        `\`{ api, internal } from "./_generated/api"\`, and call ` +
        `\`ctx.${runFn}(api.users.getOrCreateUser, {...})\` instead.`,
    );
  }

  // --- SOFT WARNINGS (never deny) ----------------------------------------
  // Heuristic: each `query({`-style block whose first ~300 chars contain no
  // `args:` / `returns:` gets one advisory line.
  const warnings = [];
  let firstWarningRule = null;
  const objectFormRe =
    /\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\s*\{/g;
  let m;
  while ((m = objectFormRe.exec(projected)) !== null) {
    const head = projected.slice(m.index, m.index + 300);
    const missing = [];
    if (!/\bargs\s*:/.test(head)) missing.push("`args:`");
    if (!/\breturns\s*:/.test(head)) missing.push("`returns:`");
    if (missing.length > 0) {
      if (firstWarningRule === null) {
        firstWarningRule = missing[0] === "`args:`"
          ? "missing_args"
          : "missing_returns";
      }
      warnings.push(
        `convex-lint: a \`${m[1]}({...})\` in \`${filePath}\` appears to be ` +
          `missing ${missing.join(" and ")}. Convex functions should always ` +
          `declare argument and return validators (use v.null() for ` +
          `functions that return nothing).`,
      );
    }
  }
  // Advisory: unbounded `.collect()`. Find each `ctx.db.query(...)` call and
  // walk forward through its method chain up to the first statement
  // terminator (`;`, or a blank line, capped at 500 chars so one bad chain
  // can't scan the whole file). If the chain reaches `.collect()` without
  // `.withIndex(`, `.take(`, or `.paginate(` appearing anywhere in it, that's
  // an unbounded full-table scan materialized into memory — the dominant
  // defect class from the eval (Finding 2). This never denies: `.collect()`
  // is legitimate on small/bounded tables and the analyzer can't know table
  // size, so it's advisory-only, same discipline as the args/returns checks.
  const dbQueryRe = /ctx\.db\s*\.query\(/g;
  let dq;
  while ((dq = dbQueryRe.exec(projected)) !== null) {
    const chainEnd = Math.min(projected.length, dq.index + 500);
    let chain = projected.slice(dq.index, chainEnd);
    // Trim the chain at the first statement-ish boundary so we don't bleed
    // into unrelated following code.
    const terminatorMatch = /;|\n\s*\n/.exec(chain);
    if (terminatorMatch) chain = chain.slice(0, terminatorMatch.index);
    const collectMatch = /\.collect\(\s*\)/.exec(chain);
    if (!collectMatch) continue;
    const isBounded =
      /\.withIndex\(/.test(chain) ||
      /\.take\(/.test(chain) ||
      /\.paginate\(/.test(chain);
    if (isBounded) continue;
    if (firstWarningRule === null) firstWarningRule = "unbounded_collect";
    warnings.push(
      `convex-lint: an unbounded \`.collect()\` in \`${filePath}\` — ` +
        `\`${snippet(chain.slice(0, collectMatch.index + collectMatch[0].length))}\` ` +
        `has no \`.withIndex(...)\`, \`.take(n)\`, or \`.paginate(...)\` in ` +
        `the chain, so it loads the entire table into memory on every call. ` +
        `Define an index in convex/schema.ts (\`.index("by_<field>", ` +
        `["<field>"])\`) and query it with \`.withIndex("by_<field>", q => ` +
        `q.eq("<field>", value))\`, then bound the result with \`.take(n)\` ` +
        `or \`.paginate(paginationOpts)\` instead of \`.collect()\` on a ` +
        `table that can grow.`,
    );
  }

  // Advisory (convex.config.ts only): `app.use(X)` where `X` was imported
  // from a relative path (e.g. `import http from "./http"`). Real
  // components mount via a package's `convex.config` subpath
  // (`app.use(agent)` from `import agent from "@convex-dev/agent/convex.config"`)
  // — a relative-path import feeding `app.use(...)` is very likely a mixup
  // with an unrelated local module (e.g. an HTTP router) rather than a
  // component. This is advisory, not a deny: an app *could* have a
  // legitimate local sub-app in rare setups, so it isn't unambiguous enough
  // for a hard deny per this hook's own discipline (false-positive denies
  // are the worst outcome).
  const isConvexConfigFile = /(^|\/)convex\.config\.ts$/.test(normalized);
  if (isConvexConfigFile) {
    const relativeImportNames = new Map();
    const relativeImportRe =
      /import\s+(\w+)\s+from\s*["'](\.\.?\/[^"']*)["']/g;
    let relImportMatch;
    while ((relImportMatch = relativeImportRe.exec(projected)) !== null) {
      relativeImportNames.set(relImportMatch[1], relImportMatch[2]);
    }
    if (relativeImportNames.size > 0) {
      const appUseRe = /\bapp\.use\(\s*(\w+)\s*[,)]/g;
      let appUseMatch;
      while ((appUseMatch = appUseRe.exec(projected)) !== null) {
        const usedName = appUseMatch[1];
        if (relativeImportNames.has(usedName)) {
          if (firstWarningRule === null) firstWarningRule = "app_use_relative_import";
          warnings.push(
            `convex-lint: \`app.use(${usedName})\` in \`${filePath}\` — ` +
              `\`${usedName}\` was imported from a relative path ` +
              `(\`${relativeImportNames.get(usedName)}\`), not a package's ` +
              `\`convex.config\` subpath. Components mount like ` +
              `\`import ${usedName} from "@convex-dev/<pkg>/convex.config"; ` +
              `app.use(${usedName});\` — if \`${usedName}\` is meant to be a ` +
              `component, install its package; if it's something else ` +
              `(e.g. an HTTP router), it likely doesn't belong in ` +
              `\`app.use(...)\` at all.`,
          );
        }
      }
    }
  }

  // Advisory (http.ts only): `ctx.runQuery(...)` / `ctx.runMutation(...)` /
  // `ctx.runAction(...)` whose first argument is a bare module-namespace
  // reference (`import * as queries from "./queries"; ...
  // ctx.runQuery(queries.getX, ...)`) instead of an `api.*`/`internal.*`
  // function reference. Confirmed real defect (forum/haiku-plugin
  // `http.ts:2`/`:27` — `ctx.runQuery(queries.getQuestions, ...)`); Convex's
  // `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction` require a
  // `FunctionReference` produced by codegen (`api.foo.bar` /
  // `internal.foo.bar`), not the raw exported function value — passing the
  // function itself compiles (both are callables to TS's structural typing)
  // but fails at runtime with a "not a function reference" error. This is
  // advisory rather than a hard deny because the module-alias name is
  // project-specific (`queries`/`mutations`/anything) and a regex can't fully
  // rule out a same-shaped false positive, so it stays a warning per this
  // hook's "hard-deny only when unambiguous" discipline.
  const isHttpFile = /(^|\/)http\.ts$/.test(normalized);
  if (isHttpFile) {
    const namespaceImports = new Set();
    const namespaceImportRe = /import\s+\*\s+as\s+(\w+)\s+from\s*["'](\.\/[^"']*)["']/g;
    let nsMatch;
    while ((nsMatch = namespaceImportRe.exec(projected)) !== null) {
      // Skip the real generated namespaces, if a project ever names an alias
      // this way — api/internal themselves are fine.
      if (nsMatch[1] !== "api" && nsMatch[1] !== "internal") {
        namespaceImports.add(nsMatch[1]);
      }
    }
    if (namespaceImports.size > 0) {
      const runCallRe = /\bctx\.(runQuery|runMutation|runAction)\(\s*(\w+)\.(\w+)/g;
      let runCallMatch;
      while ((runCallMatch = runCallRe.exec(projected)) !== null) {
        const [full, runFn, ns, member] = runCallMatch;
        if (namespaceImports.has(ns)) {
          if (firstWarningRule === null) firstWarningRule = "run_call_module_ref";
          warnings.push(
            `convex-lint: \`ctx.${runFn}(${ns}.${member}, ...)\` in ` +
              `\`${filePath}\` — \`${ns}\` was imported as ` +
              `\`import * as ${ns} from "./${ns}"\`, so \`${ns}.${member}\` ` +
              `is the raw exported function, not a Convex function ` +
              `reference. \`ctx.${runFn}\` needs \`api.${ns}.${member}\` or ` +
              `\`internal.${ns}.${member}\` (imported from ` +
              `\`./_generated/api\`) — this fails at runtime even though it ` +
              `typechecks.`,
          );
        }
      }
    }

    // Sibling shape: a *named* (non-namespace) import of a handler used
    // directly as the run-call argument, e.g.
    // `import { createAccount } from "./accounting"; ...
    // ctx.runMutation(createAccount, {...})`. Same underlying bug as the
    // namespace case above (the raw function value isn't a
    // `FunctionReference`), just a different import shape. Confirmed real
    // defect (ledger/haiku `http.ts:26,32` — `import { createAccount, ... }
    // from "./accounting"` then `ctx.runMutation(createAccount, {...})`).
    // Advisory, not deny, for the same reason as the namespace case: the
    // imported identifier name is project-specific, and a regex can't fully
    // rule out a same-named local variable that happens to hold a real
    // `api.*` reference (e.g. `const createAccount = api.accounting.createAccount;`),
    // so this stays a warning per the hook's "hard-deny only when
    // unambiguous" discipline.
    const namedImports = new Set();
    const namedImportRe = /import\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']*)["']/g;
    let namedMatch;
    while ((namedMatch = namedImportRe.exec(projected)) !== null) {
      if (/_generated\/(api|server)$/.test(namedMatch[2])) continue; // real refs live here
      for (const part of namedMatch[1].split(",")) {
        const localName = part.split(/\s+as\s+/).pop().trim();
        if (localName && localName !== "api" && localName !== "internal") {
          namedImports.add(localName);
        }
      }
    }
    if (namedImports.size > 0) {
      const directRunCallRe = /\bctx\.(runQuery|runMutation|runAction)\(\s*(\w+)\s*[,)]/g;
      let directRunMatch;
      while ((directRunMatch = directRunCallRe.exec(projected)) !== null) {
        const [, runFn, fnName] = directRunMatch;
        if (namedImports.has(fnName)) {
          if (firstWarningRule === null) firstWarningRule = "run_call_named_import_ref";
          warnings.push(
            `convex-lint: \`ctx.${runFn}(${fnName}, ...)\` in ` +
              `\`${filePath}\` — \`${fnName}\` was imported directly ` +
              `(\`import { ${fnName} } from "./..."\`), so it's the raw ` +
              `exported function, not a Convex function reference. ` +
              `\`ctx.${runFn}\` needs \`api.<module>.${fnName}\` or ` +
              `\`internal.<module>.${fnName}\` (imported from ` +
              `\`./_generated/api\`) — this fails at runtime even though it ` +
              `typechecks.`,
          );
        }
      }
    }
  }

  // Advisory: a numeric mutation arg (`v.number()`, no literal/union bound)
  // used directly as a score/balance/quantity delta — i.e. added to or
  // assigned onto a field read via `ctx.db.get`/an existing doc, with no
  // visible range check (`Math.abs`, a comparison against a fixed set, an
  // `if (... < 0 ...)` throw) between the arg declaration and its use.
  // Confirmed real defect shape (forum/haiku `votes.ts:30` — `value:
  // v.number()` used unchecked as `scoreDelta`, letting a client inflate a
  // question's score arbitrarily; warehouse/opus-plugin `stock.ts:20` — NaN/
  // Infinity qty passing guards). This is intentionally advisory, not a hard
  // deny: "is this arg later used as an unchecked delta" requires tracing
  // data flow across the handler body, which a regex can only approximate —
  // false positives are likely on legitimately-unbounded numeric fields
  // (timestamps, free-form counts). Narrow heuristic: an `args` field typed
  // exactly `v.number()` whose name matches a delta/score/vote/quantity
  // shape, with no `v.union(v.literal(` anywhere in the same `args: {...}`
  // block.
  const deltaFieldNameRe = /\b(value|delta|score|vote|qty|quantity|amount)\s*:\s*v\.number\(\)/g;
  let deltaFieldMatch;
  while ((deltaFieldMatch = deltaFieldNameRe.exec(projected)) !== null) {
    const fieldName = deltaFieldMatch[1];
    const argsBlockStart = Math.max(0, deltaFieldMatch.index - 300);
    const argsBlockSlice = projected.slice(argsBlockStart, deltaFieldMatch.index + 200);
    if (/v\.union\(\s*v\.literal\(/.test(argsBlockSlice)) continue; // already bounded nearby
    if (firstWarningRule === null) firstWarningRule = "unbounded_numeric_delta";
    warnings.push(
      `convex-lint: \`${fieldName}: v.number()\` in \`${filePath}\` has no ` +
        `visible bound — if this value is later added to or assigned onto ` +
        `an existing field (a score, balance, or quantity delta), an ` +
        `unchecked \`v.number()\` lets a client send an arbitrarily large ` +
        `or negative value and corrupt that field. If the value is one of a ` +
        `fixed set (e.g. a vote of \`+1\`/\`-1\`), use ` +
        `\`v.union(v.literal(1), v.literal(-1))\` instead; if it's a free ` +
        `magnitude, validate the range explicitly in the handler (reject ` +
        `\`NaN\`, \`Infinity\`, and out-of-bounds values) before using it.`,
    );
  }

  // Advisory: a public `query`/`mutation` whose `args` declare an identity-
  // shaped field (`userId`/`actorId`/`ownerId`/`authorId`/`accountId`, typed
  // `v.id(...)`) while the handler body never references `ctx.auth` at all.
  // This is the mechanically-detectable slice of the corpus's single largest
  // real-defect cluster — "trusts client userId, no ctx.auth" (25 of 214
  // confirmed defects, `FLYWHEEL.md` turn 1, pattern 1) — narrowed down to
  // only the shape a regex can flag without guessing at data flow. Real
  // repros matching this exact shape: `votes.ts` (`cast({ userId: v.id(...),
  // ... })`, forum/haiku `voteOnQuestion`), `bookings.ts`/`appointments.ts`
  // (`cancel`/`setStatus` taking a caller-supplied actor id), `orders.ts`
  // (`checkout({ buyerId: v.id(...), ... })`, shop/haiku-plugin), `queries.ts`
  // (`getUserOrders({ userId: v.id(...) })` — same pattern on the read side).
  // Deliberately conservative, matching turn 1's own reasoning for why this
  // pattern was NOT shipped as lint then (see FLYWHEEL.md: "false-positive
  // risk is too high for one regex to arbitrate 'is this argument used for
  // authz'") — this rule ships only the strict subset turn 1 explicitly
  // called out as too risky to guess at, by requiring BOTH: (a) the
  // fixed-shape identity field name, typed `v.id(...)` (not a bare
  // `v.string()` — narrower than the corpus's full pattern-1 population, but
  // zero ambiguity about "is this an id"), AND (b) literally zero `ctx.auth`
  // anywhere in the block (not "is ctx.auth used correctly," just "is it used
  // at all" — a function that has no auth check whatsoever cannot be
  // deriving identity from it). It is ADVISORY ONLY, never a deny: an
  // internal/admin tool, a seed script, or a trusted server-to-server call
  // legitimately takes a `userId` argument with no `ctx.auth` in sight, and
  // this hook's own discipline is "when in doubt, allow." Scoped to the
  // public `query(`/`mutation(` object-call form only — `internalQuery`/
  // `internalMutation`/`internalAction`/`httpAction` are skipped outright
  // (the `\b` word-boundary on `query`/`mutation` already excludes
  // `internalQuery`/`internalMutation` — verified: no boundary exists between
  // `l` and `Q`/`M` in those identifiers, so this never fires on them).
  const identityArgFieldRe = /\b(userId|actorId|ownerId|authorId|accountId)\s*:\s*v\.id\(/g;
  const publicFnRe = /\b(query|mutation)\(\s*\{/g;
  let pubFnMatch;
  while ((pubFnMatch = publicFnRe.exec(projected)) !== null) {
    const openBraceIndex = pubFnMatch.index + pubFnMatch[0].length - 1;
    const blockEnd = findMatchingClose(projected, openBraceIndex);
    const block = projected.slice(pubFnMatch.index, blockEnd);

    // Only look inside this function's own `args: { ... }` sub-object, not
    // the whole block, so a same-named field in a sibling function (or in
    // `returns:`) can't cross-contaminate.
    const argsKeyMatch = /\bargs\s*:\s*\{/.exec(block);
    if (!argsKeyMatch) continue;
    const argsOpenBrace = argsKeyMatch.index + argsKeyMatch[0].length - 1;
    const argsBlockEnd = findMatchingClose(block, argsOpenBrace);
    const argsBlock = block.slice(argsKeyMatch.index, argsBlockEnd);

    identityArgFieldRe.lastIndex = 0;
    const idFieldMatch = identityArgFieldRe.exec(argsBlock);
    if (!idFieldMatch) continue;

    // Zero `ctx.auth` anywhere in the function block (args + handler both) —
    // deliberately whole-block, not handler-only, so this can't be defeated
    // by a `ctx.auth` reference living just outside the slice we happened to
    // take.
    if (/\bctx\.auth\b/.test(block)) continue;

    const fieldName = idFieldMatch[1];
    if (firstWarningRule === null) firstWarningRule = "identity_arg_no_ctx_auth";
    warnings.push(
      `convex-lint: \`${fieldName}: v.id(...)\` in \`${filePath}\` — this ` +
        `public function takes \`${fieldName}\` as a client-supplied ` +
        `argument and never references \`ctx.auth\` anywhere in its body. ` +
        `Taking ${fieldName} as an argument lets any caller impersonate ` +
        `another user — derive identity from \`await ` +
        `ctx.auth.getUserIdentity()\` instead; if this is an internal/admin ` +
        `fn, ignore.`,
    );
  }

  if (warnings.length > 0) {
    track(firstWarningRule, "warn");
    allowWithWarnings(warnings.slice(0, 10));
  }

  // Nothing matched: stay silent.
  emit(null);
} catch {
  // Any unexpected internal error must never block a write.
  process.exit(0);
}
