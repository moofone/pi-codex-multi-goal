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
| `scopeId` | `goal:<goalId>:stage:<Stage.id>` | `study:<studyId>:question:<questionId>` |
| `contractRevision` | `MultiGoal.contractRevision` (D7 sha256) | its accepted question/constraints hash |
| `epoch` | `GoalExecution.generation` | its own execution epoch |
| `selection` | the host session id and selected branch anchor | the same |

`scopeId` uses `Stage.id`, never the displayed step number (D7). The displayed
number changes meaning across a transition; the id does not.

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
4. **Replay** — `resolveReplay(backend, operationId, payloadDigest)` returns
   `novel`, `identical` (the retained receipt is returned as-is, nothing is
   re-run), `quarantined` (re-plan under a new id), or `conflict` (the same id
   with a different payload — refused, and nothing is mutated). A pending
   operation never causes a second credit, mutation, completion or kickoff.

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
`{operationId, kind, payloadDigest, outcome, receipt|null, reason|null}`, capped
at `MAX_RETAINED_OPERATIONS` (16). Retention scope is **the lifetime in which an
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
| `detached` | Goal-only mode, entered only after a validated export of the selected current-stage projection and a persisted backend switch. If the export cannot fit the 8 KiB record without losing required continuity, the switch stays pending and reports why; it is never silently truncated |

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
A stage transition on a bound goal returns to `binding-pending` for the new
stage's contract (task 5.3 owns the transition operation itself).

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
