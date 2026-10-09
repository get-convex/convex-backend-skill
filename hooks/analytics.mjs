#!/usr/bin/env node
// Dependency-free PostHog telemetry for the plugin's hooks. Mirrors the
// fire-and-forget pattern of Convex's openai-mcp lib/analytics.ts
// (posthog-node) but reimplemented on global fetch (Node 18+) because this
// plugin ships with no package.json and no node_modules.
//
// Design notes:
// - NEVER delays or breaks a hook. Hooks are short-lived processes, so an
//   awaited fetch would hold the agent's turn open. Instead `capture()` spawns
//   `node analytics.mjs --emit <base64 payload>` as a DETACHED child
//   (stdio ignored, .unref()'d) and returns immediately; the parent hook can
//   exit while the child completes the POST on its own (3s abort timeout,
//   every error swallowed, always exits 0).
// - On-by-default, with explicit opt-outs checked before anything else:
//     * The public write-only PostHog project key (phc_…, the same one the
//       Convex dashboard ships in its committed .env files) is baked in as the
//       default, so telemetry works out of the box. Override or blank it with
//       CONVEX_PLUGIN_POSTHOG_KEY; a blank key fully disables sending.
//     * CONVEX_PLUGIN_TELEMETRY === "0" → disabled (explicit opt-out).
//     * DO_NOT_TRACK is "1"/"true" → disabled (ecosystem convention).
// - Privacy: NO code contents, file paths, prompts, or user identifiers ever
//   go into event properties. Only an anonymous random device id
//   (~/.convex/plugin-device-id), the plugin version, OS platform, the
//   harness tag, locally-derived booleans (e.g. convex_project),
//   and coarse event metadata (rule slugs, error counts, session source).
//   snake_case event names.
// - Any filesystem failure (unwritable home dir, missing plugin.json) falls
//   back silently — telemetry must never surface an error to the hook.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Public, write-only PostHog project key (client-side `phc_` token, safe to
// commit — it can only ingest events, not read them). Same key the Convex
// dashboard ships in its committed .env files. Override via env, or set it to
// an empty string to disable telemetry entirely.
const DEFAULT_POSTHOG_KEY = "phc_JDNTRxeh2li2sQTRO0IcOYMJcp8fPs5nTK9TU751nQK";
const POSTHOG_KEY = process.env.CONVEX_PLUGIN_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY;
const POSTHOG_HOST =
  process.env.CONVEX_PLUGIN_POSTHOG_HOST ?? "https://us.i.posthog.com";

function isDisabled() {
  if (!POSTHOG_KEY) return true;
  if (process.env.CONVEX_PLUGIN_TELEMETRY === "0") return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").toLowerCase();
  if (dnt === "1" || dnt === "true") return true;
  return false;
}

// Stable anonymous device id. Created once at ~/.convex/plugin-device-id
// (mode 0600); if the dir/file is unreadable or unwritable, fall back to
// "anonymous" rather than erroring.
function deviceId() {
  try {
    const file = join(homedir(), ".convex", "plugin-device-id");
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    } catch {
      // Missing — fall through and create it.
    }
    const id = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return "anonymous";
  }
}

// Plugin version, read lazily from ../<manifestDir>/plugin.json relative to
// this script so it works wherever the plugin is installed.
function pluginVersion(manifestDir) {
  try {
    const manifest = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      manifestDir,
      "plugin.json",
    );
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

// Cheap, local-only probe: does `dir` look like a Convex project? Used to
// attach a `convex_project: true|false` boolean to session events so
// installed-base sessions can be split from sessions doing actual Convex
// work. Only the boolean ever leaves the machine — never the path. Any fs
// error (missing dir, no permission) counts as "not a Convex project".
export function isConvexProject(dir) {
  if (typeof dir !== "string" || !dir) return false;
  try {
    if (statSync(join(dir, "convex")).isDirectory()) return true;
  } catch {
    // no convex/ dir — keep probing
  }
  try {
    if (statSync(join(dir, "convex.json")).isFile()) return true;
  } catch {
    // no convex.json — keep probing
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg?.dependencies?.convex || pkg?.devDependencies?.convex) return true;
  } catch {
    // no readable package.json
  }
  return false;
}

const CLOUD_DEPLOYMENT_TYPES = new Set(["dev", "prod", "preview", "custom"]);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEPLOYMENT_LINE = /^\s*(?:export\s+)?CONVEX_DEPLOYMENT\s*=(.*)$/gm;

/**
 * The deployment name and team slug from the `CONVEX_DEPLOYMENT` line the
 * Convex CLI writes, e.g.
 * `CONVEX_DEPLOYMENT=dev:happy-cat-123 # team: acme, project: app`.
 * `.env.local` wins over `.env`, and within a file the last line wins, matching
 * how the CLI loads them with dotenv. Returns only the two values
 * and nothing else from the files. The deployment name is kept for cloud
 * deployments only, and either value is dropped unless it looks like a slug.
 * @param {{ envLocal?: string, env?: string }} files the text of `.env.local` and `.env`, when they exist
 * @returns {{ deployment?: string, team?: string }}
 */
export function parseConvexDeployment({ envLocal, env }) {
  for (const text of [envLocal, env]) {
    if (typeof text !== "string") continue;
    const line = [...text.matchAll(DEPLOYMENT_LINE)].at(-1)?.[1];
    if (line === undefined) continue;
    const [value, comment = ""] = line.split("#");
    const [type, name] = value.trim().replace(/^["'`]|["'`]$/g, "").split(":");
    const team = comment.match(/team:\s*([^,\s]+)/)?.[1];
    const result = {};
    if (CLOUD_DEPLOYMENT_TYPES.has(type) && SLUG.test(name ?? "")) {
      result.deployment = name;
    }
    if (team && SLUG.test(team)) result.team = team;
    return result;
  }
  return {};
}

/**
 * Telemetry for one plugin. Every event carries `harness`, the agent the
 * plugin runs in, and the plugin version read from `<manifestDir>/plugin.json`
 * in the plugin root.
 * @param {{ harness: string, manifestDir: string }} plugin e.g. `{ harness: "claude", manifestDir: ".claude-plugin" }`
 */
export function makeAnalytics({ harness, manifestDir }) {
  return {
    /**
     * Fire-and-forget event capture. A no-op when telemetry is disabled,
     * otherwise returns right after spawning the detached emitter child.
     * Never throws.
     * @param {string} event
     * @param {Record<string, unknown>} [properties]
     */
    capture(event, properties = {}) {
      try {
        if (isDisabled()) return;
        const body = {
          api_key: POSTHOG_KEY,
          event,
          distinct_id: deviceId(),
          properties: {
            ...properties,
            harness,
            plugin_version: pluginVersion(manifestDir),
            $process_person_profile: false,
          },
        };
        const payload = Buffer.from(
          JSON.stringify({ host: POSTHOG_HOST, body }),
        ).toString("base64");
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "--emit", payload],
          { detached: true, stdio: "ignore" },
        );
        child.unref();
      } catch {
        // Telemetry must never change hook behavior.
      }
    },
  };
}

// Child entrypoint: `node analytics.mjs --emit <base64 payload>` decodes the
// payload and performs the actual POST, bounded by a 3s abort timeout. All
// errors are swallowed; always exits 0.
if (process.argv[2] === "--emit") {
  (async () => {
    try {
      const { host, body } = JSON.parse(
        Buffer.from(process.argv[3] ?? "", "base64").toString("utf8"),
      );
      await fetch(`${host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // ignore — telemetry is best-effort
    }
    process.exit(0);
  })();
}
