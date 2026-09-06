import assert from "node:assert/strict";
import test from "node:test";

import {
  clearEntry,
  cloneGoal,
  completeCurrentStage,
  createGoal,
  goalsEquivalent,
  isMultiGoal,
  reconstructGoal,
  replaceGoal,
  replaceGoalFromSteps,
  setEntry,
  setGoalStatus,
} from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, DEFAULT_NO_PROGRESS_LIMIT, DEFAULT_TOTAL_LIMIT } from "../src/types.ts";

test("complete advances then finishes", () => {
  const goal = createGoal(["a", "b", "c"], 1);
  const mid = completeCurrentStage(goal, 2);
  assert.equal(mid.ok, true);
  assert.equal(mid.goal?.status, "active");
  assert.equal(mid.goal?.index, 1);
  assert.equal(mid.goal?.stages[0]?.status, "complete");
  assert.equal(mid.goal?.stages[1]?.status, "active");
  assert.equal(mid.message, "Stage 2/3 active.");

  const last = completeCurrentStage(completeCurrentStage(mid.goal, 3).goal, 4);
  assert.equal(last.goal?.status, "complete");
  assert.equal(last.goal?.index, 2);
  assert.equal(last.message, "Goal complete.");
});

test("block does not advance", () => {
  const goal = createGoal(["a", "b"], 1);
  const blocked = setGoalStatus(goal, "blocked", 2);
  assert.equal(blocked.goal?.status, "blocked");
  assert.equal(blocked.goal?.index, 0);
  assert.equal(blocked.goal?.stages[0]?.status, "active");
});

test("replaceGoal keeps one objective from piped text", () => {
  // ` || ` splitting is retired; the raw text is one objective.
  const result = replaceGoal("one || two");
  assert.equal(result.ok, true);
  assert.equal(result.goal?.stages.length, 1);
  assert.equal(result.goal?.stages[0]?.title, "one || two");
});

test("replaceGoalFromSteps requires accepted nonempty criteria", () => {
  const rejected = replaceGoalFromSteps([{ objective: "a", criteria: [] }]);
  assert.equal(rejected.ok, false);

  const accepted = replaceGoalFromSteps([
    { objective: "a", criteria: ["a done"] },
    { objective: "b", criteria: ["b done"] },
  ]);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.goal?.stages.length, 2);
  assert.deepEqual(
    accepted.goal?.stages[0]?.criteria.map((criterion) => criterion.text),
    ["a done"],
  );
  assert.deepEqual(
    accepted.goal?.stages[1]?.criteria.map((criterion) => criterion.text),
    ["b done"],
  );
  assert.equal(accepted.goal?.stages[0]?.status, "active");
  assert.equal(accepted.goal?.stages[1]?.status, "pending");
});

test("v2 contract validation and v1 migration", () => {
  const textEncoder = new TextEncoder();

  // Positive control: a freshly created goal is a valid v2 snapshot.
  const valid = createGoal(["a", "b"], 1);
  assert.equal(isMultiGoal(valid), true);

  // Non-integer index is rejected (integer index required).
  const nonIntegerIndex = createGoal(["a"], 1);
  nonIntegerIndex.index = 0.5;
  assert.equal(isMultiGoal(nonIntegerIndex), false);

  // Two active stages are rejected (consistent unique active stage).
  const twoActive = createGoal(["a", "b"], 1);
  twoActive.stages[1]!.status = "active";
  assert.equal(isMultiGoal(twoActive), false);

  // A single active stage away from goal.index is rejected.
  const mislocatedActive = createGoal(["a", "b"], 1);
  mislocatedActive.stages[0]!.status = "pending";
  mislocatedActive.stages[1]!.status = "active";
  assert.equal(isMultiGoal(mislocatedActive), false);

  // Stage IDs must be unique.
  const duplicateStageIds = createGoal(["a", "b"], 1);
  duplicateStageIds.stages[1]!.id = duplicateStageIds.stages[0]!.id;
  assert.equal(isMultiGoal(duplicateStageIds), false);

  // Criterion IDs must be unique within a stage.
  const duplicateCriterionIds = createGoal(["a"], 1);
  duplicateCriterionIds.stages[0]!.criteria[1] = {
    id: duplicateCriterionIds.stages[0]!.criteria[0]!.id,
    text: "second",
  };
  assert.equal(isMultiGoal(duplicateCriterionIds), false);

  // Empty criteria cannot produce a startable/active goal (A01).
  const activeWithoutCriteria = createGoal(["a"], 1);
  activeWithoutCriteria.stages[0]!.criteria = [];
  assert.equal(isMultiGoal(activeWithoutCriteria), false);

  const blockedWithoutCriteria = setGoalStatus(createGoal(["a"], 1), "blocked", 2).goal!;
  blockedWithoutCriteria.stages[0]!.criteria = [];
  assert.equal(isMultiGoal(blockedWithoutCriteria), false);

  // Empty criteria is valid for paused-awaiting-criteria (v1 unfinished).
  const pausedAwaitingCriteria = createGoal(["a"], 1);
  pausedAwaitingCriteria.status = "paused";
  pausedAwaitingCriteria.pauseReason = "confirm criteria";
  for (const stage of pausedAwaitingCriteria.stages) {
    stage.criteria = [];
  }
  assert.equal(isMultiGoal(pausedAwaitingCriteria), true);

  // Empty criteria is valid for completed goals (v1 completed migration).
  const completedWithoutCriteria = completeCurrentStage(createGoal(["a"], 1), 2).goal!;
  completedWithoutCriteria.stages[0]!.criteria = [];
  assert.equal(isMultiGoal(completedWithoutCriteria), true);

  // Memory sized at exactly 8192 UTF-8 JSON bytes is valid (A02).
  const emptyMemory = { revision: 0, proved: [], unresolved: [], next: "" };
  const fixedBytes = textEncoder.encode(JSON.stringify(emptyMemory)).length;
  assert.ok(fixedBytes < 8192);
  const exactFit = createGoal(["a"], 1);
  exactFit.memory.next = "a".repeat(8192 - fixedBytes);
  assert.equal(textEncoder.encode(JSON.stringify(exactFit.memory)).length, 8192);
  assert.equal(isMultiGoal(exactFit), true);

  // A snapshot whose UTF-8 JSON memory exceeds 8192 bytes fails isMultiGoal (A02).
  const oversized = createGoal(["a"], 1);
  oversized.memory.next = "a".repeat(8192 - fixedBytes + 1);
  assert.equal(isMultiGoal(oversized), false);

  // The limit is UTF-8 bytes, not character count.
  const multibyteOversized = createGoal(["a"], 1);
  multibyteOversized.memory.next = "\u00e9".repeat(4200);
  assert.ok(textEncoder.encode(JSON.stringify(multibyteOversized.memory)).length > 8192);
  assert.equal(isMultiGoal(multibyteOversized), false);

  // A v1 unfinished snapshot migrates paused with titles preserved and no
  // fabricated criteria, plus a bounded grant (A10).
  const v1UnfinishedEntry = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "set",
      source: "command",
      at: 5,
      goal: {
        goalId: "v1-goal",
        status: "active",
        index: 1,
        createdAt: 1,
        updatedAt: 2,
        stages: [
          { title: "stage one", status: "complete" },
          { title: "stage two", status: "active" },
        ],
      },
    },
  };
  const migrated = reconstructGoal([v1UnfinishedEntry]);
  assert.ok(migrated);
  assert.equal(migrated.status, "paused");
  assert.equal(typeof migrated.pauseReason, "string");
  assert.deepEqual(migrated.stages.map((stage) => stage.title), ["stage one", "stage two"]);
  assert.deepEqual(migrated.stages.map((stage) => stage.status), ["complete", "active"]);
  assert.ok(migrated.stages.every((stage) => stage.criteria.length === 0));
  assert.ok(isMultiGoal(migrated));
  assert.ok(migrated.execution.noProgressRemaining > 0);
  assert.ok(migrated.execution.noProgressRemaining <= DEFAULT_NO_PROGRESS_LIMIT);
  assert.ok(migrated.execution.totalRemaining > 0);
  assert.ok(migrated.execution.totalRemaining <= DEFAULT_TOTAL_LIMIT);

  // A v1 completed snapshot keeps its completed stage statuses (rejects silent
  // invention) and stays complete (A10).
  const v1CompletedEntry = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "set",
      source: "command",
      at: 5,
      goal: {
        goalId: "v1-done",
        status: "complete",
        index: 0,
        createdAt: 1,
        updatedAt: 2,
        stages: [{ title: "solo", status: "complete" }],
      },
    },
  };
  const migratedComplete = reconstructGoal([v1CompletedEntry]);
  assert.ok(migratedComplete);
  assert.equal(migratedComplete.status, "complete");
  assert.deepEqual(migratedComplete.stages.map((stage) => stage.status), ["complete"]);
  assert.ok(migratedComplete.stages.every((stage) => stage.criteria.length === 0));
  assert.ok(isMultiGoal(migratedComplete));

  // A v2 set entry round-trips; a clear resets; an invalid v2 snapshot is
  // skipped rather than adopted.
  const advanced = completeCurrentStage(createGoal(["x", "y"], 10), 11).goal!;
  const restored = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(advanced, "runtime", 12) },
  ]);
  assert.ok(restored);
  assert.ok(goalsEquivalent(cloneGoal(advanced), restored));
  assert.equal(
    reconstructGoal([
      { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: clearEntry(advanced.goalId, "command", 13) },
    ]),
    null,
  );
  const invalidV2 = createGoal(["bad"], 14);
  invalidV2.index = 0.5;
  assert.equal(
    reconstructGoal([
      { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(invalidV2, "runtime", 15) },
    ]),
    null,
  );
});
