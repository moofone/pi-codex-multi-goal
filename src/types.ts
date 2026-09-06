export const CUSTOM_ENTRY_TYPE = "pi-codex-multi-goal";
export const MAX_STAGES = 24;
export const MIN_WIZARD_STAGES = 2;
export const MAX_STAGE_TITLE_CHARS = 200;

// Provisional limits — to be validated against the long-run fixtures (Task 9);
// these are not frozen product numbers. Bytes are not a token count.
export const MEMORY_MAX_BYTES = 8192;
export const DEFAULT_NO_PROGRESS_LIMIT = 20;
export const DEFAULT_TOTAL_LIMIT = 200;

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type StageStatus = "pending" | "active" | "complete";
export type GoalEntrySource = "command" | "tool" | "runtime";
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

/** Current-step memory only. Reset when the goal transitions to a new step. */
export interface GoalMemory {
  revision: number;
  proved: string[];
  unresolved: string[];
  next: string;
}

/** Bounded execution grant plus lifetime accounting for the current step. */
export interface GoalExecution {
  generation: number;
  noProgressRemaining: number;
  totalRemaining: number;
  noProgressLimit: number;
  totalLimit: number;
  lifetimeRequests: number;
  tokenUsage: number | null;
}

export interface MultiGoal {
  goalId: string;
  status: GoalStatus;
  stages: Stage[];
  index: number;
  createdAt: number;
  updatedAt: number;
  memory: GoalMemory;
  execution: GoalExecution;
  pauseReason: string | null;
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
