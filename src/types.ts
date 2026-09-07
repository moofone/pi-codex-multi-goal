import type { PeerOperationKind, PeerReceipt, PeerScope } from "./peer.js";

export const CUSTOM_ENTRY_TYPE = "pi-codex-multi-goal";
export const MAX_STAGES = 24;
export const MIN_WIZARD_STAGES = 2;
export const MAX_STAGE_TITLE_CHARS = 200;

// Provisional limits — to be validated against the long-run fixtures (Task 9);
// these are not frozen product numbers. Bytes are not a token count.
export const MEMORY_MAX_BYTES = 8192;
export const DEFAULT_NO_PROGRESS_LIMIT = 20;
/**
 * The step's working request budget. Unlike the old always-incrementing total,
 * novel verified evidence renews it by a capped grant, so a long productive
 * step is not killed for being long (D4 / G06).
 */
export const DEFAULT_TOTAL_LIMIT = 400;
/**
 * Goal-owned provider requests admitted inside ONE agent turn before the loop
 * backstop fires. This is what the old 200-request total was actually added
 * for: an infinite tool loop that never compacts.
 */
export const DEFAULT_TURN_LIMIT = 40;
/** Working-total requests returned by one novel verified evidence ref. */
export const DEFAULT_EVIDENCE_GRANT = 50;
/** Hard per-step ceiling on admitted requests. Nothing renews it. */
export const DEFAULT_LIFETIME_CEILING = 1000;
/** Consumed fraction of any one budget before the footer starts showing it. */
export const BUDGET_WARNING_FRACTION = 0.8;
/** Maximum credited-evidence dedupe keys kept on one execution grant. */
export const MAX_CREDITED_EVIDENCE = 64;
/**
 * Durable operation receipts kept per stage. Retention only has to cover the
 * lifetime in which an operation can be retried (GOAL_WITH_DAG_SUPPORT §4), and
 * a stage transition changes the scope identity, so the list is cleared there
 * rather than growing for the life of the goal.
 */
export const MAX_RETAINED_OPERATIONS = 16;

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type StageStatus = "pending" | "active" | "complete";
export type GoalEntrySource = "command" | "tool" | "runtime";
// "stage_advance" is the single continuation a persisted, isolated step
// transition may schedule (Task 8): one kickoff for the freshly admitted step,
// only after the completion boundary is committed.
export type GoalContinuationKind = "continuation" | "command_start" | "command_resume" | "stage_advance";

export interface Criterion {
  id: string;
  text: string;
  requiresHumanDecision?: boolean;
}

/** One human-authored step of a goal contract: an objective plus accepted criteria. */
export interface GoalStep {
  objective: string;
  criteria: string[];
}

export interface Stage {
  id: string;
  title: string;
  status: StageStatus;
  criteria: Criterion[];
}

/** Bounded working-memory record of the current step. Reset when the goal transitions to a new step. */
export interface GoalMemory {
  revision: number;
  proved: string[];
  unresolved: string[];
  next: string;
}

/**
 * Bounded execution grant plus lifetime accounting for the current step.
 *
 * Four independent fuses, in three units (D4):
 *
 * - `noProgressRemaining` counts full contexts, charged on session_compact.
 * - `turnRequests` counts goal-owned provider requests inside one agent turn.
 *   This is the runaway-loop backstop; it resets at every turn boundary and
 *   whenever novel verified evidence proves the turn is doing real work.
 * - `totalRemaining` is the step's working request budget. Novel verified
 *   evidence renews it by `evidenceGrant`, never above `totalLimit`.
 * - `lifetimeRequests` counts every admitted request this step against
 *   `lifetimeCeiling`. Nothing renews it: not evidence, not `/goal resume`.
 */
export interface GoalExecution {
  generation: number;
  /** Full contexts remaining before a no-progress pause. */
  noProgressRemaining: number;
  /** Goal-owned provider requests remaining in this step's working budget. */
  totalRemaining: number;
  /** Goal-owned provider requests already admitted in the current agent turn. */
  turnRequests: number;
  noProgressLimit: number;
  totalLimit: number;
  turnLimit: number;
  /** Working-total requests returned by one novel verified evidence ref. */
  evidenceGrant: number;
  /** Admitted goal-owned provider requests this step (never refunded). */
  lifetimeRequests: number;
  /** Unrenewable hard stop for `lifetimeRequests`. */
  lifetimeCeiling: number;
  tokenUsage: number | null;
  /** Dedupe keys of evidence refs that already received progress credit. */
  creditedEvidence: string[];
}

/**
 * The five backend states of GOAL_WITH_DAG_SUPPORT §3.
 *
 * `unbound` is not a degraded mode: it is today's Goal-only behaviour, and P0
 * must not start rejecting working Goal-only memory writes just because it
 * discovers a checkpoint (§10, P0 row; invariant 1). Optional means a peer is
 * not required to START an unbound goal — it does not mean an authoritative
 * backend may disappear without recovery, which is why an explicit disable or
 * unload after binding takes the unavailable or detached path, never a silent
 * return to `unbound`.
 */
export type GoalBackendState =
  | "unbound"
  | "binding-pending"
  | "bound-available"
  | "bound-unavailable"
  | "detached";

/**
 * The minimum binding state needed for recovery (§3). `stageId` is `Stage.id`
 * (PI_DAG_COMPACT D7): the displayed step number is not identity. The recorded
 * generation, contract revision and session/branch selection are what let a
 * stale callback be detected — a receipt is compared against the identity the
 * operation was PLANNED with, not against whatever is current when it lands.
 */
export interface GoalBinding {
  peerId: string;
  /** The peer's own work identity for this binding. */
  taskId: string;
  goalId: string;
  stageId: string;
  generation: number;
  contractRevision: string;
  sessionId: string;
  branchAnchorId: string;
  /**
   * The selected durable revision: the current working set. Checkpoints are
   * recovery anchors; this identifies what is in force. Null until the bind
   * receipt lands.
   */
  selectedRevision: string | null;
}

/**
 * One persisted intent (§4 step 1): enough to retry the SAME operation after a
 * crash at any of the four partial-write boundaries. At most one may be
 * pending for a stage.
 */
export interface PendingOperation {
  operationId: string;
  kind: PeerOperationKind;
  /** The backend state this operation intends to reach. */
  expectedState: GoalBackendState;
  /** The state to return to if it never gets there. */
  previousState: GoalBackendState;
  /** The identity it was planned with, including the branch selection. */
  scope: PeerScope;
  expectedRevision: string | null;
  payloadDigest: string;
  payload: unknown;
  /** Peer identity to record on the binding when this operation is accepted. */
  peerId?: string;
  taskId?: string;
  createdAt: number;
}

export type OperationOutcome = "committed" | "quarantined";

/**
 * A retained operation record. A committed one answers an identical replay
 * without touching the peer; a quarantined one refuses a late receipt and
 * tells the caller to re-plan under a new ID.
 */
export interface RetainedOperation {
  operationId: string;
  kind: PeerOperationKind;
  /**
   * The identity the operation was planned with. Retained so a replay must
   * match the whole intent: two operations that differ in kind, scope,
   * selection or expected revision can carry byte-equal payloads, and matching
   * on the id and payload alone would hand one of them the other's receipt.
   */
  scope: PeerScope;
  expectedRevision: string | null;
  payloadDigest: string;
  outcome: OperationOutcome;
  receipt: PeerReceipt | null;
  reason: string | null;
}

export interface GoalBackend {
  state: GoalBackendState;
  binding: GoalBinding | null;
  pending: PendingOperation | null;
  operations: RetainedOperation[];
  /** Why execution is withheld or why the last switch did not complete. */
  reason: string | null;
}

export interface MultiGoal {
  goalId: string;
  status: GoalStatus;
  stages: Stage[];
  index: number;
  /**
   * Deterministic identity of the current step's human contract: sha256 of the
   * objective, the ordered criterion IDs and text, and the human-decision
   * flags. Derived from the criteria, never authored, and recomputed on every
   * load, so a stale or tampered stored value cannot make a bound peer trust
   * the wrong contract. See `computeContractRevision`.
   */
  contractRevision: string;
  createdAt: number;
  updatedAt: number;
  memory: GoalMemory;
  execution: GoalExecution;
  /**
   * Which working-memory authority is in force, and any operation still in
   * flight to it. A goal that never meets a peer carries `unbound` here for
   * its whole life and behaves exactly as it did before P0.
   */
  backend: GoalBackend;
  pauseReason: string | null;
  /**
   * Provider-visible isolation boundary (epoch ms) recorded when a step
   * transition was accepted: messages at or before this point belong to the
   * completed step and are dropped from model context.
   */
  isolationCutoff: number | null;
}

export type GoalCustomEntry =
  | {
      version: 2;
      kind: "set";
      source: GoalEntrySource;
      goal: MultiGoal;
      at: number;
    }
  | {
      version: 2;
      kind: "clear";
      source: GoalEntrySource;
      clearedGoalId: string | null;
      at: number;
    };

export interface GoalResult {
  ok: boolean;
  message: string;
  goal: MultiGoal | null;
}

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
