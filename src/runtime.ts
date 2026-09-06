import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  allowanceExhaustion,
  allowancePauseReason,
  chargeRequest,
  creditVerifiedEvidence,
  type AllowanceExhaustion,
} from "./allowance.js";
import { registerGoalCommand, registerGoalMultiCommand } from "./commands.js";
import { createContinuation } from "./continuation.js";
import { checkEvidenceCoverage, validateEvidenceRefs } from "./evidence.js";
import { createPersistence } from "./persistence.js";
import { validateMemoryContent } from "./memory.js";
import { formatFooterStatus } from "./prompts.js";
import { loadSettings } from "./settings.js";
import {
  acceptCompletion,
  cloneGoal,
  currentStage,
  reconstructGoal,
  setGoalStatus,
  unixSeconds,
} from "./state.js";
import {
  registerGoalTools,
  type MemoryResult,
  type MemoryUpdateInput,
  type TerminalInput,
  type TerminalResult,
} from "./tools.js";
import type { GoalContinuationKind, GoalEntrySource, GoalMemory, GoalResult, MultiGoal } from "./types.js";
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

const HANDOFF_MAX_CHARS = 512;

/** An accepted completion, remembered so the SAME tool-call id replays idempotently. */
interface AcceptedCompletion {
  goalId: string;
  step: number;
  generation: number;
  result: TerminalResult;
}

const MAX_ACCEPTED_COMPLETIONS = 32;

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

  // Accepted completions, newest kept per tool-call id: a replayed terminal
  // call is acknowledged without re-running the transition (F05/A07). Bounded;
  // the oldest entries are forgotten first (they are stale by then anyway).
  const acceptedCompletions = new Map<string, AcceptedCompletion>();

  const rememberCompletion = (toolCallId: string, record: AcceptedCompletion): void => {
    acceptedCompletions.delete(toolCallId);
    acceptedCompletions.set(toolCallId, record);
    while (acceptedCompletions.size > MAX_ACCEPTED_COMPLETIONS) {
      const oldest = acceptedCompletions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      acceptedCompletions.delete(oldest);
    }
  };

  /** Identity binding shared by both terminal tools: an old call cannot claim
   *  a newly active step, and a stale callback is rejected. */
  const rejectUnboundTerminal = (goal: MultiGoal, input: TerminalInput, action: string): GoalResult | null => {
    if (input.goalId !== goal.goalId) {
      return {
        ok: false,
        message: `${action} rejected: it was not created by the current goal execution.`,
        goal,
      };
    }
    if (input.step !== goal.index + 1) {
      return {
        ok: false,
        message: `${action} rejected: this execution is bound to step ${goal.index + 1} of this goal; the step you referenced is already handled.`,
        goal,
      };
    }
    if (input.generation !== goal.execution.generation) {
      return {
        ok: false,
        message: `${action} rejected: the execution generation has changed; re-read the current goal snapshot.`,
        goal,
      };
    }
    return null;
  };

  // The accepted-completion boundary (Task 8): bind, require criterion
  // coverage on the one evidence path, persist the transition (completion,
  // cleared memory, fresh grant, isolation boundary), withdraw old-step queue
  // entries, acknowledge ONLY the old step, then admit exactly one kickoff for
  // the next step through the usual admission gates. There is no fallback that
  // runs the next step inside the old transcript.
  const completeStage = (source: GoalEntrySource, ctx: ExtensionContext, input: TerminalInput): TerminalResult => {
    if (yielding(ctx)) {
      return { ok: false, message: ORCHESTRATE_TRANSITION_REFUSAL, goal: persistence.getGoal() };
    }
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    const goal = persistence.getGoal();
    if (!goal) {
      return { ok: false, message: "No active goal exists.", goal: null };
    }
    // Idempotent replay of the SAME accepted completion: acknowledged, no
    // second advance, no second kickoff.
    const replay = acceptedCompletions.get(input.toolCallId);
    if (
      replay &&
      replay.goalId === input.goalId &&
      replay.step === input.step &&
      replay.generation === input.generation &&
      goal.goalId === input.goalId
    ) {
      return replay.result;
    }
    if (goal.status !== "active") {
      return { ok: false, message: `Goal is ${goal.status}.`, goal };
    }
    const unbound = rejectUnboundTerminal(goal, input, "Completion");
    if (unbound) {
      return unbound;
    }
    // A human-decision criterion can never be completed from agent evidence:
    // the step stays blocked from automatic completion (A11).
    const decision = currentStage(goal).criteria.find((criterion) => criterion.requiresHumanDecision);
    if (decision) {
      return {
        ok: false,
        message:
          `Completion rejected: criterion "${decision.id}" (${decision.text}) requires a human decision. ` +
          'Resolve it with the human, or call update_goal with status "blocked" to keep the step for that decision.',
        goal,
      };
    }
    // One evidence-validation path for credit and completion: existence,
    // producing operation, fingerprint, and criterion association.
    const validated = validateEvidenceRefs(goal, input.evidence);
    if (!validated.ok) {
      return { ok: false, message: validated.message, goal };
    }
    const coverage = checkEvidenceCoverage(goal, validated.refs);
    if (!coverage.ok) {
      return { ok: false, message: coverage.message, goal };
    }
    if (input.handoff !== undefined && (typeof input.handoff !== "string" || input.handoff.length > HANDOFF_MAX_CHARS)) {
      return {
        ok: false,
        message: `Completion rejected: the handoff must be one factual note of at most ${HANDOFF_MAX_CHARS} characters.`,
        goal,
      };
    }
    // Persist the transition BEFORE acknowledging it or admitting the kickoff.
    // The withdrawal decision is read before the schedule is cleared: a queued
    // old-step continuation is withdrawn (it is provably goal-owned and no
    // goal loop is in flight whose tool result could be lost), the loop that
    // reported completion keeps running so its tool result can land.
    const withdrawQueued = continuation.queuedStale();
    const result = acceptCompletion(goal, Date.now(), {
      handoff: typeof input.handoff === "string" ? input.handoff : undefined,
    });
    if (!result.ok || !result.goal) {
      return { ok: false, message: result.message, goal: result.goal ?? goal };
    }
    if (withdrawQueued) {
      ctx.abort();
    }
    continuation.clearSchedule();
    persist(result.goal, source, ctx);
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    const terminal: TerminalResult = { ...result, acknowledgedStep: input.step };
    rememberCompletion(input.toolCallId, {
      goalId: input.goalId,
      step: input.step,
      generation: input.generation,
      result: terminal,
    });
    if (result.goal.status === "active") {
      // Exactly one kickoff for the next step, through the admission gates
      // (fresh grant, ownership, persistence) — isolation is enforced by the
      // persisted context boundary the provider request is filtered through.
      requestContinuation(ctx, "stage_advance");
    } else {
      // Final step: the goal is done; invalidate all goal work.
      continuation.clear();
    }
    return terminal;
  };

  const blockGoal = (source: GoalEntrySource, ctx: ExtensionContext, input: TerminalInput): TerminalResult => {
    if (yielding(ctx)) {
      return { ok: false, message: ORCHESTRATE_TRANSITION_REFUSAL, goal: persistence.getGoal() };
    }
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    const goal = persistence.getGoal();
    if (!goal) {
      return { ok: false, message: "No active goal exists.", goal: null };
    }
    if (goal.status !== "active") {
      return { ok: false, message: `Goal is ${goal.status}.`, goal };
    }
    const unbound = rejectUnboundTerminal(goal, input, "Block");
    if (unbound) {
      return unbound;
    }
    const result = setGoalStatus(goal, "blocked");
    if (!result.ok || !result.goal) {
      return result;
    }
    withdrawGoalWork(ctx);
    persist(result.goal, source, ctx);
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    return { ...result, acknowledgedStep: input.step };
  };

  // Bounded working-memory replace (Task 7) with optional verified progress
  // credit (Task 8). The update is bound to the execution it came from: goal
  // id, step, generation, and the memory revision the model last saw. Memory
  // is continuity state only — criteria, steps, and the total allowance are
  // untouched, and no continuation is scheduled here (Task 6 cadence).
  // Evidence refs ride the same validation path completion uses; each novel
  // verified ref resets only the no-progress streak, once. Unverifiable
  // claims stay in memory without resetting counters, and late writes bound
  // to a completed step or a spent generation are rejected.
  const updateMemory = (input: MemoryUpdateInput, ctx: ExtensionContext): MemoryResult => {
    const goal = persistence.getGoal();
    if (!goal) {
      return { ok: false, message: "No active goal exists.", goal: null };
    }
    if (goal.status !== "active") {
      return {
        ok: false,
        message: `Goal is ${goal.status}; memory updates belong to an active execution.`,
        goal,
      };
    }
    if (yielding(ctx)) {
      return { ok: false, message: ORCHESTRATE_TRANSITION_REFUSAL, goal };
    }
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal };
    }
    if (input.goalId !== goal.goalId) {
      return {
        ok: false,
        message: "Memory update rejected: it was not created by the current goal execution.",
        goal,
      };
    }
    if (input.step !== goal.index + 1) {
      return {
        ok: false,
        message: `Memory update rejected: this execution is bound to step ${goal.index + 1} of this goal.`,
        goal,
      };
    }
    if (input.generation !== goal.execution.generation) {
      return {
        ok: false,
        message:
          "Memory update rejected: the execution generation has changed; re-read the current goal snapshot.",
        goal,
      };
    }
    const proposedRevision = goal.memory.revision + 1;
    const validated = validateMemoryContent(input, proposedRevision);
    if (!validated.ok) {
      return { ok: false, message: validated.message, goal };
    }
    const sameContent =
      JSON.stringify({ proved: validated.proved, unresolved: validated.unresolved, next: validated.next }) ===
      JSON.stringify({
        proved: goal.memory.proved,
        unresolved: goal.memory.unresolved,
        next: goal.memory.next,
      });
    if (sameContent) {
      // Identical replay: already recorded, no revision bump, nothing persisted.
      return { ok: true, message: "Memory already recorded; nothing changed.", goal };
    }
    if (input.revision !== goal.memory.revision) {
      return {
        ok: false,
        message:
          `Memory update rejected: expected memory revision ${goal.memory.revision}; ` +
          "the supplied revision is stale. Re-read the current goal snapshot.",
        goal,
      };
    }
    // Verified progress credit (Task 8): only refs that pass the shared
    // evidence validation, and only once per novel ref. An invalid ref
    // rejects the whole update, keeping the previous record and counters.
    let next = cloneGoal(goal);
    let credited = 0;
    if (input.evidence !== undefined) {
      const evidence = validateEvidenceRefs(goal, input.evidence);
      if (!evidence.ok) {
        return { ok: false, message: evidence.message, goal };
      }
      const outcome = creditVerifiedEvidence(goal, evidence.refs.map((ref) => ref.key));
      next = outcome.goal;
      credited = outcome.creditedKeys.length;
    }
    const memory: GoalMemory = {
      revision: proposedRevision,
      proved: validated.proved,
      unresolved: validated.unresolved,
      next: validated.next,
    };
    next.memory = memory;
    next.updatedAt = unixSeconds();
    persist(next, "tool", ctx);
    if (persistenceBroken) {
      return { ok: false, message: PERSIST_FAILURE_NOTICE, goal: persistence.getGoal() };
    }
    return {
      ok: true,
      message:
        credited > 0
          ? `Memory revision ${memory.revision} recorded; ${credited} verified evidence ref(s) credited.`
          : `Memory revision ${memory.revision} recorded.`,
      goal: next,
      credited,
    };
  };

  registerGoalTools(pi, {
    getGoal: () => persistence.getGoal(),
    completeStage,
    blockGoal,
    updateMemory,
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

  // The isolation boundary (F06/A08), built on probe 3: a context handler's
  // returned { messages } replaces the provider-visible list. After a persisted
  // step transition, every message at or before the boundary belongs to the
  // completed step (its transcript, its tool results, its memory snapshot) and
  // is dropped; extension goal messages that are not the CURRENT step's
  // snapshot are dropped in all cases, so the model view holds exactly one
  // current goal context. The CURRENT step's snapshot is kept regardless of
  // its timestamp — a snapshot stamped exactly at the cutoff (host clock tie)
  // must stay visible — and it anchors the epoch: the completing turn's own
  // leftovers (its tool results) are stamped after the cutoff but before the
  // next snapshot lands, so anything after the cutoff that is not stamped
  // later than the newest current-snapshot stamp is old-step debris and is
  // dropped too. Paused/restored goals keep filtering through the persisted
  // boundary; while pi-orchestrate owns the session the extension never
  // touches the context at all. There is no newSession fallback: if this
  // filter could not be proven, the next kickoff would stay withheld instead.
  const isNonCurrentGoalMessage = (message: unknown, goal: MultiGoal): boolean => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as { role?: unknown; customType?: unknown; details?: unknown };
    if (record.role !== "custom" || record.customType !== CUSTOM_ENTRY_TYPE) {
      return false;
    }
    if (goal.status === "complete") {
      return true;
    }
    const details = (record.details ?? {}) as { goalId?: unknown; stage?: unknown };
    return details.goalId !== goal.goalId || details.stage !== goal.index + 1;
  };

  pi.on("context", (event, ctx) => {
    const goal = persistence.getGoal();
    if (!goal || yielding(ctx)) {
      return undefined;
    }
    const cutoff = goal.isolationCutoff ?? 0;
    const stampOf = (message: unknown): number => {
      const stamp = (message as { timestamp?: unknown } | null)?.timestamp;
      return typeof stamp === "number" ? stamp : 0;
    };
    const isCurrentGoalSnapshot = (message: unknown): boolean =>
      (message as { role?: unknown } | null)?.role === "custom" &&
      !isNonCurrentGoalMessage(message, goal);
    // Newest current-snapshot stamp wins over the cutoff: messages in the
    // (cutoff, epoch] window are completing-turn leftovers of the OLD step.
    let snapshotEpoch = cutoff;
    for (const message of event.messages) {
      if (isCurrentGoalSnapshot(message)) {
        snapshotEpoch = Math.max(snapshotEpoch, stampOf(message));
      }
    }
    const messages = event.messages.filter(
      (message) => isCurrentGoalSnapshot(message) || stampOf(message) > snapshotEpoch,
    );
    if (messages.length === event.messages.length) {
      return undefined;
    }
    return { messages };
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
