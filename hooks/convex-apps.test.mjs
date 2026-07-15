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

test("enclosingConvexDir: deep path under convex/ still finds app (convex shortcut)", () => {
  // Without the basename===convex shortcut, maxDepth=4 would burn hops on
  // convex/a/b/c/d and never reach the app root. The shortcut jumps from the
  // `convex` segment to its parent.
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

test("enclosingConvexDir: maxDepth still bounds climbs above the app", () => {
  // A file outside any convex/ tree should not walk the whole filesystem;
  // with maxDepth=1 from a shallow non-convex path we get null.
  const deps = fakeFs(monorepoFiles());
  const app = enclosingConvexDir(
    p("apps", "web", "src", "page.tsx"),
    ROOT,
    deps,
    1,
  );
  assert.equal(app, null);
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
