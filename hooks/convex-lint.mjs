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
// - Everything else (missing `args:` / `returns:` on a function object) is a
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

  // --- SOFT WARNINGS (never deny) ----------------------------------------
  // Heuristic: each `query({`-style block whose validator region (everything up
  // to its `handler:` key) contains no `args:` / `returns:` gets one advisory line.
  const warnings = [];
  let firstWarningRule = null;
  const objectFormRe =
    /\b(query|mutation|action|internalQuery|internalMutation|internalAction)\(\s*\{/g;
  let m;
  while ((m = objectFormRe.exec(projected)) !== null) {
    // Scan the function's option object up to its `handler:` key (every Convex
    // function object has one, declared after args/returns) instead of a
    // fixed-size window. A large `args:`/`returns:` validator can push
    // `returns:` well past a 300-char window, producing a false "missing
    // `returns:`" advisory. Fall back to 300 chars if no handler is found.
    const rest = projected.slice(m.index);
    const handlerIdx = rest.search(/\bhandler\s*:/);
    const head = handlerIdx === -1 ? rest.slice(0, 300) : rest.slice(0, handlerIdx);
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
