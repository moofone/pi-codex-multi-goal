import { cloneGoal } from "./state.js";
import type { GoalExecution, MultiGoal } from "./types.js";

/**
 * Persisted request accounting. The allowance is finite and durable: it lives
 * in the goal snapshot (goal.execution) and is charged once per goal-owned
 * provider request at before_provider_request time. There is no unlimited
 * mode, and nothing refunds it — reloads and retries re-read the persisted
 * numbers. Verified mid-step progress credit (Task 8) may later reset ONLY the
 * no-progress streak; nothing in this module resets anything on memory text,
 * tool success, or edit/write/apply_patch tool names.
 */

export type AllowanceExhaustion = "no-progress" | "total";

/**
 * The finite admission gates. The total budget is checked first: once the
 * step's lifetime request budget is spent, no bounded no-progress re-grant can
 * re-admit goal work.
 */
export function allowanceExhaustion(execution: GoalExecution): AllowanceExhaustion | null {
  if (execution.totalRemaining <= 0) {
    return "total";
  }
  if (execution.noProgressRemaining <= 0) {
    return "no-progress";
  }
  return null;
}

export type ChargeOutcome =
  | { type: "unchanged"; exhaustion: AllowanceExhaustion }
  | { type: "charged"; execution: GoalExecution }
  | { type: "charged-exhausted"; execution: GoalExecution; exhaustion: AllowanceExhaustion };

/**
 * Charge exactly one goal-owned provider request. One call per provider
 * request, at provider entry, never below zero, never refunding: a refused
 * charge (allowance already at 0) records nothing, so lifetime totals only
 * ever count admitted requests.
 */
export function chargeRequest(execution: GoalExecution): ChargeOutcome {
  const before = allowanceExhaustion(execution);
  if (before) {
    return { type: "unchanged", exhaustion: before };
  }
  const next: GoalExecution = {
    ...execution,
    noProgressRemaining: Math.max(0, execution.noProgressRemaining - 1),
    totalRemaining: Math.max(0, execution.totalRemaining - 1),
    lifetimeRequests: execution.lifetimeRequests + 1,
  };
  const after = allowanceExhaustion(next);
  if (after) {
    return { type: "charged-exhausted", execution: next, exhaustion: after };
  }
  return { type: "charged", execution: next };
}

/**
 * An explicit user resume grants a fresh bounded no-progress allowance. The
 * total budget and the lifetime totals are never replenished here; a new step
 * starts its own grant later (Task 8).
 */
export function applyResumeGrant(goal: MultiGoal): MultiGoal {
  const next = cloneGoal(goal);
  next.execution = {
    ...next.execution,
    noProgressRemaining: next.execution.noProgressLimit,
  };
  return next;
}

export function allowancePauseReason(
  execution: GoalExecution,
  exhaustion: AllowanceExhaustion,
): string {
  if (exhaustion === "total") {
    return (
      `Goal paused: total request allowance exhausted (${execution.lifetimeRequests} ` +
      `provider requests this step, limit ${execution.totalLimit}). The total budget never ` +
      "resets; /goal <objective> starts a fresh bounded goal."
    );
  }
  return (
    `Goal paused: ${execution.noProgressLimit} provider requests without verified progress ` +
    `(no-progress allowance spent; ${execution.totalRemaining}/${execution.totalLimit} total ` +
    "requests left). /goal resume grants a fresh bounded no-progress allowance."
  );
}
