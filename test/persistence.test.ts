import assert from "node:assert/strict";
import test from "node:test";

import { createPersistence } from "../src/persistence.ts";
import { completeCurrentStage, createGoal } from "../src/state.ts";
import { DEFAULT_NO_PROGRESS_LIMIT, DEFAULT_TOTAL_LIMIT } from "../src/types.ts";

interface RecordedEntry {
  customType: string;
  data?: unknown;
}

test("flush appends version-2 snapshot with memory and accounting fields", () => {
  const appended: RecordedEntry[] = [];
  const persistence = createPersistence({
    pi: {
      appendEntry: (customType: string, data?: unknown) => {
        appended.push({ customType, data });
      },
    },
  });

  const goal = createGoal(["one", "two"], 1);
  persistence.setGoalSnapshot(goal);
  assert.equal(persistence.flush("command"), true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.customType, "pi-codex-multi-goal");

  const data = appended[0]?.data as {
    version: number;
    kind: string;
    goal: {
      memory: unknown;
      pauseReason: unknown;
      execution: {
        noProgressRemaining: number;
        totalRemaining: number;
        noProgressLimit: number;
        totalLimit: number;
        lifetimeRequests: number;
        tokenUsage: number | null;
      };
    };
  };
  assert.equal(data.version, 2);
  assert.equal(data.kind, "set");
  assert.ok(data.goal.memory);
  assert.equal(data.goal.pauseReason, null);
  assert.equal(data.goal.execution.noProgressRemaining, DEFAULT_NO_PROGRESS_LIMIT);
  assert.equal(data.goal.execution.totalRemaining, DEFAULT_TOTAL_LIMIT);
  assert.equal(data.goal.execution.noProgressLimit, DEFAULT_NO_PROGRESS_LIMIT);
  assert.equal(data.goal.execution.totalLimit, DEFAULT_TOTAL_LIMIT);
  assert.equal(data.goal.execution.lifetimeRequests, 0);
  assert.equal(data.goal.execution.tokenUsage, null);
});

test("failed append keeps last committed snapshot", () => {
  let failAppend = false;
  let appendCalls = 0;
  const persistence = createPersistence({
    pi: {
      appendEntry: () => {
        appendCalls += 1;
        if (failAppend) {
          throw new Error("append failed");
        }
      },
    },
  });

  const first = createGoal(["step one"], 1);
  persistence.setGoalSnapshot(first);
  assert.equal(persistence.flush("command"), true);
  assert.equal(appendCalls, 1);
  const committed = structuredClone(persistence.getGoal());

  // Uncommitted next snapshot; the append now throws.
  failAppend = true;
  const second = completeCurrentStage(first, 2).goal;
  assert.ok(second);
  persistence.setGoalSnapshot(second);
  assert.equal(persistence.flush("runtime"), false);
  assert.equal(appendCalls, 2);
  assert.deepEqual(persistence.getGoal(), committed);

  // Retained state is not re-persisted and not forgotten.
  assert.equal(persistence.flush("runtime"), false);
  assert.equal(appendCalls, 2);
  assert.deepEqual(persistence.getGoal(), committed);
});
