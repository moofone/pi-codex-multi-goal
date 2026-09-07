import assert from "node:assert/strict";
import test from "node:test";

import {
  abandonOperation,
  acceptReceipt,
  backendAdmitsExecution,
  beginOperation,
  failOperation,
  goalOwnsMemory,
  goalScope,
  goalScopeId,
  isGoalBackend,
  markPeerAvailable,
  markPeerUnavailable,
  reconcileSelection,
  resolveReplay,
  runPeerOperation,
  type OperationParams,
} from "../src/backend.ts";
import {
  callPeer,
  canonicalDigest,
  scopesEqual,
  verifyReceipt,
  type PeerRequest,
  type PeerScope,
  type PeerSelection,
} from "../src/peer.ts";
import {
  acceptCompletion,
  currentStage,
  isMultiGoal,
  reconstructGoal,
  replaceGoalFromSteps,
  setEntry,
} from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, type MultiGoal } from "../src/types.ts";
import { createFakePeer, operationId } from "./fixtures/fake-peer.ts";

/**
 * The Goal side of P0: the persisted binding lifecycle (GOAL_WITH_DAG_SUPPORT
 * §3), the recoverable four-step ordering (§4), and the P0 gates that do not
 * need a real DAG. The owning boundary is src/backend.ts — the persisted
 * operation state machine — driven against the in-process fake peer.
 *
 * Case IDs match ~/plan/evidence/pi-codex-multi-goal/P0/gate-status.json:
 *   B03 stale generation is rejected
 *   B04 branch movement does not attach a pending operation to another branch
 *   B05 conflicting replay refused; identical replay returns the existing receipt
 *   B06 each partial-write boundary recovers
 *   B08 at most one pending operation per stage
 *   B09 nothing here refills an execution budget
 *   B10 the five backend states behave as §3's table says
 */

const SELECTION_A: PeerSelection = { sessionId: "session-a", branchAnchorId: "anchor-1" };
const SELECTION_B: PeerSelection = { sessionId: "session-a", branchAnchorId: "anchor-2" };

function twoStepGoal(): MultiGoal {
  const result = replaceGoalFromSteps([
    { objective: "ship the fix", criteria: ["the regression test passes"] },
    { objective: "measure it", criteria: ["p95 is recorded"] },
  ]);
  assert.ok(result.ok && result.goal, result.message);
  return result.goal;
}

/** A full persist/reload round trip through the session custom entry. */
function reload(goal: MultiGoal): MultiGoal {
  const entry = JSON.parse(JSON.stringify(setEntry(goal, "runtime")));
  const restored = reconstructGoal([{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: entry }]);
  assert.ok(restored, "the snapshot must reload rather than be skipped as malformed");
  return restored;
}

function bindParams(goal: MultiGoal, id = operationId("bind"), selection = SELECTION_A): OperationParams {
  return {
    operationId: id,
    kind: "bind",
    expectedState: "bound-available",
    payload: {
      contract: {
        objective: currentStage(goal).title,
        criteria: currentStage(goal).criteria,
      },
      memory: goal.memory,
    },
    selection,
    expectedRevision: null,
    peerId: "fake-dag-peer",
    taskId: "task-1",
  };
}

function writeParams(goal: MultiGoal, memory: unknown, id: string = operationId("write")): OperationParams {
  return {
    operationId: id,
    kind: "write",
    expectedState: "bound-available",
    payload: { memory },
    selection: SELECTION_A,
    expectedRevision: goal.backend.binding?.selectedRevision ?? null,
  };
}

async function bind(goal: MultiGoal, peer: ReturnType<typeof createFakePeer>) {
  const result = await runPeerOperation(goal, peer, bindParams(goal));
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result.goal;
}

// --- B10: the five states -------------------------------------------------

test("B10: an unbound goal is exactly today's Goal-only behaviour", () => {
  const goal = twoStepGoal();

  assert.equal(goal.backend.state, "unbound", "a goal starts unbound with no settings and no peer");
  assert.equal(goal.backend.binding, null);
  assert.equal(goal.backend.pending, null);
  assert.deepEqual(goal.backend.operations, []);
  assert.equal(goalOwnsMemory(goal.backend), true, "Goal owns its own 8 KiB record while unbound");
  assert.equal(backendAdmitsExecution(goal.backend), true, "and nothing withholds execution");
});

test("B10: binding-pending withholds execution and exposes no second writable authority", async () => {
  const goal = twoStepGoal();
  const peer = createFakePeer();

  const begun = beginOperation(goal, bindParams(goal));
  assert.equal(begun.ok, true, begun.ok ? "" : begun.message);
  assert.ok(begun.ok);

  assert.equal(begun.goal.backend.state, "binding-pending", "the intended migration is persisted first");
  assert.ok(begun.goal.backend.pending, "sanity: the intent is on the snapshot");
  assert.equal(begun.goal.backend.pending?.operationId, begun.request.operationId);
  assert.equal(
    backendAdmitsExecution(begun.goal.backend),
    false,
    "Goal execution is withheld during the switch (§3)",
  );
  assert.equal(
    goalOwnsMemory(begun.goal.backend),
    false,
    "two writable authorities are never exposed at once",
  );

  const bound = await bind(goal, peer);
  assert.equal(bound.backend.state, "bound-available");
  assert.equal(backendAdmitsExecution(bound.backend), true, "execution resumes once the switch is accepted");
  assert.equal(goalOwnsMemory(bound.backend), false, "the peer is now the sole working-memory authority");
  assert.ok(bound.backend.binding, "sanity: the binding is persisted");
  assert.equal(bound.backend.binding?.goalId, goal.goalId);
  assert.equal(
    bound.backend.binding?.stageId,
    currentStage(goal).id,
    "the binding carries Stage.id, never the displayed step number (D7)",
  );
  assert.equal(bound.backend.binding?.contractRevision, goal.contractRevision);
  assert.equal(bound.backend.binding?.generation, goal.execution.generation);
  assert.ok(bound.backend.binding?.selectedRevision, "and the durably selected revision");
  assert.equal(bound.backend.pending, null, "the intent is discharged");
});

test("B10: bound-unavailable preserves the binding, the pointers and the allowances", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);
  const memoryBefore = JSON.stringify(bound.memory);

  const lost = markPeerUnavailable(bound, "the peer was unloaded");

  assert.equal(lost.backend.state, "bound-unavailable");
  assert.deepEqual(lost.backend.binding, bound.backend.binding, "the binding and its pointers survive");
  assert.match(lost.backend.reason ?? "", /unloaded/, "with a visible reason");
  assert.equal(
    backendAdmitsExecution(lost.backend),
    false,
    "Goal-owned execution pauses rather than continuing blind",
  );
  assert.equal(
    goalOwnsMemory(lost.backend),
    false,
    "invariant 8: unavailable peer state cannot silently downgrade to stale Goal memory",
  );
  assert.equal(JSON.stringify(lost.memory), memoryBefore, "the old blob is not resurrected or rewritten");
  assert.deepEqual(lost.execution, bound.execution, "and no allowance is touched");
});

test("B10: detach needs a validated export, and refuses to truncate one that does not fit", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);

  // The peer's records outgrew what Goal's 8 KiB record can hold.
  const grew = await runPeerOperation(
    bound,
    peer,
    writeParams(bound, { revision: 4, proved: ["z".repeat(9000)], unresolved: [], next: "" }),
  );
  assert.equal(grew.ok, true, grew.ok ? "" : grew.message);
  bound = grew.goal;

  const detachParams = (id: string): OperationParams => ({
    operationId: id,
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  const commitsBefore = peer.commits;
  const oversized = await runPeerOperation(bound, peer, detachParams(operationId("detach")));
  assert.equal(oversized.ok, false, "an export that does not fit leaves the switch pending");
  assert.match(oversized.ok === false ? oversized.message : "", /8192|bytes|limit/i);
  assert.equal(oversized.goal.backend.state, "bound-available", "the backend did not switch");
  assert.ok(oversized.goal.backend.pending, "and the intent is retained so the reason can be reported");
  assert.equal(peer.commits, commitsBefore, "authority was never released on an unvalidated export");

  // Abandoning the switch is a Goal-owned decision; it frees the stage's one
  // pending slot without pretending the operation succeeded.
  let current = abandonOperation(oversized.goal, "the export did not fit; shrink the working set first");
  assert.equal(current.backend.pending, null, "sanity: the slot is free again");

  const shrunk = await runPeerOperation(
    current,
    peer,
    writeParams(current, { revision: 5, proved: ["a"], unresolved: [], next: "b" }),
  );
  assert.equal(shrunk.ok, true, shrunk.ok ? "" : shrunk.message);
  current = shrunk.goal;

  const exported = await runPeerOperation(current, peer, {
    ...detachParams(operationId("detach")),
    expectedRevision: current.backend.binding?.selectedRevision ?? null,
  });
  assert.equal(exported.ok, true, exported.ok ? "" : exported.message);
  assert.equal(exported.goal.backend.state, "detached");
  assert.equal(goalOwnsMemory(exported.goal.backend), true, "Goal-only mode resumes after a validated export");
  assert.equal(backendAdmitsExecution(exported.goal.backend), true);
  assert.deepEqual(
    {
      proved: exported.goal.memory.proved,
      unresolved: exported.goal.memory.unresolved,
      next: exported.goal.memory.next,
    },
    { proved: ["a"], unresolved: [], next: "b" },
    "the exported projection becomes the Goal record",
  );
});

// --- B09: budgets ---------------------------------------------------------

test("B09: binding, detachment, reload and branch selection refill no budget", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  // Spend some of every unit first, so a refill would be visible.
  const spent: MultiGoal = {
    ...goal,
    execution: {
      ...goal.execution,
      noProgressRemaining: 3,
      totalRemaining: 17,
      turnRequests: 9,
      lifetimeRequests: 383,
    },
  };
  const before = JSON.parse(JSON.stringify(spent.execution));
  assert.equal(before.totalRemaining, 17, "sanity: the grant is partly spent");

  let current = await bind(spent, peer);
  assert.deepEqual(current.execution, before, "binding grants nothing");

  current = markPeerUnavailable(current, "peer gone");
  assert.deepEqual(current.execution, before, "losing the peer grants nothing");

  current = reload(current);
  assert.deepEqual(current.execution, before, "a reload grants nothing");

  current = reconcileSelection(current, SELECTION_B);
  assert.deepEqual(current.execution, before, "moving branch grants nothing");
});

// --- B08: one pending operation per stage ---------------------------------

test("B08: only one binding, memory or transition operation may be pending for a stage", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const first = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["one"], unresolved: [], next: "" }));
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  assert.ok(first.ok);
  assert.ok(first.goal.backend.pending, "sanity: one intent is pending");

  const callsBefore = peer.calls.length;
  const second = beginOperation(
    first.goal,
    writeParams(first.goal, { revision: 2, proved: ["two"], unresolved: [], next: "" }),
  );
  assert.equal(second.ok, false, "a second, different operation is refused locally");
  assert.equal(second.ok === false ? second.code : null, "refused");
  assert.match(second.ok === false ? second.message : "", /pending/i);
  assert.equal(peer.calls.length, callsBefore, "and nothing reached the peer");
  assert.equal(
    first.goal.backend.pending?.operationId,
    first.request.operationId,
    "the original intent is untouched",
  );
});

// --- B05: replay protection -----------------------------------------------

test("B05: an identical replay returns the existing receipt without a second commit", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  const first = await runPeerOperation(goal, peer, bindParams(goal, id));
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  assert.ok(first.ok);
  assert.equal(peer.commits, 1, "sanity: the peer committed once");

  const callsBefore = peer.calls.length;
  const replayed = await runPeerOperation(first.goal, peer, bindParams(first.goal, id));

  assert.equal(replayed.ok, true, replayed.ok ? "" : replayed.message);
  assert.ok(replayed.ok);
  assert.equal(replayed.replayed, true, "the result is recognised as a replay");
  assert.deepEqual(replayed.receipt, first.receipt, "the SAME receipt comes back");
  assert.equal(peer.commits, 1, "no second commit");
  assert.equal(peer.calls.length, callsBefore, "the retained receipt answered it without a peer round trip");
  assert.equal(replayed.goal.backend.pending, null, "nothing is left pending");
});

test("B05: the same operation ID with a conflicting payload is refused", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  const first = await runPeerOperation(goal, peer, bindParams(goal, id));
  assert.ok(first.ok);

  const conflicting = bindParams(first.goal, id);
  conflicting.payload = { contract: { objective: "a different objective" }, memory: null };
  const callsBefore = peer.calls.length;

  const refused = await runPeerOperation(first.goal, peer, conflicting);

  assert.equal(refused.ok, false, "a conflicting payload under a used ID cannot commit");
  assert.equal(refused.ok === false ? refused.code : null, "replay-conflict");
  assert.equal(peer.calls.length, callsBefore, "the conflict is caught before the peer is asked");
  assert.equal(peer.commits, 1, "and nothing was committed a second time");
  assert.deepEqual(
    refused.goal.backend.binding,
    first.goal.backend.binding,
    "the accepted binding is unchanged",
  );
});

test("B05: resolveReplay classifies novel, identical, quarantined and conflicting IDs", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");
  const params = bindParams(goal, id);
  const identity = {
    operationId: id,
    kind: params.kind,
    scope: goalScope(goal, SELECTION_A),
    expectedRevision: params.expectedRevision,
    payloadDigest: canonicalDigest(params.payload),
  };

  assert.deepEqual(
    resolveReplay(goal.backend, identity),
    { verdict: "novel" },
    "sanity: an unknown ID is novel",
  );

  const bound = (await runPeerOperation(goal, peer, params)).goal;
  assert.equal(resolveReplay(bound.backend, identity).verdict, "identical");
  assert.equal(
    resolveReplay(bound.backend, { ...identity, payloadDigest: canonicalDigest({ other: true }) }).verdict,
    "conflict",
    "a different payload under the same id conflicts",
  );
  assert.equal(
    resolveReplay(bound.backend, { ...identity, kind: "write" }).verdict,
    "conflict",
    "and so does a different kind, even with identical payload bytes",
  );
  assert.equal(
    resolveReplay(bound.backend, { ...identity, scope: goalScope(goal, SELECTION_B) }).verdict,
    "conflict",
    "and so does a different branch selection",
  );
});

// --- B06: partial-write boundaries ---------------------------------------

test("B06: crash after the intent, before the peer call, commits exactly once", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  const begun = beginOperation(goal, bindParams(goal, id));
  assert.ok(begun.ok);
  assert.equal(peer.calls.length, 0, "sanity: nothing reached the peer before the crash");

  // Crash and reload: the persisted intent is what recovery runs from.
  const restored = reload(begun.goal);
  assert.equal(restored.backend.state, "binding-pending", "the intent survives the reload");
  assert.equal(restored.backend.pending?.operationId, id);

  const recovered = await runPeerOperation(restored, peer, bindParams(restored, id));
  assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.message);
  assert.equal(peer.commits, 1, "exactly one commit");
  assert.equal(recovered.goal.backend.state, "bound-available");
});

test("B06: crash after the peer commit but before the receipt arrives recovers from the receipt", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  peer.loseNextResponse();
  const lost = await runPeerOperation(goal, peer, bindParams(goal, id));

  assert.equal(lost.ok, false, "sanity: Goal never saw the answer");
  assert.equal(lost.ok === false ? lost.code : null, "unavailable");
  assert.equal(peer.commits, 1, "sanity: the peer did commit durably");
  assert.ok(lost.goal.backend.pending, "a retryable failure keeps the intent so recovery is possible");
  assert.equal(lost.goal.backend.state, "binding-pending", "and does not publish success");

  const restored = reload(lost.goal);
  const recovered = await runPeerOperation(restored, peer, bindParams(restored, id));

  assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.message);
  assert.equal(peer.commits, 1, "the replay returned the existing receipt; no second mutation");
  assert.equal(recovered.goal.backend.state, "bound-available");
  assert.equal(
    recovered.goal.backend.binding?.selectedRevision,
    peer.revisionOf(goalScope(goal, SELECTION_A).scopeId, "pi-codex-multi-goal"),
    "Goal adopted the revision the peer actually selected",
  );
});

test("B06: crash after the receipt but before Goal's acknowledgement recovers identically", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  const begun = beginOperation(goal, bindParams(goal, id));
  assert.ok(begun.ok);
  const response = await callPeer(peer, begun.request);
  assert.equal(response.status, "committed", "sanity: the peer answered with a receipt");
  assert.equal(peer.commits, 1);

  // The receipt arrived, but the process died before acceptReceipt persisted
  // anything. Recovery starts from the snapshot that still holds the intent.
  const restored = reload(begun.goal);
  assert.ok(restored.backend.pending, "sanity: the un-acknowledged intent is still pending");

  const recovered = await runPeerOperation(restored, peer, bindParams(restored, id));
  assert.equal(recovered.ok, true, recovered.ok ? "" : recovered.message);
  assert.equal(peer.commits, 1, "no second mutation");
  assert.equal(recovered.goal.backend.state, "bound-available");
});

test("B06: crash after Goal's acknowledgement replays from retention, not from the peer", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const id = operationId("bind");

  const done = await runPeerOperation(goal, peer, bindParams(goal, id));
  assert.ok(done.ok);
  const restored = reload(done.goal);
  assert.equal(restored.backend.pending, null, "sanity: the acknowledged intent was discharged");
  assert.equal(restored.backend.operations.length, 1, "and retained for replay protection");

  const callsBefore = peer.calls.length;
  const replayed = await runPeerOperation(restored, peer, bindParams(restored, id));

  assert.equal(replayed.ok, true, replayed.ok ? "" : replayed.message);
  assert.equal(peer.calls.length, callsBefore, "retention answered it without asking the peer");
  assert.equal(peer.commits, 1);
});

// --- B04: branch movement -------------------------------------------------

test("B04: branch movement does not attach a pending operation to a different branch", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const begun = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }));
  assert.ok(begun.ok);
  const pendingId = begun.request.operationId;
  assert.equal(begun.goal.backend.pending?.scope.selection.branchAnchorId, "anchor-1", "sanity: planned on anchor-1");

  const moved = reconcileSelection(begun.goal, SELECTION_B);

  assert.equal(moved.backend.pending, null, "the intent is not carried onto the new branch");
  assert.match(moved.backend.reason ?? "", /branch|selection/i, "with a visible reason");
  const quarantined = moved.backend.operations.find((record) => record.operationId === pendingId);
  assert.ok(quarantined, "its ID is retained so a late receipt can still be refused");
  assert.equal(quarantined?.outcome, "quarantined");
  assert.deepEqual(moved.backend.binding, bound.backend.binding, "the binding itself survives the move");

  // A late receipt for the operation planned on the old branch is refused.
  const response = await callPeer(peer, begun.request);
  assert.equal(response.status, "committed", "sanity: the peer had in fact committed it");
  const late = acceptReceipt(moved, response, SELECTION_B);
  assert.equal(late.ok, false, "a late receipt matches no current intent on this branch");
  assert.equal(
    resolveReplay(moved.backend, {
      operationId: pendingId,
      kind: begun.request.kind,
      scope: begun.request.scope,
      expectedRevision: begun.request.expectedRevision,
      payloadDigest: canonicalDigest(begun.request.payload),
    }).verdict,
    "quarantined",
    "and replaying it asks for a new operation ID rather than committing again",
  );
});

test("B04: a receipt planned on another branch fails verification", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const begun = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }));
  assert.ok(begun.ok);
  const response = await callPeer(peer, begun.request);
  assert.equal(response.status, "committed", "sanity: there is a receipt to mis-apply");

  const rejected = acceptReceipt(begun.goal, response, SELECTION_B);
  assert.equal(rejected.ok, false, "the live selection no longer matches the intent's");
  assert.equal(rejected.ok === false ? rejected.code : null, "stale-selection");
  assert.equal(rejected.goal.backend.pending, null, "the intent is quarantined, not applied");
  assert.equal(
    rejected.goal.backend.binding?.selectedRevision,
    bound.backend.binding?.selectedRevision,
    "and the selected revision did not move",
  );
});

// --- B03: stale generation ------------------------------------------------

test("B03: a receipt from a spent generation is rejected, and the memory scope survives it", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const begun = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }));
  assert.ok(begun.ok);
  assert.equal(begun.request.scope.epoch, 0, "sanity: the intent was planned in generation 0");
  const response = await callPeer(peer, begun.request);
  assert.equal(response.status, "committed");

  // Execution authority was replaced while the operation was in flight.
  const nextGeneration: MultiGoal = {
    ...begun.goal,
    execution: { ...begun.goal.execution, generation: 1 },
  };

  const rejected = acceptReceipt(nextGeneration, response, SELECTION_A);

  assert.equal(rejected.ok, false, "a stale callback cannot publish state");
  assert.equal(rejected.ok === false ? rejected.code : null, "stale-epoch");
  assert.equal(rejected.goal.backend.pending, null, "the stale intent is quarantined");
  assert.ok(
    rejected.goal.backend.binding,
    "§3: a resume may retain the same memory scope while replacing execution authority",
  );
  assert.equal(
    rejected.goal.backend.binding?.selectedRevision,
    bound.backend.binding?.selectedRevision,
    "the memory pointer is not discarded merely because the generation changed",
  );
  assert.equal(rejected.goal.backend.state, "bound-available", "and the backend is not downgraded");
});

test("B03: an operation cannot be planned against a generation the goal has left", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const scope = goalScope(bound, SELECTION_A);
  assert.equal(scope.epoch, bound.execution.generation, "the scope's epoch is the live generation");
  assert.equal(
    scope.contractRevision,
    bound.contractRevision,
    "and its contract identity is the live contractRevision",
  );

  const advanced: MultiGoal = { ...bound, execution: { ...bound.execution, generation: 4 } };
  assert.equal(goalScope(advanced, SELECTION_A).epoch, 4, "sanity: the scope tracks the generation");

  const stale = verifyReceipt(
    {
      protocolVersion: 1,
      operationId: "op-stale",
      kind: "write",
      scope: goalScope(advanced, SELECTION_A),
      expectedRevision: null,
      payload: { memory: null },
    },
    {
      status: "committed",
      receipt: {
        protocolVersion: 1,
        operationId: "op-stale",
        scope,
        selectedRevision: "rev-9",
        payloadDigest: canonicalDigest({ memory: null }),
        committedAt: 1,
      },
    },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false ? stale.code : null, "stale-epoch");
});

// --- B11: a stage transition must not leave an unrecoverable state --------

test("B11: a stage transition ends the stage's binding and leaves the next stage runnable", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  // Leave a pending intent AND a retained receipt behind, so the test proves
  // both are cleared rather than carried into a scope they cannot address.
  const begun = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }));
  assert.ok(begun.ok);
  assert.ok(begun.goal.backend.pending, "sanity: an operation is in flight for stage 1");
  assert.equal(begun.goal.backend.operations.length, 1, "sanity: the bind receipt is retained");

  const advanced = acceptCompletion(begun.goal, Date.now(), {});
  assert.ok(advanced.ok && advanced.goal, advanced.message);
  assert.equal(advanced.goal.index, 1, "sanity: the goal advanced");

  assert.equal(
    backendAdmitsExecution(advanced.goal.backend),
    true,
    "no state reachable in P0 may be permanently unrecoverable",
  );
  assert.equal(goalOwnsMemory(advanced.goal.backend), true, "and the new stage's empty record is writable");
  assert.equal(advanced.goal.backend.state, "unbound");
  assert.equal(advanced.goal.backend.binding, null, "the old stage's selection is not carried forward");
  assert.equal(advanced.goal.backend.pending, null, "an intent for the old scope cannot address the new one");
  assert.deepEqual(advanced.goal.backend.operations, [], "retention ends with the stage it protected");
  assert.match(
    advanced.goal.backend.reason ?? "",
    /ended with that stage/,
    "and the change is visible rather than silent",
  );
  assert.equal(advanced.goal.memory.revision, 0, "sanity: §8 — the next stage starts with empty memory");
});

// --- B12: operation legality is enforced before the intent is persisted ---

test("B12: beginOperation refuses operations that are illegal for the current state", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();

  // From `unbound`, only `bind` is legal.
  for (const kind of ["write", "transition", "detach"] as const) {
    const attempt = beginOperation(goal, {
      operationId: operationId(kind),
      kind,
      expectedState: kind === "detach" ? "detached" : "bound-available",
      payload: { memory: null },
      selection: SELECTION_A,
      expectedRevision: null,
    });
    assert.equal(attempt.ok, false, `${kind} cannot be planned while unbound`);
    assert.equal(attempt.ok === false ? attempt.code : null, "refused");
    assert.match(attempt.ok === false ? attempt.message : "", /unbound|bind/i);
  }

  // A bind cannot claim a selected revision: it is what selects the first one.
  const claiming = beginOperation(goal, { ...bindParams(goal), expectedRevision: "rev-1" });
  assert.equal(claiming.ok, false, "a bind that claims an existing revision is refused");
  assert.match(claiming.ok === false ? claiming.message : "", /revision/i);

  const bound = await bind(goal, peer);
  const selected = bound.backend.binding?.selectedRevision ?? null;
  assert.ok(selected, "sanity: the binding selected a revision");

  // A non-bind mutation must be planned against the selected revision.
  const unanchored = beginOperation(bound, {
    ...writeParams(bound, { revision: 1, proved: [], unresolved: [], next: "" }),
    expectedRevision: null,
  });
  assert.equal(unanchored.ok, false, "a write with no expected revision is refused");
  assert.match(unanchored.ok === false ? unanchored.message : "", /revision/i);

  const misanchored = beginOperation(bound, {
    ...writeParams(bound, { revision: 1, proved: [], unresolved: [], next: "" }),
    expectedRevision: "rev-does-not-exist",
  });
  assert.equal(misanchored.ok, false, "a write against a revision that is not selected is refused");
  assert.match(misanchored.ok === false ? misanchored.message : "", /revision/i);

  // The intended end state must be the one the operation can actually reach.
  const wrongTarget = beginOperation(bound, {
    ...writeParams(bound, { revision: 1, proved: [], unresolved: [], next: "" }),
    expectedState: "detached",
  });
  assert.equal(wrongTarget.ok, false, "a write cannot intend to reach `detached`");

  // Binding twice would replace an authority without detaching from it.
  const rebind = beginOperation(bound, bindParams(bound, operationId("bind")));
  assert.equal(rebind.ok, false, "a second bind over a live binding is refused");
  assert.match(rebind.ok === false ? rebind.message : "", /bound|detach/i);

  // Nothing illegal is written to the snapshot, and nothing reached the peer.
  assert.equal(bound.backend.pending, null, "no illegal intent was persisted");
  assert.equal(peer.commits, 1, "only the legal bind committed");

  // A mutation cannot be planned while the bound authority is unavailable.
  const lost = markPeerUnavailable(bound, "the peer was unloaded");
  const whileLost = beginOperation(lost, writeParams(bound, { revision: 1, proved: [], unresolved: [], next: "" }));
  assert.equal(whileLost.ok, false, "a write cannot be planned against an unavailable backend");
  assert.equal(lost.backend.pending, null);
});

test("B12: a permissive peer cannot promote Goal to bound-available without a bind", async () => {
  // The peer here is lax about scope ownership — a buggy or over-eager peer is
  // exactly the case the Goal side must not depend on. Legality is Goal's own
  // check, made before the intent is persisted, never delegated to the peer.
  const peer = createFakePeer({ laxScope: true });
  const goal = twoStepGoal();
  assert.equal(goal.backend.state, "unbound", "sanity: nothing has bound this goal");

  const result = await runPeerOperation(goal, peer, {
    operationId: operationId("write"),
    kind: "write",
    expectedState: "bound-available",
    payload: { memory: { revision: 1, proved: ["smuggled"], unresolved: [], next: "" } },
    selection: SELECTION_A,
    expectedRevision: null,
  });

  assert.equal(result.ok, false, "the operation is refused");
  assert.equal(peer.calls.length, 0, "and it never reaches the peer");
  assert.equal(peer.commits, 0, "so nothing is committed for a scope that was never bound");
  assert.equal(result.goal.backend.state, "unbound", "the goal is still unbound");
  assert.equal(result.goal.backend.binding, null, "no binding was installed by a receipt");
  assert.equal(result.goal.backend.pending, null, "and no intent was left behind");
});

// --- B13: a detach export must be present, not merely absent -------------

/**
 * Review finding (P1, src/backend.ts): a committed `read` may omit
 * `projection`. Treating that as an empty memory record turned "the peer told
 * me nothing" into "the peer told me the working set is empty", which replaced
 * the Goal record with empty data and released authority — the exact loss the
 * read-then-detach ordering exists to prevent. §3: if the export cannot be
 * produced, leave the switch pending and report why; never silently truncate.
 */
test("B13: a detach whose export never arrives keeps the record and the binding", async () => {
  const peer = createFakePeer({ omitProjection: true });
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);
  const written = await runPeerOperation(
    bound,
    peer,
    writeParams(bound, { revision: 1, proved: ["a real finding"], unresolved: [], next: "keep going" }),
  );
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  bound = written.goal;

  const memoryBefore = JSON.stringify(bound.memory);
  const commitsBefore = peer.commits;

  const detached = await runPeerOperation(bound, peer, {
    operationId: operationId("detach"),
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  assert.equal(detached.ok, false, "a receipt with no projection is not an export");
  assert.match(
    detached.ok === false ? detached.message : "",
    /projection|export/i,
    "and the reason names what was missing",
  );
  assert.equal(detached.goal.backend.state, "bound-available", "authority was not released");
  assert.ok(detached.goal.backend.pending, "the switch stays pending so it can be retried or abandoned");
  assert.equal(JSON.stringify(detached.goal.memory), memoryBefore, "the Goal record was not replaced");
  assert.equal(peer.commits, commitsBefore, "and nothing was committed");
});

test("B13: a detach whose export is present but malformed is refused the same way", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);
  // A peer whose records do not fit Goal's record shape at all.
  const written = await runPeerOperation(bound, peer, writeParams(bound, { proved: "not an array" }));
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  bound = written.goal;
  const memoryBefore = JSON.stringify(bound.memory);

  const detached = await runPeerOperation(bound, peer, {
    operationId: operationId("detach"),
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  assert.equal(detached.ok, false);
  assert.equal(detached.goal.backend.state, "bound-available");
  assert.equal(JSON.stringify(detached.goal.memory), memoryBefore);
});

test("B13: an export that is genuinely empty is still a valid export", async () => {
  // Absent must be distinguishable from empty: a peer whose current working set
  // holds nothing has said something, and detach must succeed on it.
  const peer = createFakePeer();
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);
  const written = await runPeerOperation(bound, peer, writeParams(bound, { proved: [], unresolved: [], next: "" }));
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  bound = written.goal;

  const detached = await runPeerOperation(bound, peer, {
    operationId: operationId("detach"),
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  assert.equal(detached.ok, true, detached.ok ? "" : detached.message);
  assert.equal(detached.goal.backend.state, "detached");
  assert.deepEqual(
    {
      proved: detached.goal.memory.proved,
      unresolved: detached.goal.memory.unresolved,
      next: detached.goal.memory.next,
    },
    { proved: [], unresolved: [], next: "" },
  );
});

// --- B14: an unrecognised error code must not discard a retryable intent --

/**
 * Review finding (P1, src/peer.ts): the parser accepted any string as an error
 * code, verifyReceipt passed it through, and acceptReceipt treated anything
 * outside the retryable set as terminal — so a malformed answer permanently
 * quarantined an intent. The failure most likely to produce a garbage code is
 * an incompatible peer, which this design classifies as RETRYABLE, so the
 * unrecognised case landed in exactly the wrong bucket.
 */
test("B14: a peer answering with a code outside the protocol keeps the intent retryable", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  const rogue = createFakePeer({ badErrorCode: "not-a-protocol-code" });
  const result = await runPeerOperation(
    bound,
    rogue,
    writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }),
  );

  assert.equal(result.ok, false, "sanity: the operation did not succeed");
  assert.equal(
    result.ok === false ? result.code : null,
    "incompatible",
    "an answer this protocol version cannot read is incompatible, not a new terminal class",
  );
  assert.ok(
    result.goal.backend.pending,
    "the intent survives: a malformed answer must never discard recoverable work",
  );
  assert.equal(result.goal.backend.state, "bound-unavailable", "and the backend is visibly not answering");
  assert.deepEqual(result.goal.backend.operations.filter((r) => r.outcome === "quarantined"), []);
});

test("B14: the response parser rejects an unknown error code", async () => {
  const rogue = createFakePeer({ badErrorCode: "kaboom" });
  const response = await callPeer(rogue, {
    protocolVersion: 1,
    operationId: "op-1",
    kind: "read",
    scope: goalScope(twoStepGoal(), SELECTION_A),
    expectedRevision: null,
    payload: { profile: "current-scope@1" },
  });

  assert.equal(response.status, "error");
  assert.equal(
    response.status === "error" ? response.code : null,
    "incompatible",
    "the closed set is enforced in the parser, so no unknown code reaches a caller",
  );
});

test("B14: verifyReceipt maps an unknown error code to incompatible", () => {
  const request = {
    protocolVersion: 1,
    operationId: "op-1",
    kind: "write" as const,
    scope: goalScope(twoStepGoal(), SELECTION_A),
    expectedRevision: "rev-1",
    payload: { memory: null },
  };
  const checked = verifyReceipt(request, {
    status: "error",
    code: "invented-code" as never,
    message: "peer says no",
  });

  assert.equal(checked.ok, false, "sanity: it is still a failure");
  assert.equal(checked.ok === false ? checked.code : null, "incompatible");
});

test("B14: failOperation treats an unrecognised code as retryable, never terminal", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);
  const begun = beginOperation(bound, writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }));
  assert.ok(begun.ok);
  assert.ok(begun.goal.backend.pending, "sanity: there is an intent to lose");

  const after = failOperation(begun.goal, { code: "who-knows", message: "an answer with no known class" });

  assert.ok(after.backend.pending, "an unrecognised code must never permanently discard a retryable intent");
  assert.deepEqual(after.backend.operations.filter((r) => r.outcome === "quarantined"), []);
});

test("B15: a really detached goal survives a reload", async () => {
  // Regression preservation for the state-consistency validator: the snapshot
  // the detach path actually writes must still load.
  const peer = createFakePeer();
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);
  const written = await runPeerOperation(
    bound,
    peer,
    writeParams(bound, { revision: 1, proved: ["kept"], unresolved: [], next: "onward" }),
  );
  assert.equal(written.ok, true, written.ok ? "" : written.message);
  bound = written.goal;

  const detached = await runPeerOperation(bound, peer, {
    operationId: operationId("detach"),
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });
  assert.equal(detached.ok, true, detached.ok ? "" : detached.message);
  assert.equal(detached.goal.backend.state, "detached", "sanity: it detached");

  const reloaded = reload(detached.goal);
  assert.equal(reloaded.backend.state, "detached", "a detached snapshot is not skipped as malformed");
  assert.equal(goalOwnsMemory(reloaded.backend), true);
  assert.deepEqual(reloaded.memory.proved, ["kept"], "and the exported record survives the round trip");
});

// --- B17/B18 in the Goal adapter -----------------------------------------

test("B17: a misdirected terminal error does not discard the pending intent", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);

  // A peer answering with someone else's `refused` — a delayed error for
  // another request. It is terminal, so on the old code it quarantined a
  // perfectly valid intent.
  const misdirecting = createFakePeer({ misdirectedError: "refused" });
  const result = await runPeerOperation(
    bound,
    misdirecting,
    writeParams(bound, { revision: 1, proved: ["x"], unresolved: [], next: "" }),
  );

  assert.equal(result.ok, false, "sanity: the operation did not succeed");
  assert.equal(
    result.ok === false ? result.code : null,
    "incompatible",
    "an answer about another operation says nothing about this one",
  );
  assert.ok(result.goal.backend.pending, "the valid intent survives and stays retryable");
  assert.deepEqual(
    result.goal.backend.operations.filter((record) => record.outcome === "quarantined"),
    [],
    "and nothing was quarantined on the strength of someone else's refusal",
  );
});

/**
 * The concatenation sweep the scopeKey finding prompted. `goalScopeId` builds
 * the protocol's scopeId from two fields taken off a persisted snapshot, and
 * `migrateV1Goal` really does mint stage IDs containing `:stage:` — so the
 * delimiter can appear inside a component and the identity is forgeable.
 */
test("B18: goalScopeId cannot be made to collide by moving the delimiter", () => {
  assert.notEqual(
    goalScopeId("a", "b:stage:c"),
    goalScopeId("a:stage:b", "c"),
    "two different goal/stage pairs must not name one scope",
  );
  assert.equal(goalScopeId("a", "b"), goalScopeId("a", "b"), "sanity: it is deterministic");

  // The shape migrateV1Goal actually produces: `<goalId>:stage:<position>`.
  assert.notEqual(
    goalScopeId("g-1", "g-1:stage:0"),
    goalScopeId("g-1:stage:0", ""),
    "a migrated stage id must not be able to impersonate another goal's scope",
  );

  const pairs = [
    ["a", "b:stage:c"],
    ["a:stage:b", "c"],
    ["a:", "stage:b:c"],
    ["", "a:stage:b"],
    ["a:stage:b", ""],
  ] as const;
  const ids = pairs.map(([goalId, stageId]) => goalScopeId(goalId, stageId));
  assert.equal(new Set(ids).size, ids.length, "every distinct pair gets a distinct scope id");
});

/**
 * The export read is a PRECONDITION of the detach, not the operation itself.
 * Its id was derived by appending `:export` to the caller's, so a caller that
 * had already committed an operation under that exact derived id would get
 * that operation's receipt back and see a `replay-conflict` — terminal, which
 * destroyed the detach intent. Neither the derivation nor the classification
 * should be able to do that, so both are fixed: the id is injective, and a
 * failed precondition holds the switch rather than burning the operation.
 */
test("B18: a failed export read holds the switch instead of discarding it", async () => {
  const peer = createFakePeer({ readError: "refused" });
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);
  const memoryBefore = JSON.stringify(bound.memory);
  const detachId = operationId("detach");

  const detached = await runPeerOperation(bound, peer, {
    operationId: detachId,
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  assert.equal(detached.ok, false, "sanity: the export could not be read");
  assert.match(detached.ok === false ? detached.message : "", /export/i, "and the reason says so");
  assert.equal(detached.goal.backend.state, "bound-available", "authority was not released");
  assert.equal(JSON.stringify(detached.goal.memory), memoryBefore, "the record was not replaced");
  assert.ok(
    detached.goal.backend.pending,
    "a failed precondition holds the switch pending; it never discards the detach intent",
  );
  assert.deepEqual(
    detached.goal.backend.operations.filter((record) => record.operationId === detachId),
    [],
    "and the detach id is not burned, so the same operation can be retried",
  );
});

test("B18: the export read cannot be made to name a caller's own operation", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  let bound = await bind(goal, peer);

  // Commit a write under the id the old `${id}:export` derivation would have
  // produced for the detach below.
  const detachId = operationId("detach");
  const collide = await runPeerOperation(bound, peer, {
    ...writeParams(bound, { revision: 1, proved: ["earlier work"], unresolved: [], next: "" }),
    operationId: `${detachId}:export`,
  });
  assert.equal(collide.ok, true, collide.ok ? "" : collide.message);
  bound = collide.goal;

  const detached = await runPeerOperation(bound, peer, {
    operationId: detachId,
    kind: "detach",
    expectedState: "detached",
    payload: { profile: "current-scope@1" },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });

  assert.equal(detached.ok, true, detached.ok ? "" : detached.message);
  assert.equal(detached.goal.backend.state, "detached", "the detach was not derailed by the collision");
  assert.deepEqual(detached.goal.memory.proved, ["earlier work"], "and it exported the real record");

  const readCall = peer.calls.find((call) => call.kind === "read");
  assert.ok(readCall, "sanity: the export read happened");
  assert.notEqual(
    readCall?.operationId,
    `${detachId}:export`,
    "the derived read id is not a concatenation a caller can predict and occupy",
  );
});

// --- B21: every writer must satisfy the invariant the reader enforces -----

/**
 * Review finding (P1, src/backend.ts): markPeerAvailable accepted any string as
 * the selected revision, including "". That state admits execution, but
 * checkOperationLegality treats an empty selected revision as missing, so the
 * goal becomes runnable yet unable to plan a single backend operation — and it
 * is a snapshot isGoalBackend rejects, so the goal runs until it reloads and
 * then loses its state.
 *
 * The rule the last rounds have been converging on: a writer that produces a
 * state the reader refuses turns a live goal into an unloadable one after the
 * fact. Every transition below is checked against the validator that will read
 * it back.
 */
test("B21: availability requires a real selected revision", async () => {
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const bound = await bind(goal, peer);
  const lost = markPeerUnavailable(bound, "the peer was unloaded");
  assert.equal(lost.backend.state, "bound-unavailable", "sanity: it is waiting to come back");

  const probe: PeerRequest = {
    protocolVersion: 1,
    operationId: "op-probe",
    kind: "read",
    scope: goalScope(lost, SELECTION_A),
    expectedRevision: lost.backend.binding?.selectedRevision ?? null,
    payload: { profile: "current-scope@1" },
  };

  // A receipt that names no durably selected revision proves nothing, whatever
  // else it carries.
  for (const revision of ["", "   "]) {
    const restored = markPeerAvailable(lost, probe, {
      status: "committed",
      receipt: {
        protocolVersion: 1,
        operationId: probe.operationId,
        scope: probe.scope,
        selectedRevision: revision,
        payloadDigest: canonicalDigest(probe.payload),
        committedAt: 1,
      },
    });
    assert.equal(
      restored.backend.state,
      "bound-unavailable",
      `an empty selected revision (${JSON.stringify(revision)}) cannot make a backend available`,
    );
    assert.equal(
      restored.backend.binding?.selectedRevision,
      lost.backend.binding?.selectedRevision,
      "and the previous pointer is not overwritten with it",
    );
    assert.equal(isGoalBackend(restored.backend), true, "whatever it produced is loadable");
  }

  const answer = await callPeer(peer, probe);
  const real = markPeerAvailable(lost, probe, answer);
  assert.equal(real.backend.state, "bound-available", "sanity: a real revision still restores it");
  assert.equal(
    real.backend.binding?.selectedRevision,
    answer.status === "committed" ? answer.receipt.selectedRevision : null,
    "and the pointer is the revision the peer actually selected",
  );
  assert.equal(isGoalBackend(real.backend), true);
});

test("B21: an operation cannot be planned without an operation id", () => {
  const goal = twoStepGoal();
  const nameless = beginOperation(goal, { ...bindParams(goal, "") });
  assert.equal(nameless.ok, false, "the validator requires a non-empty operation id, so the writer must too");
  assert.equal(nameless.goal.backend.pending, null, "and nothing was persisted");
});

test("B21: abandoning an operation never leaves a state the validator refuses", () => {
  // `binding-pending` means a bind is in flight. Restoring a recorded
  // previousState blindly can put the backend back into it with no intent left
  // — a state isGoalBackend rejects, so the goal would be lost on reload.
  const goal = twoStepGoal();
  const backend: any = {
    state: "binding-pending",
    binding: null,
    pending: {
      operationId: "op-bind",
      kind: "bind",
      expectedState: "bound-available",
      previousState: "binding-pending",
      scope: goalScope(goal, SELECTION_A),
      expectedRevision: null,
      payloadDigest: "a".repeat(64),
      payload: { contract: {}, memory: null },
      createdAt: 1,
    },
    operations: [],
    reason: null,
  };
  assert.equal(isGoalBackend(backend), true, "sanity: the starting snapshot is valid");

  const abandoned = abandonOperation({ ...goal, backend }, "the user changed their mind");

  assert.equal(abandoned.backend.pending, null, "sanity: the intent is gone");
  assert.equal(
    isGoalBackend(abandoned.backend),
    true,
    "the state it settled into must be one the validator accepts",
  );
});

test("B21: every state a normal lifecycle passes through is loadable", async () => {
  // The durable guard for the rule: walk the lifecycle and validate after each
  // transition, so a future writer cannot quietly produce an unloadable state.
  //
  // It walks transitions driven by WELL-FORMED peer answers, because that is
  // what the fake peer produces. A writer that accepts a MALFORMED answer and
  // persists a record the validator rejects is invisible here; B23 covers that,
  // by asserting loadability after every answer in the generated answer space.
  const peer = createFakePeer();
  const goal = twoStepGoal();
  const seen: string[] = [];
  const check = (label: string, current: MultiGoal): MultiGoal => {
    seen.push(label);
    assert.equal(isGoalBackend(current.backend), true, `unloadable after: ${label}`);
    assert.equal(isMultiGoal(current), true, `whole snapshot unloadable after: ${label}`);
    return current;
  };

  let current = check("fresh", goal);
  const begun = beginOperation(current, bindParams(current));
  assert.ok(begun.ok);
  current = check("bind intent persisted", begun.goal);
  current = check("bind accepted", await bind(goal, peer));
  const wrote = await runPeerOperation(
    current,
    peer,
    writeParams(current, { revision: 1, proved: ["x"], unresolved: [], next: "" }),
  );
  assert.equal(wrote.ok, true, wrote.ok ? "" : wrote.message);
  current = check("write committed", wrote.goal);
  current = check("peer unavailable", markPeerUnavailable(current, "unloaded"));
  const revive: PeerRequest = {
    protocolVersion: 1,
    operationId: "op-revive",
    kind: "read",
    scope: goalScope(current, SELECTION_A),
    expectedRevision: current.backend.binding?.selectedRevision ?? null,
    payload: { profile: "current-scope@1" },
  };
  current = check("peer available again", markPeerAvailable(current, revive, await callPeer(peer, revive)));
  current = check("selection moved", reconcileSelection(current, SELECTION_B));

  const advanced = acceptCompletion(current, Date.now(), {});
  assert.ok(advanced.ok && advanced.goal, advanced.message);
  current = check("stage advanced", advanced.goal);

  assert.ok(seen.length >= 8, `sanity: the walk covered the lifecycle (${seen.length} states)`);
});

test("B21: a small configured budget produces a goal that can load itself", () => {
  // freshExecution fills the D4 fuses from constants, so a small working total
  // under a default turn bound of 40 would mint a goal whose limits violate
  // their own ordering — rejected by its own validator on the next load.
  const result = replaceGoalFromSteps([{ objective: "small", criteria: ["done"] }], {
    noProgressLimit: 2,
    totalLimit: 5,
  });
  assert.ok(result.ok && result.goal, result.message);
  assert.equal(result.goal.execution.totalLimit, 5, "sanity: the configured total is honoured");
  assert.equal(isMultiGoal(result.goal), true, "a goal must be able to load itself");
});

// --- B23: the invariant, over the whole answer space ---------------------

/**
 * Three rounds of review have found the same defect behind three different
 * doors: a peer answer that says nothing about the caller's operation being
 * allowed to destroy it. Unknown error codes, then misdirected errors and
 * pending answers, and now misdirected COMMITTED receipts, which still returned
 * `refused` while the other two branches had been corrected.
 *
 * Patching the fourth door is not the fix. This asserts the invariant itself,
 * generated over the answer space rather than over the branches anyone happens
 * to have thought of:
 *
 *   an answer may reduce a pending intent to `quarantined` ONLY IF it
 *   correlates to that intent AND its outcome is a terminal code.
 *
 * A fifth door fails here instead of in review.
 */

/** The terminal set, from docs/peer-protocol.md §4.4 — the contract, not the code. */
const TERMINAL_REJECTIONS = new Set([
  "stale-selection",
  "stale-epoch",
  "scope-conflict",
  "replay-conflict",
  "refused",
]);

const FOREIGN_OPERATION = "an-operation-this-caller-never-issued";

interface Answer {
  label: string;
  response: any;
  /** Does this answer say anything at all about the caller's operation? */
  correlates: boolean;
}

/** Every shape a peer can answer with, correlated and misdirected. */
function answerSpace(request: PeerRequest): Answer[] {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: 1,
    operationId: request.operationId,
    scope: request.scope,
    selectedRevision: "rev-9",
    payloadDigest: canonicalDigest(request.payload),
    committedAt: 1,
    ...overrides,
  });
  const mutations: Array<[string, Record<string, unknown>]> = [
    ["a valid receipt", {}],
    ["another consumer's scope", { scope: { ...request.scope, consumer: "pi-research" } }],
    ["another work scope", { scope: { ...request.scope, scopeId: "goal:other:stage:other" } }],
    ["a spent execution epoch", { scope: { ...request.scope, epoch: request.scope.epoch + 1 } }],
    [
      "another branch selection",
      { scope: { ...request.scope, selection: { sessionId: "session-a", branchAnchorId: "anchor-99" } } },
    ],
    ["another contract revision", { scope: { ...request.scope, contractRevision: "f".repeat(64) } }],
    ["a different payload", { payloadDigest: canonicalDigest({ something: "else" }) }],
    ["no durably selected revision", { selectedRevision: "" }],
    ["an unreadable protocol version", { protocolVersion: 99 }],
    // Absent, present-and-valid, and PRESENT-BUT-MALFORMED are three cases, not
    // two. Every field below is mandatory on a committed receipt, so neither
    // absence nor a wrong type may be waved through the way an optional field's
    // absence is (docs/peer-protocol.md §4.3).
    ["no operation id at all", { operationId: undefined }],
    ["an operation id that is not a string", { operationId: 42 }],
    ["an empty operation id", { operationId: "" }],
    ["no commit timestamp", { committedAt: undefined }],
    ["a commit timestamp that is not a number", { committedAt: "soon" }],
    ["no payload digest", { payloadDigest: undefined }],
    ["no selected revision at all", { selectedRevision: undefined }],
    ["a selected revision that is not a string", { selectedRevision: 7 }],
    ["no scope at all", { scope: undefined }],
  ];

  const answers: Answer[] = [];
  for (const [label, overrides] of mutations) {
    // A receipt whose own operation id is missing or malformed does not
    // correlate with anything — it cannot be matched to a request at all.
    const correlates = !("operationId" in overrides);
    answers.push({ label: `committed, correlated, ${label}`, response: { status: "committed", receipt: receipt(overrides) }, correlates });
    answers.push({
      label: `committed, MISDIRECTED, ${label}`,
      response: { status: "committed", receipt: receipt({ ...overrides, operationId: FOREIGN_OPERATION }) },
      correlates: false,
    });
  }
  answers.push({ label: "committed with no receipt at all", response: { status: "committed" }, correlates: false });

  answers.push({
    label: "pending, correlated",
    response: { status: "pending", operationId: request.operationId, reason: "reference append not acknowledged" },
    correlates: true,
  });
  answers.push({
    label: "pending, MISDIRECTED",
    response: { status: "pending", operationId: FOREIGN_OPERATION, reason: "reference append not acknowledged" },
    correlates: false,
  });

  const codes = [
    "unavailable",
    "timeout",
    "incompatible",
    "stale-selection",
    "stale-epoch",
    "scope-conflict",
    "replay-conflict",
    "refused",
    "a-code-from-a-future-version",
  ];
  for (const code of codes) {
    answers.push({
      label: `error ${code}, correlated`,
      response: { status: "error", code, message: "no", operationId: request.operationId },
      correlates: true,
    });
    answers.push({
      label: `error ${code}, MISDIRECTED`,
      response: { status: "error", code, message: "no", operationId: FOREIGN_OPERATION },
      correlates: false,
    });
    // The id is optional on an error, so its absence is not a mismatch.
    answers.push({
      label: `error ${code}, no correlation id`,
      response: { status: "error", code, message: "no" },
      correlates: true,
    });
  }
  return answers;
}

test("B23: no peer answer discards a pending intent unless it correlates and is terminal", async () => {
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);

  const plan = () => {
    const begun = beginOperation(
      bound,
      writeParams(bound, { revision: 1, proved: ["real work"], unresolved: [], next: "" }, "op-under-test"),
    );
    assert.ok(begun.ok);
    return begun;
  };
  const planned = plan();
  const space = answerSpace(planned.request);
  assert.ok(space.length > 40, `sanity: the answer space is generated, not enumerated by branch (${space.length})`);

  let quarantines = 0;
  let misdirected = 0;
  for (const answer of space) {
    const before = plan().goal;
    assert.ok(before.backend.pending, `sanity: there is an intent to protect (${answer.label})`);

    const after = acceptReceipt(before, answer.response, SELECTION_A);
    const discarded =
      after.goal.backend.pending === null &&
      after.goal.backend.operations.some(
        (record) => record.operationId === "op-under-test" && record.outcome === "quarantined",
      );

    if (discarded) {
      quarantines += 1;
      const code = after.ok ? "(accepted)" : after.code;
      assert.ok(
        answer.correlates,
        `an answer for another operation must not discard this one: ${answer.label}`,
      );
      assert.ok(
        TERMINAL_REJECTIONS.has(code),
        `a non-terminal outcome (${code}) must not discard the intent: ${answer.label}`,
      );
    }

    // The lifecycle walk (B21) proves every transition driven by a WELL-FORMED
    // peer answer is loadable. It cannot see a writer that accepts a malformed
    // answer and persists a record the validator later rejects, because the
    // fake peer never produces one. That gap is closed here, where the
    // malformed answers actually live.
    assert.equal(
      isGoalBackend(after.goal.backend),
      true,
      `the backend must stay loadable after: ${answer.label}`,
    );
    assert.equal(
      isMultiGoal(after.goal),
      true,
      `the whole snapshot must stay loadable after: ${answer.label}`,
    );

    if (!answer.correlates) {
      misdirected += 1;
      assert.ok(
        after.goal.backend.pending !== null || after.ok,
        `a misdirected answer must leave the intent recoverable: ${answer.label}`,
      );
      assert.equal(after.ok, false, `and must not be accepted as success: ${answer.label}`);
    }
  }

  assert.ok(quarantines >= 5, `sanity: the space exercises the quarantine path (${quarantines} times)`);
  assert.ok(misdirected >= 10, `sanity: the space exercises misdirection (${misdirected} answers)`);
});

// --- B24: replay identity is the whole intent ----------------------------

/**
 * Review finding (P1, src/backend.ts): retained operations were matched as
 * `identical` on operation id and payload digest alone. Two operations that
 * differ in kind, scope, selection, or expected revision can carry byte-equal
 * payloads, so a caller reusing an id got the old receipt and skipped the peer
 * — falsely acknowledging an operation that never happened.
 *
 * It matters more than a correctness nit because replay resolution runs BEFORE
 * checkOperationLegality (deliberately, so recovery works after the state has
 * moved on), which means a mis-matched replay bypasses the legality matrix
 * entirely. §4 step 4 refuses a conflicting payload; a different kind or scope
 * is a conflicting REQUEST even when the payload bytes match.
 */
test("B24: reusing an operation id for a different operation is a conflict", async () => {
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);
  const id = "op-reused";
  const payload = { memory: { revision: 1, proved: ["shared bytes"], unresolved: [], next: "" } };

  const first = await runPeerOperation(bound, peer, {
    operationId: id,
    kind: "write",
    expectedState: "bound-available",
    payload,
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  });
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  const after = first.goal;
  const selected = after.backend.binding?.selectedRevision ?? null;
  const callsBefore = peer.calls.length;

  const variants: Array<[string, Partial<OperationParams>]> = [
    ["a different kind", { kind: "transition" }],
    ["a different expected revision", { expectedRevision: "rev-from-another-time" }],
    ["a different branch selection", { selection: SELECTION_B }],
  ];

  for (const [label, override] of variants) {
    const attempt = await runPeerOperation(after, peer, {
      operationId: id,
      kind: "write",
      expectedState: "bound-available",
      payload,
      selection: SELECTION_A,
      expectedRevision: selected,
      ...override,
    });
    assert.equal(attempt.ok, false, `a reused id with ${label} must not be acknowledged`);
    assert.equal(
      attempt.ok === false ? attempt.code : null,
      "replay-conflict",
      `and must be reported as a conflict: ${label}`,
    );
  }
  assert.equal(peer.calls.length, callsBefore, "none of them reached the peer");
  assert.equal(peer.commits, 2, "and nothing was committed a second time");
});

test("B24: a true replay of the same intent still returns its receipt", async () => {
  // Regression preservation: idempotent recovery must keep working, including
  // after the backend state has legitimately moved on.
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);
  const params: OperationParams = {
    operationId: "op-identical",
    kind: "write",
    expectedState: "bound-available",
    payload: { memory: { revision: 1, proved: ["x"], unresolved: [], next: "" } },
    selection: SELECTION_A,
    expectedRevision: bound.backend.binding?.selectedRevision ?? null,
  };

  const first = await runPeerOperation(bound, peer, params);
  assert.equal(first.ok, true, first.ok ? "" : first.message);
  const callsBefore = peer.calls.length;

  const replayed = await runPeerOperation(first.goal, peer, params);
  assert.equal(replayed.ok, true, replayed.ok ? "" : replayed.message);
  assert.ok(replayed.ok);
  assert.equal(replayed.replayed, true, "recognised as a replay");
  assert.deepEqual(replayed.receipt, first.ok ? first.receipt : null, "the same receipt comes back");
  assert.equal(peer.calls.length, callsBefore, "without a peer round trip");
  assert.equal(peer.commits, 2, "and without a second commit");
});

// --- B25/B26: absent, valid, and present-but-malformed are three cases ----

/**
 * Review finding (P1, src/peer.ts): correlationFailure treated a non-string
 * operation id as if the field were ABSENT, and an absent id is deliberately
 * not a mismatch — because on an ERROR the field is optional. On a committed
 * receipt it is mandatory, so the leniency was applied to a branch where it
 * does not belong, and to a value that is not absent but wrong.
 *
 * The consequence is the writer-vs-reader rule again: a receipt with no
 * operation id could be accepted and persisted as a committed record that
 * isGoalBackend later rejects, so the goal would run until it reloaded.
 */
test("B25: a committed receipt missing a mandatory field is never accepted", async () => {
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);
  const plan = () => {
    const begun = beginOperation(
      bound,
      writeParams(bound, { revision: 1, proved: ["real work"], unresolved: [], next: "" }, "op-mandatory"),
    );
    assert.ok(begun.ok);
    return begun;
  };
  const request = plan().request;
  const valid = {
    protocolVersion: 1,
    operationId: request.operationId,
    scope: request.scope,
    selectedRevision: "rev-9",
    payloadDigest: canonicalDigest(request.payload),
    committedAt: 1,
  };

  // Sanity: the well-formed receipt IS accepted, so the cases below fail for
  // the field under test and not because the fixture was broken.
  const accepted = acceptReceipt(plan().goal, { status: "committed", receipt: valid } as any, SELECTION_A);
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.message);

  const mandatory: Array<[string, Record<string, unknown>]> = [
    ["operationId", { operationId: undefined }],
    ["operationId (wrong type)", { operationId: 42 }],
    ["operationId (empty)", { operationId: "" }],
    ["committedAt", { committedAt: undefined }],
    ["committedAt (wrong type)", { committedAt: "soon" }],
    ["payloadDigest", { payloadDigest: undefined }],
    ["selectedRevision", { selectedRevision: undefined }],
    ["selectedRevision (wrong type)", { selectedRevision: 7 }],
    ["scope", { scope: undefined }],
    ["protocolVersion", { protocolVersion: undefined }],
  ];

  for (const [field, override] of mandatory) {
    const before = plan().goal;
    const after = acceptReceipt(
      before,
      { status: "committed", receipt: { ...valid, ...override } } as any,
      SELECTION_A,
    );
    assert.equal(after.ok, false, `a receipt with a bad ${field} must not be accepted`);
    assert.equal(
      after.goal.backend.operations.some(
        (record) => record.operationId === "op-mandatory" && record.outcome === "committed",
      ),
      false,
      `and must not be retained as a committed operation: ${field}`,
    );
    assert.equal(isMultiGoal(after.goal), true, `and must leave a loadable snapshot: ${field}`);
  }
});

/**
 * Review finding (P1, src/backend.ts): markPeerAvailable granted execution
 * authority on a caller-supplied string. Last round it stopped accepting an
 * EMPTY one; the deeper problem was that it accepted any non-empty one. No
 * peer response, scope, generation or contract identity was verified, so an
 * arbitrary revision could resume Goal execution while the authoritative
 * backend was still unavailable.
 */
test("B26: availability is restored only by a verified peer answer", async () => {
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);
  const lost = markPeerUnavailable(bound, "the peer was unloaded");
  assert.equal(lost.backend.state, "bound-unavailable", "sanity: it is waiting to come back");
  const pointerBefore = lost.backend.binding?.selectedRevision;

  // A read the peer really answered, for the scope and epoch in force.
  const probe: PeerRequest = {
    protocolVersion: 1,
    operationId: "op-probe",
    kind: "read",
    scope: goalScope(lost, SELECTION_A),
    expectedRevision: pointerBefore ?? null,
    payload: { profile: "current-scope@1" },
  };
  const answer = await callPeer(peer, probe);
  assert.equal(answer.status, "committed", "sanity: the peer answered the probe");

  const restored = markPeerAvailable(lost, probe, answer);
  assert.equal(restored.backend.state, "bound-available", "a verified answer restores availability");
  assert.equal(isMultiGoal(restored), true);

  // Nothing else may.
  const forgeries: Array<[string, PeerRequest, any]> = [
    [
      "an answer that is not a receipt at all",
      probe,
      { status: "error", code: "unavailable", message: "still gone", operationId: probe.operationId },
    ],
    [
      "a receipt for another execution generation",
      { ...probe, scope: { ...probe.scope, epoch: probe.scope.epoch + 1 } },
      answer,
    ],
    [
      "a receipt for another branch selection",
      { ...probe, scope: { ...probe.scope, selection: SELECTION_B } },
      answer,
    ],
    [
      "a receipt for another work scope",
      { ...probe, scope: { ...probe.scope, scopeId: "goal:someone-else:stage:theirs" } },
      answer,
    ],
    [
      "a receipt for another contract revision",
      { ...probe, scope: { ...probe.scope, contractRevision: "f".repeat(64) } },
      answer,
    ],
  ];

  for (const [label, request, response] of forgeries) {
    const attempt = markPeerAvailable(lost, request, response);
    assert.equal(
      attempt.backend.state,
      "bound-unavailable",
      `availability must not be granted by ${label}`,
    );
    assert.equal(
      attempt.backend.binding?.selectedRevision,
      pointerBefore,
      `and the revision pointer must not move: ${label}`,
    );
    assert.equal(isMultiGoal(attempt), true, `and the snapshot stays loadable: ${label}`);
  }
});

// --- B27: a retained receipt must belong to the operation it is retained for

/**
 * Review finding (P1, src/backend.ts): isCompleteReceipt validated the
 * receipt's operation id and digest but never that its SCOPE matched the record
 * it is retained under — and it carried its own weaker copy of the shape check
 * instead of calling isWellFormedReceipt, which was introduced precisely so the
 * writer and the reader could not drift.
 *
 * The predicate that was meant to close drift left one reader out of the
 * arrangement, which is the drift it was designed to prevent, one level down.
 * The consequence is the third distinct route to answering a replay out of
 * nothing, after the missing-receipt case and the too-narrow replay identity.
 */
test("B27: a replay never returns a receipt that does not belong to its record", async () => {
  const peer = createFakePeer();
  const bound = await bind(twoStepGoal(), peer);
  const honest = bound.backend.operations.find((record) => record.outcome === "committed");
  assert.ok(honest, "sanity: the bind left a committed record");
  assert.ok(honest.receipt, "sanity: with a receipt");

  // A record whose own identity is impeccable, carrying a receipt for someone
  // else's scope. Only the receipt is forged, so replay identity matches.
  const forged: MultiGoal = {
    ...bound,
    backend: {
      ...bound.backend,
      operations: [
        {
          ...honest,
          receipt: { ...honest.receipt!, scope: { ...honest.receipt!.scope, consumer: "pi-research" } },
        },
      ],
    },
  };
  assert.equal(
    isGoalBackend(forged.backend),
    false,
    "a record whose receipt belongs to another scope makes the snapshot malformed",
  );

  // Defence in depth: even reached in memory, the replay must not hand it back.
  const callsBefore = peer.calls.length;
  const replay = beginOperation(forged, bindParams(forged, honest.operationId));
  if (replay.ok && replay.replayed) {
    assert.equal(
      replay.receipt,
      null,
      "a retained receipt inconsistent with its record is not a result to return",
    );
  } else {
    assert.equal(replay.ok, false, "or the replay is refused outright");
  }
  assert.equal(peer.calls.length, callsBefore, "and either way the peer was not consulted");
});

test("B27: scopesEqual and verifyReceipt agree on what makes two scopes differ", () => {
  // Both express "same scope"; they differ only in that verifyReceipt reports
  // WHICH field differed, so it can return a precise code. If a scope field is
  // ever added and only one of them learns about it, they drift — and the one
  // that forgets becomes a hole. Every single-field difference must be caught
  // by both.
  const goal = twoStepGoal();
  const base = goalScope(goal, SELECTION_A);
  const differences: Array<[string, PeerScope]> = [
    ["consumer", { ...base, consumer: "pi-research" }],
    ["scopeId", { ...base, scopeId: "goal:theirs:stage:theirs" }],
    ["contractRevision", { ...base, contractRevision: "f".repeat(64) }],
    ["epoch", { ...base, epoch: base.epoch + 1 }],
    ["selection", { ...base, selection: SELECTION_B }],
  ];

  for (const [field, other] of differences) {
    assert.equal(scopesEqual(base, other), false, `scopesEqual must see a different ${field}`);

    const request: PeerRequest = {
      protocolVersion: 1,
      operationId: "op-drift",
      kind: "write",
      scope: base,
      expectedRevision: "rev-1",
      payload: { memory: null },
    };
    const checked = verifyReceipt(request, {
      status: "committed",
      receipt: {
        protocolVersion: 1,
        operationId: "op-drift",
        scope: other,
        selectedRevision: "rev-2",
        payloadDigest: canonicalDigest(request.payload),
        committedAt: 1,
      },
    });
    assert.equal(checked.ok, false, `verifyReceipt must see a different ${field}`);
  }

  assert.equal(scopesEqual(base, { ...base }), true, "sanity: an identical scope is equal");
});
