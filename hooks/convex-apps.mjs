// Shared Convex-app resolution for the hooks. This is the fix for the monorepo
// false-positive: a hoisted `node_modules/convex` (common in pnpm/workspace
// setups) makes a directory LOOK like a Convex app even though its OWN
// package.json never declares `convex`, so `convex codegen` run there errors
// with "add `convex` to your package.json dependencies" and blocks the turn.
//
// The rules here draw the line correctly:
// - A genuine Convex APP ROOT is a directory D that has BOTH a `convex/`
//   subdirectory AND a package.json (D's own) declaring `convex` in
//   dependencies / devDependencies / peerDependencies. A hoisted
//   `node_modules/convex` alone is NOT sufficient.
// - The `convex codegen` / `convex dev --once` legs may run only where the
//   app's OWN package.json declares `convex` - that is exactly where the CLI
//   will actually work.
//
// Resolution is PATH-DRIVEN: each hook already knows which files a turn touched
// (git porcelain) or is about to write (the edited path), so we attribute those
// paths to their nearest enclosing app by walking UP toward the repo root. That
// verifies only the app(s) actually affected and needs nothing beyond
// `existsSync` / `readFileSync`, keeping every helper injectable and pure.
//
// All helpers take their fs boundary as `{ existsSync, readFileSync }` so the
// hook tests can fake it.

import { dirname, resolve } from "node:path";

// Does `dir`'s OWN package.json declare the `convex` package? This is the
// signal the codegen/dev legs gate on - it is true only where the Convex CLI
// can actually run, which is what fixes the hoisted-node_modules false positive.
export function declaresConvexDependency(dir, { readFileSync }) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (pkg[key] && typeof pkg[key] === "object" && "convex" in pkg[key]) {
        return true;
      }
    }
  } catch {
    // No/unparseable package.json - not a declared Convex dependency.
  }
  return false;
}

// A genuine Convex app root: a `convex/` subdirectory AND an own package.json
// declaring `convex`.
export function isConvexAppRoot(dir, deps) {
  if (!deps.existsSync(resolve(dir, "convex"))) return false;
  return declaresConvexDependency(dir, deps);
}

// Walk up from a touched/edited file to the nearest ancestor (bounded by
// `repoRoot` and `maxDepth`) that contains a `convex/` subdirectory. This is
// the container that codegen/tsc run IN; whether codegen actually runs is
// decided separately by `declaresConvexDependency`, which preserves the
// long-standing "tsc still runs even without a declared convex dep" behavior.
// Returns the directory, or null when none is found within the bound.
export function enclosingConvexDir(absFilePath, repoRoot, deps, maxDepth) {
  const { existsSync } = deps;
  let dir = dirname(absFilePath);
  let depth = 0;
  while (true) {
    if (existsSync(resolve(dir, "convex"))) return dir;
    if (dir === repoRoot) break; // reached the repo root; stop climbing
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
    depth++;
    if (maxDepth && depth > maxDepth) break;
  }
  return null;
}

// Walk up from a file to the nearest ancestor (bounded by `repoRoot` and
// `maxDepth`) that is present in `allowSet`. Used to attribute a touched/edited
// file to one of the explicitly configured app roots.
function nearestAllowedApp(absFilePath, repoRoot, allowSet, maxDepth) {
  let dir = dirname(absFilePath);
  let depth = 0;
  while (true) {
    if (allowSet.has(dir)) return dir;
    if (dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
    if (maxDepth && depth > maxDepth) break;
  }
  return null;
}

// The set of absolute app roots named by an explicit `convex_apps` config list,
// resolved against `repoRoot` and validated to be genuine app roots. A listed
// path that does not exist or does not declare `convex` is dropped silently.
function allowedAppSet(repoRoot, config, deps) {
  const set = new Set();
  for (const entry of config.convex_apps) {
    const dir = resolve(repoRoot, entry);
    if (isConvexAppRoot(dir, deps)) set.add(dir);
  }
  return set;
}

// Resolve the distinct Convex app roots affected by a turn, given the list of
// touched (repo-relative or absolute) paths. When `config.convex_apps` is set,
// only those explicit roots are eligible; otherwise apps are auto-discovered by
// attributing each touched file to its enclosing `convex/` container.
export function resolveAffectedApps(touchedPaths, repoRoot, config, deps) {
  const maxDepth = config.discovery_max_depth;
  const apps = new Set();
  const allowSet = Array.isArray(config.convex_apps)
    ? allowedAppSet(repoRoot, config, deps)
    : null;
  for (const touched of touchedPaths) {
    const abs = resolve(repoRoot, touched);
    const app = allowSet
      ? nearestAllowedApp(abs, repoRoot, allowSet, maxDepth)
      : enclosingConvexDir(abs, repoRoot, deps, maxDepth);
    if (app) apps.add(app);
  }
  return [...apps];
}

// Resolve the single Convex app directory a lint target belongs to. When an
// explicit `convex_apps` list is configured, the file must sit under one of
// those roots or it is skipped (returns null). Without an explicit list this
// preserves the historical behavior: lint any `convex/*.ts`, using the nearest
// enclosing `convex/` container as the app dir, or `repoRoot` as a fallback.
export function resolveLintApp(absFilePath, repoRoot, config, deps) {
  if (Array.isArray(config.convex_apps)) {
    const allowSet = allowedAppSet(repoRoot, config, deps);
    return nearestAllowedApp(
      absFilePath,
      repoRoot,
      allowSet,
      config.discovery_max_depth,
    );
  }
  return (
    enclosingConvexDir(
      absFilePath,
      repoRoot,
      deps,
      config.discovery_max_depth,
    ) ?? repoRoot
  );
}
