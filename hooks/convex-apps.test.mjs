// node --test suite for hooks/convex-apps.mjs - Convex-app resolution.
//
// Pure/injectable: every case passes a fake { existsSync, readFileSync } so the
// hoisted-node_modules false positive, multi-app attribution, and explicit
// convex_apps handling are exercised deterministically. `existsSync` = key
// present; `readFileSync` = value or throw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  declaresConvexDependency,
  enclosingConvexDir,
  isConvexAppRoot,
  resolveAffectedApps,
  resolveAllowlistMode,
  resolveLintApp,
} from "./convex-apps.mjs";

const ROOT = resolve("/repo");
const p = (...parts) => resolve(ROOT, ...parts);
const CONVEX_PKG = JSON.stringify({ dependencies: { convex: "^1.0.0" } });
const PLAIN_PKG = JSON.stringify({ dependencies: { react: "^18.0.0" } });

function fakeFs(files) {
  return {
    existsSync: (path) => path in files,
    readFileSync: (path) => {
      if (path in files) return files[path];
      const err = new Error(`ENOENT: ${path}`);
      err.code = "ENOENT";
      throw err;
    },
  };
}

// A monorepo root that hoists node_modules/convex but does NOT declare convex in
// its own package.json; the real app lives under apps/backend-mono.
function monorepoFiles(extra = {}) {
  return {
    [p("package.json")]: PLAIN_PKG,
    [p("node_modules", "convex", "package.json")]: CONVEX_PKG, // hoisted
    [p("apps", "backend-mono", "convex")]: true,
    [p("apps", "backend-mono", "package.json")]: CONVEX_PKG,
    ...extra,
  };
}

const AUTO = { convex_apps: null, discovery_max_depth: 4 };

test("declaresConvexDependency: own package.json vs hoisted node_modules", () => {
  const deps = fakeFs(monorepoFiles());
  assert.equal(
    declaresConvexDependency(p("apps", "backend-mono"), deps),
    true,
    "app declares convex",
  );
  assert.equal(
    declaresConvexDependency(ROOT, deps),
    false,
    "hoisted node_modules/convex must NOT count as a declared dependency",
  );
});

test("isConvexAppRoot: requires BOTH convex/ dir AND declared dep", () => {
  const deps = fakeFs(
    monorepoFiles({
      [p("convex")]: true, // a stray convex/ at the hoisted root
    }),
  );
  assert.equal(isConvexAppRoot(p("apps", "backend-mono"), deps), true);
  assert.equal(
    isConvexAppRoot(ROOT, deps),
    false,
    "convex/ dir + hoisted node_modules but no declared dep is NOT an app root",
  );
});

test("enclosingConvexDir attributes a nested file to its app container", () => {
  const deps = fakeFs(monorepoFiles());
  const app = enclosingConvexDir(
    p("apps", "backend-mono", "convex", "foo.ts"),
    ROOT,
    deps,
    4,
  );
  assert.equal(app, p("apps", "backend-mono"));
});

test("enclosingConvexDir: deep path under convex/ still finds app (segment resolve)", () => {
  // Segment-based resolve: nesting under convex/ does NOT consume maxDepth.
  const deps = fakeFs(monorepoFiles());
  const deep = p(
    "apps",
    "backend-mono",
    "convex",
    "a",
    "b",
    "c",
    "d",
    "e.ts",
  );
  const app = enclosingConvexDir(deep, ROOT, deps, 4);
  assert.equal(app, p("apps", "backend-mono"));
});

test("enclosingConvexDir: five+ levels under convex/ with maxDepth=4 still resolve", () => {
  // Regression: hop-counting used to exhaust maxDepth before reaching the
  // convex segment (domains/foo/bar/baz/qux → null). Segment resolve fixes it.
  const deps = fakeFs(monorepoFiles());
  const deep = p(
    "apps",
    "backend-mono",
    "convex",
    "domains",
    "foo",
    "bar",
    "baz",
    "qux",
    "item.ts",
  );
  const app = enclosingConvexDir(deep, ROOT, deps, 4);
  assert.equal(app, p("apps", "backend-mono"));
});

test("enclosingConvexDir: maxDepth still bounds climbs for non-convex paths", () => {
  // A file outside any convex/ tree uses the bounded fallback walk.
  const deps = fakeFs(monorepoFiles());
  const app = enclosingConvexDir(
    p("apps", "web", "src", "page.tsx"),
    ROOT,
    deps,
    1,
  );
  assert.equal(app, null);
});

test("declaresConvexDependency: optionalDependencies counts", () => {
  const deps = fakeFs({
    [p("package.json")]: JSON.stringify({
      optionalDependencies: { convex: "^1.0.0" },
    }),
  });
  assert.equal(declaresConvexDependency(ROOT, deps), true);
});

test("resolveAllowlistMode: all-invalid list falls back to auto", () => {
  const deps = fakeFs(monorepoFiles());
  const mode = resolveAllowlistMode(
    ROOT,
    { convex_apps: ["apps/does-not-exist"], discovery_max_depth: 4 },
    deps,
  );
  assert.equal(mode.mode, "auto");
  assert.equal(mode.allInvalid, true);
});

test("resolveAllowlistMode: empty list is intentional allow-nothing", () => {
  const deps = fakeFs(monorepoFiles());
  const mode = resolveAllowlistMode(
    ROOT,
    { convex_apps: [], discovery_max_depth: 4 },
    deps,
  );
  assert.equal(mode.mode, "allow");
  assert.equal(mode.set.size, 0);
  assert.equal(mode.allInvalid, false);
});

test("resolveAffectedApps: all-invalid allowlist falls back to auto-discover", () => {
  const deps = fakeFs(monorepoFiles());
  const apps = resolveAffectedApps(
    ["apps/backend-mono/convex/foo.ts"],
    ROOT,
    { convex_apps: ["apps/typo"], discovery_max_depth: 4 },
    deps,
  );
  assert.deepEqual(apps, [p("apps", "backend-mono")]);
});

test("resolveAffectedApps: empty allowlist verifies nothing", () => {
  const deps = fakeFs(monorepoFiles());
  const apps = resolveAffectedApps(
    ["apps/backend-mono/convex/foo.ts"],
    ROOT,
    { convex_apps: [], discovery_max_depth: 4 },
    deps,
  );
  assert.deepEqual(apps, []);
});

test("resolveAffectedApps: deep path under convex/ attributes correctly", () => {
  const deps = fakeFs(monorepoFiles());
  const apps = resolveAffectedApps(
    ["apps/backend-mono/convex/domains/foo/bar/baz/qux/item.ts"],
    ROOT,
    AUTO,
    deps,
  );
  assert.deepEqual(apps, [p("apps", "backend-mono")]);
});

test("resolveAffectedApps: monorepo hoisted case attributes to the sub-app", () => {
  const deps = fakeFs(monorepoFiles());
  const apps = resolveAffectedApps(
    ["apps/backend-mono/convex/foo.ts"],
    ROOT,
    AUTO,
    deps,
  );
  assert.deepEqual(apps, [p("apps", "backend-mono")]);
});

test("resolveAffectedApps: multiple apps, touching one → only that one", () => {
  const deps = fakeFs({
    [p("apps", "a", "convex")]: true,
    [p("apps", "a", "package.json")]: CONVEX_PKG,
    [p("apps", "b", "convex")]: true,
    [p("apps", "b", "package.json")]: CONVEX_PKG,
  });
  const apps = resolveAffectedApps(["apps/a/convex/x.ts"], ROOT, AUTO, deps);
  assert.deepEqual(apps, [p("apps", "a")]);
});

test("resolveAffectedApps: explicit convex_apps honored; other apps ignored", () => {
  const deps = fakeFs({
    [p("apps", "backend-mono", "convex")]: true,
    [p("apps", "backend-mono", "package.json")]: CONVEX_PKG,
    [p("apps", "other", "convex")]: true,
    [p("apps", "other", "package.json")]: CONVEX_PKG,
  });
  const config = {
    // apps/ghost does not exist and must be dropped without error.
    convex_apps: ["apps/backend-mono", "apps/ghost"],
    discovery_max_depth: 4,
  };
  const apps = resolveAffectedApps(
    ["apps/backend-mono/convex/foo.ts", "apps/other/convex/bar.ts"],
    ROOT,
    config,
    deps,
  );
  assert.deepEqual(
    apps,
    [p("apps", "backend-mono")],
    "only the listed, existing app is verified",
  );
});

test("resolveAffectedApps: hoisted root with no genuine app → []", () => {
  // convex/ at the hoisted root + hoisted node_modules/convex, but the root
  // package.json does not declare convex: not a genuine app, so nothing runs.
  const deps = fakeFs(monorepoFiles({ [p("convex")]: true }));
  const apps = resolveAffectedApps(["convex/foo.ts"], ROOT, AUTO, deps);
  assert.deepEqual(
    apps,
    [ROOT],
    "attribution finds the convex/ container (tsc still runs there)",
  );
  assert.equal(
    declaresConvexDependency(ROOT, deps),
    false,
    "but codegen is gated off because the root does not declare convex",
  );
});

test("resolveLintApp: explicit list skips files outside every app", () => {
  const deps = fakeFs({
    [p("apps", "backend-mono", "convex")]: true,
    [p("apps", "backend-mono", "package.json")]: CONVEX_PKG,
  });
  const config = { convex_apps: ["apps/backend-mono"], discovery_max_depth: 4 };
  assert.equal(
    resolveLintApp(
      p("apps", "backend-mono", "convex", "foo.ts"),
      ROOT,
      config,
      deps,
    ),
    p("apps", "backend-mono"),
  );
  assert.equal(
    resolveLintApp(p("apps", "other", "convex", "bar.ts"), ROOT, config, deps),
    null,
    "a file outside the listed apps is skipped",
  );
});

test("resolveLintApp: no explicit list falls back to repoRoot", () => {
  const deps = fakeFs({});
  assert.equal(
    resolveLintApp(p("convex", "foo.ts"), ROOT, AUTO, deps),
    ROOT,
    "without a configured list, lint any convex/*.ts (fallback to repoRoot)",
  );
});
