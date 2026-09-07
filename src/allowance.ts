import { creditKeyDigest } from "./evidence.js";
import { cloneGoal } from "./state.js";
import {
  BUDGET_WARNING_FRACTION,
  MAX_CREDITED_EVIDENCE,
  type GoalExecution,
  type MultiGoal,
} from "./types.js";

/**
 * Persisted multi-unit accounting. The grant is finite and durable: it lives
 * in the goal snapshot (goal.execution).
 *
 * - no-progress is one full context (a session_compact / context-window fill).
 *   Provider requests inside a tool loop do not spend it. The legacy
 *   `maxCompactionsWithoutMutation` number maps onto this unit.
 * - turn is one goal-owned provider request inside one agent turn. It is the
 *   runaway-loop backstop and resets at every turn boundary.
 * - total is one goal-owned provider request against the step's working
 *   budget, charged at before_provider_request.
 * - lifetime is the same request counted against an unrenewable ceiling.
 *
 * There is no unlimited mode.
 *
 * The old shape (D4) was a single 200-request per-step total that nothing
 * renewed — not edits, not verified evidence, not `/goal resume` — so a
 * productive step died for being long. It was added as an infinite-tool-loop
 * backstop, and a loop is now caught by the turn bound instead. Verified
 * mid-step progress credit renews the no-progress streak, clears the turn
 * bound, and returns a capped grant to the working total; it never refunds
 * `lifetimeRequests`. Nothing in this module resets anything on memory text,
 * tool success, or edit/write/apply_patch tool names.
 */

export type AllowanceExhaustion = "lifetime" | "total" | "turn-loop" | "no-progress";

/**
 * The finite admission gates, hardest first. The lifetime ceiling is checked
 * before everything else because no credit and no user resume can lift it;
 * reporting a renewable reason there would promise a recovery that does not
 * exist.
 */
export function allowanceExhaustion(execution: GoalExecution): AllowanceExhaustion | null {
  if (execution.lifetimeRequests >= execution.lifetimeCeiling) {
    return "lifetime";
  }
  if (execution.totalRemaining <= 0) {
    return "total";
  }
  if (execution.turnRequests >= execution.turnLimit) {
    return "turn-loop";
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
 * Charge exactly one goal-owned provider request. One call per provider
 * request, at provider entry, never below zero, never refunding, and never
 * touching the no-progress streak: a refused charge (a fuse already blown)
 * records nothing, so the counters only ever reflect admitted requests.
 */
export function chargeRequest(execution: GoalExecution): ChargeOutcome {
  const refused = refuseIfExhausted(execution);
  if (refused) {
    return refused;
  }
  return finishCharge({
    ...execution,
    totalRemaining: Math.max(0, execution.totalRemaining - 1),
    turnRequests: execution.turnRequests + 1,
    lifetimeRequests: execution.lifetimeRequests + 1,
  });
}

/**
 * Charge exactly one full context against the no-progress streak. One call
 * per session_compact while the goal owns the session, never below zero,
 * never refunding, and never touching the request budgets.
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
 * A new agent turn starts the loop backstop over. This is turn bookkeeping,
 * not a grant: it replenishes no budget and is applied to every turn boundary,
 * goal-owned or not, because the bound counts requests within one turn.
 */
export function beginAgentTurn(execution: GoalExecution): GoalExecution {
  if (execution.turnRequests === 0) {
    return execution;
  }
  return { ...execution, turnRequests: 0 };
}

/**
 * An explicit user resume grants a fresh bounded no-progress allowance and
 * begins a new agent turn. The working total, the lifetime total, and the
 * lifetime ceiling are never replenished here; a new step starts its own grant
 * later (Task 8).
 */
export function applyResumeGrant(goal: MultiGoal): MultiGoal {
  const next = cloneGoal(goal);
  next.execution = {
    ...next.execution,
    noProgressRemaining: next.execution.noProgressLimit,
    turnRequests: 0,
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
 * the shared evidence-validation path. Each novel verified ref — keyed by
 * operation/artifact/fingerprint, so repeated pass/fail toggling of the same
 * evidence cannot refill repeatedly — does three things:
 *
 * 1. resets the no-progress streak to its grant limit;
 * 2. clears the per-turn loop bound, because a turn that produced a verified
 *    result is by definition not the runaway loop that bound exists to catch;
 * 3. returns `evidenceGrant` requests to the working total, capped at
 *    `totalLimit`, which is what lets a legitimately long step keep going.
 *
 * `lifetimeRequests` is never refunded, so the ceiling still terminates a
 * session that produces novel evidence forever. Memory text, tool success, and
 * edit/write/apply_patch names alone never reach this function.
 */
export function creditVerifiedEvidence(goal: MultiGoal, keys: string[]): CreditOutcome {
  const already = new Set(goal.creditedEvidence ?? []);
  const unique = [...new Set(keys)];
  const fresh = unique.filter((key) => !already.has(creditKeyDigest(key)));
  if (fresh.length === 0) {
    return { goal, creditedKeys: [] };
  }
  const next = cloneGoal(goal);
  const credited = [...(next.creditedEvidence ?? []), ...fresh.map(creditKeyDigest)];
  const renewed = next.execution.totalRemaining + next.execution.evidenceGrant * fresh.length;
  // The dedupe record lives on the goal, not the execution grant: a step
  // transition resets the budgets but must NOT forget what was already paid
  // for. Re-submitting a step-1 artifact against a step-2 criterion is not new
  // work, and with D4 in place it would otherwise buy another grant.
  next.creditedEvidence = credited.slice(-MAX_CREDITED_EVIDENCE);
  next.execution = {
    ...next.execution,
    noProgressRemaining: next.execution.noProgressLimit,
    turnRequests: 0,
    totalRemaining: Math.min(next.execution.totalLimit, renewed),
  };
  return { goal: next, creditedKeys: fresh };
}

export interface BudgetPressure {
  /** Which fuse is closest to blowing. */
  budget: "lifetime" | "total" | "turn" | "no-progress";
  /** Consumed fraction, 0–100, rounded down so 80 % reads as "80%". */
  percent: number;
}

/**
 * The most-consumed budget, once it passes the warning threshold. Returns null
 * while every fuse still has room, so an ordinary goal shows no budget noise in
 * the footer.
 */
export function budgetPressure(execution: GoalExecution): BudgetPressure | null {
  const consumed: BudgetPressure[] = [
    {
      budget: "lifetime",
      percent: execution.lifetimeRequests / execution.lifetimeCeiling,
    },
    {
      budget: "total",
      percent: (execution.totalLimit - execution.totalRemaining) / execution.totalLimit,
    },
    { budget: "turn", percent: execution.turnRequests / execution.turnLimit },
    {
      budget: "no-progress",
      percent:
        (execution.noProgressLimit - execution.noProgressRemaining) / execution.noProgressLimit,
    },
  ];
  let worst = consumed[0]!;
  for (const candidate of consumed) {
    if (candidate.percent > worst.percent) {
      worst = candidate;
    }
  }
  if (worst.percent < BUDGET_WARNING_FRACTION) {
    return null;
  }
  return { budget: worst.budget, percent: Math.min(100, Math.floor(worst.percent * 100)) };
}

export function allowancePauseReason(
  execution: GoalExecution,
  exhaustion: AllowanceExhaustion,
): string {
  if (exhaustion === "lifetime") {
    return (
      `Goal paused: this step reached its hard ceiling of ${execution.lifetimeCeiling} ` +
      "goal-owned provider requests. Nothing renews that ceiling — not verified evidence, " +
      "not /goal resume. Start a fresh bounded goal with /goal <objective>."
    );
  }
  if (exhaustion === "turn-loop") {
    return (
      `Goal paused: ${execution.turnLimit} goal-owned provider requests in a single agent ` +
      "turn without a verified result, which is the runaway-loop bound. " +
      `${execution.totalRemaining}/${execution.totalLimit} of the step's working budget is ` +
      "still available; /goal resume starts a new turn."
    );
  }
  if (exhaustion === "total") {
    return (
      `Goal paused: the step's working budget of ${execution.totalLimit} provider requests ` +
      `is spent (${execution.lifetimeRequests} requests admitted so far). Verified evidence ` +
      "renews that budget; none arrived. /goal <objective> starts a fresh bounded goal."
    );
  }
  return (
    `Goal paused: ${execution.noProgressLimit} full contexts without verified progress ` +
    `(no-progress allowance spent; ${execution.totalRemaining}/${execution.totalLimit} working ` +
    "requests left). /goal resume grants a fresh bounded no-progress allowance."
  );
}
