// node --test suite for hooks/session-start.mjs (+ the analytics.mjs pieces
// it rides on).
//
// Same discipline as the other hook suites: spawn the hook exactly as Claude
// Code does (JSON payload on stdin), no mocking of hook internals. The
// telemetry POST is observed for real — CONVEX_PLUGIN_POSTHOG_HOST points at
// a local HTTP sink and the assertions read the captured request body — so
// these tests cover the full path: stdin → capture() → detached emitter
// child → POST. The opt-out tests assert the *absence* of a POST inside a
// grace window, which is inherently a bounded wait; the window is kept short
// because the emitter child fires immediately when it fires at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isConvexProject } from "./analytics.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "session-start.mjs");

// --- local PostHog sink ------------------------------------------------
// Requests land in `inbox`; takeCapture() consumes them in arrival order and
// waitQuiet() asserts none arrive. Tests within a file run serially under
// node --test, so a simple queue is race-free.
const inbox = [];
let notify = null;
const sink = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    inbox.push({ url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    if (notify) notify();
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const SINK_URL = `http://127.0.0.1:${sink.address().port}`;
test.after(() => sink.close());

function takeCapture(timeoutMs = 5000) {
  if (inbox.length) return Promise.resolve(inbox.shift());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      notify = null;
      reject(new Error("no telemetry POST arrived within the timeout"));
    }, timeoutMs);
    notify = () => {
      clearTimeout(t);
      notify = null;
      resolve(inbox.shift());
    };
  });
}

function waitQuiet(ms = 1200) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      notify = null;
      resolve();
    }, ms);
    notify = () => {
      clearTimeout(t);
      notify = null;
      reject(new Error(`unexpected telemetry POST: ${JSON.stringify(inbox)}`));
    };
  });
}

// Spawn the hook as Claude Code does. Telemetry is explicitly ENABLED and
// pointed at the sink; DO_NOT_TRACK/CONVEX_PLUGIN_TELEMETRY are cleared so a
// developer's global opt-out can't flip the emit-path tests.
function runHook(payload, envOverrides = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      CONVEX_PLUGIN_POSTHOG_KEY: "phc_test",
      CONVEX_PLUGIN_POSTHOG_HOST: SINK_URL,
      CONVEX_PLUGIN_TELEMETRY: "",
      DO_NOT_TRACK: "",
      ...envOverrides,
    },
  });
  assert.equal(result.status, 0, "hook must always exit 0");
  assert.equal(result.stdout, "", "hook must print nothing");
  return result;
}

// --- fixture dirs --------------------------------------------------------
function tmpProject() {
  return mkdtempSync(join(tmpdir(), "convex-session-start-"));
}

// --- isConvexProject unit coverage ---------------------------------------

test("isConvexProject: convex/ directory → true", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "convex"));
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: convex.json file → true", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, "convex.json"), "{}");
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: convex dependency in package.json → true", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { convex: "^1.0.0" } }),
  );
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: convex devDependency in package.json → true", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ devDependencies: { convex: "^1.0.0" } }),
  );
  assert.equal(isConvexProject(dir), true);
});

test("isConvexProject: plain node project → false", () => {
  const dir = tmpProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { react: "^18.0.0" } }),
  );
  assert.equal(isConvexProject(dir), false);
});

test("isConvexProject: nonexistent / bogus input → false, never throws", () => {
  assert.equal(isConvexProject(join(tmpdir(), "definitely-not-a-real-dir-xyz")), false);
  assert.equal(isConvexProject(""), false);
  assert.equal(isConvexProject(null), false);
  assert.equal(isConvexProject(42), false);
});

// --- full hook → sink coverage --------------------------------------------

test("emits plugin_session_start with harness, convex_project=true, session_source", async () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "convex"));
  runHook({ cwd: dir, source: "startup", session_id: "s1" });
  const { url, body } = await takeCapture();
  assert.equal(url, "/capture/");
  assert.equal(body.api_key, "phc_test");
  assert.equal(body.event, "plugin_session_start");
  assert.ok(body.distinct_id, "distinct_id must be set");
  assert.equal(body.properties.harness, "claude");
  assert.equal(body.properties.convex_project, true);
  assert.equal(body.properties.session_source, "startup");
  assert.equal(body.properties.os, process.platform);
  assert.equal(body.properties.node_version, process.version);
  assert.ok(body.properties.plugin_version, "plugin_version must be set");
  // The path itself must never ride along.
  assert.ok(!JSON.stringify(body).includes(dir), "cwd path must not be sent");
});

test("non-Convex cwd → convex_project=false", async () => {
  runHook({ cwd: tmpProject(), source: "resume" });
  const { body } = await takeCapture();
  assert.equal(body.properties.convex_project, false);
  assert.equal(body.properties.session_source, "resume");
});

test("unknown session source is clamped to 'other'", async () => {
  runHook({ cwd: tmpProject(), source: "some-future-source" });
  const { body } = await takeCapture();
  assert.equal(body.properties.session_source, "other");
});

test("missing cwd/source → event still emits without the derived fields", async () => {
  runHook({ session_id: "s2" });
  const { body } = await takeCapture();
  assert.equal(body.event, "plugin_session_start");
  assert.ok(!("convex_project" in body.properties));
  assert.ok(!("session_source" in body.properties));
});

test("malformed stdin → exits 0 and still emits a bare event", async () => {
  runHook("this is not json{{{");
  const { body } = await takeCapture();
  assert.equal(body.event, "plugin_session_start");
  assert.ok(!("convex_project" in body.properties));
});

test("CONVEX_PLUGIN_TELEMETRY=0 → no POST", async () => {
  runHook({ cwd: tmpProject(), source: "startup" }, { CONVEX_PLUGIN_TELEMETRY: "0" });
  await waitQuiet();
});

test("DO_NOT_TRACK=1 → no POST", async () => {
  runHook({ cwd: tmpProject(), source: "startup" }, { DO_NOT_TRACK: "1" });
  await waitQuiet();
});
