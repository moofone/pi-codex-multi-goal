import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test, { after } from "node:test";

import { creditVerifiedEvidence } from "../src/allowance.ts";
import { fingerprintContent, validateEvidenceRefs } from "../src/evidence.ts";
import { acceptCompletion, cloneGoal, replaceGoalFromSteps } from "../src/state.ts";
import type { MultiGoal } from "../src/types.ts";

/**
 * P4 — credited evidence dedupes for the goal's lifetime
 * (GOAL_WITH_DAG_SUPPORT §7, P4 row).
 *
 * A credit now returns a capped grant to the working request budget (D4), so
 * anything that lets the same artifact be credited twice is a way to buy
 * budget without doing work. Two such holes are closed here: the record being
 * cleared at a step transition, and the record ageing entries out.
 */

/** A goal whose current step has two criteria, plus a real artifact on disk. */
function fixture(): { goal: MultiGoal; artifact: string; fingerprint: string; criterion: string } {
  // The validator only accepts project-relative paths without traversal, so
  // the artifact has to live under the working directory, not in the tmpdir.
  const dir = mkdtempSync(join(process.cwd(), ".goal-evidence-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const absolute = join(dir, "finding.md");
  const bytes = Buffer.from("the pipeline regressed 4 %\n");
  writeFileSync(absolute, bytes);

  const result = replaceGoalFromSteps([
    { objective: "measure the regression", criteria: ["the regression is measured", "it is written down"] },
    { objective: "fix it", criteria: ["the fix lands"] },
  ]);
  assert.ok(result.ok && result.goal, result.message);
  return {
    goal: result.goal,
    artifact: relative(process.cwd(), absolute),
    fingerprint: fingerprintContent(bytes),
    criterion: result.goal.stages[0]!.criteria[0]!.id,
  };
}

test("P4: credited evidence dedupes for the goal's lifetime, across a step transition", () => {
  const { goal, artifact, fingerprint, criterion } = fixture();
  const validated = validateEvidenceRefs(goal, [
    { operation: "read", artifact, fingerprint, criteria: [criterion] },
  ]);
  assert.ok(validated.ok);
  const key = validated.refs[0]!.key;

  const credited = creditVerifiedEvidence(goal, [key]);
  assert.deepEqual(credited.creditedKeys, [key]);

  const advanced = acceptCompletion(credited.goal, Date.now(), {});
  assert.ok(advanced.ok && advanced.goal);
  assert.equal(advanced.goal.index, 1, "sanity: the goal advanced to step 2");

  // The artifact has not changed and no new work was done. Re-submitting it
  // against step 2's criteria must not buy a second grant.
  const reused = creditVerifiedEvidence(advanced.goal, [key]);
  assert.deepEqual(
    reused.creditedKeys,
    [],
    "evidence already credited in an earlier step cannot be credited again",
  );
  assert.equal(
    reused.goal.execution.totalRemaining,
    advanced.goal.execution.totalRemaining,
    "and it renews no budget",
  );
});

test("P4: the dedupe record cannot be aged out into a second credit", () => {
  // Eviction is what makes a bounded record dangerous now that a credit also
  // returns a capped grant to the working total: an aged-out key would let the
  // same artifact be replayed for another grant with no new work.
  const { goal } = fixture();
  const first = "read#docs/first.md#0123456789abcdef";

  let current = cloneGoal(goal);
  current = creditVerifiedEvidence(current, [first]).goal;

  for (let index = 0; index < 400; index += 1) {
    const key = `read#docs/filler-${index}.md#${index.toString(16).padStart(16, "0")}`;
    current = creditVerifiedEvidence(current, [key]).goal;
  }

  const replay = creditVerifiedEvidence(current, [first]);
  assert.deepEqual(
    replay.creditedKeys,
    [],
    "the earliest credited ref is still remembered after 400 later ones",
  );
});

test("P4: a credit never refunds lifetime requests", () => {
  const { goal } = fixture();
  const spent = cloneGoal(goal);
  spent.execution = { ...spent.execution, lifetimeRequests: 120, totalRemaining: 90 };

  const credited = creditVerifiedEvidence(spent, ["read#docs/x.md#0123456789abcdef"]);

  assert.equal(credited.goal.execution.lifetimeRequests, 120, "lifetime is never refunded");
  assert.ok(
    credited.goal.execution.totalRemaining > 90,
    "the working total is renewed, which is the point of the credit",
  );
});
