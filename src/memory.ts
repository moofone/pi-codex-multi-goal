import { MEMORY_MAX_BYTES, type GoalMemory } from "./types.js";

const textEncoder = new TextEncoder();

export interface MemoryContentInput {
  proved: unknown;
  unresolved: unknown;
  next: unknown;
}

export type MemoryValidationResult =
  | { ok: true; proved: string[]; unresolved: string[]; next: string }
  | { ok: false; reason: "schema" | "oversized"; message: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Schema and size validation for one memory replace (A02). The revision is
 * supplied by the caller; the limit applies to the UTF-8 JSON of the full
 * record, so multibyte content counts by bytes, not characters. `proved`
 * entries are agent claims — schema validation cannot verify evidence, which
 * is why every entry must stay a short reference to an artifact, operation,
 * revision, or fingerprint rather than a raw log.
 */
export function validateMemoryContent(
  input: MemoryContentInput,
  revision: number,
): MemoryValidationResult {
  if (
    !isStringArray(input.proved) ||
    !isStringArray(input.unresolved) ||
    typeof input.next !== "string"
  ) {
    return {
      ok: false,
      reason: "schema",
      message:
        "Memory update rejected: proved and unresolved must be arrays of strings and next must be a string.",
    };
  }
  const memory: GoalMemory = {
    revision,
    proved: input.proved,
    unresolved: input.unresolved,
    next: input.next,
  };
  const bytes = textEncoder.encode(JSON.stringify(memory)).length;
  if (bytes > MEMORY_MAX_BYTES) {
    return {
      ok: false,
      reason: "oversized",
      message:
        `Memory update rejected: the record is ${bytes} UTF-8 JSON bytes; the limit is ` +
        `${MEMORY_MAX_BYTES}. Keep proved entries as short references to artifacts, operations, ` +
        "revisions, or fingerprints — never raw logs.",
    };
  }
  return { ok: true, proved: memory.proved, unresolved: memory.unresolved, next: memory.next };
}
