import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { currentStage } from "./state.js";
import type { MultiGoal } from "./types.js";

/**
 * The one evidence-validation path (Task 8). Both mid-step progress credit and
 * completion coverage validate their evidence refs here: reference existence,
 * producing operation, content fingerprint, and criterion association. Novelty
 * ("not already credited") is accounting, applied by allowance.creditVerifiedEvidence.
 *
 * These are deliberately narrow deterministic checks. They establish
 * provenance and novelty, not semantic relevance: a filename, a successful
 * tool exit, changed memory text, or a bare edit/write/apply_patch name earns
 * nothing — the ref must point at an existing artifact whose current bytes
 * match the fingerprint and that the agent associates with a criterion of the
 * CURRENT step. Unverifiable claims stay in memory without resetting counters.
 */

/** Length (hex characters) of the artifact content fingerprint. */
export const FINGERPRINT_HEX_CHARS = 16;

/**
 * Operations that can produce or expose an artifact. Bookkeeping tools
 * (update_goal, update_goal_memory) are deliberately absent: naming them is
 * never evidence.
 */
export const PRODUCING_OPERATIONS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "edit",
  "write",
  "apply_patch",
  "grep",
  "glob",
  "find",
  "ls",
]);

export interface EvidenceRefInput {
  operation: string;
  artifact: string;
  fingerprint: string;
  criteria: string[];
}

export interface ValidatedEvidence extends EvidenceRefInput {
  /** Dedupe key used for "not already credited". */
  key: string;
}

export type EvidenceValidation =
  | { ok: true; refs: ValidatedEvidence[] }
  | { ok: false; message: string };

export function fingerprintContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, FINGERPRINT_HEX_CHARS);
}

/** The fingerprint of a file's current bytes, or null when it cannot be read. */
export function fingerprintFile(absolutePath: string): string | null {
  try {
    return fingerprintContent(readFileSync(absolutePath));
  } catch {
    return null;
  }
}

/**
 * The dedupe key for credited evidence. All three fields are model-supplied, so
 * the encoding has to be injective or one artifact's credit could block
 * another's — but it IS injective, and only because of two invariants enforced
 * by validateEvidenceRefs before this is ever called: `operation` comes from
 * the closed PRODUCING_OPERATIONS set (none of which contains `#`), and
 * `fingerprint` is exactly FINGERPRINT_HEX_CHARS lowercase hex. With the first
 * field drawn from a delimiter-free set and the last of fixed length, only
 * `artifact` is free, and it cannot reach across either boundary.
 *
 * If either invariant is ever relaxed — a producing operation containing `#`,
 * or a variable-width fingerprint — this must become a length-prefixed or JSON
 * encoding, as scopeKey and goalScopeId are. Do not weaken them silently.
 */
export function evidenceKey(ref: EvidenceRefInput): string {
  return `${ref.operation}#${ref.artifact}#${ref.fingerprint}`;
}

/** Is `candidate` the workspace root itself, or somewhere beneath it? */
function containedBy(root: string, candidate: string): boolean {
  const step = relative(root, candidate);
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}

export type ArtifactResolution =
  | { ok: true; path: string }
  /** Outside the workspace, by traversal, absolute path, or a link that leaves it. */
  | { ok: false; reason: "outside" }
  /** Inside the workspace, but nothing is there to fingerprint. */
  | { ok: false; reason: "missing" };

/**
 * Resolve an evidence ref to a real path inside the workspace.
 *
 * The lexical `resolve` + `relative` pair only proves the STRING stays under
 * the working directory. It says nothing about where a symlink INSIDE the
 * workspace points, and statSync/readFileSync follow links — so a ref naming an
 * ordinary-looking project path could fingerprint any readable file on the
 * machine. Since D4 that is not merely a false claim: a credited ref returns a
 * capped grant to the working request budget, so it would be a way to buy
 * execution budget by pointing at /etc/hosts.
 *
 * Links are resolved rather than banned — a symlinked directory inside a
 * project is ordinary — and the REAL path is what is returned, so the caller
 * stats and reads exactly the path that was checked. There is no window
 * between the check and the read in which the target could be swapped for a
 * link out of the workspace.
 *
 * The workspace root is realpath'd too: on a platform whose working directory
 * is reached through a symlink (macOS `/var` -> `/private/var`), comparing a
 * resolved target against an unresolved root would read as an escape.
 */
function resolveArtifactPath(artifact: string): ArtifactResolution {
  if (artifact.length === 0 || isAbsolute(artifact)) {
    return { ok: false, reason: "outside" };
  }
  let root: string;
  try {
    root = realpathSync(process.cwd());
  } catch {
    return { ok: false, reason: "outside" };
  }
  // Cheap lexical cut first, so an obvious traversal never reaches the disk.
  const resolved = resolve(root, artifact);
  if (!containedBy(root, resolved)) {
    return { ok: false, reason: "outside" };
  }
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    // No such path, or a dangling link: nothing to fingerprint either way.
    return { ok: false, reason: "missing" };
  }
  if (!containedBy(root, real)) {
    return { ok: false, reason: "outside" };
  }
  return { ok: true, path: real };
}

function refFailure(index: number, message: string): { ok: false; message: string } {
  return { ok: false, message: `Evidence ref ${index + 1} rejected: ${message}` };
}

/**
 * Validate an array of raw evidence refs against the CURRENT step. Every ref
 * must pass all four narrow checks; one invalid ref rejects the whole batch
 * (missing or stale evidence can neither complete a step nor earn credit).
 */
export function validateEvidenceRefs(goal: MultiGoal, refs: unknown): EvidenceValidation {
  if (!Array.isArray(refs) || refs.length === 0) {
    return {
      ok: false,
      message:
        "Evidence rejected: provide at least one evidence ref " +
      "{ operation, artifact, fingerprint, criteria } per covered criterion.",
    };
  }
  const criteria = new Set(currentStage(goal).criteria.map((criterion) => criterion.id));
  const validated: ValidatedEvidence[] = [];
  for (const [index, raw] of refs.entries()) {
    if (!raw || typeof raw !== "object") {
      return refFailure(index, "each ref must be an object");
    }
    const ref = raw as Partial<EvidenceRefInput>;
    if (typeof ref.operation !== "string" || !PRODUCING_OPERATIONS.has(ref.operation)) {
      return refFailure(
        index,
        `"${String(ref.operation)}" is not a producing operation; name the tool run that produced the artifact ` +
          "(bash, read, edit, write, apply_patch, grep, glob, find, ls). Bookkeeping tool names are never evidence.",
      );
    }
    if (typeof ref.artifact !== "string") {
      return refFailure(index, "artifact must be a project-relative path without traversal");
    }
    const resolution = resolveArtifactPath(ref.artifact);
    if (!resolution.ok && resolution.reason === "outside") {
      return refFailure(
        index,
        `artifact "${ref.artifact}" resolves outside the project workspace; evidence must be a ` +
          "project-relative path whose real target stays inside it (a link out of the workspace is not project evidence)",
      );
    }
    if (!resolution.ok) {
      return refFailure(index, `artifact "${ref.artifact}" does not exist`);
    }
    // The real, contained path — the same string that is stat'd and read below.
    const artifactPath = resolution.path;
    let exists = false;
    try {
      exists = statSync(artifactPath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      return refFailure(index, `artifact "${ref.artifact}" does not exist`);
    }
    if (
      typeof ref.fingerprint !== "string" ||
      ref.fingerprint.length !== FINGERPRINT_HEX_CHARS ||
      !/^[0-9a-f]+$/.test(ref.fingerprint)
    ) {
      return refFailure(
        index,
        `fingerprint must be ${FINGERPRINT_HEX_CHARS} lowercase hex characters (sha256 prefix of the artifact bytes)`,
      );
    }
    const actual = fingerprintFile(artifactPath);
    if (actual !== ref.fingerprint) {
      return refFailure(
        index,
        `stale evidence: the fingerprint does not match the current bytes of "${ref.artifact}" ` +
          `(${actual ?? "unreadable"}); re-verify and recompute it`,
      );
    }
    if (
      !Array.isArray(ref.criteria) ||
      ref.criteria.length === 0 ||
      !ref.criteria.every((id) => typeof id === "string")
    ) {
      return refFailure(index, "associate the ref with at least one criterion id of the current step");
    }
    if (ref.criteria.some((id) => !criteria.has(id))) {
      return refFailure(
        index,
        "criterion association failed: every criterion id must belong to the CURRENT step of this goal",
      );
    }
    validated.push({
      operation: ref.operation,
      artifact: ref.artifact,
      fingerprint: ref.fingerprint,
      criteria: ref.criteria,
      key: evidenceKey({ operation: ref.operation, artifact: ref.artifact, fingerprint: ref.fingerprint, criteria: [] }),
    });
  }
  return { ok: true, refs: validated };
}

export type CoverageCheck = { ok: true } | { ok: false; message: string };

/**
 * Completion requires criterion-to-evidence coverage: every criterion of the
 * current step must be covered by at least one validated ref. Human-decision
 * criteria are handled by the caller (they can never be completed from agent
 * evidence).
 */
export function checkEvidenceCoverage(
  goal: MultiGoal,
  refs: ValidatedEvidence[],
): CoverageCheck {
  const uncovered = currentStage(goal).criteria.filter(
    (criterion) => !refs.some((ref) => ref.criteria.includes(criterion.id)),
  );
  if (uncovered.length > 0) {
    const missing = uncovered.map((criterion) => `"${criterion.id}" (${criterion.text})`).join(", ");
    return {
      ok: false,
      message:
        `Completion rejected: no evidence covers ${missing}. ` +
        "Every criterion needs at least one valid evidence ref.",
    };
  }
  return { ok: true };
}
