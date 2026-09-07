# Peer protocol contract (P0)

Status: prerequisite contract for the binding and recovery protocol.
Owners: `GOAL_WITH_DAG_SUPPORT.md` §3 (binding lifecycle), §4 (peer protocol and
durable operations), §9 (invariants), §12 ("Before coding P0, specify exact
protocol payloads, target host compatibility, branch-selection checks, operation
retention, and recovery transitions"). Identity names follow
`PI_DAG_COMPACT.md` D7 and §1.

This document is the contract, not a description of what happened to get built.
`src/peer.ts` is the consumer-agnostic wire shape; `src/backend.ts` is the
Goal-side adapter and the persisted operation state machine. There is no DAG
peer yet: P0 proves the seam against an in-process fake
(`test/fixtures/fake-peer.ts`). Task 5.1 replaces that fake with the real DAG
behind this same contract, over the host's shared extension event mechanism.

## 1. What this protocol is, and is not

It carries three things and nothing else:

1. capability discovery,
2. reading a scoped, revision-tagged projection,
3. submitting scoped, idempotent mutations and transitions.

It is not a transaction coordinator, a planner, a second storage service, or a
plugin framework. Domain validation stays in the consumer. The peer enforces
scope ownership, protected mirrors, structural integrity, and durable selection.

Goal is the first consumer, not the shape of the protocol. A research consumer
(§13 of the Goal spec) maps its own study/experiment identities onto the same
fields and needs no Goal record. That reusability is a P0 gate, not a promise.

## 2. Versioning and host compatibility

```ts
PEER_PROTOCOL_VERSION = 1
```

Exact match. A peer announcing any other `protocolVersion` is **incompatible**,
not "best effort": a caller that cannot verify a receipt against a known shape
cannot know whether a mutation committed. An incompatible peer produces a
bounded `incompatible` failure and the backend goes to `bound-unavailable`
(if it was bound) or stays `unbound` (if it was not).

Required capabilities are declared by the caller, not assumed:

```ts
interface PeerRequirements {
  operations: PeerOperationKind[];   // every one must be supported
  profile?: string;                  // projection profile, if the caller needs one
}
```

An unsupported required operation or projection profile is rejected explicitly
(`incompatible`) rather than silently degraded. This is the "capability
negotiation rejects an unsupported required profile explicitly" rule of §4.

**Host compatibility.** The protocol is transport-agnostic by construction: a
`PeerClient` is two async methods. The intended transport is the host's shared
extension event mechanism, verified under the production loader in task 5.1.
Until then the following are contract, and P0 asserts them against the fake:

- No shared module singleton, no imported engine, no direct access to the
  peer's database. `PeerClient` is the only surface.
- Registration order is not a dependency: a caller that finds no peer gets
  `unavailable` immediately and keeps working (see §7).
- Late responses cannot publish state. Every response is verified against the
  *still-current* intent, scope, and selection before anything is persisted
  (§5 step 3). Cancellation, pause, generation change, and branch change all
  invalidate an in-flight callback by that check alone — the transport does not
  have to guarantee delivery ordering.
- Unload removes handlers. On the Goal side an unloaded peer is indistinguish-
  able from a missing one: `unavailable`.

## 3. Identity

Every request carries one comparable identity tuple. The generic names are the
protocol's; the Goal adapter maps its own onto them.

```ts
interface PeerSelection {
  sessionId: string;        // the session the operation was planned in
  branchAnchorId: string;   // the selected branch entry it was planned against
}

interface PeerScope {
  consumer: string;         // namespaced consumer/owner, e.g. "pi-codex-multi-goal"
  scopeId: string;          // stable work-scope identity within that consumer
  contractRevision: string; // deterministic identity of the accepted contract
  epoch: number;            // execution epoch; stale epochs are refused
  selection: PeerSelection;
}
```

| Protocol field | Goal adapter | Research adapter (future) |
|---|---|---|
| `consumer` | `"pi-codex-multi-goal"` | its own package name |
| `scopeId` | `goal:<goalId>:stage:<Stage.id>`, each component percent-encoded | `study:<studyId>:question:<questionId>` |
| `contractRevision` | `MultiGoal.contractRevision` (D7 sha256) | its accepted question/constraints hash |
| `epoch` | `GoalExecution.generation` | its own execution epoch |
| `selection` | the host session id and selected branch anchor | the same |

`scopeId` uses `Stage.id`, never the displayed step number (D7). The displayed
number changes meaning across a transition; the id does not.

**Every identity built from more than one caller-controlled value must be
injective.** Joining two free-form strings with a delimiter is not: `("a",
"b c")` and `("a b", "c")` name the same thing, which lets one consumer collide
with another's scope and, in a peer that keys storage on it, address the wrong
record. Use a collision-free encoding — JSON, as `canonicalDigest` and
`contractRevision` do, or per-component percent-encoding — so no value can
reach across a field boundary. This applies to the scope key, the mapped
`scopeId`, and any operation ID derived from another.

The caller **cannot acquire ownership by supplying these fields**. The peer
decides who owns a scope; a request from a consumer that does not own the
addressed scope is refused with `scope-conflict`. Goal's ordered-step rules and
criteria stay in the Goal adapter and never enter the protocol.

## 4. Messages

### 4.1 Capability discovery

```ts
interface PeerCapabilities {
  protocolVersion: number;
  peerId: string;                    // e.g. "pi-dag-compact"
  operations: PeerOperationKind[];
  profiles: string[];                // projection profiles it can render
}
```

### 4.2 Request

```ts
type PeerOperationKind = "bind" | "read" | "write" | "transition" | "detach";

interface PeerRequest {
  protocolVersion: number;
  operationId: string;               // correlation + idempotency key
  kind: PeerOperationKind;
  scope: PeerScope;
  expectedRevision: string | null;   // the selected revision this was planned against
  payload: unknown;                  // kind-specific; digested for replay protection
}
```

`expectedRevision` is `null` only for `bind` (there is no selected revision
yet). Every other kind carries the revision the caller believes is selected; a
mismatch is `stale-selection` and nothing is committed.

Payloads by kind:

| Kind | Payload | Mutation? |
|---|---|---|
| `bind` | `{ contract: { objective, criteria: [{id, text, requiresHumanDecision}] }, memory: GoalMemory }` — the protected contract mirror plus the migrated working record | yes |
| `read` | `{ profile: string }` | no |
| `write` | `{ memory: GoalMemory }` — the consumer's owned current-scope records only | yes |
| `transition` | `{ contract: {...}, acceptedEvidence: EvidenceRef[] }` — archive this scope, install the next contract | yes |
| `detach` | `{ profile: string }` — export the selected projection and release authority | yes |

A `read` answer carries `projection`; `bind`, `write` and `transition` answers
need not. See "An absent field is not an empty value" below for what a missing
projection means.

The `read` payload deliberately carries no consumer semantics: a profile
declares its own version, required sections, and rendering budget on the peer
side. Profile-specific rendering never creates a second writable summary.

### 4.3 Response

```ts
type PeerResponse =
  | { status: "committed"; receipt: PeerReceipt; projection?: unknown }
  | { status: "pending"; operationId: string; reason: string }
  | { status: "error"; code: PeerErrorCode; message: string; operationId?: string };

interface PeerReceipt {
  protocolVersion: number;
  operationId: string;
  scope: PeerScope;            // echoed verbatim
  selectedRevision: string;    // the DURABLY SELECTED revision after the commit
  payloadDigest: string;       // sha256 of the canonical payload
  committedAt: number;
}
```

**`pending` is never success.** §4 step 2: "Return a receipt only after durable
selection; a SQLite-only `pending_ref` result is not success." A `pending`
response leaves the Goal-side intent in place, publishes nothing, and grants
nothing. It is reconciled on the next attempt through the peer's own
pending-reference reconciliation, never from an in-memory snapshot.

**Every answer that carries an operation ID must correlate.** A response whose
`operationId` is present and is not the request's is an answer to someone
else's request: it says nothing about this one and must not be applied to it.
This holds on **every** branch — committed, pending and error alike — because
`scope-conflict`, `replay-conflict`, `stale-selection`, `stale-epoch` and
`refused` are terminal and would discard a valid pending intent. A mismatch is
reported as `incompatible`, which is retryable — the caller learns nothing and
loses nothing. The ID is optional on an error, so its ABSENCE is not a
mismatch; only a present and different ID is.

Stated as the invariant it is, because it has now been breached through three
separate branches: **an answer may reduce a pending intent to `quarantined`
only if it correlates to that intent AND its outcome is a terminal code.**
`test/backend-binding.test.ts` asserts this over a generated answer space
rather than over the branches known at the time of writing.

**An absent field is not an empty value.** A `read` or `detach` answer that
omits `projection`, or whose projection omits `memory`, means the peer told the
caller *nothing*; it does not mean the working set is empty. The two must stay
distinguishable, because collapsing them turns a dropped payload into a valid
instruction to replace the caller's record with nothing. A peer with an empty
working set says so explicitly, with a present `memory` whose fields are present
and correctly typed: `{ proved: [], unresolved: [], next: "" }` is an export;
a missing `projection` is a failed read.

### 4.4 Error codes

| Code | Meaning | Intent kept? |
|---|---|---|
| `unavailable` | no peer registered, peer threw, transport failed, peer unloaded | yes — retryable |
| `timeout` | the peer did not answer within the call deadline | yes — retryable |
| `incompatible` | protocol version, operation, or required profile unsupported | yes — retryable after the peer changes |
| `stale-selection` | `expectedRevision` or branch no longer current | no — quarantined |
| `stale-epoch` | the execution generation moved on | no — quarantined |
| `scope-conflict` | the caller does not own the addressed scope | no — quarantined |
| `replay-conflict` | this `operationId` already exists with a different payload | no — quarantined |
| `refused` | the peer validated the mutation and rejected it | no — quarantined |

"Intent kept" decides recovery: a retryable failure keeps the persisted intent
so the same `operationId` and payload can be replayed; a terminal failure moves
the intent into the retained-operations list as `quarantined` so a late receipt
for it can still be refused, and the caller must re-plan under a new id.

**The set is closed, and unrecognised codes are `incompatible`.** A response
carrying a code outside this table is rejected by the response parser and
reported as `incompatible`, which is retryable. It is never treated as a new
terminal class: the failure most likely to produce a code this protocol version
does not know is an incompatible or malformed peer, and calling that terminal
would permanently discard an intent that is in fact recoverable. Classification
is by the closed TERMINAL set — `stale-selection`, `stale-epoch`,
`scope-conflict`, `replay-conflict`, `refused` — so anything a caller does not
recognise keeps its intent rather than losing it. An intent is only ever
discarded by a code that positively means "this can never succeed".

## 5. The recoverable ordering

There is no shared transaction between Goal session state and the peer's
storage. §4's four steps map onto these functions:

1. **`beginOperation`** — Goal checks its own scope, ownership, expected
   revision, state and (where applicable) evidence, then persists a pending
   intent: `{operationId, kind, expectedState, scope, expectedRevision,
   payloadDigest, payload, createdAt}`. **At most one** binding, memory or
   transition operation may be pending for a stage. A second, different
   operation while one is pending is refused locally; nothing reaches the peer.
2. **Peer commits** — the peer validates the entire mutation and protected
   scope, commits it, appends its reference on the selected branch, and
   acknowledges selection. Only then does it return a receipt.
3. **`acceptReceipt`** — Goal verifies the receipt against the *still-current*
   intent and selection: protocol version, operation id, payload digest, scope
   identity (consumer, scopeId, contractRevision, epoch, selection), and a
   non-empty `selectedRevision`. Only after that does it persist the
   corresponding backend state, revision pointer and acknowledgement. Success is
   published only after this step.
4. **Replay** — `resolveReplay` returns `novel`, `identical` (the retained
   receipt is returned as-is, nothing is re-run), `quarantined` (re-plan under a
   new id), or `conflict` (refused, and nothing is mutated). A pending operation
   never causes a second credit, mutation, completion or kickoff.

   **Replay identity is the whole intent, not the id and payload.** An
   operation ID is a name; two operations are the same operation only when
   their **kind, scope (consumer, work scope, contract revision, execution
   epoch and branch selection), expected revision, and payload digest** all
   match. Anything else under a used ID is a `conflict`: §4 step 4 refuses a
   conflicting payload, and a different kind or scope is a conflicting REQUEST
   even when the payload bytes are equal. This is load-bearing rather than
   pedantic — replay resolution deliberately runs BEFORE the legality checks of
   §6.1 so that recovery still works after the state has legitimately moved on,
   so a replay matched on too little would bypass the legality matrix entirely
   and be acknowledged with an unrelated operation's receipt. For the same
   reason a retained record stores the identity it was planned with, not just
   its ID and digest.

### 5.1 Partial-write boundaries

| Crash point | What is persisted | Recovery on reload |
|---|---|---|
| after the intent, before the peer call | `pending` present, no receipt | replay the same id and payload; the peer has no record and commits exactly once |
| after the peer commit, before the receipt arrives | `pending` present, peer holds the receipt | replay the same id and payload; the peer returns the **same** receipt; Goal accepts it. No second mutation, no second credit |
| after the receipt, before Goal's acknowledgement | `pending` present | identical to the row above — the receipt is not authority until Goal has persisted its acknowledgement |
| after Goal's acknowledgement | `pending` cleared, receipt retained in `operations` | replay returns the retained result **without calling the peer** |

If the peer commits but Goal's acknowledgement fails, the intent is retained and
recovery runs from the receipt. If the peer's reference append fails, its own
pending-reference reconciliation owns it; Goal does not acknowledge success from
an in-memory snapshot.

### 5.2 Branch-selection checks

Three checks, all on the Goal side, all before anything is published:

1. **Planning.** `beginOperation` stamps the intent with the current
   `PeerSelection`. That stamp, not the live selection, is what the receipt is
   later compared against.
2. **Movement.** When the selection changes (a branch switch, a session tree
   navigation, a different session), `reconcileSelection` refuses to attach the
   pending intent to the new branch: the intent is quarantined with its reason
   and its `operationId` is retained so a late receipt for it is refused.
   Re-planning happens under a new id on the branch that owns it; the peer's own
   idempotency prevents a double commit if the original did commit.
3. **Verification.** `acceptReceipt` compares the receipt's
   `scope.selection` against the intent's. A receipt that arrives after the
   branch moved matches no current intent and is refused.

Late commits after a pause may be reconciled as stored data, but they cannot
resume execution or grant credit to a new generation.

### 5.3 Operation retention

`backend.operations` is a bounded FIFO of
`{operationId, kind, scope, expectedRevision, payloadDigest, outcome,
receipt|null, reason|null}`, capped at `MAX_RETAINED_OPERATIONS` (16). It
retains the planned identity, not just the ID and digest, because that is what
a replay is matched against. Retention scope is **the lifetime in which an
operation can be retried**, which is the stage:

- a stage transition clears the list, because the next stage has a different
  `scopeId` and `contractRevision` and no old operation can address it;
- a rebind to a different scope clears it for the same reason;
- within a stage, the oldest record is dropped first once the cap is reached.

## 6. Backend states

The five persisted states of §3's table. `MultiGoal.backend.state`:

| State | Goal-side behaviour |
|---|---|
| `unbound` | **Exactly today's Goal-only behaviour.** The 8 KiB memory record, the evidence path, and compaction are untouched. The peer is not consulted at all. An unrelated peer checkpoint has no effect: discovering one does not bind, does not change state, and does not reject a working Goal-only memory write |
| `binding-pending` | The intended migration is persisted and Goal-owned execution is withheld during the switch. Goal-only memory writes are refused, so two writable authorities are never exposed |
| `bound-available` | The peer is the sole working-memory authority. Goal reads a revision-tagged projection and writes through the adapter. Any retained Goal blob is a read-only, revision-tagged cache |
| `bound-unavailable` | The binding, the memory pointers and the allowances are preserved. Goal-owned execution is paused with a visible reason. The old blob is not resurrected and completion requirements are not weakened (invariant 8) |
| `detached` | Goal-only mode, entered only after a validated export of the selected current-stage projection and a persisted backend switch. The binding is RELEASED, not kept as a decoration — a binding in a state that disclaims authority is a contradiction — and its provenance moves to `reason`. If the export cannot fit the 8 KiB record without losing required continuity, the switch stays pending and reports why; it is never silently truncated |

Optional means the peer is not required to *start* an unbound goal. It does not
mean an authoritative backend may disappear without recovery: an explicit
disable or unload after binding takes the `bound-unavailable` or `detached`
path, never a silent return to `unbound`.

Transitions:

```
unbound ──bind intent──▶ binding-pending ──receipt──▶ bound-available
                              │                          │      ▲
                              │ retryable failure         │      │ peer returns
                              ▼                           ▼      │
                        (intent retained,          bound-unavailable
                         state unchanged)                  │
                                                           │ validated export
                                                           ▼
                                                       detached
```

`detached` is terminal for that binding; a later bind starts a new one.

**A binding is scoped to one stage.** Its `scopeId` is
`goal:<goalId>:stage:<Stage.id>`, so a stage transition moves to a scope that
nothing has bound. The binding therefore ends with the stage it belonged to:
the next stage starts `unbound`, with the empty working-memory record §8 of the
Goal spec mandates, and the backend `reason` records which peer, task and
revision the previous stage was bound to so the change is visible rather than
silent. The pending intent and the retained receipts are cleared with it —
neither can address the new `scopeId` and `contractRevision` — which also
satisfies "a stage transition invalidates old reviews and active selections
before admitting the next stage" (PI_DAG_COMPACT §1).

The next stage is therefore always runnable. **No state reachable within P0 may
be permanently unrecoverable**, and P0 has neither a transition operation nor a
runtime path that submits one: moving the new stage to `binding-pending` would
persist a switch that nothing could complete, `abandonOperation` could not act
on it because no intent would exist, and the goal would be wedged with no
user-reachable exit. Task 5.3 replaces this rule with the durable transition
operation that archives the old stage and installs the next stage's protected
contract in one scoped mutation, and carries the binding across as part of it.

### 6.2 Snapshot consistency

§6.1 governs operations. It is not enough on its own, because a persisted
snapshot **asserts** a state rather than reaching it through an operation: a
backend loaded from disk enters the state machine's invariants without passing
the guard that enforces them. So a snapshot must satisfy its own state, and one
that does not is malformed — the whole snapshot, not a field to be repaired, so
that a corrupt record can never be laundered into authority. Reconstruction
keeps the last valid snapshot when it skips one.

| State | Requires | Forbids |
|---|---|---|
| `unbound` | — | a binding; a pending intent; any `committed` retained record |
| `binding-pending` | a pending intent whose kind is `bind` | a binding |
| `bound-available` | a binding with a non-empty `selectedRevision` | a pending intent whose kind is `bind` |
| `bound-unavailable` | a binding with a non-empty `selectedRevision` | a pending intent whose kind is `bind` |
| `detached` | — | a binding; a pending intent |

Read as two biconditionals: **a binding exists exactly when the state is
`bound-available` or `bound-unavailable`**, and **a pending `bind` intent exists
exactly when the state is `binding-pending`**. Only a bind switches authority,
and planning one moves the state with it, so the two imply each other.

Retained operation records:

| Outcome | Requires | Forbids |
|---|---|---|
| `committed` | a complete receipt: this protocol version, the record's own `operationId`, a valid scope, a non-empty `selectedRevision`, and a `payloadDigest` equal to the record's | — |
| `quarantined` | a `reason` | a receipt |

A `committed` record is what answers an identical replay **without contacting
the peer**, so an incomplete one would let a replay return success out of
nothing. A `quarantined` record exists to refuse a late receipt and to tell the
user why, so it must carry a reason and must not carry proof of a commit.

Operation IDs are unique across the retained list, and a pending intent's ID may
not also appear in it: otherwise replay resolution would depend on list order,
which is not an identity. Payload digests are sha256 hex.

A pending intent's `expectedState` must be the state its kind can reach (§6.1),
because that field is what the acknowledgement promotes on.

### 6.1 Operation legality

The state machine above is enforced by the caller **before the intent is
persisted**, never delegated to the peer. A peer that would happily accept an
illegal operation must not be able to promote Goal into `bound-available`
without a bind, so these checks are Goal's own.

| Kind | Legal from | Required `expectedState` | Required `expectedRevision` |
|---|---|---|---|
| `bind` | `unbound`, `detached`, `binding-pending` | `bound-available` | `null` — a bind is what selects the first revision, so it cannot claim one |
| `write` | `bound-available` | `bound-available` | the binding's current `selectedRevision` |
| `transition` | `bound-available` | `bound-available` | the binding's current `selectedRevision` |
| `detach` | `bound-available` | `detached` | the binding's current `selectedRevision` |
| `read` | any | — | — (no intent is persisted; reads mutate nothing) |

Consequences worth stating explicitly:

- A second `bind` over a live binding is refused. Replacing an authority without
  detaching from it would lose the export §3 requires.
- `write`, `transition` and `detach` require a binding with a non-null
  `selectedRevision`. There is no path on which a receipt installs a binding
  that no `bind` created.
- `detach` requires `bound-available`, because the export must be read and
  validated before authority is released; there is nothing to read from an
  unavailable peer.
- No mutation may be planned while the backend is `bound-unavailable`. The
  binding is preserved and execution is paused; planning new work against an
  authority that is not answering would only manufacture intents to quarantine.

Legality is checked on the **novel** path only. A replay — the same operation ID
with the same payload — is resolved first and answered from the pending intent
or the retained receipt, because idempotent recovery must still work after the
state has legitimately moved on (a `bind` replayed after its own acknowledgement
would otherwise be rejected as "already bound").

**Budgets.** Neither binding, detachment, reload, nor branch selection refills
any execution budget (§3, invariant 6). Every function in `src/backend.ts`
leaves `goal.execution` byte-identical. A resume may retain the same memory
scope while replacing execution authority: a generation change refuses stale
callbacks but does **not** discard the binding or the memory pointers.

## 7. Bounded failure

`callPeer` never hangs and never throws:

- no registered peer → `unavailable`, synchronously in effect (no timer, no
  await on a transport);
- the peer throws or rejects → `unavailable` with the thrown message;
- the peer does not answer within `DEFAULT_PEER_TIMEOUT_MS` → `timeout`;
- the peer answers with a malformed response → `incompatible`.

A tool call therefore has a bounded worst case of one timeout. There is no path
on which a missing, unloaded, wedged, or incompatible peer stalls the agent
loop, and none on which it takes a working unbound goal down with it.

## 8. What P0 does not deliver

Named here so the seam is not mistaken for the feature:

- No DAG, SQLite, graph, or `pi-dag-compact` code. The peer is a test fixture.
- No transport. `runtime.ts` registers no `PeerClient`; that is task 5.1.
- No protected contract mirrors, no deterministic projection, no owned-record
  write-through, no 8 KiB export/migration (P1, task 5.2).
- No stage-transition operation, no compaction integration, no evidence
  conversion (P2–P4).
- No new command or tool surface. `/goal <objective>`, `/goal`,
  `/goal pause|resume|clear`, `/goal-multi`, the headless JSON contract, and the
  `update_goal` / `update_goal_memory` tools are unchanged, and Goal does not
  duplicate `/dag-*` commands (§11).
