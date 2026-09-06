export const DEFAULT_MAX_COMPACTIONS_WITHOUT_MUTATION = 5;

const MUTATING_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);

export interface StallState {
  compactonsWithoutMutation: number;
  mutatedSinceCompact: boolean;
}

export type StallCompactDecision =
  | { type: "ignore" }
  | { type: "reset" }
  | { type: "count"; compactonsWithoutMutation: number }
  | { type: "pause"; compactonsWithoutMutation: number };

export function createStallState(): StallState {
  return { compactonsWithoutMutation: 0, mutatedSinceCompact: false };
}

export function resetStallState(state: StallState): void {
  state.compactonsWithoutMutation = 0;
  state.mutatedSinceCompact = false;
}

export function isMutatingToolName(toolName: string): boolean {
  return MUTATING_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export function isFullContextCompactReason(reason: string): boolean {
  return reason === "threshold" || reason === "overflow";
}

export function noteMutation(state: StallState): void {
  state.mutatedSinceCompact = true;
}

export function stallPauseReason(compactonsWithoutMutation: number): string {
  const windows = compactonsWithoutMutation === 1 ? "window" : "windows";
  return `Goal paused: ${compactonsWithoutMutation} context ${windows} with no code changes. /goal resume to continue.`;
}

export function noteFullContextCompact(
  state: StallState,
  options: { goalActive: boolean; limit: number | null; reason: string },
): StallCompactDecision {
  if (!options.goalActive || options.limit === null || options.limit <= 0) {
    return { type: "ignore" };
  }
  if (!isFullContextCompactReason(options.reason)) {
    return { type: "ignore" };
  }
  if (state.mutatedSinceCompact) {
    state.compactonsWithoutMutation = 0;
    state.mutatedSinceCompact = false;
    return { type: "reset" };
  }
  state.compactonsWithoutMutation += 1;
  if (state.compactonsWithoutMutation >= options.limit) {
    return { type: "pause", compactonsWithoutMutation: state.compactonsWithoutMutation };
  }
  return { type: "count", compactonsWithoutMutation: state.compactonsWithoutMutation };
}
