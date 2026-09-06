import assert from "node:assert/strict";
import test from "node:test";

import { completeCurrentStage, createGoal, replaceGoal, setGoalStatus } from "../src/state.ts";

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

test("replaceGoal parses stages", () => {
  const result = replaceGoal("one || two");
  assert.equal(result.ok, true);
  assert.equal(result.goal?.stages.length, 2);
});
