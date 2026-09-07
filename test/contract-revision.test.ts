import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptCompletion,
  cloneGoal,
  createGoal,
  reconstructGoal,
  replaceGoalFromSteps,
  setEntry,
} from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import type { MultiGoal } from "../src/types.ts";

/**
 * `contractRevision` (PI_DAG_COMPACT D7, §1 "Goal and memory authority";
 * GOAL_WITH_DAG_SUPPORT §3 binding state).
 *
 * The deterministic identity of the human contract the agent is currently
 * working under: the sha256 of the accepted objective, the ordered criterion
 * IDs and text, and the human-decision flags. Goal computes it and DAG carries
 * it unchanged, so that a bound peer can tell "the contract I mirrored" from
 * "the contract in force now" without re-reading Goal's criteria.
 *
 * It is scoped to the current step, not the whole goal: a step transition is
 * exactly the event a bound peer must notice.
 */

function twoStepGoal(): MultiGoal {
  const result = replaceGoalFromSteps([
    { objective: "ship the fix", criteria: ["the regression test passes", "the docs match"] },
    { objective: "measure it", criteria: ["p95 is recorded"] },
  ]);
  assert.ok(result.ok && result.goal, result.message);
  return result.goal;
}

test("contractRevision is a stable sha256 over the current step's contract", () => {
  const goal = twoStepGoal();

  assert.match(
    goal.contractRevision,
    /^[0-9a-f]{64}$/,
    "the contract revision is a bare sha256 hex digest",
  );
  assert.equal(
    cloneGoal(goal).contractRevision,
    goal.contractRevision,
    "recomputing it over unchanged input is stable",
  );
});

test("contractRevision changes when any part of the contract changes", () => {
  const goal = twoStepGoal();
  const base = goal.contractRevision;

  const retitled = cloneGoal(goal);
  retitled.stages[0]!.title = "ship the other fix";
  assert.notEqual(cloneGoal(retitled).contractRevision, base, "the objective is covered");

  const retexted = cloneGoal(goal);
  retexted.stages[0]!.criteria[0]!.text = "the regression test passes twice";
  assert.notEqual(cloneGoal(retexted).contractRevision, base, "criterion text is covered");

  const reordered = cloneGoal(goal);
  reordered.stages[0]!.criteria.reverse();
  assert.notEqual(cloneGoal(reordered).contractRevision, base, "criterion order is covered");

  const flagged = cloneGoal(goal);
  flagged.stages[0]!.criteria[0]!.requiresHumanDecision = true;
  assert.notEqual(cloneGoal(flagged).contractRevision, base, "human-decision flags are covered");

  const reidentified = cloneGoal(goal);
  reidentified.stages[0]!.criteria[0]!.id = "a-different-id";
  assert.notEqual(cloneGoal(reidentified).contractRevision, base, "criterion IDs are covered");
});

test("contractRevision ignores everything that is not the contract", () => {
  const goal = twoStepGoal();
  const base = goal.contractRevision;
  assert.match(base, /^[0-9a-f]{64}$/, "sanity: there is a revision to be stable about");

  const spent = cloneGoal(goal);
  spent.execution = {
    ...spent.execution,
    totalRemaining: 12,
    lifetimeRequests: 388,
    turnRequests: 3,
  };
  spent.memory = { revision: 9, proved: ["something"], unresolved: ["else"], next: "onward" };
  spent.updatedAt = goal.updatedAt + 1000;
  spent.pauseReason = "paused for a reason";

  assert.equal(
    cloneGoal(spent).contractRevision,
    base,
    "budgets, memory, and status are not the contract",
  );

  // A later step's contract is not the current one, so editing it is invisible
  // until that step becomes current.
  const laterStep = cloneGoal(goal);
  laterStep.stages[1]!.title = "measure it more carefully";
  assert.equal(
    cloneGoal(laterStep).contractRevision,
    base,
    "only the current step's contract is hashed",
  );
});

test("a step transition produces a new contractRevision", () => {
  const goal = twoStepGoal();
  const before = goal.contractRevision;

  const advanced = acceptCompletion(goal, Date.now(), {});
  assert.ok(advanced.ok && advanced.goal, advanced.message);
  assert.equal(advanced.goal.index, 1, "sanity: the goal advanced");

  assert.notEqual(
    advanced.goal.contractRevision,
    before,
    "the next step is a different contract, and a bound peer must be able to see that",
  );
  assert.match(advanced.goal.contractRevision, /^[0-9a-f]{64}$/);
});

test("contractRevision survives a reload and rides the custom entry", () => {
  const goal = twoStepGoal();

  assert.match(goal.contractRevision, /^[0-9a-f]{64}$/, "sanity: there is a revision to carry");

  const entry = setEntry(goal, "runtime");
  assert.equal(
    (entry as { goal: MultiGoal }).goal.contractRevision,
    goal.contractRevision,
    "the persisted custom entry carries it",
  );

  const reloaded = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: entry },
  ]);
  assert.ok(reloaded);
  assert.equal(reloaded.contractRevision, goal.contractRevision, "a reload preserves it");
});

test("a stored contractRevision that disagrees with the contract is corrected on load", () => {
  // It is derived state, so the criteria are authoritative and a stale or
  // tampered stored value can never make a bound peer trust the wrong
  // contract.
  const goal = twoStepGoal();
  assert.match(goal.contractRevision, /^[0-9a-f]{64}$/, "sanity: there is a revision to correct to");
  const tampered = { ...cloneGoal(goal), contractRevision: "0".repeat(64) };

  const reloaded = reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: tampered, at: 1 },
    },
  ]);

  assert.ok(reloaded, "the snapshot still loads");
  assert.equal(
    reloaded.contractRevision,
    goal.contractRevision,
    "the value recomputed from the criteria wins",
  );
});

test("a snapshot written before contractRevision existed loads with one", () => {
  const goal = twoStepGoal();
  assert.match(goal.contractRevision, /^[0-9a-f]{64}$/, "sanity: there is a revision to materialise");
  const legacy = cloneGoal(goal) as Partial<MultiGoal>;
  delete legacy.contractRevision;

  const reloaded = reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: legacy, at: 1 },
    },
  ]);

  assert.ok(reloaded, "an older snapshot must restore, not be skipped as malformed");
  assert.equal(reloaded.contractRevision, goal.contractRevision);
});

test("test-compat goals also carry a contractRevision", () => {
  const goal = createGoal(["one step"], 1);
  assert.match(goal.contractRevision, /^[0-9a-f]{64}$/);
});
