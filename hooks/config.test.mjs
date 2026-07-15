// node --test suite for hooks/config.mjs - the shared plugin-settings loader.
//
// Pure/injectable: every case passes a fake { existsSync, readFileSync } so the
// parser and defaulting are exercised without touching the real filesystem. The
// contract these tests pin down: an absent or malformed `.claude/convex.local.md`
// degrades to defaults (everything enabled, auto-discover) and NEVER throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  hookEnabled,
  loadConvexPluginConfig,
  parseFrontmatter,
} from "./config.mjs";

const ROOT = resolve("/repo");
const CONFIG_PATH = resolve(ROOT, ".claude", "convex.local.md");

// Fake fs where `files` maps absolute path -> contents.
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

test("absent config file → full defaults (all hooks on, auto-discover)", () => {
  const config = loadConvexPluginConfig(ROOT, fakeFs({}));
  assert.equal(config.typecheck_hook, true);
  assert.equal(config.lint_hook, true);
  assert.equal(config.freshness_hook, true);
  assert.equal(config.session_start_hook, true);
  assert.equal(config.convex_apps, null);
  assert.equal(config.discovery_max_depth, 4);
});

test("per-hook toggles are read; unset keys keep their default", () => {
  const config = loadConvexPluginConfig(
    ROOT,
    fakeFs({
      [CONFIG_PATH]:
        "---\ntypecheck_hook: false\nlint_hook: false\n---\n# notes\n",
    }),
  );
  assert.equal(config.typecheck_hook, false);
  assert.equal(config.lint_hook, false);
  assert.equal(config.freshness_hook, true, "unset key stays enabled");
  assert.equal(config.session_start_hook, true);
});

test("explicit convex_apps list is parsed (quoted and bare entries)", () => {
  const config = loadConvexPluginConfig(
    ROOT,
    fakeFs({
      [CONFIG_PATH]:
        '---\nconvex_apps: ["apps/backend-mono", apps/other]\ndiscovery_max_depth: 6\n---\n',
    }),
  );
  assert.deepEqual(config.convex_apps, ["apps/backend-mono", "apps/other"]);
  assert.equal(config.discovery_max_depth, 6);
});

test("malformed / non-frontmatter file → defaults, never throws", () => {
  const config = loadConvexPluginConfig(
    ROOT,
    fakeFs({ [CONFIG_PATH]: "just some prose, no frontmatter at all\n" }),
  );
  assert.equal(config.typecheck_hook, true);
  assert.equal(config.convex_apps, null);
});

test("readFileSync throwing → defaults, never throws", () => {
  const deps = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("boom");
    },
  };
  const config = loadConvexPluginConfig(ROOT, deps);
  assert.equal(config.typecheck_hook, true);
  assert.equal(config.discovery_max_depth, 4);
});

test("invalid values are ignored (non-boolean toggle, non-int depth)", () => {
  const config = loadConvexPluginConfig(
    ROOT,
    fakeFs({
      [CONFIG_PATH]:
        "---\ntypecheck_hook: maybe\ndiscovery_max_depth: lots\n---\n",
    }),
  );
  assert.equal(config.typecheck_hook, true, "non-boolean toggle stays default");
  assert.equal(config.discovery_max_depth, 4, "non-int depth stays default");
});

test("hookEnabled: only an explicit false disables", () => {
  assert.equal(hookEnabled({ typecheck_hook: false }, "typecheck_hook"), false);
  assert.equal(hookEnabled({ typecheck_hook: true }, "typecheck_hook"), true);
  assert.equal(hookEnabled({}, "typecheck_hook"), true);
  assert.equal(hookEnabled(null, "typecheck_hook"), true);
});

test("parseFrontmatter tolerates leading blank lines and inline comments", () => {
  const parsed = parseFrontmatter(
    "\n\n---\nlint_hook: false # turn it off here\n---\n",
  );
  assert.equal(parsed.lint_hook, false);
});
