import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_COMPACTIONS_WITHOUT_MUTATION } from "./stall.js";

export interface MultiGoalSettings {
  maxCompactionsWithoutMutation: number | null;
  settingsPath: string;
}

export function settingsPath(): string {
  const dir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "pi-codex-multi-goal.json");
}

function parseLimit(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value === 0 ? null : value;
  }
  return undefined;
}

export function parseSettings(raw: unknown, path: string): MultiGoalSettings {
  const fallback: MultiGoalSettings = {
    maxCompactionsWithoutMutation: DEFAULT_MAX_COMPACTIONS_WITHOUT_MUTATION,
    settingsPath: path,
  };
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const parsed = parseLimit((raw as { maxCompactionsWithoutMutation?: unknown }).maxCompactionsWithoutMutation);
  if (parsed === undefined) {
    return fallback;
  }
  return { maxCompactionsWithoutMutation: parsed, settingsPath: path };
}

export function loadSettings(): MultiGoalSettings {
  const path = settingsPath();
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")), path);
  } catch {
    return parseSettings(undefined, path);
  }
}
