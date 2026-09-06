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

test("wrapper includes current criteria and memory only", () => {
  const goal = createGoal(["pin duplicate", "write red test", "fix miner"], 1);
  const advanced = completeCurrentStage(goal, 2).goal!;
  advanced.stages[1]!.criteria = [
    { id: "c-current-1", text: "duplicate pinned in the lockfile" },
    { id: "c-current-2", text: "release manager signs off", requiresHumanDecision: true },
  ];
  // The previous record, then the current one after a replace: the snapshot
  // must render exactly one memory record — the current one.
  advanced.memory = {
    revision: 1,
    proved: ["old proved note"],
    unresolved: ["old unresolved question"],
    next: "old next action",
  };
  advanced.memory = {
    revision: 2,
    proved: ["proved: lockfile pinned (artifact: package-lock.json)"],
    unresolved: ["unresolved: sign-off pending"],
    next: "rerun the install check",
  };
  const wrapper = formatGoalWrapper(advanced);

  // Current objective, criteria, memory, and position k/n.
  assert.match(wrapper, /<objective>\nwrite red test\n<\/objective>/);
  assert.match(wrapper, /<stage>2\/3<\/stage>/);
  assert.match(wrapper, /<criteria>/);
  assert.match(wrapper, /- duplicate pinned in the lockfile/);
  assert.match(wrapper, /- release manager signs off \(needs human decision\)/);
  assert.match(wrapper, /revision="2"/);
  assert.match(wrapper, /<proved>\n- proved: lockfile pinned \(artifact: package-lock\.json\)\n<\/proved>/);
  assert.match(wrapper, /<unresolved>\n- unresolved: sign-off pending\n<\/unresolved>/);
  assert.match(wrapper, /<next>\nrerun the install check\n<\/next>/);

  // No other step titles, and no stale memory content.
  assert.equal(wrapper.includes("pin duplicate"), false);
  assert.equal(wrapper.includes("fix miner"), false);
  assert.equal(wrapper.includes("old proved note"), false);
  assert.equal(wrapper.includes("old unresolved question"), false);
  assert.equal(wrapper.includes("old next action"), false);
});
