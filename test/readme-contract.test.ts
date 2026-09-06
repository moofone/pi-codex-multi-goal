import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseGoalContract } from "../src/parse.ts";

// The README is the command contract a headless caller relies on. It must
// document the JSON start contract (objective + human criteria — the only
// headless start path; plain text never starts a goal) and must NOT document
// the retired undocumented ` || ` stage splitter.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

/** Extract the `/goal ` JSON payload from the one fenced json example containing `needle`. */
function goalJsonExample(needle: string): string {
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes("/goal") && block.includes(needle));
  assert.equal(
    blocks.length,
    1,
    `README must contain exactly one fenced /goal JSON example mentioning ${needle}`,
  );
  return blocks[0].replace(/^\/goal\s*/, "").trim();
}

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

  // The documented multi-step payload must be something parseGoalContract
  // accepts: top-level nonempty objective and criteria, steps (when present)
  // a nonempty array of the same shape. A steps-only object is rejected by
  // parseGoalContract and by test/commands.test.ts — the README must not
  // document it as startable.
  const multiStepExample = goalJsonExample('"steps"');
  const parsed = parseGoalContract(multiStepExample);
  assert.equal(
    parsed.ok,
    true,
    `README multi-step /goal example must be accepted by parseGoalContract: ${parsed.ok ? "" : parsed.message}`,
  );
});
