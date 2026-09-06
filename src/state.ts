import { randomUUID } from "node:crypto";

import { parseStageTitles, validateTitles } from "./parse.js";
import {
  CUSTOM_ENTRY_TYPE,
  DEFAULT_NO_PROGRESS_LIMIT,
  DEFAULT_TOTAL_LIMIT,
  type Criterion,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalExecution,
  type GoalMemory,
  type GoalResult,
  type GoalStatus,
  MAX_STAGES,
  MEMORY_MAX_BYTES,
  type MultiGoal,
  type SessionEntryLike,
  type Stage,
  type StageStatus,
} from "./types.js";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const V1_MIGRATION_PAUSE_REASON = "migrated from a version-1 goal: confirm criteria to resume";

export function emptyMemory(): GoalMemory {
  return { revision: 0, proved: [], unresolved: [], next: "" };
}

export function freshExecution(): GoalExecution {
  return {
    generation: 0,
    noProgressRemaining: DEFAULT_NO_PROGRESS_LIMIT,
    totalRemaining: DEFAULT_TOTAL_LIMIT,
    noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
    totalLimit: DEFAULT_TOTAL_LIMIT,
    lifetimeRequests: 0,
    tokenUsage: null,
  };
}

export function cloneGoal(goal: MultiGoal): MultiGoal {
  return {
    goalId: goal.goalId,
    status: goal.status,
    index: goal.index,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    memory: {
      revision: goal.memory.revision,
      proved: [...goal.memory.proved],
      unresolved: [...goal.memory.unresolved],
      next: goal.memory.next,
    },
    execution: { ...goal.execution },
    pauseReason: goal.pauseReason,
    stages: goal.stages.map((stage) => ({
      ...stage,
      criteria: stage.criteria.map((criterion) => ({ ...criterion })),
    })),
  };
}

export function currentStage(goal: MultiGoal): Stage {
  const stage = goal.stages[goal.index];
  if (!stage) {
    throw new Error("Goal index is out of range.");
  }
  return stage;
}

export function createGoal(titles: string[], now = unixSeconds()): MultiGoal {
  return {
    goalId: randomUUID(),
    status: "active",
    index: 0,
    createdAt: now,
    updatedAt: now,
    memory: emptyMemory(),
    execution: freshExecution(),
    pauseReason: null,
    // Compat path until Task 3: production constructors still take titles, so
    // each stage starts with the objective as its sole accepted criterion.
    stages: titles.map((title, index) => ({
      id: randomUUID(),
      title,
      status: index === 0 ? "active" : "pending",
      criteria: [{ id: randomUUID(), text: title }],
    })),
  };
}

export function replaceGoalFromTitles(titles: string[]): GoalResult {
  const parsed = validateTitles(titles);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, goal: null };
  }
  const goal = createGoal(parsed.titles);
  return { ok: true, message: formatSetMessage(goal), goal };
}

export function replaceGoal(raw: string): GoalResult {
  const parsed = parseStageTitles(raw);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, goal: null };
  }
  return replaceGoalFromTitles(parsed.titles);
}

function formatSetMessage(goal: MultiGoal): string {
  if (goal.stages.length === 1) {
    return "Goal set.";
  }
  return `Goal set with ${goal.stages.length} stages.`;
}

export function completeCurrentStage(current: MultiGoal | null, now = unixSeconds()): GoalResult {
  if (!current) {
    return { ok: false, message: "No active goal exists.", goal: null };
  }
  if (current.status !== "active") {
    return { ok: false, message: `Goal is ${current.status}.`, goal: current };
  }

  const next = cloneGoal(current);
  next.stages[next.index] = { ...next.stages[next.index]!, status: "complete" };
  next.updatedAt = now;

  if (next.index >= next.stages.length - 1) {
    next.status = "complete";
    return { ok: true, message: "Goal complete.", goal: next };
  }

  next.index += 1;
  next.stages[next.index] = { ...next.stages[next.index]!, status: "active" };
  return {
    ok: true,
    message: `Stage ${next.index + 1}/${next.stages.length} active.`,
    goal: next,
  };
}

export function setGoalStatus(
  current: MultiGoal | null,
  status: Exclude<GoalStatus, "complete">,
  now = unixSeconds(),
): GoalResult {
  if (!current) {
    return { ok: false, message: "No active goal exists.", goal: null };
  }
  if (current.status === "complete") {
    return {
      ok: false,
      message: "Completed goals are terminal; use /goal <objective> to replace or /goal clear.",
      goal: current,
    };
  }
  if (status === "active" && current.status !== "paused" && current.status !== "blocked") {
    return { ok: false, message: `Goal is already ${current.status}.`, goal: current };
  }
  if (status === "paused" && current.status !== "active") {
    return { ok: false, message: `Goal is ${current.status}.`, goal: current };
  }
  if (status === "blocked" && current.status !== "active") {
    return { ok: false, message: `Goal is ${current.status}.`, goal: current };
  }

  const next = cloneGoal(current);
  next.status = status;
  next.updatedAt = now;
  const message =
    status === "active" ? "Goal resumed." : status === "paused" ? "Goal paused." : "Goal blocked.";
  return { ok: true, message, goal: next };
}

export function setEntry(goal: MultiGoal, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return { version: 2, kind: "set", source, goal: cloneGoal(goal), at };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return { version: 2, kind: "clear", source, clearedGoalId, at };
}

function isStage(value: unknown): value is Stage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stage = value as Stage;
  return (
    typeof stage.id === "string" &&
    stage.id.length > 0 &&
    typeof stage.title === "string" &&
    (stage.status === "pending" || stage.status === "active" || stage.status === "complete") &&
    Array.isArray(stage.criteria) &&
    stage.criteria.every(isCriterion)
  );
}

function isCriterion(value: unknown): value is Criterion {
  if (!value || typeof value !== "object") {
    return false;
  }
  const criterion = value as Criterion;
  return (
    typeof criterion.id === "string" &&
    criterion.id.length > 0 &&
    typeof criterion.text === "string" &&
    criterion.text.length > 0 &&
    (criterion.requiresHumanDecision === undefined ||
      typeof criterion.requiresHumanDecision === "boolean")
  );
}

const textEncoder = new TextEncoder();

function isGoalMemory(value: unknown): value is GoalMemory {
  if (!value || typeof value !== "object") {
    return false;
  }
  const memory = value as GoalMemory;
  if (!Number.isInteger(memory.revision) || memory.revision < 0) {
    return false;
  }
  if (!Array.isArray(memory.proved) || !memory.proved.every((item) => typeof item === "string")) {
    return false;
  }
  if (
    !Array.isArray(memory.unresolved) ||
    !memory.unresolved.every((item) => typeof item === "string")
  ) {
    return false;
  }
  if (typeof memory.next !== "string") {
    return false;
  }
  return textEncoder.encode(JSON.stringify(memory)).length <= MEMORY_MAX_BYTES;
}

function isGoalExecution(value: unknown): value is GoalExecution {
  if (!value || typeof value !== "object") {
    return false;
  }
  const execution = value as GoalExecution;
  return (
    Number.isInteger(execution.generation) &&
    execution.generation >= 0 &&
    Number.isInteger(execution.noProgressRemaining) &&
    execution.noProgressRemaining >= 0 &&
    Number.isInteger(execution.totalRemaining) &&
    execution.totalRemaining >= 0 &&
    Number.isInteger(execution.noProgressLimit) &&
    execution.noProgressLimit > 0 &&
    Number.isInteger(execution.totalLimit) &&
    execution.totalLimit > 0 &&
    Number.isInteger(execution.lifetimeRequests) &&
    execution.lifetimeRequests >= 0 &&
    (execution.tokenUsage === null ||
      (typeof execution.tokenUsage === "number" && Number.isFinite(execution.tokenUsage)))
  );
}

export function isMultiGoal(value: unknown): value is MultiGoal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const goal = value as MultiGoal;
  if (
    typeof goal.goalId !== "string" ||
    goal.goalId.length === 0 ||
    (goal.status !== "active" &&
      goal.status !== "paused" &&
      goal.status !== "blocked" &&
      goal.status !== "complete") ||
    !Number.isInteger(goal.index) ||
    typeof goal.createdAt !== "number" ||
    typeof goal.updatedAt !== "number" ||
    !Array.isArray(goal.stages) ||
    goal.stages.length === 0 ||
    goal.stages.length > MAX_STAGES ||
    !goal.stages.every(isStage) ||
    !isGoalMemory(goal.memory) ||
    !isGoalExecution(goal.execution) ||
    !(goal.pauseReason === null || typeof goal.pauseReason === "string")
  ) {
    return false;
  }
  if (goal.index < 0 || goal.index >= goal.stages.length) {
    return false;
  }

  const stageIds = new Set(goal.stages.map((stage) => stage.id));
  if (stageIds.size !== goal.stages.length) {
    return false;
  }
  for (const stage of goal.stages) {
    const criterionIds = new Set(stage.criteria.map((criterion) => criterion.id));
    if (criterionIds.size !== stage.criteria.length) {
      return false;
    }
  }

  // Consistent unique active stage: at most one, and it must sit at index.
  const activePositions = goal.stages.flatMap((stage, position) =>
    stage.status === "active" ? [position] : [],
  );
  if (activePositions.length > 1) {
    return false;
  }
  if (activePositions.length === 1 && activePositions[0] !== goal.index) {
    return false;
  }
  if (goal.status === "active" && goal.stages[goal.index]!.status !== "active") {
    return false;
  }

  // Missing criteria cannot start or keep running a goal (A01). Paused- and
  // completed-status goals may hold criteria-less stages (v1 migration).
  if (goal.status === "active" || goal.status === "blocked") {
    const runnableStagesHaveCriteria = goal.stages.every(
      (stage) =>
        (stage.status !== "pending" && stage.status !== "active") || stage.criteria.length > 0,
    );
    if (!runnableStagesHaveCriteria) {
      return false;
    }
  }

  return true;
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 2 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  return entry.kind === "set" && isMultiGoal(entry.goal);
}

interface V1GoalShape {
  goalId: string;
  status: GoalStatus;
  index: number;
  createdAt: number;
  updatedAt: number;
  stages: Array<{ title: string; status: StageStatus }>;
}

function isV1Goal(value: unknown): value is V1GoalShape {
  if (!value || typeof value !== "object") {
    return false;
  }
  const goal = value as V1GoalShape;
  if (
    typeof goal.goalId !== "string" ||
    goal.goalId.length === 0 ||
    (goal.status !== "active" &&
      goal.status !== "paused" &&
      goal.status !== "blocked" &&
      goal.status !== "complete") ||
    !Number.isInteger(goal.index) ||
    typeof goal.createdAt !== "number" ||
    typeof goal.updatedAt !== "number" ||
    !Array.isArray(goal.stages) ||
    goal.stages.length === 0
  ) {
    return false;
  }
  return (
    goal.index >= 0 &&
    goal.index < goal.stages.length &&
    goal.stages.every(
      (stage) =>
        !!stage &&
        typeof stage.title === "string" &&
        (stage.status === "pending" || stage.status === "active" || stage.status === "complete"),
    )
  );
}

function isV1SetEntry(data: unknown): data is { kind: "set"; goal: V1GoalShape } {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as { version?: unknown; kind?: unknown; goal?: unknown };
  return entry.version === 1 && entry.kind === "set" && isV1Goal(entry.goal);
}

function isV1ClearEntry(data: unknown): data is { kind: "clear" } {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as { version?: unknown; kind?: unknown };
  return entry.version === 1 && entry.kind === "clear";
}

/**
 * Migrate a version-1 snapshot. Stage titles and statuses (including completed
 * ones) are preserved exactly; criteria are never invented; unfinished goals
 * come back paused awaiting criteria confirmation, with a fresh bounded grant.
 * Missing safety history is not refilled: lifetime accounting starts at zero.
 * Stage IDs are derived deterministically so repeated replays of the same entry
 * yield identical snapshots.
 */
export function migrateV1Goal(v1: V1GoalShape): MultiGoal {
  const complete = v1.status === "complete";
  return {
    goalId: v1.goalId,
    status: complete ? "complete" : "paused",
    index: v1.index,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    memory: emptyMemory(),
    execution: freshExecution(),
    pauseReason: complete ? null : V1_MIGRATION_PAUSE_REASON,
    stages: v1.stages.map((stage, position) => ({
      id: `${v1.goalId}:stage:${position}`,
      title: stage.title,
      status: stage.status,
      criteria: [],
    })),
  };
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): MultiGoal | null {
  let goal: MultiGoal | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data;
    if (isGoalCustomEntry(data)) {
      goal = data.kind === "clear" ? null : cloneGoal(data.goal);
    } else if (isV1ClearEntry(data)) {
      goal = null;
    } else if (isV1SetEntry(data)) {
      goal = cloneGoal(migrateV1Goal(data.goal));
    }
    // Anything else is malformed; skip it and keep the last valid snapshot.
  }
  return goal;
}

export function goalsEquivalent(left: MultiGoal, right: MultiGoal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
