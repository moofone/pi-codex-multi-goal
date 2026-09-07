import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_EVIDENCE_GRANT,
  DEFAULT_LIFETIME_CEILING,
  DEFAULT_NO_PROGRESS_LIMIT,
  DEFAULT_TOTAL_LIMIT,
  DEFAULT_TURN_LIMIT,
} from "./types.js";

export interface MultiGoalSettings {
  noProgressLimit: number;
  totalLimit: number;
  turnLimit: number;
  evidenceGrant: number;
  lifetimeCeiling: number;
  settingsPath: string;
}

export function settingsPath(): string {
  const dir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "pi-codex-multi-goal.json");
}

/**
 * Only positive integers are limits. There is no unlimited mode: 0, null,
 * and malformed values clamp to the finite defaults.
 */
function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Finite limits only. `maxCompactionsWithoutMutation` is the legacy name for
 * the no-progress full-context limit: when no explicit `noProgressLimit` is
 * set, a positive legacy value migrates onto it (same unit: context windows).
 * Its old 0/null "disable" meaning clamps to the finite default instead of
 * disabling admission.
 */
export function parseSettings(raw: unknown, path: string): MultiGoalSettings {
  const fallback: MultiGoalSettings = {
    noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
    totalLimit: DEFAULT_TOTAL_LIMIT,
    turnLimit: DEFAULT_TURN_LIMIT,
    evidenceGrant: DEFAULT_EVIDENCE_GRANT,
    lifetimeCeiling: DEFAULT_LIFETIME_CEILING,
    settingsPath: path,
  };
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const record = raw as {
    noProgressLimit?: unknown;
    totalLimit?: unknown;
    turnLimit?: unknown;
    evidenceGrant?: unknown;
    lifetimeCeiling?: unknown;
    maxCompactionsWithoutMutation?: unknown;
  };
  const legacy = parsePositiveInteger(record.maxCompactionsWithoutMutation);
  const totalLimit = parsePositiveInteger(record.totalLimit) ?? DEFAULT_TOTAL_LIMIT;
  // The four fuses are checked hardest-first (lifetime, total, turn,
  // no-progress) and that ordering is only meaningful if the limits are ordered
  // too: a turn bound above the working total can never fire, and a working
  // total above the lifetime ceiling is unreachable. A snapshot carrying such a
  // combination is rejected as malformed on load, so clamp a misconfiguration
  // here rather than letting it mint a goal that cannot be reloaded.
  const turnLimit = Math.min(parsePositiveInteger(record.turnLimit) ?? DEFAULT_TURN_LIMIT, totalLimit);
  const lifetimeCeiling = Math.max(
    parsePositiveInteger(record.lifetimeCeiling) ?? DEFAULT_LIFETIME_CEILING,
    totalLimit,
  );
  return {
    noProgressLimit:
      parsePositiveInteger(record.noProgressLimit) ?? legacy ?? DEFAULT_NO_PROGRESS_LIMIT,
    totalLimit,
    turnLimit,
    evidenceGrant: parsePositiveInteger(record.evidenceGrant) ?? DEFAULT_EVIDENCE_GRANT,
    lifetimeCeiling,
    settingsPath: path,
  };
}

export function loadSettings(): MultiGoalSettings {
  const path = settingsPath();
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return parseSettings(undefined, path);
  }
}
