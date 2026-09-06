export const CUSTOM_ENTRY_TYPE = "pi-codex-multi-goal";
export const MAX_STAGES = 24;
export const MIN_WIZARD_STAGES = 2;
export const MAX_STAGE_TITLE_CHARS = 200;
export const STAGE_SEPARATOR = " || ";

export type GoalStatus = "active" | "paused" | "blocked" | "complete";
export type StageStatus = "pending" | "active" | "complete";
export type GoalEntrySource = "command" | "tool" | "runtime";
export type GoalContinuationKind = "continuation" | "command_start" | "command_resume" | "stage_advance";

export interface Stage {
  title: string;
  status: StageStatus;
}

export interface MultiGoal {
  goalId: string;
  status: GoalStatus;
  stages: Stage[];
  index: number;
  createdAt: number;
  updatedAt: number;
}

export type GoalCustomEntry =
  | {
      version: 1;
      kind: "set";
      source: GoalEntrySource;
      goal: MultiGoal;
      at: number;
    }
  | {
      version: 1;
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
