import assert from "node:assert/strict";
import test from "node:test";

import {
  allowanceExhaustion,
  allowancePauseReason,
  applyResumeGrant,
  chargeRequest,
  creditVerifiedEvidence,
} from "../src/allowance.ts";
import { formatFooterStatus } from "../src/prompts.ts";
import { cloneGoal, createGoal, freshExecution, reconstructGoal } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";
import type { GoalExecution, MultiGoal } from "../src/types.ts";

/**
 * G06 — the total-request budget is a runaway-loop backstop, not a progress
 * measure (PI_DAG_COMPACT D4, R5 fixture G06).
 *
 * A live goal did roughly forty minutes of productive work, never compacted
 * much (no-progress still 4/5), and died at `lifetimeRequests: 200`. The old
 * shape was one always-incrementing per-step counter that nothing renewed:
 * not edits, not verified evidence, not `/goal resume`. These fixtures pin the
 * replacement:
 *
 * - a per-agent-turn request bound catches the loop the old total was added for
 * - a working total that novel verified evidence renews by a capped grant
 *   covers legitimately long steps
 * - a hard lifetime ceiling remains the unrenewable safety limit
 *
 * The unit under test is the persisted grant itself, which is where the policy
 * lives. Turn boundaries are not needed by these fixtures: novel verified
 * evidence is what relieves the per-turn bound, so a productive session never
 * depends on where the host happened to end a turn.
 */

/** Charge one goal-owned provider request, asserting it was admitted. */
function admit(execution: GoalExecution, label: string): GoalExecution {
  const outcome = chargeRequest(execution);
  assert.notEqual(
    outcome.type,
    "unchanged",
    `${label}: the request was refused with ${outcome.type === "unchanged" ? outcome.exhaustion : ""}`,
  );
  assert.ok(outcome.type !== "unchanged");
  return outcome.execution;
}

/** Apply one novel verified-evidence credit to a goal's execution. */
function credit(execution: GoalExecution, key: string): GoalExecution {
  const goal = cloneGoal(createGoal(["long step"], 1));
  goal.execution = execution;
  const outcome = creditVerifiedEvidence(goal, [key]);
  assert.deepEqual(outcome.creditedKeys, [key], `evidence ${key} must be novel`);
  return outcome.goal.execution;
}

/**
 * Ten rounds of a productive step: 25 goal-owned requests of real work plus
 * `maintenancePerRound` DAG maintenance requests, then one novel verified
 * result. No compaction at all, so the no-progress allowance is never touched.
 */
function productiveStep(maintenancePerRound: number): {
  execution: GoalExecution;
  lowestTotal: number;
} {
  let execution = freshExecution();
  let lowestTotal = execution.totalLimit;
  for (let round = 0; round < 10; round += 1) {
    for (let request = 0; request < 25; request += 1) {
      execution = admit(execution, `round ${round} request ${request}`);
      lowestTotal = Math.min(lowestTotal, execution.totalRemaining);
    }
    for (let call = 0; call < maintenancePerRound; call += 1) {
      execution = admit(execution, `round ${round} maintenance ${call}`);
      lowestTotal = Math.min(lowestTotal, execution.totalRemaining);
    }
    execution = credit(execution, `sha256:round-${round}`);
  }
  return { execution, lowestTotal };
}

test("G06: a productive 250-request step is not killed by the total budget", () => {
  const { execution, lowestTotal } = productiveStep(0);

  assert.equal(execution.lifetimeRequests, 250);
  assert.equal(
    allowanceExhaustion(execution),
    null,
    "250 requests of evidenced work must not exhaust any budget",
  );
  assert.equal(
    execution.noProgressRemaining,
    execution.noProgressLimit,
    "no compaction happened, so no-progress must be untouched",
  );
  assert.ok(
    lowestTotal > 0,
    "the working total must never reach zero while verified evidence keeps arriving",
  );

  // Enabling DAG maintenance calls must not shorten the productive session:
  // the same ten rounds of work still complete with five maintenance requests
  // charged in each of them.
  const withDag = productiveStep(5);
  assert.equal(withDag.execution.lifetimeRequests, 300);
  assert.equal(
    allowanceExhaustion(withDag.execution),
    null,
    "DAG maintenance calls must not shorten the productive session",
  );
});

test("G06: a runaway tool loop inside one agent turn is stopped by the turn bound", () => {
  let execution = freshExecution();
  const turnLimit = execution.turnLimit;
  assert.ok(
    Number.isInteger(turnLimit) && turnLimit > 0 && turnLimit < execution.totalLimit,
    "the per-turn loop bound must be a finite budget smaller than the working total",
  );

  // Sixty tool calls inside one agent turn, no verified evidence, no
  // compaction: exactly the shape the old 200-request counter was added for.
  let admitted = 0;
  let refusal: string | null = null;
  for (let call = 0; call < 60; call += 1) {
    const outcome = chargeRequest(execution);
    if (outcome.type === "unchanged") {
      refusal = outcome.exhaustion;
      break;
    }
    execution = outcome.execution;
    admitted += 1;
    if (outcome.type === "charged-exhausted") {
      refusal = outcome.exhaustion;
      break;
    }
  }

  assert.equal(admitted, turnLimit, "the loop must stop at the per-turn bound");
  assert.equal(refusal, "turn-loop", "and it must stop for the loop reason, not the step total");
  assert.ok(
    execution.totalRemaining > 0,
    "a stopped loop has not spent the step's working total",
  );
  assert.match(
    allowancePauseReason(execution, "turn-loop"),
    /turn/i,
    "the pause reason must name the agent turn, not the step budget",
  );

  // Novel verified evidence is what distinguishes real work from a loop, so it
  // clears the turn bound; a loop that produces nothing stays stopped.
  const relieved = credit(execution, "sha256:a-real-result");
  assert.equal(
    allowanceExhaustion(relieved),
    null,
    "verified evidence must relieve the per-turn bound",
  );
});

test("G06: the hard lifetime ceiling stops an endlessly evidenced step", () => {
  let execution = freshExecution();
  const ceiling = execution.lifetimeCeiling;
  assert.ok(
    Number.isInteger(ceiling) && ceiling > execution.totalLimit,
    "the lifetime ceiling must be a finite limit above the renewable working total",
  );

  // Twenty-five requests then one novel verified result, forever. Nothing here
  // is a loop and nothing is unproductive, so only the ceiling can stop it.
  let admitted = 0;
  let refusal: string | null = null;
  for (let round = 0; round < ceiling; round += 1) {
    let stop = false;
    for (let request = 0; request < 25; request += 1) {
      const outcome = chargeRequest(execution);
      if (outcome.type === "unchanged") {
        refusal = outcome.exhaustion;
        stop = true;
        break;
      }
      execution = outcome.execution;
      admitted += 1;
      if (outcome.type === "charged-exhausted") {
        refusal = outcome.exhaustion;
        stop = true;
        break;
      }
    }
    if (stop) {
      break;
    }
    execution = credit(execution, `sha256:endless-${round}`);
  }

  assert.equal(admitted, ceiling, "every admitted request counts against the ceiling");
  assert.equal(execution.lifetimeRequests, ceiling);
  assert.equal(refusal, "lifetime", "the ceiling is the reason, and it is unrenewable");

  // Nothing renews it: not evidence, not a user resume.
  const evidenced = credit(execution, "sha256:one-more-real-result");
  assert.equal(allowanceExhaustion(evidenced), "lifetime");
  const goal = cloneGoal(createGoal(["long step"], 1));
  goal.execution = evidenced;
  assert.equal(allowanceExhaustion(applyResumeGrant(goal).execution), "lifetime");
});

test("G06: a reload preserves the turn, working, and lifetime counters", () => {
  let execution = freshExecution();
  for (let call = 0; call < 7; call += 1) {
    execution = admit(execution, `pre-reload request ${call}`);
  }
  const goal: MultiGoal = cloneGoal(createGoal(["long step"], 1));
  goal.execution = execution;

  const reloaded = reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal, at: 1 },
    },
  ]);

  assert.ok(reloaded, "the snapshot must round-trip");
  assert.equal(reloaded.execution.turnRequests, 7, "partial turn consumption survives a reload");
  assert.equal(reloaded.execution.lifetimeRequests, 7);
  assert.equal(reloaded.execution.totalRemaining, execution.totalRemaining);
  assert.equal(reloaded.execution.turnLimit, execution.turnLimit);
  assert.equal(reloaded.execution.lifetimeCeiling, execution.lifetimeCeiling);
  assert.equal(reloaded.execution.evidenceGrant, execution.evidenceGrant);
});

test("G06: a snapshot written before the fuse existed loads with the new limits", () => {
  // Materialising the new fields on load is what keeps an in-flight goal from
  // being skipped as malformed after an upgrade.
  const goal = cloneGoal(createGoal(["long step"], 1));
  const legacy = { ...goal, execution: { ...goal.execution } } as {
    execution: Record<string, unknown>;
  };
  legacy.execution.totalRemaining = 195;
  legacy.execution.totalLimit = 200;
  legacy.execution.lifetimeRequests = 5;
  delete legacy.execution.turnRequests;
  delete legacy.execution.turnLimit;
  delete legacy.execution.evidenceGrant;
  delete legacy.execution.lifetimeCeiling;

  const reloaded = reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: legacy, at: 1 },
    },
  ]);

  assert.ok(reloaded, "an older snapshot must still restore, not be skipped as malformed");
  assert.equal(reloaded.execution.totalRemaining, 195, "its spent working total is preserved");
  assert.equal(reloaded.execution.lifetimeRequests, 5);
  assert.equal(reloaded.execution.turnRequests, 0);
  assert.ok(reloaded.execution.turnLimit > 0, "the loop bound is materialised on load");
  assert.ok(reloaded.execution.lifetimeCeiling > 0, "the ceiling is materialised on load");
  assert.equal(allowanceExhaustion(reloaded.execution), null);
});

test("G06: /goal resume renews the no-progress allowance only", () => {
  let execution = freshExecution();
  for (let call = 0; call < 30; call += 1) {
    execution = admit(execution, `request ${call}`);
    if (call === 20) {
      execution = credit(execution, "sha256:mid-run");
    }
  }
  execution = { ...execution, noProgressRemaining: 0 };
  const goal = cloneGoal(createGoal(["long step"], 1));
  goal.execution = execution;

  const resumed = applyResumeGrant(goal).execution;

  assert.equal(resumed.noProgressRemaining, resumed.noProgressLimit);
  assert.equal(resumed.totalRemaining, execution.totalRemaining, "resume never refills the total");
  assert.equal(
    resumed.lifetimeRequests,
    execution.lifetimeRequests,
    "resume never refunds lifetime requests",
  );
  assert.equal(resumed.turnRequests, 0, "a resume begins a new agent turn");
});

test("G06: the footer warns once a budget passes 80 percent", () => {
  const goal = cloneGoal(createGoal(["long step"], 1));
  assert.equal(
    formatFooterStatus(goal),
    "Pursuing 1/1",
    "an unpressured goal shows no budget noise",
  );

  const ceiling = goal.execution.lifetimeCeiling;
  const pressured = cloneGoal(goal);
  pressured.execution = {
    ...pressured.execution,
    lifetimeRequests: Math.ceil(ceiling * 0.8),
  };
  const status = formatFooterStatus(pressured) ?? "";
  assert.match(status, /Pursuing 1\/1/, "the stage label stays");
  assert.match(status, /8[0-9]%|9[0-9]%|100%/, "the consumed fraction is shown");
  assert.match(status, /lifetime/i, "and it names which budget is under pressure");

  const justBelow = cloneGoal(goal);
  justBelow.execution = {
    ...justBelow.execution,
    lifetimeRequests: Math.floor(ceiling * 0.79),
  };
  assert.equal(formatFooterStatus(justBelow), "Pursuing 1/1", "79 percent is not yet a warning");
});
