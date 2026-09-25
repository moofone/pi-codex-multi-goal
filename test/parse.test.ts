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

test("accepts realistic multi-sentence objectives", () => {
  const rejectedInPractice =
    "Complete Phase A in /Users/greg/spec/TSC_PROOF_OF_INFERENCE/RESEARCH_HANDOFF.md. Reports only; respect its resource restrictions. " +
    "Produce the acceptance-contract assessment and next falsifiable experiment, or exact blockers. Do not start later phases.";
  assert.deepEqual(parseStageTitles(rejectedInPractice), { ok: true, titles: [rejectedInPractice] });
  // A paragraph-sized brief with paths and constraints is an objective, not a title.
  const brief = `${rejectedInPractice} `.repeat(8).trim();
  assert.ok([...brief].length > 1500);
  assert.equal(parseStageTitles(brief).ok, true);
});

test("rejects empty and oversized objectives", () => {
  assert.equal(parseStageTitles("").ok, false);
  assert.equal(parseStageTitles("   ").ok, false);
  assert.equal(parseStageTitles("a".repeat(MAX_STAGE_TITLE_CHARS)).ok, true);
  const oversized = parseStageTitles("a".repeat(MAX_STAGE_TITLE_CHARS + 1));
  assert.equal(oversized.ok, false);
  assert.match(oversized.ok ? "" : oversized.message, /^Objectives must be \d+ characters or fewer\.$/);
  // Code points, not UTF-16 units: an astral character counts once.
  assert.equal(parseStageTitles("\u{1F600}".repeat(MAX_STAGE_TITLE_CHARS)).ok, true);
});
