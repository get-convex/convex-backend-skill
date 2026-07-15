// Shared Convex-app resolution for the hooks. This is the fix for the monorepo
// false-positive: a hoisted `node_modules/convex` (common in pnpm/workspace
// setups) makes a directory LOOK like a Convex app even though its OWN
// package.json never declares `convex`, so `convex codegen` run there errors
// with "add `convex` to your package.json dependencies" and blocks the turn.
//
// The rules here draw the line correctly:
// - A genuine Convex APP ROOT is a directory D that has BOTH a `convex/`
//   subdirectory AND a package.json (D's own) declaring `convex` in
//   dependencies / devDependencies / peerDependencies / optionalDependencies.
//   A hoisted `node_modules/convex` alone is NOT sufficient.
// - The `convex codegen` / `convex dev --once` legs may run only where the
//   app's OWN package.json declares `convex` - that is exactly where the CLI
//   will actually work.
//
// Resolution is PATH-DRIVEN: each hook already knows which files a turn touched
// (git porcelain) or is about to write (the edited path), so we attribute those
// paths to their nearest enclosing app. Paths under `.../convex/...` resolve via
// the `convex` path segment (independent of discovery_max_depth); maxDepth only
// bounds fallback walks that do not pass through a `convex` segment.
//
// All helpers take their fs boundary as `{ existsSync, readFileSync }` so the
// hook tests can fake it.

import { basename, dirname, resolve } from "node:path";

const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// Does `dir`'s OWN package.json declare the `convex` package? This is the
// signal the codegen/dev legs gate on - it is true only where the Convex CLI
// can actually run, which is what fixes the hoisted-node_modules false positive.
export function declaresConvexDependency(dir, { readFileSync }) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    for (const key of DEP_KEYS) {
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

// Resolve app root from a path that sits under a `convex/` directory: the
// parent of the nearest (deepest) path segment named `convex`. Independent of
// maxDepth so domain-style trees (convex/a/b/c/d/e.ts) never miss attribution.
function appRootFromConvexSegment(absFilePath, deps) {
  const { existsSync } = deps;
  let dir = dirname(resolve(absFilePath));
  while (true) {
    if (basename(dir) === "convex") {
      const parent = dirname(dir);
      if (parent !== dir && existsSync(resolve(parent, "convex"))) {
        return parent;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Walk up from a touched/edited file to the nearest ancestor (bounded by
// `repoRoot` and `maxDepth`) that contains a `convex/` subdirectory. This is
// the container that codegen/tsc run IN; whether codegen/dev actually run is
// decided separately by `declaresConvexDependency`.
//
// Paths under `.../convex/...` resolve via the `convex` path segment and do
// NOT consume discovery_max_depth. maxDepth only bounds the fallback walk for
// layouts that do not pass through a `convex` segment.
// Returns the directory, or null when none is found within the bound.
export function enclosingConvexDir(absFilePath, repoRoot, deps, maxDepth) {
  const { existsSync } = deps;
  const root = resolve(repoRoot);

  const fromSegment = appRootFromConvexSegment(absFilePath, deps);
  if (fromSegment !== null) return fromSegment;

  // Fallback: walk up looking for a dir that *contains* convex/, bounded.
  let dir = dirname(resolve(absFilePath));
  let depth = 0;
  while (true) {
    if (existsSync(resolve(dir, "convex"))) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (maxDepth && depth >= maxDepth) break;
    dir = parent;
    depth++;
  }
  return null;
}

// Walk up from a file to the nearest ancestor that is present in `allowSet`.
// Uses the same `convex` segment shortcut so deep trees under convex/ still
// attribute to an allowed app root without a hop budget.
function nearestAllowedApp(absFilePath, repoRoot, allowSet, maxDepth, deps) {
  if (allowSet.size === 0) return null;

  // Segment path: parent of nearest `convex` segment, if allowed.
  const fromSegment = appRootFromConvexSegment(absFilePath, deps);
  if (fromSegment !== null && allowSet.has(fromSegment)) return fromSegment;

  // Fallback walk (non-convex paths / odd layouts), bounded by maxDepth.
  let dir = dirname(resolve(absFilePath));
  const root = resolve(repoRoot);
  let depth = 0;
  while (true) {
    if (allowSet.has(dir)) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (maxDepth && depth >= maxDepth) break;
    dir = parent;
    depth++;
  }
  return null;
}

// The set of absolute app roots named by an explicit `convex_apps` config list,
// resolved against `repoRoot` and validated to be genuine app roots. A listed
// path that does not exist or does not declare `convex` is dropped.
export function allowedAppSet(repoRoot, config, deps) {
  const set = new Set();
  if (!Array.isArray(config.convex_apps)) return set;
  for (const entry of config.convex_apps) {
    const dir = resolve(repoRoot, entry);
    if (isConvexAppRoot(dir, deps)) set.add(dir);
  }
  return set;
}

// Resolve allowlist mode for hooks:
// - auto: no explicit list (or list was all-invalid → fall back to auto)
// - allow: explicit set (may be empty for intentional `convex_apps: []`)
// `allInvalid` is true when a non-empty list produced zero valid app roots.
export function resolveAllowlistMode(repoRoot, config, deps) {
  if (!Array.isArray(config.convex_apps)) {
    return { mode: "auto", set: null, allInvalid: false };
  }
  if (config.convex_apps.length === 0) {
    return { mode: "allow", set: new Set(), allInvalid: false };
  }
  const set = allowedAppSet(repoRoot, config, deps);
  if (set.size === 0) {
    // Typos / moved paths: fall back to auto-discover rather than silently
    // disabling every hook forever.
    return { mode: "auto", set: null, allInvalid: true };
  }
  return { mode: "allow", set, allInvalid: false };
}

// Resolve the distinct Convex app roots affected by a turn, given the list of
// touched (repo-relative or absolute) paths. When `config.convex_apps` is a
// non-empty valid list, only those roots are eligible; an empty list means
// verify nothing; an all-invalid list falls back to auto-discover.
export function resolveAffectedApps(touchedPaths, repoRoot, config, deps) {
  const maxDepth = config.discovery_max_depth;
  const apps = new Set();
  const { mode, set: allowSet } = resolveAllowlistMode(repoRoot, config, deps);
  for (const touched of touchedPaths) {
    const abs = resolve(repoRoot, touched);
    const app =
      mode === "allow"
        ? nearestAllowedApp(abs, repoRoot, allowSet, maxDepth, deps)
        : enclosingConvexDir(abs, repoRoot, deps, maxDepth);
    if (app) apps.add(app);
  }
  return [...apps];
}

// Resolve the single Convex app directory a lint target belongs to. When an
// explicit valid `convex_apps` list is configured, the file must sit under one
// of those roots or it is skipped (returns null). Empty list → always skip.
// All-invalid list → auto-discover fallback. Without an explicit list this
// preserves historical behavior: lint any `convex/*.ts`, using the nearest
// enclosing `convex/` container as the app dir, or `repoRoot` as a fallback.
export function resolveLintApp(absFilePath, repoRoot, config, deps) {
  const { mode, set: allowSet } = resolveAllowlistMode(repoRoot, config, deps);
  if (mode === "allow") {
    return nearestAllowedApp(
      absFilePath,
      repoRoot,
      allowSet,
      config.discovery_max_depth,
      deps,
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
