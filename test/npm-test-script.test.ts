import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A12: typecheck must sit on the normal verification path. `npm test` is the
// project's single verification command, so it must run `tsc --noEmit` AND a
// test runner that actually executes the suite (a nonzero test count) — a
// typecheck-only or tests-only script would each let the other half silently
// rot (F09's compiler gap shipped exactly that way).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("npm test runs typecheck", () => {
  const script: string = pkg.scripts?.test ?? "";
  assert.match(
    script,
    /tsc --noEmit/,
    "package.json scripts.test must include tsc --noEmit on the normal test path",
  );
  assert.match(
    script,
    /tsx --test/,
    "package.json scripts.test must run the suite through a test runner",
  );
  assert.match(
    script,
    /test\/\*\.test\.ts/,
    "package.json scripts.test must execute the test files (nonzero test count)",
  );
});
