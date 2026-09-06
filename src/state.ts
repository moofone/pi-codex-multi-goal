import { randomUUID } from "node:crypto";

import { parseStageTitles, validateTitles } from "./parse.js";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalResult,
  type GoalStatus,
  type MultiGoal,
  type SessionEntryLike,
  type Stage,
} from "./types.js";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneGoal(goal: MultiGoal): MultiGoal {
  return {
    goalId: goal.goalId,
    status: goal.status,
    index: goal.index,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    stages: goal.stages.map((stage) => ({ ...stage })),
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
    stages: titles.map((title, index) => ({
      title,
      status: index === 0 ? "active" : "pending",
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
  return { version: 1, kind: "set", source, goal: cloneGoal(goal), at };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return { version: 1, kind: "clear", source, clearedGoalId, at };
}

function isStage(value: unknown): value is Stage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stage = value as Stage;
  return (
    typeof stage.title === "string" &&
    (stage.status === "pending" || stage.status === "active" || stage.status === "complete")
  );
}

export function isMultiGoal(value: unknown): value is MultiGoal {
  if (!value || typeof value !== "object") {
    return false;
  }
  const goal = value as MultiGoal;
  if (
    typeof goal.goalId !== "string" ||
    (goal.status !== "active" &&
      goal.status !== "paused" &&
      goal.status !== "blocked" &&
      goal.status !== "complete") ||
    typeof goal.index !== "number" ||
    typeof goal.createdAt !== "number" ||
    typeof goal.updatedAt !== "number" ||
    !Array.isArray(goal.stages) ||
    goal.stages.length === 0 ||
    !goal.stages.every(isStage)
  ) {
    return false;
  }
  return goal.index >= 0 && goal.index < goal.stages.length;
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  return entry.kind === "set" && isMultiGoal(entry.goal);
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): MultiGoal | null {
  let goal: MultiGoal | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else {
      goal = cloneGoal(entry.data.goal);
    }
  }
  return goal;
}

export function goalsEquivalent(left: MultiGoal, right: MultiGoal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
