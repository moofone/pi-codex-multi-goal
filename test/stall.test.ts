import assert from "node:assert/strict";
import test from "node:test";

import {
  allowanceExhaustion,
  applyResumeGrant,
  chargeContext,
  chargeRequest,
} from "../src/allowance.ts";
import { createGoal } from "../src/state.ts";
import { parseSettings } from "../src/settings.ts";

test("0 and null are not unlimited", () => {
  const path = "/tmp/pi-codex-multi-goal.json";
  const defaults = { noProgressLimit: 20, totalLimit: 400 };
  const finite = (raw: unknown) => {
    const settings = parseSettings(raw, path);
    return { noProgressLimit: settings.noProgressLimit, totalLimit: settings.totalLimit };
  };

  assert.deepEqual(finite(undefined), defaults, "missing settings fall back to finite defaults");
  assert.deepEqual(finite({}), defaults);
  assert.deepEqual(finite({ noProgressLimit: 0 }), defaults, "0 must clamp to the finite default");
  assert.deepEqual(finite({ noProgressLimit: null }), defaults, "null must clamp to the finite default");
  assert.deepEqual(finite({ totalLimit: 0 }), defaults, "0 must clamp to the finite default");
  assert.deepEqual(finite({ totalLimit: null }), defaults, "null must clamp to the finite default");
  assert.deepEqual(finite({ noProgressLimit: 1.5 }), defaults, "only integers are limits");
  assert.deepEqual(finite({ noProgressLimit: -2 }), defaults, "only positive integers are limits");
  assert.deepEqual(finite({ totalLimit: "200" }), defaults, "only numbers are limits");
  assert.deepEqual(
    finite({ maxCompactionsWithoutMutation: 0 }),
    defaults,
    "the retired unlimited legacy key clamps to the finite defaults",
  );
  assert.deepEqual(
    finite({ maxCompactionsWithoutMutation: null }),
    defaults,
    "the retired disable legacy key clamps to the finite defaults",
  );
  assert.deepEqual(
    finite({ maxCompactionsWithoutMutation: 7 }),
    { noProgressLimit: 7, totalLimit: 400 },
    "the legacy compaction key migrates onto the no-progress limit",
  );
  assert.deepEqual(
    finite({ noProgressLimit: 4, totalLimit: 6 }),
    { noProgressLimit: 4, totalLimit: 6 },
    "explicit finite limits are honored",
  );
});

test("request charges spend total only, context charges spend no-progress only", () => {
  const goal = createGoal(["step"], 1);
  goal.execution = { ...goal.execution, noProgressRemaining: 3, totalRemaining: 3 };

  assert.equal(allowanceExhaustion(goal.execution), null);
  let execution = goal.execution;
  for (let i = 2; i >= 0; i -= 1) {
    const outcome = chargeRequest(execution);
    if (outcome.type === "unchanged") {
      assert.fail("a charge within the allowance must charge");
    }
    execution = outcome.execution;
    assert.equal(execution.noProgressRemaining, 3, "provider requests must not spend no-progress");
    assert.equal(execution.totalRemaining, i);
    assert.equal(execution.lifetimeRequests, 3 - i);
  }
  assert.equal(allowanceExhaustion(execution), "total");

  // At 0 the charge refuses and records nothing: no negative counters, no
  // lifetime inflation for requests this extension cannot deny.
  const refused = chargeRequest(execution);
  assert.equal(refused.type, "unchanged");
  assert.equal(allowanceExhaustion(execution), "total");
  assert.equal(execution.noProgressRemaining, 3);
  assert.equal(execution.totalRemaining, 0);
  assert.equal(execution.lifetimeRequests, 3);
});

test("full-context charges spend no-progress only, and never refund", () => {
  const goal = createGoal(["step"], 1);
  goal.execution = { ...goal.execution, noProgressRemaining: 3, totalRemaining: 10 };

  let execution = goal.execution;
  for (let i = 2; i >= 0; i -= 1) {
    const outcome = chargeContext(execution);
    if (outcome.type === "unchanged") {
      assert.fail("a charge within the allowance must charge");
    }
    execution = outcome.execution;
    assert.equal(execution.noProgressRemaining, i);
    assert.equal(execution.totalRemaining, 10, "full contexts must not spend the total request budget");
    assert.equal(execution.lifetimeRequests, 0, "full contexts are not provider requests");
  }
  assert.equal(allowanceExhaustion(execution), "no-progress");

  const refused = chargeContext(execution);
  assert.equal(refused.type, "unchanged");
  assert.equal(execution.noProgressRemaining, 0);
  assert.equal(execution.totalRemaining, 10);
  assert.equal(execution.lifetimeRequests, 0);
});

test("user resume grants a bounded no-progress allowance only", () => {
  const goal = createGoal(["step"], 1);
  goal.execution = {
    ...goal.execution,
    noProgressRemaining: 0,
    totalRemaining: 5,
    lifetimeRequests: 195,
  };
  const resumed = applyResumeGrant(goal);
  assert.equal(resumed.execution.noProgressRemaining, resumed.execution.noProgressLimit);
  assert.equal(resumed.execution.totalRemaining, 5, "the total budget is never replenished");
  assert.equal(resumed.execution.lifetimeRequests, 195, "lifetime totals never reset");
  assert.equal(allowanceExhaustion(resumed.execution), null);
});
