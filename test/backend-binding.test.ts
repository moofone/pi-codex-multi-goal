import assert from "node:assert/strict";
import test from "node:test";

import {
  abandonOperation,
  acceptReceipt,
  backendAdmitsExecution,
  beginOperation,
  goalOwnsMemory,
  goalScope,
  markPeerUnavailable,
  reconcileSelection,
  resolveReplay,
  runPeerOperation,
  type OperationParams,
} from "../src/backend.ts";
import { callPeer, canonicalDigest, verifyReceipt, type PeerSelection } from "../src/peer.ts";
import {
  acceptCompletion,
  currentStage,
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

function writeParams(goal: MultiGoal, memory: unknown, id = operationId("write")): OperationParams {
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
  const digest = canonicalDigest(params.payload);

  assert.deepEqual(
    resolveReplay(goal.backend, id, digest),
    { verdict: "novel" },
    "sanity: an unknown ID is novel",
  );

  const bound = (await runPeerOperation(goal, peer, params)).goal;
  assert.equal(resolveReplay(bound.backend, id, digest).verdict, "identical");
  assert.equal(resolveReplay(bound.backend, id, canonicalDigest({ other: true })).verdict, "conflict");
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
    resolveReplay(moved.backend, pendingId, canonicalDigest(begun.request.payload)).verdict,
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
