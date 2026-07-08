#!/usr/bin/env node
// SessionStart hook: emits a single anonymous `plugin_session_start`
// telemetry event (see analytics.mjs for the privacy and opt-out gates).
// Beyond OS platform + Node version, the event carries two locally-derived,
// non-identifying fields read from the hook payload:
//   - convex_project: whether the session's cwd looks like a Convex app
//     (convex/ dir, convex.json, or a convex package dep — see
//     isConvexProject in analytics.mjs). The boolean is sent, the path never
//     is. This is what separates "plugin installed" from "doing Convex work"
//     in the session numbers.
//   - session_source: how the session began (startup | resume | clear |
//     compact, per Claude Code's SessionStart payload). Any other value is
//     clamped to "other" so no free-form harness string is ever recorded.
// Prints nothing and exits 0 in every case; the capture itself is
// fire-and-forget via a detached child, so this hook never delays the
// session.

import { readFileSync } from "node:fs";
import { capture, isConvexProject } from "./analytics.mjs";

const SESSION_SOURCES = new Set(["startup", "resume", "clear", "compact"]);

try {
  // Read the hook payload from stdin, tolerating garbage — malformed input
  // degrades to an event without the derived fields, never an error.
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}") ?? {};
  } catch {
    // ignore malformed input
  }
  const props = {
    os: process.platform,
    node_version: process.version,
  };
  if (typeof payload.cwd === "string" && payload.cwd) {
    props.convex_project = isConvexProject(payload.cwd);
  }
  if (typeof payload.source === "string" && payload.source) {
    props.session_source = SESSION_SOURCES.has(payload.source)
      ? payload.source
      : "other";
  }
  capture("plugin_session_start", props);
} catch {
  // Telemetry must never surface an error to the session.
}
process.exit(0);
