// Shared plugin configuration for the Convex hooks. Reads an OPTIONAL,
// per-project settings file `.claude/convex.local.md` (the canonical Claude
// Code plugin-settings location) and applies defaults so an absent file means
// "everything on, auto-discover apps" - i.e. existing single-app repos behave
// exactly as before.
//
// The file carries a small YAML-style frontmatter block; only the handful of
// keys below are read. This module intentionally ships NO YAML dependency (the
// plugin is Node-stdlib only), so it parses just the flat `key: value` lines it
// needs. Anything it can't understand is ignored.
//
// Design notes:
// - Pure and injectable: `loadConvexPluginConfig(repoRoot, { existsSync,
//   readFileSync })` takes its fs boundary as an argument so the hook tests can
//   fake it, mirroring the other hooks' override seam.
// - Fail-safe: an unreadable, missing, or malformed file degrades to defaults.
//   This module NEVER throws and NEVER blocks - a broken settings file must not
//   be able to wedge a session.

import { resolve } from "node:path";

// Per-hook enable toggles. Each defaults to true (hook enabled) when the key is
// absent or not a boolean.
const HOOK_TOGGLE_KEYS = [
  "typecheck_hook",
  "lint_hook",
  "freshness_hook",
  "session_start_hook",
];

// Default upper bound on how far the app resolver walks when attributing a
// touched file to its enclosing Convex app root. Small on purpose: real apps
// sit shallow, and a tight bound keeps the walk cheap.
const DEFAULT_DISCOVERY_MAX_DEPTH = 4;

// The full default config, applied whenever the settings file is absent or a
// given key is missing/invalid. `convex_apps: null` means "no explicit list -
// auto-discover".
function defaults() {
  return {
    typecheck_hook: true,
    lint_hook: true,
    freshness_hook: true,
    session_start_hook: true,
    convex_apps: null,
    discovery_max_depth: DEFAULT_DISCOVERY_MAX_DEPTH,
  };
}

// Parse a single scalar frontmatter value into boolean | number | string.
// Arrays are handled separately by the caller.
function parseScalar(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  // Strip a single layer of matching quotes if present.
  const m = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  return m ? m[1] : raw;
}

// Parse an inline `[a, b, "c"]` list into an array of strings. Returns null
// when the value is not a bracketed list.
function parseInlineList(raw) {
  const m = /^\[(.*)\]$/.exec(raw);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((part) => {
      const t = part.trim();
      const q = /^"([^"]*)"$/.exec(t) ?? /^'([^']*)'$/.exec(t);
      return q ? q[1] : t;
    })
    .filter((s) => s.length > 0);
}

// Minimal frontmatter reader: pulls the block delimited by the first two `---`
// lines and returns a flat { key: value } map. Only flat `key: value` lines are
// understood; nested structures and multi-line values are ignored. Never
// throws.
export function parseFrontmatter(text) {
  const out = {};
  if (typeof text !== "string") return out;
  const lines = text.split(/\r?\n/);
  // The frontmatter must open with `---` as the first non-empty line.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "---") return out;
  i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break; // end of frontmatter
    // Drop a trailing `# comment`, and skip whole-line comments / blanks.
    const withoutComment = line.replace(/\s+#.*$/, "");
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (!key) continue;
    const list = parseInlineList(rawValue);
    out[key] = list !== null ? list : parseScalar(rawValue);
  }
  return out;
}

// Load the plugin config for `repoRoot`, applying defaults. Injectable fs so
// tests can fake the boundary. Always returns a fully-populated config object;
// on any error it returns pure defaults.
export function loadConvexPluginConfig(
  repoRoot,
  { existsSync, readFileSync },
) {
  const config = defaults();
  try {
    const path = resolve(repoRoot, ".claude", "convex.local.md");
    if (!existsSync(path)) return config;
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    for (const key of HOOK_TOGGLE_KEYS) {
      if (typeof parsed[key] === "boolean") config[key] = parsed[key];
    }
    if (Array.isArray(parsed.convex_apps)) {
      const apps = parsed.convex_apps.filter(
        (a) => typeof a === "string" && a.length > 0,
      );
      config.convex_apps = apps; // may be [] - an explicit empty allowlist
    }
    if (
      Number.isInteger(parsed.discovery_max_depth) &&
      parsed.discovery_max_depth > 0
    ) {
      config.discovery_max_depth = parsed.discovery_max_depth;
    }
  } catch {
    // Unreadable/malformed settings file - fall back to defaults, never throw.
    return defaults();
  }
  return config;
}

// Whether a given hook is enabled under `config`. Unset/unknown => enabled, so
// a partial or absent config never silently disables a hook.
export function hookEnabled(config, hookName) {
  return config?.[hookName] !== false;
}
