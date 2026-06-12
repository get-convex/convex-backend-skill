#!/usr/bin/env node
// SessionStart hook: emits a single anonymous `plugin_session_start`
// telemetry event (OS platform + Node version only — see analytics.mjs for
// the privacy and opt-out gates). Prints nothing and exits 0 in every case;
// the capture itself is fire-and-forget via a detached child, so this hook
// never delays the session.

import { readFileSync } from "node:fs";
import { capture } from "./analytics.mjs";

try {
  // Drain stdin (the hook payload) but tolerate garbage — nothing in it is
  // needed or recorded.
  try {
    JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    // ignore malformed input
  }
  capture("plugin_session_start", {
    os: process.platform,
    node_version: process.version,
  });
} catch {
  // Telemetry must never surface an error to the session.
}
process.exit(0);
