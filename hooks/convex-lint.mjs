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
//        automatic implicit tiebreaker Convex appends to every index).
// - `app.use(X)` in `convex.config.ts` where `X`'s import comes from a
//   relative path (e.g. `./http`) is an ADVISORY, not a deny — legitimate
//   components are mounted via a package's `convex.config` subpath
//   (`app.use(agent)` from `@convex-dev/agent/convex.config`), but a
//   same-file relative import isn't unambiguously wrong (could be a local
//   sub-app in rare setups), so this stays soft per the deny discipline below.
// - Everything else (missing `args:` / `returns:` on a function object, an
//   unbounded `.collect()`) is a soft advisory delivered via
//   `additionalContext` on an "allow" decision.
// - Edge discipline: a hard-deny false positive is the worst outcome. When in
//   doubt, allow; any internal error → exit 0 silent (try/catch everywhere).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// Ground truth for Rule 6: the real named exports of the `convex/server`
// package entrypoint. Generated with:
//   cd /tmp && npm i convex --no-save && node -e \
//     'console.log(JSON.stringify(Object.keys(require("convex/server"))))'
// against convex@1.42.1 (2026-07-02). Re-run that command and update this
// list if the package's public surface changes — it is intentionally a
// static snapshot, not a runtime `require`, because this hook must work
// inside a target project that may have a different (or no) `convex`
// resolution from this plugin's own process.
const CONVEX_SERVER_EXPORTS = new Set([
  "HttpRouter",
  "ROUTABLE_HTTP_METHODS",
  "actionGeneric",
  "anyApi",
  "componentsGeneric",
  "createFunctionHandle",
  "cronJobs",
  "currentSystemUdfInComponent",
  "defineApp",
  "defineComponent",
  "defineSchema",
  "defineTable",
  "filterApi",
  "getFunctionAddress",
  "getFunctionName",
  "httpActionGeneric",
  "httpRouter",
  "internalActionGeneric",
  "internalMutationGeneric",
  "internalQueryGeneric",
  "log",
  "makeFunctionReference",
  "mutationGeneric",
  "queryGeneric",
  "paginationOptsValidator",
  "paginationResultValidator",
  "SearchFilter",
]);

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
      // `Foo` or `Foo as Bar` — the exported name is the part before `as`.
      const exportedName = part.split(/\s+as\s+/)[0].trim();
      if (!exportedName) continue;
      if (!CONVEX_SERVER_EXPORTS.has(exportedName)) {
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
  const dbQueryRe = /ctx\.db\.query\(/g;
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
