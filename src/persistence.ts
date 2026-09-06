import { clearEntry, cloneGoal, goalsEquivalent, setEntry } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type MultiGoal } from "./types.js";

interface PersistenceDeps {
  pi?: { appendEntry(customType: string, data?: unknown): void };
}

export function createPersistence(deps: PersistenceDeps = {}) {
  let goal: MultiGoal | null = null;
  let lastPersisted: MultiGoal | null = null;

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
    deps.pi?.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(goal, source));
    lastPersisted = cloneGoal(goal);
    return true;
  };

  const appendClear = (clearedGoalId: string | null, source: GoalEntrySource): void => {
    deps.pi?.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
    goal = null;
    lastPersisted = null;
  };

  return { appendClear, flush, getGoal, setGoalSnapshot, syncPersistedSnapshot };
}

export type GoalPersistence = ReturnType<typeof createPersistence>;
