import { cloneGoal } from "./state.js";
import { MAX_CREDITED_EVIDENCE, type GoalExecution, type MultiGoal } from "./types.js";

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
    `Goal paused: ${execution.noProgressLimit} provider requests without verified progress ` +
    `(no-progress allowance spent; ${execution.totalRemaining}/${execution.totalLimit} total ` +
    "requests left). /goal resume grants a fresh bounded no-progress allowance."
  );
}
