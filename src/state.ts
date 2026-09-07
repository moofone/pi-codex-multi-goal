import { randomUUID } from "node:crypto";

import {
  advanceBackendToNextStage,
  emptyBackend,
  isGoalBackend,
  normalizeBackend,
} from "./backend.js";
import { computeContractRevision } from "./contract.js";
import { parseStageTitles, validateSteps, validateTitles } from "./parse.js";
import {
  CUSTOM_ENTRY_TYPE,
  DEFAULT_EVIDENCE_GRANT,
  DEFAULT_LIFETIME_CEILING,
  DEFAULT_NO_PROGRESS_LIMIT,
  DEFAULT_TOTAL_LIMIT,
  DEFAULT_TURN_LIMIT,
  MAX_CREDITED_EVIDENCE,
  type Criterion,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalExecution,
  type GoalMemory,
  type GoalResult,
  type GoalStatus,
  type GoalStep,
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

/**
 * The configurable limits of one execution grant. Only `noProgressLimit` and
 * `totalLimit` are required; the fuses added with the D4 budget split fall back
 * to their defaults so existing callers keep compiling and behaving.
 */
export interface ExecutionLimits {
  noProgressLimit: number;
  totalLimit: number;
  turnLimit?: number;
  evidenceGrant?: number;
  lifetimeCeiling?: number;
}

/** A bounded grant: finite limits only, no unlimited mode. */
export function freshExecution(
  limits: ExecutionLimits = {
    noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
    totalLimit: DEFAULT_TOTAL_LIMIT,
  },
): GoalExecution {
  return {
    generation: 0,
    noProgressRemaining: limits.noProgressLimit,
    totalRemaining: limits.totalLimit,
    turnRequests: 0,
    noProgressLimit: limits.noProgressLimit,
    totalLimit: limits.totalLimit,
    turnLimit: limits.turnLimit ?? DEFAULT_TURN_LIMIT,
    evidenceGrant: limits.evidenceGrant ?? DEFAULT_EVIDENCE_GRANT,
    lifetimeRequests: 0,
    lifetimeCeiling: limits.lifetimeCeiling ?? DEFAULT_LIFETIME_CEILING,
    tokenUsage: null,
    creditedEvidence: [],
  };
}

/**
 * Materialise the fuses added with the D4 budget split on a snapshot written
 * by an older build. Spent budgets are preserved exactly; only the missing
 * limits are filled in. Without this an in-flight goal would fail validation
 * after an upgrade and be skipped as malformed.
 */
function normalizeExecution(execution: GoalExecution): GoalExecution {
  return {
    ...execution,
    turnRequests: execution.turnRequests ?? 0,
    turnLimit: execution.turnLimit ?? DEFAULT_TURN_LIMIT,
    evidenceGrant: execution.evidenceGrant ?? DEFAULT_EVIDENCE_GRANT,
    lifetimeCeiling: execution.lifetimeCeiling ?? DEFAULT_LIFETIME_CEILING,
    creditedEvidence: [...(execution.creditedEvidence ?? [])],
  };
}

/**
 * The current step's contract revision, recomputed from the criteria. Every
 * goal that enters memory goes through cloneGoal, so recomputing here is what
 * keeps the field from ever drifting from the contract it identifies — an
 * older snapshot that predates the field gets one, and a stale or tampered
 * stored value is overwritten by the truth.
 */
function currentContractRevision(goal: Omit<MultiGoal, "contractRevision">): string {
  const stage = goal.stages[goal.index];
  return stage ? computeContractRevision(stage) : "";
}

/** Stamp a freshly constructed goal with the identity of its current contract. */
function sealGoal(goal: Omit<MultiGoal, "contractRevision">): MultiGoal {
  return { ...goal, contractRevision: currentContractRevision(goal) };
}

export function cloneGoal(goal: MultiGoal): MultiGoal {
  return {
    goalId: goal.goalId,
    status: goal.status,
    index: goal.index,
    contractRevision: currentContractRevision(goal),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    isolationCutoff: goal.isolationCutoff ?? null,
    memory: {
      revision: goal.memory.revision,
      proved: [...goal.memory.proved],
      unresolved: [...goal.memory.unresolved],
      next: goal.memory.next,
    },
    execution: normalizeExecution(goal.execution),
    // A snapshot written before P0 has no backend record; a goal that never met
    // a peer is `unbound`, which is today's behaviour (invariant 1).
    backend: normalizeBackend(goal.backend),
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

/**
 * Test-compat constructor: each stage gets its objective as its sole criterion.
 * Production start paths must use replaceGoalFromSteps, which requires accepted
 * nonempty human criteria.
 */
export function createGoal(titles: string[], now = unixSeconds()): MultiGoal {
  return sealGoal({
    goalId: randomUUID(),
    status: "active",
    index: 0,
    createdAt: now,
    updatedAt: now,
    isolationCutoff: null,
    memory: emptyMemory(),
    execution: freshExecution(),
    backend: emptyBackend(),
    pauseReason: null,
    stages: titles.map((title, index) => ({
      id: randomUUID(),
      title,
      status: index === 0 ? "active" : "pending",
      criteria: [{ id: randomUUID(), text: title }],
    })),
  });
}

function createGoalFromSteps(
  steps: GoalStep[],
  now = unixSeconds(),
  limits?: { noProgressLimit: number; totalLimit: number },
): MultiGoal {
  return sealGoal({
    goalId: randomUUID(),
    status: "active",
    index: 0,
    createdAt: now,
    updatedAt: now,
    isolationCutoff: null,
    memory: emptyMemory(),
    execution: freshExecution(limits),
    backend: emptyBackend(),
    pauseReason: null,
    stages: steps.map((step, index) => ({
      id: randomUUID(),
      title: step.objective,
      status: index === 0 ? "active" : "pending",
      criteria: step.criteria.map((text) => ({ id: randomUUID(), text })),
    })),
  });
}

export function replaceGoalFromSteps(
  steps: GoalStep[],
  limits?: { noProgressLimit: number; totalLimit: number },
): GoalResult {
  const validated = validateSteps(steps);
  if (!validated.ok) {
    return { ok: false, message: validated.message, goal: null };
  }
  const goal = createGoalFromSteps(validated.steps, unixSeconds(), limits);
  return { ok: true, message: formatSetMessage(goal), goal };
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
  // The step moved, so the contract in force moved with it. cloneGoal stamped
  // the OLD step's revision above; restamp before anyone can read it.
  next.contractRevision = currentContractRevision(next);
  return {
    ok: true,
    message: `Stage ${next.index + 1}/${next.stages.length} active.`,
    goal: next,
  };
}

/**
 * The accepted-completion boundary (Task 8): the old step is marked complete,
 * its working memory is removed, and — when a next step exists — the next step
 * starts with empty memory, a fresh bounded grant (same limits, new generation,
 * its own accounting), and the persisted provider-visible isolation boundary.
 * The optional handoff is the single minimal factual note the next step
 * explicitly depends on; it can never rewrite criteria or add instructions
 * beyond what the bounded memory record already is. Lifetime totals are not
 * reset: they stay visible across grants.
 */
export function acceptCompletion(
  current: MultiGoal | null,
  isolationCutoffMs: number,
  options: { handoff?: string } = {},
  now = unixSeconds(),
): GoalResult {
  const completed = completeCurrentStage(current, now);
  if (!completed.ok || !completed.goal) {
    return completed;
  }
  const next = completed.goal;
  if (next.status === "complete") {
    // Last step: keep the completion receipt in the stages, drop active memory.
    next.memory = emptyMemory();
    next.pauseReason = null;
    return { ok: true, message: "Goal complete.", goal: next };
  }
  next.memory = emptyMemory();
  if (typeof options.handoff === "string" && options.handoff.trim().length > 0) {
    next.memory.proved = [options.handoff.trim().slice(0, 512)];
  }
  // A new step gets a fresh working budget, a fresh no-progress streak, and a
  // fresh turn. lifetimeRequests deliberately carries across steps: the ceiling
  // bounds the whole goal execution, not one step of it.
  next.execution = {
    generation: next.execution.generation + 1,
    noProgressRemaining: next.execution.noProgressLimit,
    totalRemaining: next.execution.totalLimit,
    turnRequests: 0,
    noProgressLimit: next.execution.noProgressLimit,
    totalLimit: next.execution.totalLimit,
    turnLimit: next.execution.turnLimit,
    evidenceGrant: next.execution.evidenceGrant,
    lifetimeRequests: next.execution.lifetimeRequests,
    lifetimeCeiling: next.execution.lifetimeCeiling,
    tokenUsage: next.execution.tokenUsage,
    creditedEvidence: [],
  };
  next.isolationCutoff = isolationCutoffMs;
  // The new stage has a different Stage.id and contractRevision, so no
  // operation planned for the old one can address it: the pending intent and
  // the retained receipts are cleared with the stage they belonged to (§4
  // "operation retention"). A bound goal waits for the next stage's protected
  // contract before it is authoritative again.
  next.backend = advanceBackendToNextStage(next.backend);
  next.pauseReason = null;
  return {
    ok: true,
    message: `Stage ${next.index}/${next.stages.length} complete.`,
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
  // A01/A10: a goal whose runnable stages lack accepted criteria — e.g. a
  // migrated v1 snapshot — can never be activated. It stays paused awaiting
  // criteria confirmation; /goal and /goal-multi start a fresh goal identity
  // with human-confirmed criteria instead.
  if (status === "active") {
    const runnableStagesHaveCriteria = current.stages.every(
      (stage) =>
        (stage.status !== "pending" && stage.status !== "active") || stage.criteria.length > 0,
    );
    if (!runnableStagesHaveCriteria) {
      return {
        ok: false,
        message:
          current.pauseReason ??
          "Cannot resume: a runnable stage has no accepted criteria. Confirm criteria to resume via /goal or /goal-multi; the goal stays paused.",
        goal: current,
      };
    }
  }

  const next = cloneGoal(current);
  next.status = status;
  next.updatedAt = now;
  if (status === "active") {
    // An explicit resume clears the stored explanation; the goal is no longer
    // waiting on a decision.
    next.pauseReason = null;
  }
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
  // creditedEvidence was added in Task 8; snapshots persisted by earlier
  // builds may omit it and are accepted until the next write materializes it.
  const credited = execution.creditedEvidence;
  const creditedValid =
    credited === undefined ||
    (Array.isArray(credited) &&
      credited.length <= MAX_CREDITED_EVIDENCE &&
      credited.every((key) => typeof key === "string" && key.length <= 1024));
  // The turn bound, evidence grant, and lifetime ceiling were added with the
  // D4 budget split; snapshots persisted by earlier builds omit them and are
  // accepted, then materialized by normalizeExecution on load.
  const optionalCounter = (value: unknown): boolean =>
    value === undefined || (Number.isInteger(value) && (value as number) >= 0);
  const optionalLimit = (value: unknown): boolean =>
    value === undefined || (Number.isInteger(value) && (value as number) > 0);
  if (
    !optionalCounter(execution.turnRequests) ||
    !optionalLimit(execution.turnLimit) ||
    !optionalLimit(execution.evidenceGrant) ||
    !optionalLimit(execution.lifetimeCeiling)
  ) {
    return false;
  }
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
      (typeof execution.tokenUsage === "number" && Number.isFinite(execution.tokenUsage))) &&
    creditedValid
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
    // Absent is fine (an older snapshot is unbound); present but unreadable is
    // not, because invariant 8 forbids downgrading an authoritative backend to
    // "there was never a binding". reconstructGoal keeps the last valid one.
    !(goal.backend === undefined || isGoalBackend(goal.backend)) ||
    !(goal.pauseReason === null || typeof goal.pauseReason === "string")
  ) {
    return false;
  }
  // isolationCutoff was added in Task 8; tolerate snapshots persisted by
  // earlier builds until the next write materializes it.
  const cutoff = goal.isolationCutoff;
  if (
    cutoff !== undefined &&
    cutoff !== null &&
    !(typeof cutoff === "number" && Number.isFinite(cutoff) && cutoff >= 0)
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
  return sealGoal({
    goalId: v1.goalId,
    status: complete ? "complete" : "paused",
    index: v1.index,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    isolationCutoff: null,
    memory: emptyMemory(),
    execution: freshExecution(),
    backend: emptyBackend(),
    pauseReason: complete ? null : V1_MIGRATION_PAUSE_REASON,
    stages: v1.stages.map((stage, position) => ({
      id: `${v1.goalId}:stage:${position}`,
      title: stage.title,
      status: stage.status,
      criteria: [],
    })),
  });
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
