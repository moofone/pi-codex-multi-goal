import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The README is the command contract a headless caller relies on. It must
// document the JSON start contract (objective + human criteria — the only
// headless start path; plain text never starts a goal) and must NOT document
// the retired undocumented ` || ` stage splitter.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("documents headless JSON and no pipe split", () => {
  assert.match(
    readme,
    /"objective"\s*:\s*"[^"]+"/,
    "README must document the headless JSON contract objective field",
  );
  assert.match(
    readme,
    /"criteria"\s*:\s*\[\s*"[^"]+"\s*\]/,
    "README must document the headless JSON contract nonempty criteria list",
  );
  assert.equal(
    readme.includes(" || "),
    false,
    "README must not document ` || ` as a stage splitter (retired undocumented behavior)",
  );
});
