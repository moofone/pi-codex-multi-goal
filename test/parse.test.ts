import assert from "node:assert/strict";
import test from "node:test";

import { parseStageTitles } from "../src/parse.ts";
import { MAX_STAGE_TITLE_CHARS } from "../src/types.ts";

test("single stage", () => {
  assert.deepEqual(parseStageTitles("  pin duplicate  "), { ok: true, titles: ["pin duplicate"] });
});

test("goal text is a single objective", () => {
  // ` || ` splitting is retired: the whole argument is one objective.
  const parsed = parseStageTitles("pin duplicate || write red test");
  assert.deepEqual(parsed, { ok: true, titles: ["pin duplicate || write red test"] });
  // Single pipes are literal text too.
  assert.deepEqual(parseStageTitles("keep | single | pipes"), {
    ok: true,
    titles: ["keep | single | pipes"],
  });
});

test("rejects empty and oversized objectives", () => {
  assert.equal(parseStageTitles("").ok, false);
  assert.equal(parseStageTitles("   ").ok, false);
  assert.equal(parseStageTitles("a".repeat(MAX_STAGE_TITLE_CHARS)).ok, true);
  assert.equal(parseStageTitles("a".repeat(MAX_STAGE_TITLE_CHARS + 1)).ok, false);
});
