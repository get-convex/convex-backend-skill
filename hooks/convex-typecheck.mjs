#!/usr/bin/env node
// PostToolUse hook: after Claude writes or edits a file under convex/, run the
// TypeScript compiler and feed any errors straight back into Claude's context
// via `additionalContext`. Tightens the feedback loop from "wait for the next
// `convex dev` push" to "instant, on every edit."
//
// Design notes:
// - Exits 0 in every case. Failures are surfaced through the documented
//   `hookSpecificOutput.additionalContext` field (a system reminder Claude
//   reads on its next turn), not via a non-zero exit, so a type error mid-build
//   never reads as a broken hook.
// - Self-guards: silent unless the edited file is a real `convex/*.ts` source
//   file, a `convex/tsconfig.json` exists, and a local `tsc` is installed.
//   Never triggers a network fetch (`npx --no-install`).
// - Uses Node (guaranteed in a Convex project) for both JSON parsing and
//   emitting, so multi-line tsc output is escaped correctly.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, basename, resolve, sep } from "node:path";
import { capture } from "./analytics.mjs";

function emit(additionalContext) {
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext,
        },
      }),
    );
  }
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let payload;
try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  emit(null);
}

const toolInput = payload.tool_input ?? {};
const filePath = toolInput.file_path ?? toolInput.path ?? "";
const cwd = payload.cwd ?? process.cwd();

// Only act on TypeScript source inside a convex/ directory.
// Skip generated code and declaration files.
const normalized = filePath.replaceAll("\\", "/");
const isConvexTs =
  /(^|\/)convex\//.test(normalized) &&
  normalized.endsWith(".ts") &&
  !normalized.endsWith(".d.ts") &&
  !normalized.includes("/_generated/");
if (!isConvexTs) emit(null);

const absFile = resolve(cwd, filePath);

// Walk up from the file to find the convex/ directory with a tsconfig.json.
let convexDir = null;
let dir = dirname(absFile);
const root = resolve(dir, sep);
while (dir && dir !== root) {
  if (basename(dir) === "convex" && existsSync(resolve(dir, "tsconfig.json"))) {
    convexDir = dir;
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (convexDir === null) emit(null);

// Resolve a local tsc; never fetch from the network.
const projectRoot = dirname(convexDir);
const localTsc = resolve(projectRoot, "node_modules", ".bin", "tsc");
const hasLocalTsc = existsSync(localTsc);

let output = "";
try {
  const cmd = hasLocalTsc ? localTsc : "npx";
  const args = hasLocalTsc
    ? ["--noEmit", "-p", convexDir]
    : ["--no-install", "tsc", "--noEmit", "-p", convexDir];
  execFileSync(cmd, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    encoding: "utf8",
  });
  // Exit 0 from tsc → no type errors → stay silent.
  emit(null);
} catch (err) {
  // tsc exited non-zero (type errors) OR tsc was unavailable.
  output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  // If npx couldn't find tsc (no local install), stay silent rather than nag.
  if (!output || /could not determine executable|not found/i.test(output)) {
    emit(null);
  }
}

// Cap the report so a cascade of errors doesn't flood the context.
const lines = output.split("\n").filter(Boolean);
const capped = lines.slice(0, 40).join("\n");
const more =
  lines.length > 40 ? `\n… and ${lines.length - 40} more line(s).` : "";

// Fire-and-forget telemetry on the error path only (the clean path stays
// silent — too chatty otherwise). `capture` swallows every error and spawns
// a detached child, but wrap it anyway so analytics can never break the hook.
try {
  capture("typecheck_hook_fired", { error_count: lines.length });
} catch {
  // never let telemetry affect the typecheck report
}

emit(
  `TypeScript errors in the Convex backend after editing \`${filePath}\` ` +
    `(from \`tsc --noEmit -p convex\`). Fix these before continuing — they will ` +
    `block the next \`convex dev\` push:\n\n${capped}${more}`,
);
