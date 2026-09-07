import assert from "node:assert/strict";
import test from "node:test";

import { parseSettings } from "../src/settings.ts";
import { cloneGoal, isMultiGoal, reconstructGoal, replaceGoalFromSteps, setEntry } from "../src/state.ts";
import {
  CUSTOM_ENTRY_TYPE,
  DEFAULT_LIFETIME_CEILING,
  DEFAULT_TURN_LIMIT,
  type GoalExecution,
  type MultiGoal,
} from "../src/types.ts";

/**
 * B19 (review finding, P1, src/state.ts): the execution validator checked each
 * counter in isolation — `>= 0` for counters, `> 0` for limits — and never
 * checked a counter against the limit that is supposed to bound it. A persisted
 * or forged snapshot could assert `totalRemaining: 999999` and the whole D4
 * fuse evaporates.
 *
 * This is the same defect the backend validator had: fields checked for SHAPE,
 * never for consistency with what they claim. Same treatment — the four fuses
 * only mean anything in relation to each other.
 *
 * The threat model is deliberately "a snapshot must respect the limits IT
 * declares", not "limits must match current settings": the limits in a snapshot
 * are the ones that were in force when the grant was issued, and changing
 * settings must not retroactively rewrite a running goal's budget.
 */

function goalWith(execution: Partial<GoalExecution>): MultiGoal {
  const result = replaceGoalFromSteps([{ objective: "ship it", criteria: ["the test passes"] }]);
  assert.ok(result.ok && result.goal, result.message);
  const goal = cloneGoal(result.goal);
  goal.execution = { ...goal.execution, ...execution } as GoalExecution;
  return goal;
}

/** Strip the fields the D4 split added, as a pre-D4 snapshot would have them. */
function preD4(goal: MultiGoal): unknown {
  const raw = JSON.parse(JSON.stringify(goal)) as any;
  delete raw.execution.turnRequests;
  delete raw.execution.turnLimit;
  delete raw.execution.evidenceGrant;
  delete raw.execution.lifetimeCeiling;
  return raw;
}

function reloadRaw(raw: unknown): MultiGoal | null {
  return reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: raw, at: 1 },
    },
  ]);
}

test("B19: a counter that exceeds the limit bounding it is malformed", () => {
  const cases: Array<[string, Partial<GoalExecution>]> = [
    ["totalRemaining above totalLimit", { totalRemaining: 999_999 }],
    ["totalRemaining one above totalLimit", { totalLimit: 400, totalRemaining: 401 }],
    ["noProgressRemaining above noProgressLimit", { noProgressLimit: 20, noProgressRemaining: 21 }],
    ["turnRequests above turnLimit", { turnLimit: 40, turnRequests: 41 }],
    ["lifetimeRequests above lifetimeCeiling", { lifetimeCeiling: 1000, lifetimeRequests: 1001 }],
  ];

  for (const [label, execution] of cases) {
    assert.equal(isMultiGoal(goalWith(execution)), false, `must be rejected: ${label}`);
  }
});

test("B19: limits whose ordering makes the fuses meaningless are malformed", () => {
  // chargeRequest spends the working total on every turn request, so a turn
  // bound above the working total can never fire — the loop backstop would be
  // dead. Likewise nothing renews lifetimeRequests, so a working total above
  // the ceiling means the ceiling always fires first and the total is noise.
  // allowanceExhaustion checks lifetime, then total, then turn, and that
  // hardest-first ordering only means something if ceiling >= total >= turn.
  assert.equal(
    isMultiGoal(goalWith({ totalLimit: 400, turnLimit: 500 })),
    false,
    "a turn bound above the working total can never fire",
  );
  assert.equal(
    isMultiGoal(goalWith({ totalLimit: 2000, lifetimeCeiling: 1000, totalRemaining: 100 })),
    false,
    "a working total above the lifetime ceiling is unreachable",
  );

  // The evidence grant is deliberately NOT bounded by the working total:
  // creditVerifiedEvidence clamps the renewal at totalLimit, so an oversized
  // grant is a full refill, not an unbounded one.
  assert.equal(
    isMultiGoal(goalWith({ totalLimit: 400, evidenceGrant: 10_000 })),
    true,
    "an oversized evidence grant is clamped at the point of use, not a forgery",
  );
});

test("B19: an ordinary spent grant is still valid", () => {
  // Regression preservation: every consistent state the accounting produces.
  const spent = goalWith({
    noProgressRemaining: 3,
    totalRemaining: 17,
    turnRequests: 9,
    lifetimeRequests: 383,
  });
  assert.equal(isMultiGoal(spent), true, "a partly spent grant is not a forgery");

  const exhausted = goalWith({
    noProgressRemaining: 0,
    totalRemaining: 0,
    turnRequests: 40,
    lifetimeRequests: 1000,
  });
  assert.equal(isMultiGoal(exhausted), true, "and neither is a fully spent one");

  const fresh = goalWith({});
  assert.equal(isMultiGoal(fresh), true, "sanity: a fresh grant validates");
});

test("B19: a forged grant is skipped, keeping the last valid snapshot", () => {
  const honest = goalWith({ totalRemaining: 17, lifetimeRequests: 383 });
  const forged = JSON.parse(JSON.stringify(honest));
  forged.execution.totalRemaining = 999_999;
  forged.execution.lifetimeRequests = 0;

  const reloaded = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(honest, "runtime") },
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: forged, at: 2 },
    },
  ]);

  assert.ok(reloaded, "the last valid snapshot is kept");
  assert.equal(reloaded.execution.totalRemaining, 17, "the forged budget was skipped, not adopted");
  assert.equal(reloaded.execution.lifetimeRequests, 383, "and neither was its erased history");
});

test("B19: a pre-D4 snapshot still migrates, and migrates into a consistent grant", () => {
  // normalizeExecution materialises the limits the D4 split added. The new
  // bounds must not break that: an older snapshot's spent budgets are preserved
  // and the defaults it gains must satisfy the ordering it is now held to.
  const old = preD4(goalWith({ noProgressRemaining: 4, totalRemaining: 11, lifetimeRequests: 150 }));
  const reloaded = reloadRaw(old);

  assert.ok(reloaded, "an older snapshot must restore, not be skipped as malformed");
  assert.equal(reloaded.execution.totalRemaining, 11, "its spent budget is preserved exactly");
  assert.equal(reloaded.execution.lifetimeRequests, 150);
  assert.equal(reloaded.execution.turnLimit, DEFAULT_TURN_LIMIT);
  assert.equal(reloaded.execution.lifetimeCeiling, DEFAULT_LIFETIME_CEILING);
  assert.equal(isMultiGoal(reloaded), true, "and what it migrated into is itself valid");
});

test("B19: a pre-D4 snapshot with a large working total still migrates", () => {
  // The trap: defaulting lifetimeCeiling to 1000 under a totalLimit of 5000
  // would make the migrated grant violate its own ordering, and the goal would
  // be skipped as malformed on the next load. The materialised defaults have to
  // be consistent with what the snapshot already declares.
  const old = preD4(goalWith({ totalLimit: 5000, totalRemaining: 4200, lifetimeRequests: 800 }));
  const reloaded = reloadRaw(old);

  assert.ok(reloaded, "a large but legitimate working total must not be rejected on migration");
  assert.equal(reloaded.execution.totalLimit, 5000, "its configured limit is preserved");
  assert.equal(reloaded.execution.totalRemaining, 4200);
  assert.ok(
    reloaded.execution.lifetimeCeiling >= reloaded.execution.totalLimit,
    "the ceiling it gains is at least its working total",
  );
  assert.ok(
    reloaded.execution.turnLimit <= reloaded.execution.totalLimit,
    "and the turn bound it gains is at most its working total",
  );
  assert.equal(isMultiGoal(reloaded), true, "so the migrated grant is valid");
});

test("B19: a pre-D4 snapshot with a tiny working total still migrates", () => {
  // The mirror trap: a default turn bound of 40 under a totalLimit of 5 would
  // be a turn bound that can never fire.
  const old = preD4(goalWith({ totalLimit: 5, totalRemaining: 2, noProgressLimit: 2, noProgressRemaining: 1 }));
  const reloaded = reloadRaw(old);

  assert.ok(reloaded, "a small configured budget must not be rejected on migration");
  assert.ok(
    reloaded.execution.turnLimit <= reloaded.execution.totalLimit,
    "the turn bound it gains is at most its working total",
  );
  assert.equal(isMultiGoal(reloaded), true);
});

test("B19: a misconfigured settings file cannot mint an unloadable goal", () => {
  // The limits come from ~/.pi/agent/pi-codex-multi-goal.json, so a user could
  // configure a turn bound above the working total. A goal created from that
  // would be rejected as malformed on its next load — the settings boundary
  // clamps instead, so a misconfiguration is inert rather than fatal.
  const settings = parseSettings(
    { totalLimit: 400, turnLimit: 5000, lifetimeCeiling: 50 },
    "/tmp/settings.json",
  );

  assert.equal(settings.totalLimit, 400, "the configured working total is honoured");
  assert.ok(settings.turnLimit <= settings.totalLimit, "the turn bound is clamped to it");
  assert.ok(settings.lifetimeCeiling >= settings.totalLimit, "and the ceiling is raised to it");

  const goal = goalWith({
    totalLimit: settings.totalLimit,
    totalRemaining: settings.totalLimit,
    turnLimit: settings.turnLimit,
    lifetimeCeiling: settings.lifetimeCeiling,
    evidenceGrant: settings.evidenceGrant,
  });
  assert.equal(isMultiGoal(goal), true, "a goal built from clamped settings loads");
});
