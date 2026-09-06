import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  allowanceExhaustion,
  allowancePauseReason,
  chargeRequest,
  type AllowanceExhaustion,
} from "./allowance.js";
import { registerGoalCommand, registerGoalMultiCommand } from "./commands.js";
import { createContinuation } from "./continuation.js";
import { createPersistence } from "./persistence.js";
import { formatFooterStatus } from "./prompts.js";
import { loadSettings } from "./settings.js";
import {
  cloneGoal,
  completeCurrentStage,
  reconstructGoal,
  setGoalStatus,
  unixSeconds,
} from "./state.js";
import { registerGoalTools } from "./tools.js";
import type { GoalContinuationKind, GoalEntrySource, GoalResult, MultiGoal } from "./types.js";
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

// Restored work never silently resumes (A10): an active snapshot from the
// selected branch comes back paused and waits for an explicit user decision.
const RESTORE_PAUSE_REASON =
  "Restored from session history. Review the goal, then run /goal resume to continue.";

const PERSIST_FAILURE_NOTICE =
  "Goal persistence failed: the session log rejected the write, so goal execution is disabled until an entry can be saved.";

// F07: the same ownership decision that gates scheduling and accounting gates
// the model-facing terminal tools.
const ORCHESTRATE_TRANSITION_REFUSAL =
  "pi-orchestrate owns this session: goal stage transitions are paused until it hands back control.";

export function registerMultiGoal(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const persistence = createPersistence({ pi });
  let persistenceBroken = false;

  const trackPersistence = (ctx: ExtensionContext | null): void => {
    if (persistence.lastWriteFailed()) {
      if (!persistenceBroken) {
        persistenceBroken = true;
        ctx?.ui.notify(PERSIST_FAILURE_NOTICE, "warning");
      }
      return;
    }
    // A successful write re-admits goal work.
    persistenceBroken = false;
  };

  const restoreBranchGoal = (ctx: ExtensionContext): MultiGoal | null => {
    // F08: the authoritative reconstruction source is the selected branch,
    // never the whole append-only log. Malformed snapshots are skipped by
    // reconstructGoal, keeping the last valid branch snapshot.
    const reconstructed = reconstructGoal(ctx.sessionManager.getBranch());
    if (!reconstructed || reconstructed.status !== "active") {
      return reconstructed;
    }
    const restored = cloneGoal(reconstructed);
    restored.status = "paused";
    restored.pauseReason = RESTORE_PAUSE_REASON;
    return restored;
  };

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
      formatFooterStatus(goal, { yielding: isYielding }),
    );
  };

  const persist = (goal: MultiGoal | null, source: GoalEntrySource, ctx: ExtensionContext | null): void => {
    if (!goal) {
      return;
    }
    persistence.setGoalSnapshot(goal);
    persistence.flush(source);
    trackPersistence(ctx);
    if (ctx) {
      refresh(ctx);
    }
  };

  // F02/A05: pause, clear, block, and replacement invalidate future goal work
  // and withdraw what was already submitted — but only provably goal-owned
  // work. continuation.outstanding() is true exactly when a queued goal
  // continuation (with no user message in front of it) or a goal-owned
  // in-flight loop exists, so the process-global abort (probe 2) can never
  // cancel peer or user work. One abort drains both the queued follow-up and
  // the in-flight loop; it is never called twice for one withdraw.
  const withdrawGoalWork = (ctx: ExtensionContext): void => {
    if (continuation.outstanding()) {
      ctx.abort();
    }
    continuation.clear();
  };

  const setGoal = (goal: MultiGoal, source: GoalEntrySource, ctx: ExtensionContext): void => {
    withdrawGoalWork(ctx);
    persist(goal, source, ctx);
  };

  const clearGoal = (source: GoalEntrySource, ctx: ExtensionContext): void => {
    withdrawGoalWork(ctx);
    const id = persistence.getGoal()?.goalId ?? null;
    persistence.appendClear(id, source);
    trackPersistence(ctx);
    refresh(ctx);
  };

  // Exhaustion pauses goal execution with a visible, persisted reason. The
  // user resume path may grant a fresh bounded no-progress allowance, but the
  // total budget never refills. This is an accounting pause: future scheduling
  // is invalidated, and the loop already in flight keeps its goal ownership
  // (a later user withdraw must still recognize it) — no abort is issued here,
  // so the request that was just charged is not thrown away.
  const pauseForExhaustion = (
    ctx: ExtensionContext,
    goal: MultiGoal,
    exhaustion: AllowanceExhaustion,
  ): void => {
    if (goal.status !== "active") {
      return;
    }
    const paused = setGoalStatus(goal, "paused");
    if (!paused.ok || !paused.goal) {
      return;
    }
    paused.goal.pauseReason = allowancePauseReason(paused.goal.execution, exhaustion);
    continuation.clearSchedule();
    persist(paused.goal, "runtime", ctx);
    if (!persistenceBroken) {
      ctx.ui.notify(paused.goal.pauseReason, "warning");
    }
  };

  // Persistence failure admits no goal work: no completions, no blocks, and no
  // continuations for state that cannot be committed.
  const requestContinuation = (
    ctx: ExtensionContext,
    kind?: GoalContinuationKind,
    options?: { atContextBoundary?: boolean },
  ): boolean => {
    if (persistenceBroken) {
      return false;
    }
    const goal = persistence.getGoal();
    if (goal?.status === "active" && !yielding(ctx)) {
      // Admission gate: once the allowance reaches 0, no goal continuation is
      // requested (the Phase 0 probe recorded that before_provider_request
      // cannot deny a request including retries, so refusing to schedule is
      // the admission barrier this extension can actually provide).
      const exhausted = allowanceExhaustion(goal.execution);
      if (exhausted) {
        pauseForExhaustion(ctx, goal, exhausted);
        return false;
      }
    }
    return continuation.request(ctx, kind, options);
  };

  // Persisted request accounting at provider entry (probe 1: the hook observes
  // every goal-owned agent-loop request before the provider's retry loop).
  // Charge durably exactly once per request; reloads and retries never refund.
  // Revalidation at provider admission: ownership (yielding), goal status, and
  // a non-exhausted allowance — a host-issued request this extension cannot
  // deny is left uncharged rather than negative — the A04 gap is documented,
  // not claimed solved.
  const chargeAtProviderEntry = (ctx: ExtensionContext): void => {
    const goal = persistence.getGoal();
    if (!goal || goal.status !== "active" || yielding(ctx) || persistenceBroken) {
      return;
    }
    const outcome = chargeRequest(goal.execution);
    if (outcome.type === "unchanged") {
      pauseForExhaustion(ctx, goal, outcome.exhaustion);
      return;
    }
    const next = cloneGoal(goal);
    next.execution = outcome.execution;
    next.updatedAt = unixSeconds();
    if (outcome.type === "charged-exhausted") {
      next.status = "paused";
      next.pauseReason = allowancePauseReason(next.execution, outcome.exhaustion);
      continuation.clearSchedule();
    }
    persist(next, "runtime", ctx);
    if (next.status === "paused" && next.pauseReason && !persistenceBroken) {
      ctx.ui.notify(next.pauseReason, "warning");
    }
  };

  const completeStage = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    if (yielding(ctx)) {
      return { ok: false, message: ORCHESTRATE_TRANSITION_REFUSAL, goal: persistence.getGoal() };
    }
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    const result = completeCurrentStage(persistence.getGoal());
    if (!result.ok || !result.goal) {
      return result;
    }
    // A step advanced: the old step's queued/delivered continuation line is
    // invalidated, and the loop that reported completion keeps running so its
    // tool result can land. There is no continuation.request on stage_advance —
    // automatic multi-step stays disabled, and the next step waits for an
    // explicit user decision.
    continuation.clearSchedule();
    persist(result.goal, source, ctx);
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    return result;
  };

  const blockGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    if (yielding(ctx)) {
      return { ok: false, message: ORCHESTRATE_TRANSITION_REFUSAL, goal: persistence.getGoal() };
    }
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    const result = setGoalStatus(persistence.getGoal(), "blocked");
    if (!result.ok || !result.goal) {
      return result;
    }
    withdrawGoalWork(ctx);
    persist(result.goal, source, ctx);
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    return result;
  };

  registerGoalTools(pi, {
    getGoal: () => persistence.getGoal(),
    completeStage,
    blockGoal,
  });

  const commandHost = {
    getGoal: () => persistence.getGoal(),
    limits: { noProgressLimit: settings.noProgressLimit, totalLimit: settings.totalLimit },
    setGoal,
    clearGoal,
    requestContinuation: (ctx: ExtensionContext, kind?: GoalContinuationKind) =>
      requestContinuation(ctx, kind),
  };
  registerGoalCommand(pi, commandHost);
  registerGoalMultiCommand(pi, commandHost);

  // Delivery acknowledgement runs on the supported host message events: our
  // continuation messages arm the next eligible boundary (after revalidation),
  // user messages take precedence for loop ownership.
  const classifyDeliveredMessage = (message: unknown, ctx: ExtensionContext): void => {
    if (!message || typeof message !== "object") {
      return;
    }
    const record = message as { customType?: unknown; role?: unknown };
    if (record.customType === CUSTOM_ENTRY_TYPE) {
      continuation.goalMessageDelivered(ctx);
      return;
    }
    if (record.role === "user") {
      continuation.userMessageDelivered();
    }
  };

  pi.on("message_start", (event, ctx) => {
    classifyDeliveredMessage(event.message, ctx);
  });

  pi.on("message_end", (event, ctx) => {
    // Idempotent: only the one queued continuation is acknowledged, once.
    classifyDeliveredMessage(event.message, ctx);
  });

  // In-flight goal ownership: the loop (and each turn inside it) is goal-owned
  // when it was triggered by the delivered goal continuation.
  pi.on("agent_start", (_event, _ctx) => {
    continuation.agentLoopStarted();
  });

  pi.on("turn_start", (_event, _ctx) => {
    continuation.agentLoopStarted();
  });

  pi.on("session_start", (_event, ctx) => {
    const restored = restoreBranchGoal(ctx);
    persistence.setGoalSnapshot(restored);
    persistence.syncPersistedSnapshot(restored);
    continuation.clear();
    refresh(ctx);
    // No continuation request: restored work waits for an explicit user
    // decision, and restart never grants a new allowance (A10, F03).
  });

  pi.on("session_tree", (_event, ctx) => {
    const restored = restoreBranchGoal(ctx);
    persistence.setGoalSnapshot(restored);
    persistence.syncPersistedSnapshot(restored);
    continuation.clear();
    refresh(ctx);
    // No continuation request: tree navigation restores the selected branch
    // paused and must not silently resume off-branch work.
  });

  pi.on("before_provider_request", (_event, ctx) => {
    chargeAtProviderEntry(ctx);
    // No payload replacement and no denial: the host provides no deny channel
    // (qa/evidence/host-capabilities.txt probe 1).
  });

  pi.on("session_before_compact", (_event, ctx) => {
    persistence.flush("runtime");
    trackPersistence(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    persistence.flush("runtime");
    trackPersistence(ctx);
    refresh(ctx);
    // The one context-boundary snapshot: eligible only after the previous
    // continuation was delivered, and still gated by ownership, status, and
    // allowance. Recovery after context loss is a goal continuation like any
    // other; the provider-entry charge applies to it.
    requestContinuation(ctx, undefined, { atContextBoundary: true });
  });

  pi.on("agent_end", (event, ctx) => {
    // Ownership of the abort is decided before the loop bookkeeping resets:
    // only a goal-owned turn's abort invalidates goal execution. A peer or
    // user turn aborting is not ours to act on (F07).
    const goalOwnedTurn = continuation.goalTurnInFlight();
    continuation.agentLoopEnded();
    const aborted = event.messages.some(
      (message) => message.role === "assistant" && "stopReason" in message && message.stopReason === "aborted",
    );
    if (aborted && goalOwnedTurn) {
      const goal = persistence.getGoal();
      if (goal?.status === "active") {
        const paused = setGoalStatus(goal, "paused");
        if (paused.ok && paused.goal) {
          continuation.clear();
          persist(paused.goal, "runtime", ctx);
        }
      }
    }
    // No continuation request on ordinary turn ends: model-facing snapshots
    // are scheduled at step start and eligible context boundaries only (A06).
  });

  pi.on("session_shutdown", (_event, ctx) => {
    persistence.flush("runtime");
    trackPersistence(ctx);
    // Invalidate future goal work. No abort: the process is going down.
    continuation.clear();
  });
}
