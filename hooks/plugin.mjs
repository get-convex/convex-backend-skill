// This plugin's identity for the shared telemetry in analytics.mjs.
import { makeAnalytics } from "./analytics.mjs";

export const analytics = makeAnalytics({ harness: "claude", manifestDir: ".claude-plugin" });
