// Shared plugin configuration for the Convex hooks. Reads an OPTIONAL,
// per-project settings file `.claude/convex.local.md` (the canonical Claude
// Code plugin-settings location) and applies defaults so an absent file means
// "everything on, auto-discover apps" - i.e. existing single-app repos behave
// exactly as before.
//
// The file carries a small YAML-style frontmatter block; only the handful of
// keys below are read. This module intentionally ships NO YAML dependency (the
// plugin is Node-stdlib only), so it parses the flat keys + the list shapes
// it needs (inline `[a, b]` and multi-line `- item`). Anything it can't
// understand is ignored.
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
// touched file that is NOT under a `convex/` path segment. Paths under
// `.../convex/...` resolve via the segment itself and do not use this budget.
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

// Strip one layer of matching single/double quotes.
function unquote(raw) {
  const m = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  return m ? m[1] : raw;
}

// Drop a trailing `# comment` only when `#` is outside quotes, so values like
// `path: "foo # bar"` are preserved.
function stripTrailingComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

// Parse a single scalar frontmatter value into boolean | number | string.
// Quotes are stripped BEFORE boolean/int recognition so `"false"` and `'6'`
// work like unquoted forms. Also accepts True/False/yes/no/on/off.
function parseScalar(raw) {
  const u = unquote(String(raw).trim());
  const lower = u.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  if (/^-?\d+$/.test(u)) return parseInt(u, 10);
  return u;
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
    .map((part) => unquote(part.trim()))
    .filter((s) => s.length > 0);
}

// Minimal frontmatter reader: pulls the block delimited by the first two `---`
// lines and returns a flat { key: value } map. Supports:
// - flat `key: value` scalars
// - inline lists `key: [a, b]`
// - multi-line lists:
//     key:
//       - a
//       - b
// Never throws.
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
    const withoutComment = stripTrailingComment(line);
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Multi-line list continuation is handled when we see `key:` with empty
    // value; standalone `- item` lines without a preceding key are ignored.
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (!key) continue;

    if (!rawValue) {
      // Multi-line list: following indented `- item` lines.
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === "---") break;
        const itemLine = stripTrailingComment(lines[j]);
        const itemTrim = itemLine.trim();
        if (!itemTrim || itemTrim.startsWith("#")) continue;
        const itemMatch = /^-\s+(.*)$/.exec(itemTrim);
        if (!itemMatch) break;
        const item = unquote(itemMatch[1].trim());
        if (item.length > 0) items.push(item);
      }
      if (items.length > 0) {
        out[key] = items;
        i = j - 1;
        continue;
      }
      // Empty value with no list items — leave unset (defaults apply).
      continue;
    }

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
    } else if (
      typeof parsed.convex_apps === "string" &&
      parsed.convex_apps.length > 0
    ) {
      // Bare scalar `convex_apps: apps/backend-mono` → single-entry list.
      config.convex_apps = [parsed.convex_apps];
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
