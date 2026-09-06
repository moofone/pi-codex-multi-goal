import { clearEntry, cloneGoal, goalsEquivalent, setEntry } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type MultiGoal } from "./types.js";

interface PersistenceDeps {
  pi?: { appendEntry(customType: string, data?: unknown): void };
}

export function createPersistence(deps: PersistenceDeps = {}) {
  let goal: MultiGoal | null = null;
  let lastPersisted: MultiGoal | null = null;
  let lastWriteFailed = false;

  const getGoal = (): MultiGoal | null => goal;

  const setGoalSnapshot = (next: MultiGoal | null): void => {
    goal = next;
  };

  const syncPersistedSnapshot = (snapshot: MultiGoal | null): void => {
    lastPersisted = snapshot ? cloneGoal(snapshot) : null;
  };

  const flush = (source: GoalEntrySource): boolean => {
    if (!goal) {
      return false;
    }
    if (lastPersisted && goalsEquivalent(goal, lastPersisted)) {
      return false;
    }
    const pending = goal;
    try {
      deps.pi?.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(pending, source));
    } catch {
      // Persistence failed: retain the last committed snapshot and report
      // failure. The uncommitted in-memory snapshot is discarded.
      lastWriteFailed = true;
      goal = lastPersisted ? cloneGoal(lastPersisted) : null;
      return false;
    }
    lastWriteFailed = false;
    lastPersisted = cloneGoal(pending);
    return true;
  };

  const appendClear = (clearedGoalId: string | null, source: GoalEntrySource): boolean => {
    try {
      deps.pi?.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
    } catch {
      // Persistence failed: keep the current committed state and report failure.
      lastWriteFailed = true;
      return false;
    }
    lastWriteFailed = false;
    goal = null;
    lastPersisted = null;
    return true;
  };

  return { appendClear, flush, getGoal, lastWriteFailed: () => lastWriteFailed, setGoalSnapshot, syncPersistedSnapshot };
}

export type GoalPersistence = ReturnType<typeof createPersistence>;
