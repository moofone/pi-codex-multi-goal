import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatGoalWrapper } from "./prompts.js";
import { CUSTOM_ENTRY_TYPE, type GoalContinuationKind, type MultiGoal } from "./types.js";

const CONTINUATION_RETRY_MS = 50;

interface ContinuationDeps {
  pi: Pick<ExtensionAPI, "sendMessage">;
  getGoal: () => MultiGoal | null;
  shouldYield: (ctx: ExtensionContext) => boolean;
}

export function createContinuation(deps: ContinuationDeps) {
  let queuedFor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledFor: string | null = null;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    scheduledFor = null;
  };

  const clear = (): void => {
    clearTimer();
    queuedFor = null;
  };

  const send = (goal: MultiGoal, kind: GoalContinuationKind): void => {
    queuedFor = goal.goalId;
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

  const request = (ctx: ExtensionContext, kind: GoalContinuationKind = "continuation"): boolean => {
    const goal = deps.getGoal();
    if (!goal || goal.status !== "active" || deps.shouldYield(ctx)) {
      return false;
    }
    if (queuedFor === goal.goalId) {
      return true;
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
        request(ctx, kind);
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
      queuedFor === goal.goalId ||
      ctx.hasPendingMessages() ||
      !ctx.isIdle() ||
      deps.shouldYield(ctx)
    ) {
      return false;
    }
    send(current, kind);
    return true;
  };

  return {
    clear,
    markQueued: (goalId: string) => {
      queuedFor = goalId;
    },
    request,
  };
}
