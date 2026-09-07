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
