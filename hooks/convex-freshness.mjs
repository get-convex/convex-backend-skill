#!/usr/bin/env node
// SessionStart hook: nudge the user to upgrade the Convex plugin when their
// installed version is behind the latest published version. The "latest" is
// served by the anteater at /plugin-versions.json, so the nudge is controllable
// server-side (one deploy reaches every installed user, no plugin release).
//
// Principles: fail-open (never blocks or errors the session), throttled to once
// per day per plugin, fast (short fetch timeout), and honors the same opt-outs
// as telemetry (it does reach our server). Emits a SessionStart additionalContext
// line the assistant relays to the user; silent when up to date.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE =
  process.env.CONVEX_PLUGIN_VERSIONS_BASE ||
  "https://basic-anteater-667.convex.site";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

// Emit SessionStart context (the assistant relays it), then exit.
function nudge(context) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      }),
    );
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function semverCmp(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function main() {
  // Drain the hook stdin payload (unused) without failing on garbage.
  try {
    readFileSync(0, "utf8");
  } catch {
    /* ignore */
  }

  // Opt-out: a version check reaches our server, so respect the telemetry opt-outs
  // plus a dedicated switch.
  if (
    process.env.DO_NOT_TRACK === "1" ||
    process.env.CONVEX_PLUGIN_TELEMETRY === "0" ||
    process.env.CONVEX_PLUGIN_FRESHNESS === "0"
  ) {
    process.exit(0);
  }

  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) process.exit(0);

  let name, installed;
  try {
    const pj = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    name = pj.name;
    installed = pj.version;
  } catch {
    process.exit(0);
  }
  if (!name || !installed) process.exit(0);

  // Throttle: at most once per day per plugin.
  const cacheDir = join(tmpdir(), "convex-plugin-freshness");
  const cacheFile = join(cacheDir, `${name}.json`);
  const now = Date.now();
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (now - (c.t || 0) < THROTTLE_MS) process.exit(0);
    } catch {
      /* treat as no cache */
    }
  }

  // Fetch the latest versions (fast, fail-open).
  let data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${BASE}/plugin-versions.json`, {
      signal: ctrl.signal,
    });
    if (!res.ok) process.exit(0);
    data = await res.json();
  } catch {
    process.exit(0);
  } finally {
    clearTimeout(timer);
  }

  const entry = data && data.plugins && data.plugins[name];
  if (!entry || !entry.latest) process.exit(0);

  // Record the check so we don't refetch again today (even when up to date).
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ t: now }));
  } catch {
    /* best effort */
  }

  if (semverCmp(installed, entry.latest) >= 0) process.exit(0); // current

  const belowMin = entry.min && semverCmp(installed, entry.min) < 0;
  if (belowMin) {
    nudge(
      `The installed Convex plugin (${name} v${installed}) is well behind the latest (v${entry.latest}) and below the supported minimum (v${entry.min}). Early in the session, clearly tell the user to upgrade: run \`claude plugin marketplace update\` then reinstall the plugin — some features may misbehave until they do.`,
    );
  } else {
    nudge(
      `A newer Convex plugin is available (${name} v${entry.latest}; installed v${installed}). At a natural moment, let the user know they can upgrade with \`claude plugin marketplace update\` (then reinstall). Informational only — do not interrupt their work.`,
    );
  }
}

main().catch(() => process.exit(0));
