import { validateMemoryContent } from "./memory.js";
import {
  PEER_PROTOCOL_VERSION,
  callPeer,
  canonicalDigest,
  selectionsEqual,
  verifyReceipt,
  type PeerClient,
  type PeerOperationKind,
  type PeerReceipt,
  type PeerRequest,
  type PeerResponse,
  type PeerScope,
  type PeerSelection,
  type ReceiptRejection,
} from "./peer.js";
import { cloneGoal, currentStage } from "./state.js";
import {
  MAX_RETAINED_OPERATIONS,
  type GoalBackend,
  type GoalBackendState,
  type GoalMemory,
  type MultiGoal,
  type PendingOperation,
  type RetainedOperation,
} from "./types.js";

/**
 * The Goal side of the binding and recovery protocol
 * (GOAL_WITH_DAG_SUPPORT §3 and §4; contract in docs/peer-protocol.md).
 *
 * This module is the Goal ADAPTER over the generic seam in src/peer.ts: it maps
 * `goalId`, `Stage.id`, `generation` and `contractRevision` onto the protocol's
 * consumer/scope/epoch fields (PI_DAG_COMPACT D7), and it owns the small
 * persisted operation state machine that makes a mutation recoverable across
 * the four partial-write boundaries. It is NOT a transaction coordinator: there
 * is no shared transaction between Goal session state and a peer's storage, and
 * this file never pretends otherwise.
 *
 * Two rules run through everything here:
 *
 *  1. `unbound` is untouched. No peer is consulted, no state is rewritten, and
 *     a checkpoint that describes unrelated work has no effect (§10 P0 row).
 *  2. Nothing in this file grants execution budget. Binding, detachment,
 *     reload and branch selection all leave `goal.execution` byte-identical
 *     (§3; invariant 6).
 */

export const GOAL_CONSUMER = "pi-codex-multi-goal";

/** The projection profile Goal needs a peer to be able to render. */
export const GOAL_PROJECTION_PROFILE = "current-scope@1";

export function emptyBackend(): GoalBackend {
  return { state: "unbound", binding: null, pending: null, operations: [], reason: null };
}

const BACKEND_STATES: GoalBackendState[] = [
  "unbound",
  "binding-pending",
  "bound-available",
  "bound-unavailable",
  "detached",
];

const OPERATION_KINDS: PeerOperationKind[] = ["bind", "read", "write", "transition", "detach"];

/**
 * Materialise the backend record on a snapshot written before P0 existed. A
 * missing field means "this goal never met a peer", which is exactly `unbound`
 * — the one default that cannot change behaviour.
 */
export function normalizeBackend(backend: GoalBackend | undefined | null): GoalBackend {
  if (!backend) {
    return emptyBackend();
  }
  return {
    state: backend.state,
    binding: backend.binding ? { ...backend.binding } : null,
    pending: backend.pending ? { ...backend.pending, scope: cloneScope(backend.pending.scope) } : null,
    operations: (backend.operations ?? []).map((record) => ({ ...record })),
    reason: backend.reason ?? null,
  };
}

function cloneScope(scope: PeerScope): PeerScope {
  return { ...scope, selection: { ...scope.selection } };
}

function isSelection(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const selection = value as PeerSelection;
  return typeof selection.sessionId === "string" && typeof selection.branchAnchorId === "string";
}

function isScope(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const scope = value as PeerScope;
  return (
    typeof scope.consumer === "string" &&
    typeof scope.scopeId === "string" &&
    typeof scope.contractRevision === "string" &&
    Number.isInteger(scope.epoch) &&
    isSelection(scope.selection)
  );
}

/**
 * Snapshot validation. A malformed backend record makes the whole snapshot
 * malformed rather than being repaired into `unbound`: invariant 8 says
 * previously authoritative but unreadable backend state cannot silently
 * downgrade to stale Goal memory, and reconstructGoal keeps the last VALID
 * branch snapshot when it skips one.
 */
export function isGoalBackend(value: unknown): value is GoalBackend {
  if (!value || typeof value !== "object") {
    return false;
  }
  const backend = value as GoalBackend;
  if (!BACKEND_STATES.includes(backend.state)) {
    return false;
  }
  if (!(backend.reason === null || backend.reason === undefined || typeof backend.reason === "string")) {
    return false;
  }
  const binding = backend.binding;
  if (binding !== null && binding !== undefined) {
    if (
      typeof binding.peerId !== "string" ||
      typeof binding.taskId !== "string" ||
      typeof binding.goalId !== "string" ||
      typeof binding.stageId !== "string" ||
      !Number.isInteger(binding.generation) ||
      typeof binding.contractRevision !== "string" ||
      typeof binding.sessionId !== "string" ||
      typeof binding.branchAnchorId !== "string" ||
      !(binding.selectedRevision === null || typeof binding.selectedRevision === "string")
    ) {
      return false;
    }
  }
  const pending = backend.pending;
  if (pending !== null && pending !== undefined) {
    if (
      typeof pending.operationId !== "string" ||
      !OPERATION_KINDS.includes(pending.kind) ||
      !BACKEND_STATES.includes(pending.expectedState) ||
      !BACKEND_STATES.includes(pending.previousState) ||
      !isScope(pending.scope) ||
      !(pending.expectedRevision === null || typeof pending.expectedRevision === "string") ||
      typeof pending.payloadDigest !== "string" ||
      typeof pending.createdAt !== "number"
    ) {
      return false;
    }
  }
  const operations = backend.operations;
  if (!Array.isArray(operations) || operations.length > MAX_RETAINED_OPERATIONS) {
    return false;
  }
  return operations.every(
    (record) =>
      !!record &&
      typeof record === "object" &&
      typeof record.operationId === "string" &&
      OPERATION_KINDS.includes(record.kind) &&
      typeof record.payloadDigest === "string" &&
      (record.outcome === "committed" || record.outcome === "quarantined"),
  );
}

/**
 * The stage's scope identity. `Stage.id` and not the displayed step number,
 * because the displayed number changes meaning at every transition while the id
 * does not (D7).
 */
export function goalScopeId(goalId: string, stageId: string): string {
  return `goal:${goalId}:stage:${stageId}`;
}

/** The identity every mutation and transition carries (§3). */
export function goalScope(goal: MultiGoal, selection: PeerSelection): PeerScope {
  return {
    consumer: GOAL_CONSUMER,
    scopeId: goalScopeId(goal.goalId, currentStage(goal).id),
    contractRevision: goal.contractRevision,
    epoch: goal.execution.generation,
    selection: { ...selection },
  };
}

/**
 * True only when Goal itself is the working-memory authority. While a switch is
 * in progress, or while a bound peer is unavailable, the answer is false: §3
 * forbids exposing two writable authorities during the switch, and invariant 8
 * forbids downgrading to the stale blob when the authority is gone.
 */
export function goalOwnsMemory(backend: GoalBackend): boolean {
  return backend.state === "unbound" || backend.state === "detached";
}

/** False while the switch is in progress or the bound authority is missing. */
export function backendAdmitsExecution(backend: GoalBackend): boolean {
  return backend.state !== "binding-pending" && backend.state !== "bound-unavailable";
}

export function backendWithholdReason(backend: GoalBackend): string | null {
  if (backendAdmitsExecution(backend)) {
    return null;
  }
  const detail = backend.reason ? ` (${backend.reason})` : "";
  if (backend.state === "binding-pending") {
    return (
      "Goal execution is withheld while the working-memory backend switch is in progress" +
      `${detail}. The migration is persisted and will be recovered; it is not lost.`
    );
  }
  return (
    "Goal execution is paused: the bound working-memory backend is unavailable" +
    `${detail}. The binding, its memory pointers and the allowances are preserved; ` +
    "Goal will not fall back to its previous memory record."
  );
}

/**
 * Why a Goal-only memory replace cannot be accepted right now. Whole-record
 * replacement is preserved when unbound (§5 "Memory tool behavior"); in every
 * other state Goal is not the authority, and accepting the write would either
 * expose a second writable authority during the switch or silently downgrade an
 * unavailable backend to the stale blob (invariants 2 and 8).
 */
export function backendMemoryRefusal(backend: GoalBackend): string | null {
  if (goalOwnsMemory(backend)) {
    return null;
  }
  if (backend.state === "bound-available") {
    return (
      "Memory update rejected: the bound working-memory backend is the authority for this stage, " +
      "so the record is written through the peer adapter rather than replaced here."
    );
  }
  return `Memory update rejected. ${backendWithholdReason(backend) ?? ""}`.trim();
}

// --- replay protection (§4 step 4) ---------------------------------------

export type ReplayVerdict =
  | { verdict: "novel" }
  | { verdict: "pending"; pending: PendingOperation }
  | { verdict: "identical"; record: RetainedOperation }
  | { verdict: "quarantined"; record: RetainedOperation }
  | { verdict: "conflict"; message: string };

/**
 * Classify an operation ID against everything this stage remembers. Retention
 * is bounded but must cover the lifetime in which an operation can be retried,
 * which is why a quarantined ID keeps its record: a late receipt for an
 * operation that was abandoned still has to be refusable.
 */
export function resolveReplay(
  backend: GoalBackend,
  operationId: string,
  payloadDigest: string,
): ReplayVerdict {
  const pending = backend.pending;
  if (pending && pending.operationId === operationId) {
    if (pending.payloadDigest !== payloadDigest) {
      return {
        verdict: "conflict",
        message: `operation ${operationId} is already pending with a different payload`,
      };
    }
    return { verdict: "pending", pending };
  }
  const record = backend.operations.find((entry) => entry.operationId === operationId);
  if (!record) {
    return { verdict: "novel" };
  }
  if (record.payloadDigest !== payloadDigest) {
    return {
      verdict: "conflict",
      message: `operation ${operationId} already exists with a different payload`,
    };
  }
  return record.outcome === "committed" ? { verdict: "identical", record } : { verdict: "quarantined", record };
}

function retain(backend: GoalBackend, record: RetainedOperation): RetainedOperation[] {
  const kept = backend.operations.filter((entry) => entry.operationId !== record.operationId);
  kept.push(record);
  return kept.slice(-MAX_RETAINED_OPERATIONS);
}

// --- operation legality (docs/peer-protocol.md §6.1) ----------------------

/** The one backend state each kind of operation can actually reach. */
const REACHABLE_STATE: Record<Exclude<PeerOperationKind, "read">, GoalBackendState> = {
  bind: "bound-available",
  write: "bound-available",
  transition: "bound-available",
  detach: "detached",
};

/** Where a `bind` may start: nothing is bound, or a previous binding ended. */
const BINDABLE_FROM: GoalBackendState[] = ["unbound", "detached", "binding-pending"];

export type LegalityCheck = { ok: true } | { ok: false; message: string };

/**
 * Is this operation legal for the backend as it stands? Enforced BEFORE the
 * intent is persisted and never delegated to the peer, because a peer that
 * accepts an illegal operation must not be able to promote Goal into
 * `bound-available` without a bind. The protocol's own guarantee cannot rest on
 * the peer being well behaved.
 *
 * Checked on the novel path only: a replay is resolved from the pending intent
 * or the retained receipt first, so idempotent recovery still works after the
 * state has legitimately moved on (a `bind` replayed after its own
 * acknowledgement would otherwise be rejected as "already bound").
 */
export function checkOperationLegality(
  backend: GoalBackend,
  params: { kind: PeerOperationKind; expectedState: GoalBackendState; expectedRevision: string | null },
): LegalityCheck {
  if (params.kind === "read") {
    return { ok: false, message: "a read mutates nothing and persists no intent" };
  }
  const reachable = REACHABLE_STATE[params.kind];
  if (params.expectedState !== reachable) {
    return {
      ok: false,
      message: `a ${params.kind} operation reaches ${reachable}, not ${params.expectedState}`,
    };
  }

  if (params.kind === "bind") {
    if (!BINDABLE_FROM.includes(backend.state)) {
      return {
        ok: false,
        message:
          `this goal is already ${backend.state}; a second bind would replace the working-memory ` +
          "authority without detaching from it. Detach first.",
      };
    }
    if (params.expectedRevision !== null) {
      return {
        ok: false,
        message: "a bind is what selects the first revision, so it cannot claim an expected revision",
      };
    }
    return { ok: true };
  }

  // write, transition and detach all act on a live binding.
  if (backend.state !== "bound-available") {
    return {
      ok: false,
      message:
        `a ${params.kind} operation needs a bound and available backend; this goal is ${backend.state}. ` +
        (backend.state === "unbound" || backend.state === "detached"
          ? "Bind first."
          : "The bound backend is not answering; nothing new can be planned against it."),
    };
  }
  const selected = backend.binding?.selectedRevision ?? null;
  if (!selected) {
    return {
      ok: false,
      message: `a ${params.kind} operation needs a binding with a selected revision; none is recorded`,
    };
  }
  if (params.expectedRevision !== selected) {
    return {
      ok: false,
      message:
        `a ${params.kind} operation must be planned against the selected revision ${selected}; ` +
        `the supplied expected revision is ${params.expectedRevision ?? "null"}`,
    };
  }
  return { ok: true };
}

// --- step 1: persist the intent -------------------------------------------

export interface OperationParams {
  operationId: string;
  kind: PeerOperationKind;
  /** The backend state this operation intends to reach. */
  expectedState: GoalBackendState;
  payload: unknown;
  selection: PeerSelection;
  expectedRevision: string | null;
  /** Recorded on the binding when a bind is accepted. */
  peerId?: string;
  taskId?: string;
  now?: number;
}

export type BeginResult =
  | { ok: true; goal: MultiGoal; request: PeerRequest; replayed: false }
  | { ok: true; goal: MultiGoal; request: PeerRequest; replayed: true; receipt: PeerReceipt | null }
  | { ok: false; goal: MultiGoal; code: ReceiptRejection; message: string };

function requestOf(pending: PendingOperation): PeerRequest {
  return {
    protocolVersion: PEER_PROTOCOL_VERSION,
    operationId: pending.operationId,
    kind: pending.kind,
    scope: cloneScope(pending.scope),
    expectedRevision: pending.expectedRevision,
    payload: pending.payload,
  };
}

/**
 * Step 1 of the recoverable ordering: check ownership and scope, then persist a
 * pending intent carrying the operation ID, the expected state, and enough
 * payload to retry.
 *
 * Only ONE binding, memory or transition operation may be pending for a stage.
 * A second, different operation is refused here, before anything reaches the
 * peer, which is what makes "a pending operation never causes a second credit,
 * graph mutation, completion, or kickoff" true by construction rather than by
 * the peer's good behaviour.
 *
 * Reads persist no intent: they mutate nothing, so there is nothing to recover.
 *
 * Order matters and is load-bearing: replay is resolved first (so idempotent
 * recovery still works after the state has legitimately moved on), then
 * `checkOperationLegality` enforces the state machine, then the one-pending
 * check — and only after all three is anything written to the snapshot. The
 * legality guard is inside this function, a few lines below, not at the call
 * sites: no caller can persist an intent without passing it.
 */
export function beginOperation(goal: MultiGoal, params: OperationParams): BeginResult {
  if (params.kind === "read") {
    return {
      ok: false,
      goal,
      code: "refused",
      message: "a read mutates nothing and needs no persisted intent; call the peer directly",
    };
  }
  const backend = goal.backend;
  const digest = canonicalDigest(params.payload);
  const replay = resolveReplay(backend, params.operationId, digest);
  if (replay.verdict === "conflict") {
    return { ok: false, goal, code: "replay-conflict", message: replay.message };
  }
  if (replay.verdict === "identical") {
    // Already acknowledged: hand back the retained result without touching the
    // peer and without re-running anything.
    return { ok: true, goal, request: requestOf(pendingFrom(params, goal, digest)), replayed: true, receipt: replay.record.receipt };
  }
  if (replay.verdict === "quarantined") {
    return {
      ok: false,
      goal,
      code: "refused",
      message:
        `operation ${params.operationId} was quarantined (${replay.record.reason ?? "no reason recorded"}); ` +
        "re-plan it under a new operation ID",
    };
  }
  if (replay.verdict === "pending") {
    // The same intent, replayed after a crash: reuse the persisted request so
    // the peer sees byte-identical input and can answer idempotently.
    return { ok: true, goal, request: requestOf(replay.pending), replayed: false };
  }
  // Novel work: the state machine is enforced here, before anything is
  // persisted and before the peer is asked (docs/peer-protocol.md §6.1).
  const legality = checkOperationLegality(backend, params);
  if (!legality.ok) {
    return { ok: false, goal, code: "refused", message: legality.message };
  }
  if (backend.pending) {
    return {
      ok: false,
      goal,
      code: "refused",
      message:
        `operation ${backend.pending.operationId} (${backend.pending.kind}) is already pending for this stage; ` +
        "at most one binding, memory or transition operation may be in flight",
    };
  }

  const pending = pendingFrom(params, goal, digest);
  const next = cloneGoal(goal);
  next.backend = {
    ...next.backend,
    // The intended migration is persisted BEFORE the peer is asked, and the
    // state moves with it so execution is withheld during the switch (§3).
    // Only a bind switches authority; an ordinary write against a live binding
    // does not withhold execution.
    state: pending.kind === "bind" ? "binding-pending" : backend.state,
    pending,
    reason: null,
  };
  return { ok: true, goal: next, request: requestOf(pending), replayed: false };
}

function pendingFrom(params: OperationParams, goal: MultiGoal, digest: string): PendingOperation {
  return {
    operationId: params.operationId,
    kind: params.kind,
    expectedState: params.expectedState,
    previousState: goal.backend.state,
    scope: goalScope(goal, params.selection),
    expectedRevision: params.expectedRevision,
    payloadDigest: digest,
    payload: params.payload,
    peerId: params.peerId,
    taskId: params.taskId,
    createdAt: params.now ?? Date.now(),
  };
}

// --- step 3: verify the receipt against the still-current intent ----------

export type AcceptResult =
  | { ok: true; goal: MultiGoal; receipt: PeerReceipt; projection?: unknown }
  | { ok: false; goal: MultiGoal; code: ReceiptRejection; message: string };

function quarantine(goal: MultiGoal, pending: PendingOperation, reason: string, state?: GoalBackendState): MultiGoal {
  const next = cloneGoal(goal);
  next.backend = {
    ...next.backend,
    state: state ?? pending.previousState,
    pending: null,
    operations: retain(next.backend, {
      operationId: pending.operationId,
      kind: pending.kind,
      payloadDigest: pending.payloadDigest,
      outcome: "quarantined",
      receipt: null,
      reason,
    }),
    reason,
  };
  return next;
}

/**
 * Step 3: verify the receipt against the STILL-CURRENT intent and selection,
 * then persist the corresponding backend state. Success is published only
 * after this.
 *
 * The identity checks are the reason a late response is harmless: a receipt
 * that arrives after a pause, a generation change, a branch move, or a
 * cancellation matches no current intent and quarantines itself instead of
 * publishing state. A changed generation quarantines the OPERATION only — §3
 * is explicit that a resume may retain the same memory scope while replacing
 * execution authority, so the binding and its revision pointer survive.
 */
export function acceptReceipt(
  goal: MultiGoal,
  response: PeerResponse,
  selection: PeerSelection,
  options: { export?: GoalMemory } = {},
): AcceptResult {
  const pending = goal.backend.pending;
  if (!pending) {
    // No current intent. An identical, already-acknowledged operation is
    // idempotent; anything else is a late callback with nothing to attach to.
    if (response.status === "committed") {
      const record = goal.backend.operations.find(
        (entry) => entry.operationId === response.receipt.operationId && entry.outcome === "committed",
      );
      if (record && record.payloadDigest === response.receipt.payloadDigest) {
        return { ok: true, goal, receipt: response.receipt };
      }
    }
    return {
      ok: false,
      goal,
      code: "refused",
      message: "the answer matches no current intent for this stage",
    };
  }
  if (!selectionsEqual(pending.scope.selection, selection)) {
    return {
      ok: false,
      goal: quarantine(
        goal,
        pending,
        `operation ${pending.operationId} was planned on branch ${pending.scope.selection.branchAnchorId}; ` +
          `the session/branch selection has moved to ${selection.branchAnchorId}`,
      ),
      code: "stale-selection",
      message: "the live session/branch selection no longer matches the intent this receipt answers",
    };
  }
  if (pending.scope.epoch !== goal.execution.generation) {
    return {
      ok: false,
      goal: quarantine(
        goal,
        pending,
        `operation ${pending.operationId} was planned in execution generation ${pending.scope.epoch}; ` +
          `${goal.execution.generation} is in force`,
        goal.backend.state,
      ),
      code: "stale-epoch",
      message: "the execution generation changed while the operation was in flight",
    };
  }

  const verified = verifyReceipt(requestOf(pending), response);
  if (!verified.ok) {
    if (verified.code === "pending") {
      // Not durably selected: publish nothing, keep the intent for the retry.
      const held = cloneGoal(goal);
      held.backend = { ...held.backend, reason: verified.message };
      return { ok: false, goal: held, code: "pending", message: verified.message };
    }
    // Only a code that positively means "this can never succeed" discards the
    // intent. Everything else — transport failures, and anything this build
    // does not recognise — keeps it for the retry (see TERMINAL_CODES).
    if (!TERMINAL_CODES.has(verified.code)) {
      return {
        ok: false,
        goal: failOperation(goal, { code: verified.code, message: verified.message }),
        code: verified.code,
        message: verified.message,
      };
    }
    return {
      ok: false,
      goal: quarantine(goal, pending, verified.message),
      code: verified.code,
      message: verified.message,
    };
  }

  const receipt = verified.receipt;
  const next = cloneGoal(goal);

  if (pending.expectedState === "detached") {
    // A detach may only complete against a VALIDATED export: §3 forbids
    // silently truncating a projection that does not fit the 8 KiB record.
    // Defence in depth: this is the function that actually replaces the Goal
    // record, so it re-validates rather than trusting its caller. An absent
    // export and an invalid one both hold the switch; neither truncates.
    const exported = options.export;
    const exportCheck = exported
      ? validateMemoryContent(
          { proved: exported.proved, unresolved: exported.unresolved, next: exported.next },
          exported.revision,
        )
      : null;
    if (!exported || !exportCheck?.ok) {
      const message = exportCheck && !exportCheck.ok
        ? `a detach needs a valid export before Goal-only mode resumes. ${exportCheck.message}`
        : "a detach needs a validated export before Goal-only mode resumes";
      const held = cloneGoal(goal);
      held.backend = { ...held.backend, reason: message };
      return { ok: false, goal: held, code: "refused", message };
    }
    next.memory = { ...exported };
    next.backend = {
      ...next.backend,
      state: "detached",
      binding: next.backend.binding
        ? { ...next.backend.binding, selectedRevision: receipt.selectedRevision }
        : null,
      pending: null,
      operations: retain(next.backend, {
        operationId: pending.operationId,
        kind: pending.kind,
        payloadDigest: pending.payloadDigest,
        outcome: "committed",
        receipt,
        reason: null,
      }),
      reason: null,
    };
    return { ok: true, goal: next, receipt, projection: response.status === "committed" ? response.projection : undefined };
  }

  if (pending.kind !== "bind" && !goal.backend.binding) {
    // Defence in depth: no receipt may install a binding that no bind created.
    return {
      ok: false,
      goal: quarantine(goal, pending, "a receipt cannot install a binding that no bind operation created"),
      code: "refused",
      message: "a receipt cannot install a binding that no bind operation created",
    };
  }
  const stage = currentStage(goal);
  next.backend = {
    ...next.backend,
    state: pending.expectedState,
    binding: {
      peerId: next.backend.binding?.peerId ?? pending.peerId ?? "",
      taskId: next.backend.binding?.taskId ?? pending.taskId ?? "",
      goalId: goal.goalId,
      stageId: stage.id,
      generation: goal.execution.generation,
      contractRevision: goal.contractRevision,
      sessionId: pending.scope.selection.sessionId,
      branchAnchorId: pending.scope.selection.branchAnchorId,
      selectedRevision: receipt.selectedRevision,
    },
    pending: null,
    operations: retain(next.backend, {
      operationId: pending.operationId,
      kind: pending.kind,
      payloadDigest: pending.payloadDigest,
      outcome: "committed",
      receipt,
      reason: null,
    }),
    reason: null,
  };
  return { ok: true, goal: next, receipt, projection: response.status === "committed" ? response.projection : undefined };
}

/**
 * The codes that positively mean "this operation can never succeed". Anything
 * else — including a code this build does not recognise — keeps its intent.
 *
 * The default matters: an unrecognised code most likely came from a malformed
 * or incompatible peer, which this design classifies as retryable. Discarding
 * the intent on it would turn a recoverable transport problem into permanent
 * loss of the operation, so classification is by this closed TERMINAL set
 * rather than by a closed retryable set with a terminal default.
 */
const TERMINAL_CODES: ReadonlySet<string> = new Set<ReceiptRejection>([
  "stale-selection",
  "stale-epoch",
  "scope-conflict",
  "replay-conflict",
  "refused",
]);

/**
 * Apply a failed attempt. The code decides recovery:
 *
 *  - retryable (`unavailable`, `timeout`, `incompatible`) keeps the persisted
 *    intent so the SAME operation ID and payload can be replayed — that is what
 *    makes the "peer committed but Goal never saw the receipt" boundary
 *    recoverable rather than a lost mutation;
 *  - terminal codes quarantine the intent, keeping its ID so a late receipt can
 *    still be refused, and the caller re-plans under a new one.
 *
 * A terminal failure of a bind that was never bound returns the goal to
 * `unbound`, so a peer that refuses outright cannot wedge a session that never
 * had an authoritative backend to lose (§3 "optional"; §10's P0 warning). This
 * only ever runs after an EXPLICIT bind: nothing here is triggered by merely
 * discovering a checkpoint.
 */
export function failOperation(goal: MultiGoal, failure: { code: string; message: string }): MultiGoal {
  const pending = goal.backend.pending;
  if (!pending) {
    return goal;
  }
  if (TERMINAL_CODES.has(failure.code)) {
    return quarantine(goal, pending, failure.message);
  }
  const next = cloneGoal(goal);
  next.backend = {
    ...next.backend,
    // A bound authority that stopped answering is `bound-unavailable`, never a
    // silent return to Goal's own record (invariant 8). A bind attempt that
    // never landed stays `binding-pending`: the switch is persisted, visible,
    // and recoverable, and abandonOperation is the way out of it.
    state: next.backend.state === "bound-available" ? "bound-unavailable" : next.backend.state,
    reason: failure.message,
  };
  return next;
}

/**
 * Give up on the pending switch. This is a Goal-owned decision — an export that
 * cannot fit, a user who changed their mind — and it frees the stage's one
 * pending slot without pretending the operation succeeded. The ID stays
 * retained, so a late receipt for it is still refused.
 */
export function abandonOperation(goal: MultiGoal, reason: string): MultiGoal {
  const pending = goal.backend.pending;
  if (!pending) {
    return goal;
  }
  return quarantine(goal, pending, reason);
}

/**
 * Branch-selection check 2 (§4: "branch movement must not attach a pending
 * operation to a different branch"). The intent is quarantined rather than
 * rebased: replanning happens under a new ID on the branch that owns it, and
 * the peer's own idempotency prevents a double commit if the original did
 * commit. The BINDING itself is left alone — moving branch is not losing the
 * backend, and it refills no budget.
 */
export function reconcileSelection(goal: MultiGoal, selection: PeerSelection): MultiGoal {
  const pending = goal.backend.pending;
  if (!pending || selectionsEqual(pending.scope.selection, selection)) {
    return goal;
  }
  return quarantine(
    goal,
    pending,
    `operation ${pending.operationId} was planned on branch ${pending.scope.selection.branchAnchorId}; ` +
      `the selection moved to ${selection.branchAnchorId}, so it was not attached`,
  );
}

/**
 * The bound authority stopped answering. §3: preserve the binding, the memory
 * pointers and the allowances; pause Goal-owned execution with a visible
 * reason; do not resurrect the old blob.
 */
export function markPeerUnavailable(goal: MultiGoal, reason: string): MultiGoal {
  if (goal.backend.state !== "bound-available" && goal.backend.state !== "bound-unavailable") {
    return goal;
  }
  const next = cloneGoal(goal);
  next.backend = { ...next.backend, state: "bound-unavailable", reason };
  return next;
}

/** The peer answered again on the revision Goal still believes is selected. */
export function markPeerAvailable(goal: MultiGoal, selectedRevision: string): MultiGoal {
  if (goal.backend.state !== "bound-unavailable" || !goal.backend.binding) {
    return goal;
  }
  const next = cloneGoal(goal);
  next.backend = {
    ...next.backend,
    state: "bound-available",
    binding: { ...next.backend.binding!, selectedRevision },
    reason: null,
  };
  return next;
}

/**
 * End the stage's binding.
 *
 * A binding is scoped to ONE stage: its `scopeId` is
 * `goal:<goalId>:stage:<Stage.id>`, so a transition moves to a scope nothing
 * has bound. The pending intent and the retained receipts go with it — neither
 * can address the new `scopeId` and `contractRevision`, which is exactly "the
 * lifetime in which an operation can be retried" (§4) and satisfies "a stage
 * transition invalidates old reviews and active selections before admitting the
 * next stage" (PI_DAG_COMPACT §1).
 *
 * The next stage therefore starts `unbound`, which is runnable, and pairs with
 * the empty working-memory record §8 mandates — there is no stale blob here to
 * downgrade to, so invariant 8 is not in play. The `reason` records which peer,
 * task and revision the previous stage was bound to, so the change is visible
 * rather than silent.
 *
 * This deliberately does NOT move to `binding-pending`. P0 has no transition
 * operation and no runtime path that submits one, so a pending switch would be
 * a switch nothing could complete: `requestContinuation` would refuse forever,
 * `abandonOperation` would have no intent to act on, and a bound goal would be
 * wedged after stage 1 with no user-reachable exit. No state reachable within
 * P0 may be permanently unrecoverable. Task 5.3 replaces this rule with the
 * durable transition operation that archives the old stage, installs the next
 * stage's protected contract in one scoped mutation, and carries the binding
 * across as part of it.
 */
export function endStageBinding(backend: GoalBackend): GoalBackend {
  if (backend.state === "unbound" && !backend.binding) {
    return { ...backend, pending: null, operations: [], reason: null };
  }
  const previous = backend.binding;
  return {
    state: "unbound",
    binding: null,
    pending: null,
    operations: [],
    reason: previous
      ? `the previous stage's binding to ${previous.peerId} (task ${previous.taskId}, ` +
        `selected revision ${previous.selectedRevision ?? "none"}) ended with that stage; ` +
        "this stage starts unbound because the durable stage-transition operation is not implemented yet"
      : null,
  };
}

// --- the driver -----------------------------------------------------------

export type OperationResult =
  | { ok: true; goal: MultiGoal; receipt: PeerReceipt | null; projection?: unknown; replayed: boolean }
  | { ok: false; goal: MultiGoal; code: ReceiptRejection; message: string };

/**
 * The four-step ordering, end to end. Every caller of a durable Goal-side
 * operation goes through here so that no path can skip the intent, the
 * verification, or the acknowledgement.
 *
 * `detach` is the one kind with an extra step: the export is READ and validated
 * against Goal's 8 KiB record before the peer is asked to release authority.
 * Validating after the release would leave Goal unable to un-release; §3
 * requires the switch to stay pending and report why instead. The export must be
 * PRESENT to be validated: a committed read that carries no projection is a
 * failed export, not an empty one.
 */
export async function runPeerOperation(
  goal: MultiGoal,
  client: PeerClient | null | undefined,
  params: OperationParams,
  options: { timeoutMs?: number } = {},
): Promise<OperationResult> {
  const begun = beginOperation(goal, params);
  if (!begun.ok) {
    return begun;
  }
  if (begun.replayed) {
    return { ok: true, goal: begun.goal, receipt: begun.receipt, replayed: true };
  }

  let exported: GoalMemory | undefined;
  if (params.kind === "detach") {
    const read: PeerRequest = {
      protocolVersion: PEER_PROTOCOL_VERSION,
      operationId: `${params.operationId}:export`,
      kind: "read",
      scope: cloneScope(begun.request.scope),
      expectedRevision: params.expectedRevision,
      payload: { profile: GOAL_PROJECTION_PROFILE },
    };
    const readResponse = await callPeer(client, read, options);
    const readVerified = verifyReceipt(read, readResponse);
    if (!readVerified.ok) {
      return {
        ok: false,
        goal: failOperation(begun.goal, { code: readVerified.code, message: readVerified.message }),
        code: readVerified.code,
        message: readVerified.message,
      };
    }
    // An ABSENT export is not an empty one. A committed read that carries no
    // projection — or a projection with no memory record — means the peer said
    // nothing, and defaulting that to an empty record would let a dropped
    // payload replace the Goal record with nothing and release authority. That
    // is the exact loss this read-then-detach ordering exists to prevent, so
    // absent and empty stay distinguishable: a peer whose working set really is
    // empty says so with a present, correctly typed { proved: [], unresolved:
    // [], next: "" }. Missing fields are left missing here rather than filled
    // in, so validateMemoryContent refuses them on the schema check.
    const projection = readResponse.status === "committed" ? readResponse.projection : undefined;
    const record =
      projection && typeof projection === "object"
        ? (projection as { memory?: unknown }).memory
        : undefined;
    const holdSwitch = (message: string): OperationResult => {
      // The switch stays pending with a visible reason; nothing is truncated
      // and authority is never released on an export Goal cannot hold.
      const held = cloneGoal(begun.goal);
      held.backend = { ...held.backend, reason: message };
      return { ok: false, goal: held, code: "refused", message };
    };
    if (!record || typeof record !== "object") {
      return holdSwitch(
        "Detach refused: the peer acknowledged the export read but returned no projection record, " +
          "so there is nothing to validate. An absent export is not an empty one; the backend switch " +
          "stays pending. Retry it, or abandon the switch.",
      );
    }
    const memory = record as { proved?: unknown; unresolved?: unknown; next?: unknown };
    const validated = validateMemoryContent(
      { proved: memory.proved, unresolved: memory.unresolved, next: memory.next },
      goal.memory.revision + 1,
    );
    if (!validated.ok) {
      return holdSwitch(`Detach refused: the exported projection is not a valid Goal record. ${validated.message}`);
    }
    exported = {
      revision: goal.memory.revision + 1,
      proved: validated.proved,
      unresolved: validated.unresolved,
      next: validated.next,
    };
  }

  const response = await callPeer(client, begun.request, options);
  const accepted = acceptReceipt(begun.goal, response, params.selection, { export: exported });
  if (!accepted.ok) {
    return accepted;
  }
  return { ok: true, goal: accepted.goal, receipt: accepted.receipt, projection: accepted.projection, replayed: false };
}
