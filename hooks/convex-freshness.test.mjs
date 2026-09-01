// node --test suite for hooks/convex-freshness.mjs.
//
// Same discipline as the other hook suites: spawn the hook exactly as Claude
// Code does (JSON payload on stdin), no mocking of hook internals. The
// versions fetch is observed for real — CONVEX_PLUGIN_VERSIONS_BASE points at
// a local HTTP server whose payload each test sets — and CLAUDE_PLUGIN_ROOT
// points at a synthetic install tree, so the marketplace detection runs on
// real paths. Each run gets a fresh TMPDIR so the once-a-day throttle can't
// leak between cases (except the test that exercises the throttle itself).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "convex-freshness.mjs");

// --- local versions endpoint -------------------------------------------
// Tests run serially under node --test, so a single mutable payload is fine.
let payload = {};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE_URL = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

function setVersions(latest, min = "1.0.0") {
  payload = { plugins: { convex: { latest, min } } };
}

// Build a synthetic install and return its CLAUDE_PLUGIN_ROOT. A marketplace
// install mirrors <plugins>/cache/<marketplace>/<plugin>/<version>; a dev
// checkout (marketplace: null) is just a bare directory.
function makeInstall({ marketplace, version }) {
  const base = mkdtempSync(join(tmpdir(), "freshness-install-"));
  const root = marketplace
    ? join(base, "plugins", "cache", marketplace, "convex", version)
    : join(base, "checkout", "convex-backend-skill");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "convex", version }),
  );
  return root;
}

// Spawn the hook as Claude Code does. Resolves to the additionalContext
// string, or null when the hook stayed silent. Must be async (not spawnSync):
// the hook fetches from the server in THIS process, so the event loop has to
// stay live while the child runs.
function runHook(root, { throttleDir } = {}) {
  const scratch = throttleDir || mkdtempSync(join(tmpdir(), "freshness-tmp-"));
  const env = { ...process.env };
  delete env.DO_NOT_TRACK;
  delete env.CONVEX_PLUGIN_TELEMETRY;
  delete env.CONVEX_PLUGIN_FRESHNESS;
  env.CONVEX_PLUGIN_VERSIONS_BASE = BASE_URL;
  env.CLAUDE_PLUGIN_ROOT = root;
  env.TMPDIR = scratch; // os.tmpdir() honors these, isolating the throttle
  env.TEMP = scratch;
  env.TMP = scratch;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, timeout: 15000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        assert.equal(code, 0, `hook must fail open (stderr: ${stderr})`);
        const out = stdout.trim();
        resolve(out ? JSON.parse(out).hookSpecificOutput.additionalContext : null);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end("{}");
  });
}

test("silent when the installed version is current", async () => {
  setVersions("1.14.0");
  const root = makeInstall({ marketplace: "convex", version: "1.14.0" });
  assert.equal(await runHook(root), null);
});

test("home-marketplace install behind latest → plain marketplace update", async () => {
  setVersions("1.14.0");
  const root = makeInstall({ marketplace: "convex", version: "1.12.0" });
  const msg = await runHook(root);
  assert.match(msg, /newer Convex plugin is available/);
  assert.match(msg, /`claude plugin marketplace update`/);
  assert.doesNotMatch(msg, /claude plugin marketplace add/);
});

test("foreign-marketplace install behind latest → switch to the Convex marketplace", async () => {
  setVersions("1.14.0");
  const root = makeInstall({
    marketplace: "claude-plugins-official",
    version: "1.10.0",
  });
  const msg = await runHook(root);
  assert.match(msg, /"claude-plugins-official" marketplace/);
  assert.match(msg, /`claude plugin marketplace add get-convex\/convex-backend-skill`/);
  assert.match(msg, /`claude plugin install convex@convex`/);
  // The foreign pin can't be assumed to serve `latest`, so the message must
  // not present a bare marketplace update as the upgrade path.
  assert.doesNotMatch(msg, /upgrade with `claude plugin marketplace update`/);
});

test("foreign-marketplace install below the supported minimum → urgent switch", async () => {
  setVersions("1.14.0", "1.12.0");
  const root = makeInstall({
    marketplace: "claude-plugins-official",
    version: "1.10.0",
  });
  const msg = await runHook(root);
  assert.match(msg, /below the supported minimum \(v1\.12\.0\)/);
  assert.match(msg, /"claude-plugins-official" marketplace/);
  assert.match(msg, /`claude plugin install convex@convex`/);
});

test("dev checkout (no cache path) behind latest → generic update message", async () => {
  setVersions("1.14.0");
  const root = makeInstall({ marketplace: null, version: "1.12.0" });
  const msg = await runHook(root);
  assert.match(msg, /`claude plugin marketplace update`/);
  assert.doesNotMatch(msg, /claude plugin marketplace add/);
});

test("throttled to one check per day per plugin", async () => {
  setVersions("1.14.0");
  const root = makeInstall({ marketplace: "convex", version: "1.12.0" });
  const throttleDir = mkdtempSync(join(tmpdir(), "freshness-tmp-"));
  assert.notEqual(await runHook(root, { throttleDir }), null);
  assert.equal(await runHook(root, { throttleDir }), null);
});
