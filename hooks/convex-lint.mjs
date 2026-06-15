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
// - Hard denies are limited to the two patterns that are unambiguous in a
//   convex/ source file:
//     1. `.filter(q => … q.field(…))` on a db query — the `q.field(` call
//        inside the filter callback is the discriminator; JS array `.filter`
//        callbacks never contain `q.field(`. Fix: `.withIndex(...)`.
//     2. Old positional function syntax `query(async (ctx, …)` — Convex
//        functions must use the object form with `args`/`returns`/`handler`.
// - Everything else (missing `args:` on a function object) is a
//   soft advisory delivered via `additionalContext` on an "allow" decision.
// - Edge discipline: a hard-deny false positive is the worst outcome. When in
//   doubt, allow; any internal error → exit 0 silent (try/catch everywhere).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { capture } from "./analytics.mjs";

// Fire-and-forget telemetry (one event per hook run, primary finding only).
// `capture` already swallows every error and spawns a detached child, but
// wrap it anyway so an analytics failure can never change hook behavior.
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

  let withIndexFilterNote = null; // soft advisory (collected, emitted with warnings)

  // Rule 1: `.filter(q => … q.field(…))` on a Convex db query. The
  // `q.field(` token inside the filter callback (same param name) is the
  // discriminator — a JS array `.filter` callback never calls `q.field(`.
  //
  // Exception (canon-valid): `.withIndex(...).filter((q) => q.eq(q.field(...)))`
  // is correct — the index narrows the scan and `.filter` applies a secondary
  // predicate on the already-narrowed range (see convex-evals' own
  // `index_and_filter` task). Only the *unindexed* form — a `.filter` with no
  // `.withIndex` earlier in the same query chain — is the full-table scan we
  // deny. Guard: require that no `.withIndex(` appears in the chain text from
  // the enclosing `.query(`/`.db.query(` up to the matched `.filter(`.
  const dbFilterRe =
    /\.filter\(\s*\(?\s*(\w+)\s*\)?\s*=>[\s\S]{0,200}?\b\1\.field\(/;
  const dbFilterMatch = dbFilterRe.exec(projected);
  if (dbFilterMatch) {
    // Find the chain start (nearest `.query(` before this `.filter(`) and check
    // whether a `.withIndex(` sits between it and the filter — if so, allow.
    const filterIdx = dbFilterMatch.index;
    const before = projected.slice(0, filterIdx);
    const queryStart = before.lastIndexOf(".query(");
    const chain = queryStart >= 0 ? before.slice(queryStart) : before;
    if (/\.withIndex\s*\(/.test(chain)) {
      // Indexed query with a secondary `.filter` predicate — not denied (it's
      // valid and convex-evals has a canonical answer using it), but it's
      // usually a smell: `.filter` still reads every doc in the index range and
      // discards non-matches. Advise (never block).
      withIndexFilterNote =
        "convex-lint: this `.withIndex(...).filter(...)` still reads every " +
        "document in the index range and discards non-matches. Prefer a " +
        "compound index that includes the filtered field, or `.paginate()` / " +
        "`.take(n)` to bound the reads — never `.collect()` behind a `.filter()`.";
    } else {
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
        `${positionalMatch[1]}({ args: {...}, ` +
        `handler: async (ctx, args) => {...} }).`,
    );
  }

  // Rule 3: imports from the wrong module — always fail tsc/deploy, so deny.
  // The `Id`/`Doc` types live in ./_generated/dataModel (convex/values only
  // exports `v` and value types); the function builders live in
  // ./_generated/server (convex/server has no `query`/`mutation`/... exports).
  const idFromValuesRe =
    /import\s+(?:type\s+)?\{[^}]*\b(?:Id|Doc)\b[^}]*\}\s+from\s+["']convex\/values["']/;
  const idFromValuesMatch = idFromValuesRe.exec(projected);
  if (idFromValuesMatch) {
    track("wrong_import_values", "deny");
    deny(
      `convex-lint rule "wrong import module": this write contains ` +
        `\`${snippet(idFromValuesMatch[0])}\` — the \`Id\`/\`Doc\` types are ` +
        `not exported by convex/values (it only exports \`v\` and value ` +
        `types). Import them from "./_generated/dataModel" instead; this ` +
        `import fails tsc.`,
    );
  }
  const buildersFromServerRe =
    /import\s+\{[^}]*\b(query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\b[^}]*\}\s+from\s+["']convex\/server["']/;
  const buildersFromServerMatch = buildersFromServerRe.exec(projected);
  if (buildersFromServerMatch) {
    track("wrong_import_server", "deny");
    deny(
      `convex-lint rule "wrong import module": this write imports ` +
        `\`${buildersFromServerMatch[1]}\` from "convex/server", which has no ` +
        `such export — the function builders come from "./_generated/server". ` +
        `This import fails the deploy bundler. (convex/server is correct only ` +
        `for defineSchema/defineTable/httpRouter/cronJobs/paginationOptsValidator etc.)`,
    );
  }

  const helpersFromGeneratedRe =
    /import\s+\{[^}]*\b(paginationOptsValidator|defineSchema|defineTable|httpRouter|cronJobs)\b[^}]*\}\s+from\s+["']\.\/_generated\/server["']/;
  const helpersFromGeneratedMatch = helpersFromGeneratedRe.exec(projected);
  if (helpersFromGeneratedMatch) {
    track("wrong_import_generated", "deny");
    deny(
      `convex-lint rule "wrong import module": this write imports ` +
      `\`${helpersFromGeneratedMatch[1]}\` from "./_generated/server", which ` +
      `does not export it — it comes from "convex/server". This import fails ` +
      `the deploy bundler.`,
    );
  }

  // Rule 4: explicit TypeScript `any` in a convex/ source file. Convex's
  // eslint config bans @typescript-eslint/no-explicit-any, so this fails the
  // lint gate every time — and it's never necessary in function code: ctx is
  // `QueryCtx`/`MutationCtx`/`ActionCtx` from ./_generated/server, ids are
  // `Id<"table">` from ./_generated/dataModel, and document shapes flow from
  // the schema. Carefully excludes the legitimate `v.any()` validator (that's
  // a value, `: v.any()` / `v.any(` — never a bare `any` type annotation).
  //
  // The trailing two alternations close a gap: `any` used as a *generic type
  // argument that is not the sole token* — `Record<string, any>`,
  // `Map<K, any>`, `Promise<Foo, any>` (`,\s*any\s*[,>]`) and `any` as the
  // first of several args, `ReadonlyArray<any, …>` (`<\s*any\s*,`). The
  // original `<\s*any\s*>` only caught `any` as the *whole* argument list
  // (`Promise<any>`, `Array<any>`), so `Record<string, any>` slipped through
  // even though no-explicit-any flags it identically. Still never matches
  // `v.any()`, which is a call expression (parentheses), not a `<…>` arg.
  const anyTypeRe =
    /:\s*any\b|<\s*any\s*>|\bas\s+any\b|\bany\s*\[\s*\]|,\s*any\s*[,>]|<\s*any\s*,/;
  // Guard: ignore matches that are actually `: v.any()` style (value, not type).
  const strippedForAny = projected.replace(/\bv\.any\s*\(\s*\)/g, "v.__validator__()");
  const anyMatch = anyTypeRe.exec(strippedForAny);
  if (anyMatch) {
    track("explicit_any", "deny");
    deny(
      `convex-lint rule "explicit any": this write uses the TypeScript \`any\` ` +
        `type (\`${snippet(anyMatch[0])}\`). Convex's lint gate bans it and it's ` +
        `never needed in function code — type \`ctx\` as ` +
        `\`QueryCtx\`/\`MutationCtx\`/\`ActionCtx\` (from ./_generated/server), ` +
        `ids as \`Id<"table">\` (from ./_generated/dataModel), and let document ` +
        `shapes flow from the schema. (\`v.any()\` the validator is fine — this ` +
        `is about \`any\` as a type annotation.)`,
    );
  }

  // Rule 5: the `as unknown as X` double-cast — the canonical TypeScript
  // escape hatch for forcing one type onto an unrelated value. It defeats the
  // type system exactly as `as any` does (and is precisely what people reach
  // for to dodge the no-explicit-any rule), so it is the same class of unsafe
  // cast. In convex/ function code it is never necessary: ctx/handler/document
  // types all flow from the schema and ./_generated, so a forced reinterpret
  // is always a sign the real types are wrong. The token `as unknown as`
  // (two `as` straddling `unknown`) is the discriminator — a lone
  // `value as unknown` is occasionally legitimate (widening before a guard),
  // but the *double* cast is unambiguously a reinterpret hatch.
  const doubleCastRe = /\bas\s+unknown\s+as\b/;
  const doubleCastMatch = doubleCastRe.exec(projected);
  if (doubleCastMatch) {
    track("double_cast", "deny");
    deny(
      `convex-lint rule "as unknown as cast": this write contains ` +
        `\`${snippet(doubleCastMatch[0])}\` — the \`as unknown as X\` ` +
        `double-cast forces an unrelated type the same way \`as any\` does and ` +
        `is never needed in Convex function code, where ctx, handler results, ` +
        `and document shapes already flow from the schema and ./_generated. ` +
        `Fix the underlying type (annotate \`ctx\` as ` +
        `\`QueryCtx\`/\`MutationCtx\`/\`ActionCtx\`, ids as \`Id<"table">\`) ` +
        `instead of reinterpreting through \`unknown\`.`,
    );
  }

  // --- SOFT WARNINGS (never deny) ----------------------------------------
  // Heuristic: each `query({`-style block whose first ~300 chars contain no
  // `args:` gets one advisory line. Deliberately args-only: the official
  // Convex guidelines omit `returns:` validators, and spec-comparing tooling
  // (e.g. convex-evals' compareFunctionSpec) treats an added `returns` as a
  // mismatch — the previous returns advisory measurably caused functional
  // failures by overriding session guidance to the contrary on every write.
  const warnings = [];
  let firstWarningRule = null;
  const objectFormRe =
    /\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\s*\{/g;
  let m;
  while ((m = objectFormRe.exec(projected)) !== null) {
    const head = projected.slice(m.index, m.index + 300);
    if (!/\bargs\s*:/.test(head)) {
      if (firstWarningRule === null) firstWarningRule = "missing_args";
      warnings.push(
        `convex-lint: a \`${m[1]}({...})\` in \`${filePath}\` appears to be ` +
          `missing \`args:\`. Convex functions should always declare argument ` +
          `validators (\`args: {}\` when they take none).`,
      );
    }
  }
  // Advisory: bare .collect() — legitimate on small bounded tables, a scale
  // bug on anything that grows. Never deny; just point at the alternatives.
  if (/\.collect\(\)/.test(projected)) {
    if (firstWarningRule === null) firstWarningRule = "bare_collect";
    warnings.push(
      `convex-lint: this write calls \`.collect()\`. If the table can grow ` +
        `unbounded, cap the read with \`.take(n)\`, paginate with ` +
        `\`paginationOptsValidator\` + \`.paginate\`, or use ` +
        `\`@convex-dev/aggregate\` for counts — \`.collect()\` loads every ` +
        `row and hits the ~16k-document read limit.`,
    );
  }

  if (withIndexFilterNote) {
    if (firstWarningRule === null) firstWarningRule = "withindex_filter";
    warnings.push(withIndexFilterNote);
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
