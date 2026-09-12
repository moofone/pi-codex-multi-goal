import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test, { after } from "node:test";

import { creditVerifiedEvidence } from "../src/allowance.ts";
import {
  convertPeerEvidence,
  fingerprintContent,
  validateEvidenceRefs,
} from "../src/evidence.ts";
import { acceptCompletion, cloneGoal, replaceGoalFromSteps } from "../src/state.ts";
import type { MultiGoal } from "../src/types.ts";

/**
 * P4 — one evidence path shared by Goal and a bound peer
 * (GOAL_WITH_DAG_SUPPORT §7, P4 row).
 *
 * A peer's evidence references are not Goal evidence. Goal's validator checks
 * an artifact that exists on disk whose current bytes match a fingerprint and
 * which the agent associated with a criterion of the CURRENT step. A peer ref
 * that cannot meet that bar must convert to an explicit refusal, never to a
 * silently dropped ref and never to a fabricated one.
 *
 * The dedupe key is derived from the producing operation, the project path and
 * the content fingerprint — never from a peer record or node ID — so renaming
 * or re-creating a node cannot buy a second credit for the same artifact.
 */

/** A goal whose current step has two criteria, plus a real artifact on disk. */
function fixture(): { goal: MultiGoal; artifact: string; fingerprint: string; criterion: string } {
  // The validator only accepts project-relative paths without traversal, so
  // the artifact has to live under the working directory, not in the tmpdir.
  const dir = mkdtempSync(join(process.cwd(), ".goal-evidence-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const absolute = join(dir, "finding.md");
  const bytes = Buffer.from("the pipeline regressed 4 %\n");
  writeFileSync(absolute, bytes);

  const result = replaceGoalFromSteps([
    { objective: "measure the regression", criteria: ["the regression is measured", "it is written down"] },
    { objective: "fix it", criteria: ["the fix lands"] },
  ]);
  assert.ok(result.ok && result.goal, result.message);
  return {
    goal: result.goal,
    artifact: relative(process.cwd(), absolute),
    fingerprint: fingerprintContent(bytes),
    criterion: result.goal.stages[0]!.criteria[0]!.id,
  };
}

test("P4: an artifact peer ref converts to a Goal evidence ref", () => {
  const { goal, artifact, fingerprint, criterion } = fixture();

  const converted = convertPeerEvidence(
    { kind: "artifact", path: artifact, sha256: fingerprint },
    { operation: "read", criteria: [criterion] },
  );

  assert.equal(converted.ok, true, "an artifact ref with a matching digest is convertible");
  assert.ok(converted.ok);
  assert.deepEqual(converted.ref, {
    operation: "read",
    artifact,
    fingerprint,
    criteria: [criterion],
  });

  const validated = validateEvidenceRefs(goal, [converted.ref]);
  assert.equal(validated.ok, true, "and the result passes the same validator completion uses");
});

test("P4: peer refs Goal cannot verify are refused, not dropped or invented", () => {
  const { criterion } = fixture();

  const session = convertPeerEvidence(
    { kind: "session", sessionId: "s-1", entryId: "e-1" },
    { operation: "read", criteria: [criterion] },
  );
  assert.equal(session.ok, false, "a transcript entry is not an artifact Goal can fingerprint");
  assert.ok(!session.ok);
  assert.match(session.message, /session/i);

  const research = convertPeerEvidence(
    { kind: "research", taskId: "t-1", recordId: "r-1" },
    { operation: "read", criteria: [criterion] },
  );
  assert.equal(research.ok, false, "nor is a peer record id");
  assert.ok(!research.ok);
  assert.match(research.message, /research/i);

  // An artifact ref with no digest cannot be verified either: Goal would have
  // to trust the peer's word for the content.
  const undigested = convertPeerEvidence(
    { kind: "artifact", path: "docs/finding.md" },
    { operation: "read", criteria: [criterion] },
  );
  assert.equal(undigested.ok, false, "an artifact without a digest is unverifiable");
  assert.ok(!undigested.ok);
  assert.match(undigested.message, /sha256|digest|fingerprint/i);
});

test("P4: a peer node id never reaches the dedupe key", () => {
  const { goal, artifact, fingerprint, criterion } = fixture();

  const first = convertPeerEvidence(
    { kind: "artifact", path: artifact, sha256: fingerprint, recordId: "node-1" },
    { operation: "read", criteria: [criterion] },
  );
  const churned = convertPeerEvidence(
    { kind: "artifact", path: artifact, sha256: fingerprint, recordId: "node-2-renamed" },
    { operation: "read", criteria: [criterion] },
  );
  assert.ok(first.ok && churned.ok);

  const validated = validateEvidenceRefs(goal, [first.ref]);
  const revalidated = validateEvidenceRefs(goal, [churned.ref]);
  assert.ok(validated.ok && revalidated.ok);
  assert.equal(
    validated.refs[0]!.key,
    revalidated.refs[0]!.key,
    "the same artifact under a churned node id is the same evidence",
  );

  const credited = creditVerifiedEvidence(goal, [validated.refs[0]!.key]);
  assert.equal(credited.creditedKeys.length, 1);
  const again = creditVerifiedEvidence(credited.goal, [revalidated.refs[0]!.key]);
  assert.deepEqual(again.creditedKeys, [], "node-id churn earns no second credit");
});

