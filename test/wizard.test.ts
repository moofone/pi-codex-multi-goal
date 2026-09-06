import assert from "node:assert/strict";
import test from "node:test";

import { formatStagePreview, parseStepCount } from "../src/parse.ts";
import { collectMultiGoalTitles } from "../src/wizard.ts";

test("parseStepCount accepts 2–24 only", () => {
  assert.deepEqual(parseStepCount("3"), { ok: true, count: 3 });
  assert.equal(parseStepCount("1").ok, false);
  assert.equal(parseStepCount("25").ok, false);
  assert.equal(parseStepCount("two").ok, false);
  assert.equal(parseStepCount("3.5").ok, false);
});

test("formatStagePreview numbers titles", () => {
  assert.equal(formatStagePreview(["pin", "test"]), "1. pin\n2. test");
});

test("wizard collects titles then accepts", async () => {
  const inputs = ["3", "pin duplicate", "write red test", "fix miner"];
  const ui = {
    async input() {
      return inputs.shift() ?? "";
    },
    async confirm(_title: string, message: string) {
      assert.match(message, /1\. pin duplicate/);
      assert.match(message, /3\. fix miner/);
      return true;
    },
    notify() {},
  };
  const result = await collectMultiGoalTitles(ui, { hasUI: true });
  assert.deepEqual(result, {
    ok: true,
    titles: ["pin duplicate", "write red test", "fix miner"],
  });
});

test("wizard reject and cancel", async () => {
  const titles = ["2", "one", "two"];
  const rejected = await collectMultiGoalTitles(
    {
      async input() {
        return titles.shift() ?? "";
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
    { hasUI: true },
  );
  assert.deepEqual(rejected, { ok: false, message: "Multi-goal rejected." });

  const cancelled = await collectMultiGoalTitles(
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
  assert.deepEqual(cancelled, { ok: false, message: "Multi-goal cancelled." });

  const noUi = await collectMultiGoalTitles(
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
