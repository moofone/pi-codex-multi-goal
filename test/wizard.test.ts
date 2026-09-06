import assert from "node:assert/strict";
import test from "node:test";

import { formatStepsPreview, parseStepCount } from "../src/parse.ts";
import { collectMultiGoalSteps } from "../src/wizard.ts";

test("parseStepCount accepts 2–24 only", () => {
  assert.deepEqual(parseStepCount("3"), { ok: true, count: 3 });
  assert.equal(parseStepCount("1").ok, false);
  assert.equal(parseStepCount("25").ok, false);
  assert.equal(parseStepCount("two").ok, false);
  assert.equal(parseStepCount("3.5").ok, false);
});

test("formatStepsPreview numbers steps and lists criteria", () => {
  assert.equal(
    formatStepsPreview([
      { objective: "pin", criteria: ["no dupes"] },
      { objective: "test", criteria: ["red first", "green after"] },
    ]),
    "1. pin\n   Criteria:\n   - no dupes\n2. test\n   Criteria:\n   - red first\n   - green after",
  );
});

test("multi-goal collects per-step criteria then confirms", async () => {
  const inputs = [
    "2",
    "pin duplicate",
    "no duplicate pins",
    "diff reviewed",
    "",
    "write red test",
    "failing test exists",
    "",
  ];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const ui = {
    async input() {
      return inputs.shift() ?? "";
    },
    async confirm(title: string, message: string) {
      confirmCalls.push({ title, message });
      return true;
    },
    notify() {},
  };
  const result = await collectMultiGoalSteps(ui, { hasUI: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.steps.map((step) => step.objective), ["pin duplicate", "write red test"]);
  assert.deepEqual(result.steps[0]!.criteria, ["no duplicate pins", "diff reviewed"]);
  assert.deepEqual(result.steps[1]!.criteria, ["failing test exists"]);
  // Exactly one sequence confirm, showing the full contract.
  assert.equal(confirmCalls.length, 1);
  assert.match(confirmCalls[0]!.title, /multi-goal/i);
  assert.match(confirmCalls[0]!.message, /1\. pin duplicate/);
  assert.match(confirmCalls[0]!.message, /no duplicate pins/);
  assert.match(confirmCalls[0]!.message, /2\. write red test/);
});

test("wizard rejects title-only start", async () => {
  // A blank criteria entry is warned about and re-prompted; it is never
  // accepted as a criteria-less step. Cancelling leaves nothing started.
  const inputs: Array<string | undefined> = ["2", "pin duplicate", "", undefined];
  const warnings: string[] = [];
  const ui = {
    async input() {
      return inputs.shift();
    },
    async confirm() {
      return true;
    },
    notify(message: string, level?: string) {
      if (level === "warning") warnings.push(message);
    },
  };
  const result = await collectMultiGoalSteps(ui, { hasUI: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /cancelled/i);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /criterion/i);
});

test("wizard reject and cancel", async () => {
  // Full contract collected, then the sequence confirm is declined.
  const queue = ["2", "one", "c1", "", "two", "c2", ""];
  const rejected = await collectMultiGoalSteps(
    {
      async input() {
        return queue.shift() ?? "";
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
    { hasUI: true },
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.message, "Multi-goal rejected.");

  const cancelled = await collectMultiGoalSteps(
    {
      async input() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
    { hasUI: true },
  );
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.message, "Multi-goal cancelled.");

  const noUi = await collectMultiGoalSteps(
    {
      async input() {
        return "2";
      },
      async confirm() {
        return true;
      },
      notify() {},
    },
    { hasUI: false },
  );
  assert.equal(noUi.ok, false);
});
