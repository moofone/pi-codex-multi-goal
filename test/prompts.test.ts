import assert from "node:assert/strict";
import test from "node:test";

import { formatGoalWrapper, otherStageTitles } from "../src/prompts.ts";
import { completeCurrentStage, createGoal } from "../src/state.ts";

test("wrapper contains only the current stage title", () => {
  const goal = createGoal(["pin duplicate", "write red test", "fix miner"], 1);
  const advanced = completeCurrentStage(goal, 2).goal!;
  const wrapper = formatGoalWrapper(advanced);
  assert.match(wrapper, /<objective>\nwrite red test\n<\/objective>/);
  assert.match(wrapper, /<stage>2\/3<\/stage>/);
  assert.equal(wrapper.includes("pin duplicate"), false);
  assert.equal(wrapper.includes("fix miner"), false);
  assert.deepEqual(otherStageTitles(advanced), ["pin duplicate", "fix miner"]);
});
