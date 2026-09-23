import { cloneGoal } from "./state.js";
import { MAX_CREDITED_EVIDENCE, type GoalExecution, type MultiGoal } from "./types.js";

/**
 * Persisted dual-unit accounting. The grant is finite and durable: it lives
 * in the goal snapshot (goal.execution).
 *
 * - no-progress is one full context (a session_compact / context-window fill).
 *   Provider requests inside a tool loop do not spend it. The legacy
 *   `maxCompactionsWithoutMutation` number maps onto this unit.
 * - total/lifetime is one goal-owned provider request, charged at
 *   before_provider_request. Reloads and retries never refund.
 *
 * There is no unlimited mode. Verified mid-step progress credit (Task 8) may
 * later reset ONLY the no-progress streak; nothing in this module resets
 * anything on memory text, tool success, or edit/write/apply_patch tool names.
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

function refuseIfExhausted(execution: GoalExecution): ChargeOutcome | null {
  const before = allowanceExhaustion(execution);
  return before ? { type: "unchanged", exhaustion: before } : null;
}

function finishCharge(next: GoalExecution): ChargeOutcome {
  const after = allowanceExhaustion(next);
  if (after) {
    return { type: "charged-exhausted", execution: next, exhaustion: after };
  }
  return { type: "charged", execution: next };
}

/**
 * Charge exactly one goal-owned provider request against the total budget.
 * One call per provider request, at provider entry, never below zero, never
 * refunding, and never touching the no-progress streak: a refused charge
 * (allowance already at 0) records nothing, so lifetime totals only ever
 * count admitted requests.
 */
export function chargeRequest(execution: GoalExecution): ChargeOutcome {
  const refused = refuseIfExhausted(execution);
  if (refused) {
    return refused;
  }
  return finishCharge({
    ...execution,
    totalRemaining: Math.max(0, execution.totalRemaining - 1),
    lifetimeRequests: execution.lifetimeRequests + 1,
  });
}

/**
 * Charge exactly one full context against the no-progress streak. One call
 * per session_compact while the goal owns the session, never below zero,
 * never refunding, and never touching the total request budget.
 */
export function chargeContext(execution: GoalExecution): ChargeOutcome {
  const refused = refuseIfExhausted(execution);
  if (refused) {
    return refused;
  }
  return finishCharge({
    ...execution,
    noProgressRemaining: Math.max(0, execution.noProgressRemaining - 1),
  });
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

export interface CreditOutcome {
  goal: MultiGoal;
  /** Keys newly credited by this call (empty when everything was stale). */
  creditedKeys: string[];
}

/**
 * Verified mid-step progress credit (Task 8), applied ONLY to refs that passed
 * the shared evidence-validation path. A novel verified evidence ref resets the
 * no-progress streak to the grant limit — once per ref, keyed by
 * operation/artifact/fingerprint, so repeated pass/fail toggling of the same
 * evidence cannot refill repeatedly. Nothing here touches totalRemaining,
 * lifetimeRequests, or tokenUsage; memory text, tool success, and
 * edit/write/apply_patch names alone never reach this function.
 */
export function creditVerifiedEvidence(goal: MultiGoal, keys: string[]): CreditOutcome {
  const already = new Set(goal.execution.creditedEvidence ?? []);
  const fresh = [...new Set(keys)].filter((key) => !already.has(key));
  if (fresh.length === 0) {
    return { goal, creditedKeys: [] };
  }
  const next = cloneGoal(goal);
  const credited = [...(next.execution.creditedEvidence ?? []), ...fresh];
  next.execution = {
    ...next.execution,
    creditedEvidence: credited.slice(-MAX_CREDITED_EVIDENCE),
    noProgressRemaining: next.execution.noProgressLimit,
  };
  return { goal: next, creditedKeys: fresh };
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
    `Goal paused: ${execution.noProgressLimit} full contexts without verified progress ` +
    `(no-progress allowance spent; ${execution.totalRemaining}/${execution.totalLimit} total ` +
    "requests left). /goal resume grants a fresh bounded no-progress allowance."
  );
}
