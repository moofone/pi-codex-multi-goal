import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { currentStage } from "./state.js";
import { CREDIT_DIGEST_HEX_CHARS } from "./types.js";
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

/**
 * The fingerprint of a file's current bytes, or null when it cannot be read.
 *
 * NOT for the validation path. It resolves the file BY NAME, which is exactly
 * the window resolveArtifactContent exists to close: between a containment
 * check and a name-based read, a local writer can swap the path for a link out
 * of the workspace. Validation opens once and reads from the descriptor it
 * checked. Use this only where the bytes are not evidence for credit.
 */
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

/**
 * The stored form of a dedupe key. Keys contain project paths of unbounded
 * length, and the record has to be remembered for the whole goal, so what is
 * persisted is a fixed-width digest rather than the key itself.
 */
export function creditKeyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, CREDIT_DIGEST_HEX_CHARS);
}

/**
 * A peer's evidence reference, in the shape `pi-dag-compact` uses. Only an
 * artifact with a content digest can become Goal evidence; the other kinds
 * name things Goal has no way to verify.
 */
export type PeerEvidenceRef =
  | { kind: "session"; sessionId: string; entryId: string }
  | { kind: "research"; taskId: string; recordId: string }
  | { kind: "artifact"; path: string; sha256?: string; recordId?: string };

export type PeerEvidenceConversion =
  | { ok: true; ref: EvidenceRefInput }
  | { ok: false; message: string };

/**
 * Convert a peer evidence reference into a Goal evidence ref (P4).
 *
 * Goal's evidence bar is deliberately narrow: an artifact that exists on disk,
 * whose current bytes match a fingerprint, associated with a criterion of the
 * CURRENT step. A peer reference that cannot meet that bar is REFUSED with a
 * reason. It is never silently dropped — that would let a completion claim
 * coverage it does not have — and never fabricated into a passing ref.
 *
 * The resulting dedupe key is built from the producing operation, the project
 * path, and the content fingerprint. A peer record or node ID never enters it,
 * so re-creating or renaming a node cannot buy a second credit for an artifact
 * that has not changed.
 */
export function convertPeerEvidence(
  ref: PeerEvidenceRef,
  context: { operation: string; criteria: string[] },
): PeerEvidenceConversion {
  if (ref.kind === "session") {
    return {
      ok: false,
      message:
        `Peer evidence rejected: a session reference (${ref.sessionId}/${ref.entryId}) names a ` +
        "transcript entry, which Goal cannot fingerprint. Cite the artifact the work produced.",
    };
  }
  if (ref.kind === "research") {
    return {
      ok: false,
      message:
        `Peer evidence rejected: a research reference (${ref.taskId}/${ref.recordId}) names a peer ` +
        "record, not an artifact. Goal validates artifacts; cite the file the record points at.",
    };
  }
  if (typeof ref.sha256 !== "string" || ref.sha256.length < FINGERPRINT_HEX_CHARS) {
    return {
      ok: false,
      message:
        `Peer evidence rejected: artifact "${ref.path}" carries no sha256 digest, so Goal would have ` +
        "to take the peer's word for its contents.",
    };
  }
  return {
    ok: true,
    ref: {
      operation: context.operation,
      artifact: ref.path,
      // Goal's fingerprint is the sha256 prefix; a peer may carry the full digest.
      fingerprint: ref.sha256.slice(0, FINGERPRINT_HEX_CHARS),
      criteria: context.criteria,
    },
  };
}

/** Is `candidate` the workspace root itself, or somewhere beneath it? */
function containedBy(root: string, candidate: string): boolean {
  const step = relative(root, candidate);
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}

export type ArtifactContent =
  | { ok: true; bytes: Uint8Array }
  /** Outside the workspace, by traversal, absolute path, or a link that leaves it. */
  | { ok: false; reason: "outside" }
  /** Inside the workspace, but there is no readable file there to fingerprint. */
  | { ok: false; reason: "missing" };

/**
 * Read an evidence artifact's bytes, proving as we go that they belong to the
 * project workspace.
 *
 * A lexical `resolve` + `relative` pair only proves the STRING stays under the
 * working directory; it says nothing about where a symlink inside the workspace
 * points, and stat/read follow links. Resolving the real path first and reusing
 * that string closes the gap between the two reads but NOT the gap between the
 * resolution and the reads — a local writer can swap a checked directory or
 * file for a link to an outside path in between, and the fingerprint then
 * covers outside bytes. Since D4 that is not merely a false claim: a credited
 * ref returns a capped grant to the working request budget, so fingerprinting
 * outside bytes buys execution budget.
 *
 * Node exposes no `openat`, and `O_NOFOLLOW` constrains only the final path
 * component, so this is NARROWED, NOT ELIMINATED. The sequence is:
 *
 *   1. open the path once, and hold the descriptor;
 *   2. `fstat` the descriptor — the inode we will actually read;
 *   3. resolve the real path and containment-check it by name;
 *   4. `stat` that resolved name and require the SAME device and inode;
 *   5. read from the DESCRIPTOR, never from the name again.
 *
 * A swap before the open makes step 3 resolve outside and fail. A swap after
 * the open makes step 3 or step 4 disagree with the descriptor and fail. So the
 * bytes fingerprinted always come from an inode that was reachable at a
 * contained path at check time.
 *
 * Residual risks, stated rather than papered over:
 *
 *  - A HARD LINK inside the workspace to an outside file shares that file's
 *    inode, so it genuinely is reachable at a contained path and no path-based
 *    check can distinguish it. Accepted, and characterised in
 *    test/evidence-workspace.test.ts.
 *  - Steps 1, 3 and 4 are separate syscalls. The device/inode pin makes an
 *    interleaved swap detectable rather than exploitable, but it is a
 *    mitigation, not an atomic operation.
 *
 * Both require write access inside the workspace, which is a strictly weaker
 * position than the agent's own: anyone holding it could copy the same bytes in
 * directly. The containment rule ties evidence to project artifacts; it is not
 * and never was a confidentiality boundary.
 */
function resolveArtifactContent(artifact: string): ArtifactContent {
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

  let fd: number | undefined;
  try {
    fd = openSync(resolved, "r");
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      return { ok: false, reason: "missing" };
    }
    const real = realpathSync(resolved);
    if (!containedBy(root, real)) {
      return { ok: false, reason: "outside" };
    }
    const named = statSync(real);
    if (named.dev !== opened.dev || named.ino !== opened.ino) {
      // The name no longer refers to what we opened: something moved under us.
      return { ok: false, reason: "outside" };
    }
    return { ok: true, bytes: readFileSync(fd) };
  } catch {
    // No such path, a dangling link, or an unreadable file: nothing to
    // fingerprint either way.
    return { ok: false, reason: "missing" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
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
    // One open, one read, one inode: the bytes are fetched and proved to belong
    // to the workspace together, so the path is never resolved by name again
    // between the check and the read.
    const content = resolveArtifactContent(ref.artifact);
    if (!content.ok && content.reason === "outside") {
      return refFailure(
        index,
        `artifact "${ref.artifact}" resolves outside the project workspace; evidence must be a ` +
          "project-relative path whose real target stays inside it (a link out of the workspace is not project evidence)",
      );
    }
    if (!content.ok) {
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
    const actual = fingerprintContent(content.bytes);
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
