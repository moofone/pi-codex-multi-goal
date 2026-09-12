import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatGoalWrapper } from "./prompts.js";
import { CUSTOM_ENTRY_TYPE, type GoalContinuationKind, type MultiGoal } from "./types.js";

const CONTINUATION_RETRY_MS = 50;

/** The goal/step/generation a queued continuation was built for. */
interface ContinuationIdentity {
  goalId: string;
  index: number;
  generation: number;
}

function identityOf(goal: MultiGoal): ContinuationIdentity {
  return { goalId: goal.goalId, index: goal.index, generation: goal.execution.generation };
}

function sameIdentity(identity: ContinuationIdentity, goal: MultiGoal): boolean {
  const current = identityOf(goal);
  return (
    identity.goalId === current.goalId &&
    identity.index === current.index &&
    identity.generation === current.generation
  );
}

interface ContinuationDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
  getGoal: () => MultiGoal | null;
  shouldYield: (ctx: ExtensionContext) => boolean;
}

/**
 * The single continuation owner. Explicit minimal state replaces the old
 * never-cleared sent marker (F04):
 *
 * - `idle`: nothing scheduled;
 * - `queued`: one continuation handed to the host, delivery not yet
 *   acknowledged — while queued, no second continuation may be scheduled;
 * - `delivered`: the host acknowledged delivery on its message events; this
 *   arms eligibility for exactly one continuation at the next context
 *   boundary. A context boundary with no armed eligibility sends nothing.
 *   An unfinished idle `agent_end` (goal still active) sends exactly one
 *   current-snapshot continuation — force keep going, still at most one pending.
 *
 * Delivery is revalidated against the current goal/step/generation/status (and
 * ownership when a context is available): a stale delivery arms nothing. The
 * owner also records who triggered the in-flight agent loop — the delivered
 * goal message or a user message (user messages take precedence) — so a
 * withdraw can prove that cancellation would only hit goal-owned work
 * (probe 2: ctx.abort() is process-global, so it must never be called for
 * peer- or user-owned work).
 */
export function createContinuation(deps: ContinuationDeps) {
  let phase: "idle" | "queued" | "delivered" = "idle";
  let sentFor: ContinuationIdentity | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledFor: string | null = null;
  // What triggered the agent loop now in flight, if anything.
  let loopTrigger: "goal" | "user" | null = null;
  let goalLoopInFlight = false;
  // A user message was delivered after the continuation was sent: the queue or
  // the loop may now carry user content, so cancellation is off limits.
  let userMessageSinceSend = false;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    scheduledFor = null;
  };

  /** Full invalidation: a goal lifecycle change (pause/clear/replace/restore). */
  const clear = (): void => {
    clearTimer();
    phase = "idle";
    sentFor = null;
    loopTrigger = null;
    goalLoopInFlight = false;
    userMessageSinceSend = false;
  };

  /**
   * Drop pending scheduling only, keeping in-flight loop ownership: the step
   * that advanced (or the allowance that ran out) belongs to the same goal
   * whose loop may still be running, and a later withdraw must still be able
   * to recognize and stop that work.
   */
  const clearSchedule = (): void => {
    clearTimer();
    phase = "idle";
    sentFor = null;
    userMessageSinceSend = false;
  };

  const send = (goal: MultiGoal, kind: GoalContinuationKind): void => {
    phase = "queued";
    sentFor = identityOf(goal);
    userMessageSinceSend = false;
    deps.pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: formatGoalWrapper(goal),
        display: true,
        details: { kind, goalId: goal.goalId, stage: goal.index + 1, stages: goal.stages.length },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const request = (
    ctx: ExtensionContext,
    kind: GoalContinuationKind = "continuation",
    options: { atContextBoundary?: boolean } = {},
  ): boolean => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active" || deps.shouldYield(ctx)) {
      return false;
    }
    if (phase === "queued") {
      // At most one pending goal continuation.
      return true;
    }
    if (options.atContextBoundary && phase !== "delivered") {
      // A context boundary is eligible only after the previous continuation
      // was delivered; without that acknowledgement it would be reminder spam
      // or a stack on top of unacknowledged work.
      return false;
    }
    if (ctx.hasPendingMessages()) {
      clearTimer();
      return false;
    }
    if (!ctx.isIdle()) {
      if (scheduledFor === goal.goalId) {
        return true;
      }
      const goalId = goal.goalId;
      scheduledFor = goalId;
      timer = setTimeout(() => {
        timer = null;
        scheduledFor = null;
        request(ctx, kind, options);
      }, CONTINUATION_RETRY_MS);
      timer.unref?.();
      return true;
    }
    clearTimer();
    const current = deps.getGoal();
    if (
      !current ||
      current.status !== "active" ||
      current.goalId !== goal.goalId ||
      ctx.hasPendingMessages() ||
      !ctx.isIdle() ||
      deps.shouldYield(ctx)
    ) {
      return false;
    }
    send(current, kind);
    return true;
  };

  /**
   * Delivery acknowledgement for this extension's message on the supported
   * host message events. Revalidates the goal identity, step, generation, and
   * status: only a still-current delivery is marked delivered (arming the next
   * boundary); a stale one arms nothing. Ownership at delivery is revalidated
   * too when a context is available. The loop the message triggers counts as
   * goal-owned while the same goal is still active.
   */
  const goalMessageDelivered = (ctx?: ExtensionContext): void => {
    if (phase !== "queued" || !sentFor) {
      return;
    }
    const goal = deps.getGoal();
    const sameGoal = !!goal && goal.goalId === sentFor.goalId;
    const owned = !!goal && goal.status === "active" && sameGoal && !(ctx && deps.shouldYield(ctx));
    loopTrigger = owned ? "goal" : null;
    if (!owned || !goal || !sameIdentity(sentFor, goal)) {
      phase = "idle";
      sentFor = null;
      return;
    }
    phase = "delivered";
  };

  /** A user message was delivered: user messages take precedence. */
  const userMessageDelivered = (): void => {
    if (phase !== "idle") {
      userMessageSinceSend = true;
    }
    loopTrigger = "user";
  };

  /** An agent loop (or a turn inside one) started. */
  const agentLoopStarted = (): void => {
    if (loopTrigger === "goal") {
      goalLoopInFlight = true;
    }
  };

  /** The agent loop ended; ownership of the next loop is undetermined. */
  const agentLoopEnded = (): void => {
    goalLoopInFlight = false;
    loopTrigger = null;
  };

  /** Read BEFORE agentLoopEnded() when handling agent_end. */
  const goalTurnInFlight = (): boolean => goalLoopInFlight;

  /**
   * True only when cancellation provably targets goal-owned work: a queued
   * continuation this extension submitted with no user message in front of it,
   * or an in-flight loop the delivered goal continuation started. Peer and
   * user work never satisfies this — the caller may ctx.abort() only when true.
   */
  const outstanding = (): boolean =>
    (phase === "queued" && !userMessageSinceSend) || (goalLoopInFlight && loopTrigger === "goal");

  /**
   * True when a queued, undelivered goal continuation is stale relative to the
   * goal lifecycle AND aborting it cannot kill a running goal loop that is
   * reporting a terminal tool result (the caller's own loop). The completion
   * boundary uses this to withdraw old-step queue entries without aborting the
   * loop whose tool result must still land.
   */
  const queuedStale = (): boolean =>
    phase === "queued" && !userMessageSinceSend && !goalLoopInFlight;

  return {
    clear,
    clearSchedule,
    request,
    goalMessageDelivered,
    userMessageDelivered,
    agentLoopStarted,
    agentLoopEnded,
    goalTurnInFlight,
    outstanding,
    queuedStale,
  };
}

export type Continuation = ReturnType<typeof createContinuation>;
