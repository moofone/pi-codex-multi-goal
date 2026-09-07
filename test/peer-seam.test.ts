import assert from "node:assert/strict";
import test from "node:test";

import {
  PEER_PROTOCOL_VERSION,
  callPeer,
  canonicalDigest,
  discoverPeer,
  verifyReceipt,
  type PeerRequest,
  type PeerScope,
} from "../src/peer.ts";
import { createFakePeer, operationId } from "./fixtures/fake-peer.ts";

/**
 * P0 gates B02 and B07 (GOAL_WITH_DAG_SUPPORT §10 P0 row):
 *
 *   B02 — "missing/incompatible peer fails boundedly": every failure mode
 *         returns a typed error within a deadline. There is no path on which a
 *         missing, unloaded, wedged, or incompatible peer stalls a tool call.
 *   B07 — "a minimal fake research consumer can bind/read/write without a Goal
 *         record and cannot mutate Goal-owned scope": the seam is reusable, not
 *         Goal-shaped. This file imports nothing from src/state.ts or
 *         src/backend.ts on purpose — a consumer with no MultiGoal must be able
 *         to speak the whole protocol.
 *
 * See docs/peer-protocol.md §2, §3, §7.
 */

const SELECTION = { sessionId: "session-a", branchAnchorId: "anchor-1" };

function scope(consumer: string, scopeId: string, epoch = 0): PeerScope {
  return {
    consumer,
    scopeId,
    contractRevision: "c".repeat(64),
    epoch,
    selection: SELECTION,
  };
}

function request(target: PeerScope, kind: PeerRequest["kind"], payload: unknown, expectedRevision: string | null): PeerRequest {
  return {
    protocolVersion: PEER_PROTOCOL_VERSION,
    operationId: operationId(kind),
    kind,
    scope: target,
    expectedRevision,
    payload,
  };
}

// --- B02: bounded failure -------------------------------------------------

test("B02: a missing peer fails boundedly instead of hanging", async () => {
  const started = Date.now();
  const response = await callPeer(null, request(scope("pi-research", "study:1"), "read", { profile: "x" }, null));

  assert.equal(response.status, "error", "sanity: a missing peer is not success");
  assert.equal(
    response.status === "error" ? response.code : null,
    "unavailable",
    "no registered peer is `unavailable`, not a silent success and not a throw",
  );
  assert.ok(
    Date.now() - started < 1_000,
    "a missing peer must not wait on a deadline it can never satisfy",
  );
});

test("B02: a peer that never answers fails at the deadline, not never", async () => {
  const peer = createFakePeer({ hang: true });
  const started = Date.now();

  const response = await callPeer(peer, request(scope("pi-research", "study:1"), "read", { profile: "x" }, null), {
    timeoutMs: 40,
  });

  const elapsed = Date.now() - started;
  assert.equal(response.status, "error");
  assert.equal(
    response.status === "error" ? response.code : null,
    "timeout",
    "a wedged peer is a bounded timeout, never a hanging tool call",
  );
  assert.ok(elapsed >= 30, `sanity: the deadline was actually awaited (${elapsed}ms)`);
  assert.ok(elapsed < 2_000, `the call returned at its deadline, not later (${elapsed}ms)`);
});

test("B02: a peer that throws fails boundedly and keeps its reason", async () => {
  const peer = createFakePeer({ throws: "transport closed" });

  const response = await callPeer(peer, request(scope("pi-research", "study:1"), "read", { profile: "x" }, null));

  assert.equal(response.status, "error");
  assert.equal(response.status === "error" ? response.code : null, "unavailable");
  assert.match(
    response.status === "error" ? response.message : "",
    /transport closed/,
    "the reason is visible rather than swallowed",
  );
});

test("B02: an incompatible peer is rejected explicitly, not degraded", async () => {
  const older = createFakePeer({ protocolVersion: PEER_PROTOCOL_VERSION + 1 });
  const wrongVersion = await discoverPeer(older, { operations: ["bind", "read", "write"] });
  assert.equal(wrongVersion.ok, false, "a different protocol version cannot be verified, so it is incompatible");
  assert.equal(wrongVersion.ok === false ? wrongVersion.code : null, "incompatible");

  const narrow = createFakePeer({ operations: ["read"] });
  const missingOperation = await discoverPeer(narrow, { operations: ["bind", "read", "write"] });
  assert.equal(missingOperation.ok, false, "a required operation the peer cannot do is incompatible");
  assert.equal(missingOperation.ok === false ? missingOperation.code : null, "incompatible");
  assert.match(missingOperation.ok === false ? missingOperation.message : "", /bind|write/);

  const noProfile = createFakePeer({ profiles: ["something-else@9"] });
  const missingProfile = await discoverPeer(noProfile, {
    operations: ["bind", "read", "write"],
    profile: "current-scope@1",
  });
  assert.equal(missingProfile.ok, false, "an unsupported required profile is rejected explicitly (§4)");
  assert.equal(missingProfile.ok === false ? missingProfile.code : null, "incompatible");

  const usable = createFakePeer();
  const ok = await discoverPeer(usable, { operations: ["bind", "read", "write"], profile: "current-scope@1" });
  assert.equal(ok.ok, true, "sanity: a compatible peer still discovers");
  assert.equal(ok.ok === true ? ok.capabilities.peerId : null, "fake-dag-peer");
});

test("B02: a missing peer never binds by accident", async () => {
  const missing = await discoverPeer(null, { operations: ["bind"] });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false ? missing.code : null, "unavailable");
});

test("B02: a `pending` answer is not success", async () => {
  const peer = createFakePeer({ alwaysPending: true });
  const target = scope("pi-research", "study:pending");
  const bind = request(target, "bind", { contract: { question: "q" }, memory: null }, null);

  const response = await callPeer(peer, bind);
  assert.equal(response.status, "pending", "sanity: the peer answered pending");

  const verified = verifyReceipt(bind, response);
  assert.equal(verified.ok, false, "a SQLite-only pending_ref result is not a commit receipt (§4 step 2)");
  assert.equal(verified.ok === false ? verified.code : null, "pending");
  assert.equal(peer.commits, 0, "nothing was durably selected");
});

// --- B07: the seam is reusable by a non-Goal consumer ---------------------

/**
 * The minimal research consumer of GOAL_WITH_DAG_SUPPORT §13: a study/question
 * scope, its own contract identity, its own epoch. It holds NO MultiGoal, no
 * ordered steps, no criteria, and no Goal memory record. If the protocol had
 * been shaped around Goal, this could not be written.
 */
function researchConsumer(peer: ReturnType<typeof createFakePeer> | null) {
  const target = scope("pi-research", "study:cuda-1:question:occupancy", 3);
  let selectedRevision: string | null = null;

  return {
    target,
    get revision() {
      return selectedRevision;
    },
    async submit(kind: PeerRequest["kind"], payload: unknown, overrideScope?: PeerScope) {
      const req = request(overrideScope ?? target, kind, payload, kind === "bind" ? null : selectedRevision);
      const response = await callPeer(peer, req);
      const verified = verifyReceipt(req, response);
      if (verified.ok && kind !== "read") {
        selectedRevision = verified.receipt.selectedRevision;
      }
      return { response, verified, projection: response.status === "committed" ? response.projection : undefined };
    },
  };
}

test("B07: a research consumer binds, reads, and writes with no Goal record", async () => {
  const peer = createFakePeer();
  const research = researchConsumer(peer);

  const bound = await research.submit("bind", {
    contract: { question: "does occupancy explain the regression?", constraints: ["no live GPU"] },
    memory: null,
  });
  assert.equal(bound.verified.ok, true, "the seam binds a scope that is not a Goal step");
  assert.ok(research.revision, "sanity: binding selected a durable revision");

  const wrote = await research.submit("write", {
    memory: { hypotheses: ["occupancy-bound"], observations: ["kernel 2 is 1.4x"] },
  });
  assert.equal(wrote.verified.ok, true, "and writes its own records through the same operations");

  const read = await research.submit("read", { profile: "current-scope@1" });
  assert.equal(read.verified.ok, true);
  assert.deepEqual(
    (read.projection as { memory: unknown }).memory,
    { hypotheses: ["occupancy-bound"], observations: ["kernel 2 is 1.4x"] },
    "the projection it reads back is the revision it wrote",
  );
});

test("B07: a research consumer cannot mutate Goal-owned scope", async () => {
  const peer = createFakePeer();

  // Goal binds its own scope first, exactly as the Goal adapter would.
  const goalScope = scope("pi-codex-multi-goal", "goal:g-1:stage:s-1");
  const goalBind = request(goalScope, "bind", { contract: { objective: "ship it" }, memory: null }, null);
  const goalBound = await callPeer(peer, goalBind);
  const goalReceipt = verifyReceipt(goalBind, goalBound);
  assert.equal(goalReceipt.ok, true, "sanity: Goal owns this scope");
  const goalRevision = goalReceipt.ok ? goalReceipt.receipt.selectedRevision : null;

  const research = researchConsumer(peer);
  await research.submit("bind", { contract: { question: "q" }, memory: null });

  // The research consumer addresses Goal's scopeId with its own consumer
  // namespace. Supplying the fields does not acquire ownership (§3).
  const intruder: PeerScope = { ...research.target, scopeId: "goal:g-1:stage:s-1" };
  const attempt = await research.submit("write", { memory: { proved: ["mine now"] } }, intruder);

  assert.equal(attempt.verified.ok, false, "the write is refused");
  assert.equal(
    attempt.verified.ok === false ? attempt.verified.code : null,
    "scope-conflict",
    "ownership is the peer's decision, not the caller's claim",
  );
  assert.equal(
    peer.revisionOf("goal:g-1:stage:s-1", "pi-codex-multi-goal"),
    goalRevision,
    "Goal's selected revision did not move",
  );
  assert.deepEqual(
    peer.recordOf("goal:g-1:stage:s-1", "pi-codex-multi-goal")?.contract,
    { objective: "ship it" },
    "Goal's protected contract mirror is untouched",
  );
});

test("B07: a receipt for a foreign scope is refused by the caller too", async () => {
  // Defence in depth: even a peer that answered wrongly cannot publish state,
  // because the caller verifies the echoed scope against its own request.
  const mine = scope("pi-research", "study:1");
  const req = request(mine, "write", { memory: {} }, "rev-1");
  const forged = verifyReceipt(req, {
    status: "committed",
    receipt: {
      protocolVersion: PEER_PROTOCOL_VERSION,
      operationId: req.operationId,
      scope: { ...mine, consumer: "pi-codex-multi-goal" },
      selectedRevision: "rev-2",
      payloadDigest: canonicalDigest(req.payload),
      committedAt: 1,
    },
  });

  assert.equal(forged.ok, false);
  assert.equal(forged.ok === false ? forged.code : null, "scope-conflict");
});

test("B02: a malformed answer is incompatible, never a silent success", () => {
  const req = request(scope("pi-research", "study:1"), "write", { memory: {} }, "rev-1");

  const noReceipt = verifyReceipt(req, { status: "committed" } as never);
  assert.equal(noReceipt.ok, false);
  assert.equal(noReceipt.ok === false ? noReceipt.code : null, "incompatible");

  const noSelection = verifyReceipt(req, {
    status: "committed",
    receipt: {
      protocolVersion: PEER_PROTOCOL_VERSION,
      operationId: req.operationId,
      scope: req.scope,
      selectedRevision: "",
      payloadDigest: canonicalDigest(req.payload),
      committedAt: 1,
    },
  });
  assert.equal(noSelection.ok, false, "a receipt without a durably selected revision is not a commit");
  assert.equal(noSelection.ok === false ? noSelection.code : null, "refused");
});

test("canonicalDigest is key-order independent so an identical payload replays as identical", () => {
  const a = canonicalDigest({ memory: { proved: ["x"], next: "y" }, note: 1 });
  const b = canonicalDigest({ note: 1, memory: { next: "y", proved: ["x"] } });
  assert.equal(a, b, "field order is not part of the payload's identity");
  assert.match(a, /^[0-9a-f]{64}$/, "sanity: it is a sha256 hex digest");
  assert.notEqual(
    a,
    canonicalDigest({ memory: { proved: ["x"], next: "z" }, note: 1 }),
    "a changed value is a different payload",
  );
});
