import assert from "node:assert/strict";
import test from "node:test";

import {
  PEER_PROTOCOL_VERSION,
  callPeer,
  canonicalDigest,
  discoverPeer,
  isWellFormedReceipt,
  scopeKey,
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
  // Reclassified from `refused` (terminal) to `incompatible` (retryable), and
  // deliberately: a receipt that omits the field which MAKES a commit a commit
  // is a malformed answer, not a definitive refusal. It is ambiguous — the peer
  // may well have committed and merely answered badly — and this series has
  // established that ambiguity must not discard a valid pending intent, because
  // a retry is idempotent while a quarantine is not reversible. The substantive
  // claim above is unchanged; only the classification moved, and it moved to
  // the safer side.
  assert.equal(noSelection.ok === false ? noSelection.code : null, "incompatible");

  // Whitespace is not a revision either, and is classified the same way.
  const blankSelection = verifyReceipt(req, {
    status: "committed",
    receipt: {
      protocolVersion: PEER_PROTOCOL_VERSION,
      operationId: req.operationId,
      scope: req.scope,
      selectedRevision: "   ",
      payloadDigest: canonicalDigest(req.payload),
      committedAt: 1,
    },
  });
  assert.equal(blankSelection.ok, false, "a blank selected revision is not a durable selection");
  assert.equal(blankSelection.ok === false ? blankSelection.code : null, "incompatible");
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

// --- B17: an answer must correlate to the request it is applied to -------

/**
 * Review finding (P1, src/peer.ts): verifyReceipt accepted every error
 * response on its code alone and ignored the `operationId` the protocol
 * already promises. A delayed error for another request could therefore be
 * applied to the caller's pending intent — and the codes involved
 * (`scope-conflict`, `refused`) are legitimately terminal, so it destroyed a
 * valid operation instead of leaving it retryable.
 *
 * This is the third door onto the same failure: an unrelated answer discarding
 * recoverable work. The committed path has always correlated through
 * `receipt.operationId`; the error and pending paths now do too.
 */
test("B17: a terminal error correlated to another operation cannot be applied", () => {
  const req = request(scope("pi-research", "study:1"), "write", { memory: {} }, "rev-1");

  for (const code of ["refused", "scope-conflict", "replay-conflict", "stale-epoch"] as const) {
    const checked = verifyReceipt(req, {
      status: "error",
      code,
      message: "an answer for another request entirely",
      operationId: "somebody-elses-operation",
    });
    assert.equal(checked.ok, false, "sanity: it is still a failure");
    assert.equal(
      checked.ok === false ? checked.code : null,
      "incompatible",
      `a ${code} answering another operation says nothing about this one, so it must not be terminal`,
    );
  }
});

test("B17: a correlated terminal error is still terminal", () => {
  // Regression preservation: correlation must not soften a real refusal.
  const req = request(scope("pi-research", "study:1"), "write", { memory: {} }, "rev-1");
  const checked = verifyReceipt(req, {
    status: "error",
    code: "refused",
    message: "the peer validated the mutation and rejected it",
    operationId: req.operationId,
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.ok === false ? checked.code : null, "refused");
});

test("B17: an error with no operation ID is still applied to the request", () => {
  // The field is optional: a transport that cannot correlate is not thereby a
  // mismatch, and callPeer's own synthesised errors carry the request's ID.
  const req = request(scope("pi-research", "study:1"), "write", { memory: {} }, "rev-1");
  const checked = verifyReceipt(req, {
    status: "error",
    code: "refused",
    message: "no correlation available",
  });
  assert.equal(checked.ok === false ? checked.code : null, "refused");
});

test("B17: a pending answer for another operation is not applied either", () => {
  const req = request(scope("pi-research", "study:1"), "write", { memory: {} }, "rev-1");
  const checked = verifyReceipt(req, {
    status: "pending",
    operationId: "somebody-elses-operation",
    reason: "reference append not acknowledged",
  });
  assert.equal(checked.ok, false);
  assert.equal(
    checked.ok === false ? checked.code : null,
    "incompatible",
    "a pending answer about another operation tells this caller nothing",
  );
});

// --- B18: identities must be injective -----------------------------------

/**
 * Review finding (P1, src/peer.ts): `${consumer} ${scopeId}` is not injective —
 * ("a", "b c") and ("a b", "c") produce the same key. Both fields are
 * caller-controlled, so a consumer could collide with another scope and cause
 * ownership conflicts, or address the wrong record in a peer that keys storage
 * on it. `canonicalDigest` and `contractRevision` already take this care; the
 * scope key did not.
 */
test("B18: scopeKey cannot be made to collide by moving the delimiter", () => {
  const left = scopeKey({ ...scope("a", "b c") });
  const right = scopeKey({ ...scope("a b", "c") });
  assert.notEqual(left, right, "two different identities must not share a key");

  // And it is still a function: the same identity keys the same.
  assert.equal(scopeKey({ ...scope("a", "b c") }), left, "sanity: the key is deterministic");

  // Neither field can escape its own position, whatever it contains.
  const tricky = [
    ["a", 'b" ,"c'],
    ['a" ,"b', "c"],
    ["a", "b\\c"],
    ["a\\", "c"],
    ["", "a b"],
    ["a b", ""],
  ] as const;
  const keys = tricky.map(([consumer, scopeId]) => scopeKey({ ...scope(consumer, scopeId) }));
  assert.equal(new Set(keys).size, keys.length, "every distinct identity gets a distinct key");
});

test("B18: a legitimate scope is not blocked by a colliding neighbour", async () => {
  const peer = createFakePeer();

  // Two genuinely different consumers whose identities collide under a
  // space-joined key: ("consumer-a", "scope one") and ("consumer-a scope", "one").
  const first = scope("consumer-a", "scope one");
  const firstBind = request(first, "bind", { contract: { objective: "mine" }, memory: null }, null);
  const firstDone = verifyReceipt(firstBind, await callPeer(peer, firstBind));
  assert.equal(firstDone.ok, true, "sanity: the first consumer bound its scope");

  const second = scope("consumer-a scope", "one");
  const secondBind = request(second, "bind", { contract: { objective: "also mine" }, memory: null }, null);
  const secondDone = verifyReceipt(secondBind, await callPeer(peer, secondBind));

  assert.equal(
    secondDone.ok,
    true,
    "a different consumer's own scope must not be refused because its key collided",
  );
  assert.notEqual(
    firstDone.ok === true ? firstDone.receipt.selectedRevision : null,
    secondDone.ok === true ? secondDone.receipt.selectedRevision : null,
    "and the two scopes are separate records, not one",
  );
  assert.deepEqual(
    peer.recordOf("scope one", "consumer-a")?.contract,
    { objective: "mine" },
    "the first consumer's record is untouched",
  );
});

// --- B31: discovery keeps its bounded-failure promise for nonsense too ----

/**
 * Review finding (P1, src/peer.ts): the capability parser validated
 * `protocolVersion` and `peerId` but not `operations` or `profiles`, so a peer
 * answering `operations: {}` made `new Set(...)` throw instead of returning the
 * bounded typed result discovery promises.
 *
 * Nothing generated covered discoverPeer at all — every guard in this suite
 * pointed at the answer path. Discovery makes the same promise the answer path
 * makes (a typed failure, never an exception), so it gets the same treatment: a
 * generated space over capability responses, asserting the call never throws
 * and always returns a typed result.
 *
 * The round-9 sweep examined `capabilities.operations` and cleared it, reasoning
 * that absent means "supports nothing" and fails the required check. That is
 * true of ABSENT and says nothing about MALFORMED — in the very round whose
 * subject was that those are two different cases.
 */

/** The closed set, from docs/peer-protocol.md §4.4 — the contract, not the code. */
const PROTOCOL_ERROR_CODES = new Set([
  "unavailable",
  "timeout",
  "incompatible",
  "stale-selection",
  "stale-epoch",
  "scope-conflict",
  "replay-conflict",
  "refused",
]);

function capabilitySpace(): Array<{ label: string; value: unknown; usable: boolean }> {
  const valid = {
    protocolVersion: PEER_PROTOCOL_VERSION,
    peerId: "fake-dag-peer",
    operations: ["bind", "read", "write", "transition", "detach"],
    profiles: ["current-scope@1"],
  };
  const mutate = (label: string, overrides: Record<string, unknown>) => ({
    label,
    value: { ...valid, ...overrides },
    usable: false,
  });
  return [
    { label: "a valid announcement", value: valid, usable: true },
    { label: "nothing at all", value: undefined, usable: false },
    { label: "null", value: null, usable: false },
    { label: "a string", value: "hello", usable: false },
    { label: "a number", value: 7, usable: false },
    { label: "an array", value: [], usable: false },
    { label: "an empty object", value: {}, usable: false },
    mutate("no protocol version", { protocolVersion: undefined }),
    mutate("a non-numeric protocol version", { protocolVersion: "one" }),
    mutate("another protocol version", { protocolVersion: PEER_PROTOCOL_VERSION + 1 }),
    mutate("no peer id", { peerId: undefined }),
    mutate("an empty peer id", { peerId: "" }),
    mutate("a non-string peer id", { peerId: 42 }),
    // The nested cases the sweep missed: present, but not what it claims to be.
    mutate("operations as an object", { operations: {} }),
    mutate("operations as a string", { operations: "read" }),
    mutate("operations as null", { operations: null }),
    mutate("operations of numbers", { operations: [1, 2, 3] }),
    mutate("operations containing an object", { operations: ["bind", {}] }),
    mutate("no operations at all", { operations: undefined }),
    mutate("profiles as an object", { profiles: {} }),
    mutate("profiles as a string", { profiles: "current-scope@1" }),
    mutate("profiles as null", { profiles: null }),
    mutate("profiles of numbers", { profiles: [1] }),
    mutate("no profiles at all", { profiles: undefined }),
  ];
}

test("B31: discovery never throws and always returns a typed result", async () => {
  const space = capabilitySpace();
  assert.ok(space.length > 20, `sanity: the space is generated (${space.length} announcements)`);
  let usable = 0;

  for (const announcement of space) {
    const peer = createFakePeer({ capabilitiesOverride: announcement.value });
    let result: Awaited<ReturnType<typeof discoverPeer>>;
    try {
      result = await discoverPeer(peer, {
        operations: ["bind", "read", "write"],
        profile: "current-scope@1",
      });
    } catch (error) {
      assert.fail(`discovery must not throw on ${announcement.label} (${String(error)})`);
    }

    if (announcement.usable) {
      usable += 1;
      assert.equal(result.ok, true, `a valid announcement must discover: ${announcement.label}`);
      continue;
    }
    assert.equal(result.ok, false, `${announcement.label} must not discover`);
    const code = result.ok === false ? result.code : null;
    assert.ok(
      code !== null && PROTOCOL_ERROR_CODES.has(code),
      `${announcement.label} must fail with a code the protocol defines, got ${String(code)}`,
    );
    assert.equal(
      code,
      "incompatible",
      `an announcement this protocol version cannot use is incompatible: ${announcement.label}`,
    );
  }

  assert.equal(usable, 1, "sanity: exactly one announcement in the space is usable");
});

test("B31: the transports that cannot answer are still bounded", async () => {
  const missing = await discoverPeer(null, { operations: ["bind"] });
  assert.equal(missing.ok === false ? missing.code : null, "unavailable");

  const throwing = await discoverPeer(createFakePeer({ throws: "socket closed" }), { operations: ["bind"] });
  assert.equal(throwing.ok === false ? throwing.code : null, "unavailable");

  const started = Date.now();
  const wedged = await discoverPeer(createFakePeer({ hang: true }), { operations: ["bind"] }, { timeoutMs: 40 });
  assert.equal(wedged.ok === false ? wedged.code : null, "timeout");
  assert.ok(Date.now() - started < 2_000, "and it returned at its deadline");
});

test("B32: a well-formedness predicate validates to the depth its callers assume", () => {
  // A shallow check that callers treat as deep is worse than no check: it turns
  // a malformed input into a confident misclassification. isWellFormedReceipt
  // only tested that `scope` was an object, so a receipt with `scope: {}`
  // reached the identity comparisons and came back `scope-conflict` or
  // `stale-epoch` — terminal codes, which discard the caller's pending work.
  const base = {
    protocolVersion: PEER_PROTOCOL_VERSION,
    operationId: "op-1",
    scope: scope("pi-research", "study:1"),
    selectedRevision: "rev-1",
    payloadDigest: "a".repeat(64),
    committedAt: 1,
  };
  assert.equal(isWellFormedReceipt(base), true, "sanity: a complete receipt is well formed");

  const shallow: Array<[string, unknown]> = [
    ["an empty scope", {}],
    ["a scope with no consumer", { ...base.scope, consumer: undefined }],
    ["a scope with no work id", { ...base.scope, scopeId: undefined }],
    ["a scope with a numeric work id", { ...base.scope, scopeId: 7 }],
    ["a scope with no contract revision", { ...base.scope, contractRevision: undefined }],
    ["a scope with a non-integer epoch", { ...base.scope, epoch: 1.5 }],
    ["a scope with no selection", { ...base.scope, selection: undefined }],
    ["a scope whose selection is a string", { ...base.scope, selection: "anchor" }],
    ["a scope whose selection has no session", { ...base.scope, selection: { branchAnchorId: "a" } }],
    ["a scope that is an array", []],
  ];
  for (const [label, badScope] of shallow) {
    assert.equal(
      isWellFormedReceipt({ ...base, scope: badScope }),
      false,
      `a receipt carrying ${label} is not well formed`,
    );
  }
});
