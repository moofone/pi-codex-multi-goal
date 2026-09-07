import { randomUUID } from "node:crypto";

import {
  PEER_PROTOCOL_VERSION,
  canonicalDigest,
  scopeKey,
  type PeerCapabilities,
  type PeerClient,
  type PeerErrorCode,
  type PeerOperationKind,
  type PeerReceipt,
  type PeerRequest,
  type PeerResponse,
} from "../../src/peer.ts";

/**
 * The in-process peer that stands in for `pi-dag-compact` while P0 proves the
 * binding and recovery protocol (GOAL_WITH_DAG_SUPPORT §4; task 1.3 "a fake
 * in-process peer satisfies the protocol shape"). It is a TEST FIXTURE ONLY:
 * no DAG, no SQLite, no graph. Task 5.1 puts the real peer behind this same
 * `PeerClient`.
 *
 * It implements exactly the peer-side obligations the protocol contract names,
 * because those are what the Goal side is being tested against:
 *
 *   - scope ownership: the first `bind` claims a scope for its consumer, and a
 *     request from any other consumer on that scope is refused. Ownership is
 *     the PEER's decision; supplying the fields does not acquire it;
 *   - durable selection before a receipt: a receipt is returned only after the
 *     revision is selected, so `pending` is never success;
 *   - idempotency: the same operation ID with the same payload returns the
 *     SAME receipt without committing again; a different payload conflicts;
 *   - expected-revision checks, so a caller planning against a superseded
 *     revision is refused rather than silently rebased.
 *
 * Failure injection covers the partial-write boundaries: `loseNextResponse`
 * commits durably and then loses the answer, which is the "peer committed but
 * Goal never saw the receipt" crash point.
 */

export interface FakePeerOptions {
  peerId?: string;
  /** Announce a different protocol version, to exercise incompatibility. */
  protocolVersion?: number;
  operations?: PeerOperationKind[];
  profiles?: string[];
  /** Never answer, to prove the caller's deadline is what bounds a tool call. */
  hang?: boolean;
  /** Reject instead of answering, to prove a throwing peer fails boundedly. */
  throws?: string;
  /** Answer `pending`: committed to its own store but not durably selected. */
  alwaysPending?: boolean;
  /**
   * A peer that is lax about scope ownership: it will happily create a scope on
   * a `write` that no `bind` ever claimed. Real peers should not, but the Goal
   * side must not DEPEND on that — operation legality is Goal's own check, made
   * before the intent is persisted.
   */
  laxScope?: boolean;
}

interface CommittedOperation {
  receipt: PeerReceipt;
  payloadDigest: string;
  scope: string;
}

interface ScopeRecord {
  owner: string;
  revision: string;
  contract: unknown;
  memory: unknown;
}

export interface FakePeer extends PeerClient {
  /** Every request that actually reached the peer, in order. */
  readonly calls: PeerRequest[];
  /** Commit the next mutation durably, then lose the response (crash point 2). */
  loseNextResponse(): void;
  /** Current durable revision of a scope, or null when it owns no such scope. */
  revisionOf(scopeId: string, consumer: string): string | null;
  /** The records the peer holds for a scope, for read-back assertions. */
  recordOf(scopeId: string, consumer: string): ScopeRecord | null;
  /** How many times a mutation was actually committed (not replayed). */
  readonly commits: number;
}

const ALL_OPERATIONS: PeerOperationKind[] = ["bind", "read", "write", "transition", "detach"];

export function createFakePeer(options: FakePeerOptions = {}): FakePeer {
  const peerId = options.peerId ?? "fake-dag-peer";
  const protocolVersion = options.protocolVersion ?? PEER_PROTOCOL_VERSION;
  const operations = options.operations ?? ALL_OPERATIONS;
  const profiles = options.profiles ?? ["current-scope@1"];

  const calls: PeerRequest[] = [];
  const committedOperations = new Map<string, CommittedOperation>();
  const scopes = new Map<string, ScopeRecord>();
  let commits = 0;
  let loseNext = false;
  let revisionCounter = 0;

  const nextRevision = (): string => `rev-${(revisionCounter += 1)}`;

  const error = (code: PeerErrorCode, message: string, id: string): PeerResponse => ({
    status: "error",
    code,
    message,
    operationId: id,
  });

  const commit = (request: PeerRequest, record: ScopeRecord, projection?: unknown): PeerResponse => {
    // Durable selection happens BEFORE the receipt exists: a receipt the caller
    // can verify is proof the revision is selected, never proof of an
    // in-memory snapshot.
    record.revision = nextRevision();
    scopes.set(scopeKey(request.scope), record);
    commits += 1;
    const receipt: PeerReceipt = {
      protocolVersion: PEER_PROTOCOL_VERSION,
      operationId: request.operationId,
      scope: request.scope,
      selectedRevision: record.revision,
      payloadDigest: canonicalDigest(request.payload),
      committedAt: 1_700_000_000_000 + commits,
    };
    committedOperations.set(request.operationId, {
      receipt,
      payloadDigest: receipt.payloadDigest,
      scope: scopeKey(request.scope),
    });
    if (loseNext) {
      // Crash point 2: the mutation is durable and the receipt exists, but the
      // answer never reaches Goal. A replay must return this same receipt.
      loseNext = false;
      return error("unavailable", "the peer committed but the response was lost", request.operationId);
    }
    return { status: "committed", receipt, projection };
  };

  const peer: FakePeer = {
    get calls() {
      return calls;
    },
    get commits() {
      return commits;
    },
    loseNextResponse() {
      loseNext = true;
    },
    revisionOf(scopeId, consumer) {
      return scopes.get(`${consumer} ${scopeId}`)?.revision ?? null;
    },
    recordOf(scopeId, consumer) {
      return scopes.get(`${consumer} ${scopeId}`) ?? null;
    },
    async capabilities(): Promise<PeerCapabilities> {
      if (options.hang) {
        return new Promise<PeerCapabilities>(() => {});
      }
      if (options.throws) {
        throw new Error(options.throws);
      }
      return { protocolVersion, peerId, operations, profiles };
    },
    async request(request: PeerRequest): Promise<PeerResponse> {
      if (options.hang) {
        return new Promise<PeerResponse>(() => {});
      }
      if (options.throws) {
        throw new Error(options.throws);
      }
      calls.push(request);
      if (request.protocolVersion !== PEER_PROTOCOL_VERSION) {
        return error("incompatible", `unsupported protocol version ${request.protocolVersion}`, request.operationId);
      }
      if (!operations.includes(request.kind)) {
        return error("incompatible", `unsupported operation ${request.kind}`, request.operationId);
      }

      // Step 4 of the recoverable ordering, peer side: the same operation ID
      // with the same payload returns its existing result without committing
      // again; a different payload conflicts.
      const existing = committedOperations.get(request.operationId);
      if (existing) {
        if (existing.payloadDigest !== canonicalDigest(request.payload)) {
          return error(
            "replay-conflict",
            `operation ${request.operationId} already committed with a different payload`,
            request.operationId,
          );
        }
        return { status: "committed", receipt: existing.receipt, projection: projectionFor(request) };
      }

      const key = scopeKey(request.scope);
      const held = scopes.get(key);
      if (held && held.owner !== request.scope.consumer) {
        return error("scope-conflict", `scope ${request.scope.scopeId} is owned by ${held.owner}`, request.operationId);
      }
      // Cross-consumer protection is by scope identity, not by a supplied
      // owner flag: a consumer addressing another consumer's scopeId is
      // refused even when the tuple is otherwise well formed.
      for (const [otherKey, record] of scopes) {
        if (otherKey === key) {
          continue;
        }
        if (otherKey.endsWith(` ${request.scope.scopeId}`) && record.owner !== request.scope.consumer) {
          return error(
            "scope-conflict",
            `scope ${request.scope.scopeId} is owned by ${record.owner}`,
            request.operationId,
          );
        }
      }

      if (request.kind === "bind") {
        if (options.alwaysPending) {
          return { status: "pending", operationId: request.operationId, reason: "reference append not acknowledged" };
        }
        const payload = (request.payload ?? {}) as { contract?: unknown; memory?: unknown };
        return commit(request, {
          owner: request.scope.consumer,
          revision: "",
          contract: payload.contract ?? null,
          memory: payload.memory ?? null,
        });
      }

      if (!held) {
        if (!options.laxScope) {
          return error("scope-conflict", `scope ${request.scope.scopeId} is not bound`, request.operationId);
        }
        // Lax mode: create the scope implicitly, as an over-eager peer would.
        const payload = (request.payload ?? {}) as { memory?: unknown };
        return commit(request, {
          owner: request.scope.consumer,
          revision: "",
          contract: null,
          memory: payload.memory ?? null,
        });
      }
      if (request.expectedRevision !== null && request.expectedRevision !== held.revision) {
        return error(
          "stale-selection",
          `expected revision ${request.expectedRevision}; ${held.revision} is selected`,
          request.operationId,
        );
      }

      if (request.kind === "read") {
        // Reads mutate nothing and never move the selection.
        return {
          status: "committed",
          receipt: {
            protocolVersion: PEER_PROTOCOL_VERSION,
            operationId: request.operationId,
            scope: request.scope,
            selectedRevision: held.revision,
            payloadDigest: canonicalDigest(request.payload),
            committedAt: 1_700_000_000_000,
          },
          projection: { revision: held.revision, memory: held.memory, contract: held.contract },
        };
      }

      if (options.alwaysPending) {
        return { status: "pending", operationId: request.operationId, reason: "reference append not acknowledged" };
      }

      if (request.kind === "write") {
        const payload = (request.payload ?? {}) as { memory?: unknown };
        return commit(request, { ...held, memory: payload.memory ?? null });
      }
      if (request.kind === "transition") {
        const payload = (request.payload ?? {}) as { contract?: unknown };
        return commit(request, { ...held, contract: payload.contract ?? null, memory: null });
      }
      // detach: export the selected projection, then release authority.
      return commit(
        request,
        { ...held },
        { revision: held.revision, memory: held.memory, contract: held.contract },
      );
    },
  };

  function projectionFor(request: PeerRequest): unknown {
    const held = scopes.get(scopeKey(request.scope));
    if (!held || (request.kind !== "read" && request.kind !== "detach")) {
      return undefined;
    }
    return { revision: held.revision, memory: held.memory, contract: held.contract };
  }

  return peer;
}

/** A correlation ID for one durable operation. */
export function operationId(prefix = "op"): string {
  return `${prefix}-${randomUUID()}`;
}
