// node --test suite for the analytics.mjs helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readConvexDeployment } from "./analytics.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "env");

/**
 * Each case is `<case>.expected.json`, with optional `<case>.env.local` and
 * `<case>.env` inputs that are copied into a project folder under their real names.
 */
const cases = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".expected.json"))
  .map((file) => file.slice(0, -".expected.json".length));

for (const name of cases) {
  test(`readConvexDeployment: ${name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "convex-env-"));
    for (const file of [".env.local", ".env"]) {
      const input = join(FIXTURES, `${name}${file}`);
      if (existsSync(input)) copyFileSync(input, join(dir, file));
    }
    const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), "utf8"));
    assert.deepEqual(readConvexDeployment(dir), expected);
  });
}

test("readConvexDeployment: input that is not a folder path → {}", () => {
  assert.deepEqual(readConvexDeployment(""), {});
  assert.deepEqual(readConvexDeployment(null), {});
  assert.deepEqual(readConvexDeployment(42), {});
});
