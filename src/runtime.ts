import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand, registerGoalMultiCommand } from "./commands.js";
import { createContinuation } from "./continuation.js";
import { createPersistence } from "./persistence.js";
import { formatFooterStatus } from "./prompts.js";
import { loadSettings } from "./settings.js";
import {
  completeCurrentStage,
  reconstructGoal,
  setGoalStatus,
} from "./state.js";
import {
  createStallState,
  isMutatingToolName,
  noteFullContextCompact,
  noteMutation,
  resetStallState,
  stallPauseReason,
} from "./stall.js";
import { registerGoalTools } from "./tools.js";
import type { GoalContinuationKind, GoalEntrySource, MultiGoal } from "./types.js";
import { CUSTOM_ENTRY_TYPE } from "./types.js";
import { sessionOwnsLiveOrchestrateFeature, type SessionIdentity } from "./yield.js";

function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
  const manager = ctx.sessionManager as {
    getSessionId?: () => string;
    getSessionFile?: () => string | null | undefined;
  };
  let id = "";
  let file = "";
  try {
    id = manager.getSessionId?.() ?? "";
  } catch {
    /* reload */
  }
  try {
    file = manager.getSessionFile?.() ?? "";
  } catch {
    /* reload */
  }
  return { id: id.trim() || undefined, file: file.trim() || undefined };
}

export function registerMultiGoal(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const stall = createStallState();
  let stallReason: string | null = null;
  const persistence = createPersistence({ pi });

  const yielding = (ctx: ExtensionContext): boolean =>
    sessionOwnsLiveOrchestrateFeature(sessionIdentity(ctx));

  const continuation = createContinuation({
    pi,
    getGoal: () => persistence.getGoal(),
    shouldYield: yielding,
  });

  const refresh = (ctx: { ui: { setStatus?: (key: string, text: string | undefined) => void } } & Partial<ExtensionContext>): void => {
    const goal = persistence.getGoal();
    const isYielding = ctx.sessionManager ? yielding(ctx as ExtensionContext) : false;
    ctx.ui.setStatus?.(
      CUSTOM_ENTRY_TYPE,
      formatFooterStatus(goal, { yielding: isYielding, stallReason: goal?.status === "paused" ? stallReason : null }),
    );
  };

  const persist = (goal: MultiGoal | null, source: GoalEntrySource, ctx: ExtensionContext | null): void => {
    if (!goal) {
      return;
    }
    persistence.setGoalSnapshot(goal);
    persistence.flush(source);
    if (ctx) {
      refresh(ctx);
    }
  };

  const setGoal = (goal: MultiGoal, source: GoalEntrySource, ctx: ExtensionContext): void => {
    continuation.clear();
    resetStallState(stall);
    stallReason = null;
    persist(goal, source, ctx);
  };

  const clearGoal = (source: GoalEntrySource, ctx: ExtensionContext): void => {
    continuation.clear();
    resetStallState(stall);
    stallReason = null;
    const id = persistence.getGoal()?.goalId ?? null;
    persistence.appendClear(id, source);
    refresh(ctx);
  };

  const completeStage = (source: GoalEntrySource, ctx: ExtensionContext) => {
    const result = completeCurrentStage(persistence.getGoal());
    if (!result.ok || !result.goal) {
      return result;
    }
    continuation.clear();
    resetStallState(stall);
    stallReason = null;
    persist(result.goal, source, ctx);
    if (result.goal.status === "active") {
      continuation.request(ctx, "stage_advance");
    }
    return result;
  };

  const blockGoal = (source: GoalEntrySource, ctx: ExtensionContext) => {
    const result = setGoalStatus(persistence.getGoal(), "blocked");
    if (!result.ok || !result.goal) {
      return result;
    }
    continuation.clear();
    persist(result.goal, source, ctx);
    return result;
  };

  registerGoalTools(pi, {
    getGoal: () => persistence.getGoal(),
    completeStage,
    blockGoal,
  });

  const commandHost = {
    getGoal: () => persistence.getGoal(),
    setGoal,
    clearGoal,
    requestContinuation: (ctx: ExtensionContext, kind?: GoalContinuationKind) =>
      continuation.request(ctx, kind),
  };
  registerGoalCommand(pi, commandHost);
  registerGoalMultiCommand(pi, commandHost);

  pi.on("session_start", (_event, ctx) => {
    const reconstructed = reconstructGoal(ctx.sessionManager.getEntries());
    persistence.setGoalSnapshot(reconstructed);
    persistence.syncPersistedSnapshot(reconstructed);
    resetStallState(stall);
    stallReason = null;
    refresh(ctx);
    if (reconstructed?.status === "active") {
      continuation.request(ctx);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    const reconstructed = reconstructGoal(ctx.sessionManager.getEntries());
    persistence.setGoalSnapshot(reconstructed);
    persistence.syncPersistedSnapshot(reconstructed);
    continuation.clear();
    refresh(ctx);
    if (reconstructed?.status === "active") {
      continuation.request(ctx);
    }
  });

  pi.on("session_before_compact", (_event, ctx) => {
    persistence.flush("runtime");
    void ctx;
  });

  pi.on("session_compact", (event, ctx) => {
    persistence.flush("runtime");
    const goal = persistence.getGoal();
    const decision = noteFullContextCompact(stall, {
      goalActive: goal?.status === "active",
      limit: settings.maxCompactionsWithoutMutation,
      reason: event.reason,
    });
    if (decision.type === "pause" && goal) {
      const paused = setGoalStatus(goal, "paused");
      if (paused.ok && paused.goal) {
        stallReason = stallPauseReason(decision.compactonsWithoutMutation);
        continuation.clear();
        resetStallState(stall);
        persist(paused.goal, "runtime", ctx);
        ctx.ui.notify(stallReason, "warning");
      }
      return;
    }
    refresh(ctx);
    continuation.request(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError && isMutatingToolName(event.toolName)) {
      noteMutation(stall);
    }
    void ctx;
  });

  pi.on("agent_end", (event, ctx) => {
    const aborted = event.messages.some(
      (message) => message.role === "assistant" && "stopReason" in message && message.stopReason === "aborted",
    );
    if (aborted) {
      const goal = persistence.getGoal();
      if (goal?.status === "active") {
        const paused = setGoalStatus(goal, "paused");
        if (paused.ok && paused.goal) {
          continuation.clear();
          persist(paused.goal, "runtime", ctx);
        }
      }
      return;
    }
    continuation.request(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    persistence.flush("runtime");
    continuation.clear();
    void ctx;
  });
}
