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
//     6. `import { ... } from "convex/server"` where ANY named import is not
//        a real export of the `convex/server` module — e.g. `HttpResponse`,
//        which does not exist. Grounded against the actual npm package (see
//        CONVEX_SERVER_EXPORTS below): a name outside that list is either a
//        typo, a hallucinated symbol, or one of the generated-server aliases
//        (query/mutation/…) already covered by rule 3. Hard deploy failure.
//     7. `app.use(X)` in convex/convex.config.ts where X is imported from a
//        RELATIVE path (e.g. `./http`) rather than a package's
//        `.../convex.config` submodule — `app.use(...)` only accepts
//        Component definitions from installed Convex Components, never a
//        same-project module. Hard deploy failure when unambiguous
//        (identifier traced to a relative-path import); advisory otherwise.
//     8. `schema.ts` indexes named `by_id` / `by_creation_time` / anything
//        starting with `_`, or an index fields array containing
//        `"_creationTime"` — all reserved; Convex appends `_creationTime`
//        automatically and errors with `IndexNameReserved` / a schema error.
// - Everything else (missing `args:` / `returns:` on a function object, an
//   unbounded `.collect()`) is a soft advisory delivered via
//   `additionalContext` on an "allow" decision.
// - Edge discipline: a hard-deny false positive is the worst outcome. When in
//   doubt, allow; any internal error → exit 0 silent (try/catch everywhere).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { capture } from "./analytics.mjs";

// The real, complete set of named exports of the `convex/server` npm package.
// GROUNDED: `node -e 'console.log(Object.keys(require("convex/server")))'`
// against a real `npm i convex` install (convex@1.42.1) — not hand-typed from
// memory. Any named import from "convex/server" outside this list is either a
// typo, a hallucinated symbol (e.g. `HttpResponse`, which does not exist —
// use `httpAction` from `./_generated/server` and the standard `Response`),
// or one of the generated-server aliases (`query`/`mutation`/`action`/
// `internalQuery`/`internalMutation`/`internalAction`) that rule 3 above
// already denies by name and that in fact live in `./_generated/server`.
const CONVEX_SERVER_EXPORTS = new Set([
  "HttpRouter",
  "ROUTABLE_HTTP_METHODS",
  "SearchFilter",
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
  "paginationOptsValidator",
  "paginationResultValidator",
  "queryGeneric",
]);

// Symbols agents most often expect to be here but genuinely live elsewhere —
// used only to make the deny message point somewhere useful.
const CONVEX_SERVER_KNOWN_ELSEWHERE = {
  query: "./_generated/server",
  mutation: "./_generated/server",
  action: "./_generated/server",
  internalQuery: "./_generated/server",
  internalMutation: "./_generated/server",
  internalAction: "./_generated/server",
  api: "./_generated/api",
  internal: "./_generated/api",
  httpAction: "./_generated/server",
  HttpResponse: null, // does not exist anywhere — use httpAction + a standard Response
};

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

  // Rule 6: `import { ... } from "convex/server"` where ANY named import is
  // not a real export of the package (see CONVEX_SERVER_EXPORTS above,
  // grounded against the actual npm package). Unambiguous — an import
  // statement can only name symbols that either exist or don't. Skip names
  // already covered by rule 3 (query/mutation/action/internal*) so the deny
  // reason for those stays specific to that rule; this rule catches
  // everything else, including hallucinated symbols like `HttpResponse`.
  {
    const serverPkgAllowlistRe =
      /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']convex\/server["']/g;
    let allowlistMatch;
    while ((allowlistMatch = serverPkgAllowlistRe.exec(projected)) !== null) {
      const rawNames = allowlistMatch[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const rule3Names = new Set([
        "query",
        "mutation",
        "action",
        "internalQuery",
        "internalMutation",
        "internalAction",
      ]);
      for (const rawName of rawNames) {
        // Handle `Foo as Bar` and `type Foo` forms — the exported symbol is
        // the first token.
        const importedName = rawName.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!importedName || rule3Names.has(importedName)) continue;
        if (CONVEX_SERVER_EXPORTS.has(importedName)) continue;
        const elsewhere = CONVEX_SERVER_KNOWN_ELSEWHERE[importedName];
        const fixHint =
          elsewhere === null
            ? `\`${importedName}\` does not exist in Convex at all — for an HTTP ` +
              `action, use \`httpAction\` from \`"./_generated/server"\` and return ` +
              `a standard \`Response\`, e.g. \`return new Response(JSON.stringify(x), ` +
              `{ status: 200 })\`.`
            : elsewhere
              ? `\`${importedName}\` is exported from \`"${elsewhere}"\`, not ` +
                `\`"convex/server"\` — import it from there instead.`
              : `\`${importedName}\` is not a real \`convex/server\` export. Check ` +
                `the spelling, or it may live in \`"./_generated/server"\` or ` +
                `\`"./_generated/api"\` instead.`;
        track("server_pkg_allowlist", "deny");
        deny(
          `convex-lint rule "convex/server export allowlist": this write ` +
            `contains \`${snippet(allowlistMatch[0])}\` — ${fixHint}`,
        );
      }
    }
  }

  // Rule 7: `app.use(X)` in convex/convex.config.ts where X is imported from
  // a RELATIVE path (e.g. `./http`, `../lib/foo`) rather than a package's
  // `.../convex.config` submodule. `defineApp().use(...)` only mounts
  // installed Convex Components (`import agent from "@convex-dev/agent/convex.config"`);
  // a same-project relative import is never a valid argument. Unambiguous
  // only when we can trace the identifier passed to `.use(` back to a
  // same-file `import ... from "./..."` — otherwise stays advisory.
  if (/(^|\/)convex\/convex\.config\.ts$/.test(normalized)) {
    const useCallRe = /\bapp(?:\w*)?\.use\(\s*([A-Za-z_$][\w$]*)\s*[),]/g;
    let useMatch;
    const relativeImports = new Map();
    const packageConfigImports = new Set();
    const importRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']*)["']/g;
    let impMatch;
    while ((impMatch = importRe.exec(projected)) !== null) {
      const [, ident, fromPath] = impMatch;
      if (fromPath.startsWith(".")) {
        relativeImports.set(ident, fromPath);
      } else if (fromPath.endsWith("/convex.config")) {
        // A package's `.../convex.config` submodule — the canonical shape of
        // a Convex Component. Known-good; no advisory.
        packageConfigImports.add(ident);
      }
    }
    const advisories = [];
    while ((useMatch = useCallRe.exec(projected)) !== null) {
      const ident = useMatch[1];
      const fromPath = relativeImports.get(ident);
      if (packageConfigImports.has(ident)) {
        continue;
      } else if (fromPath) {
        track("app_use_relative", "deny");
        deny(
          `convex-lint rule "app.use() relative import": this write contains ` +
            `\`${snippet(useMatch[0])}\` where \`${ident}\` is imported from the ` +
            `relative path \`"${fromPath}"\` — \`app.use(...)\` in convex.config.ts ` +
            `only accepts Convex Components (e.g. ` +
            `\`import agent from "@convex-dev/agent/convex.config"; app.use(agent);\`), ` +
            `never a same-project module. Remove this \`.use(${ident})\` call — a ` +
            `relative-path module like \`"${fromPath}"\` is mounted by importing it ` +
            `normally (e.g. an HTTP router in \`http.ts\`), not via \`app.use(...)\`.`,
        );
      } else {
        advisories.push(
          `convex-lint: \`app.use(${ident})\` in \`${filePath}\` — verify \`${ident}\` ` +
            `is a Convex Component's \`convex.config\` default export (e.g. from ` +
            `\`@convex-dev/<name>/convex.config\`), not a same-project module. ` +
            `\`app.use(...)\` only accepts installed Components.`,
        );
      }
    }
    if (advisories.length > 0) {
      track("app_use_ambiguous", "warn");
      allowWithWarnings(advisories.slice(0, 10));
    }
  }

  // Rule 8: reserved index names / fields in convex/schema.ts. Convex
  // auto-appends `_creationTime` as the implicit tiebreaker on every index —
  // naming an index `by_id`, `by_creation_time`, or anything starting with
  // `_` is reserved (IndexNameReserved at push), and listing `_creationTime`
  // explicitly in an index's fields array is a schema error. Unambiguous:
  // both are literal string matches inside a `.index(...)` call.
  if (/(^|\/)convex\/schema\.ts$/.test(normalized)) {
    const indexCallRe = /\.index\(\s*["']([^"']*)["']\s*,\s*(\[[^\]]*\])/g;
    let indexMatch;
    while ((indexMatch = indexCallRe.exec(projected)) !== null) {
      const indexName = indexMatch[1];
      const fieldsLiteral = indexMatch[2];
      if (indexName === "by_id" || indexName === "by_creation_time" || indexName.startsWith("_")) {
        track("reserved_index_name", "deny");
        deny(
          `convex-lint rule "reserved index name": this write contains ` +
            `\`${snippet(indexMatch[0])}\` — the index name \`"${indexName}"\` is ` +
            `reserved. Convex auto-appends \`_creationTime\` as the implicit ` +
            `tiebreaker on every index and reserves \`by_id\`/\`by_creation_time\`/ ` +
            `any name starting with \`_\` for its own system indexes. Pick a name ` +
            `after the columns instead, e.g. \`.index("by_<field>", [...])\`.`,
        );
      }
      if (/["']_creationTime["']/.test(fieldsLiteral)) {
        track("reserved_index_field", "deny");
        deny(
          `convex-lint rule "reserved index field": this write contains ` +
            `\`${snippet(indexMatch[0])}\` — \`_creationTime\` cannot appear in an ` +
            `index's fields array. Convex appends it automatically as the implicit ` +
            `tiebreaker on every index; listing it explicitly errors at push. Remove ` +
            `\`"_creationTime"\` from the fields array.`,
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
