import { createHash } from "node:crypto";

/**
 * The consumer-agnostic peer seam (GOAL_WITH_DAG_SUPPORT §4; the contract is
 * docs/peer-protocol.md).
 *
 * It carries three things and nothing else: capability discovery, reading a
 * scoped revision-tagged projection, and submitting scoped idempotent
 * mutations/transitions. There is deliberately nothing about goals, ordered
 * steps, criteria, or budgets in this file — Goal is the FIRST consumer of the
 * continuity protocol, not its shape (§1). A research consumer maps its own
 * study/experiment identities onto the same fields and needs no Goal record;
 * P0 proves that with a fixture (test/peer-seam.test.ts, gate B07).
 *
 * Nothing here imports a peer engine, opens its database, or reads a module
 * singleton: a `PeerClient` is two async methods, which is what lets the real
 * transport be the host's shared extension event mechanism in task 5.1 without
 * changing a caller.
 */

/**
 * Exact match, never "best effort". A caller that cannot verify a receipt
 * against a known shape cannot know whether a mutation committed, so a
 * different version is incompatible rather than degraded.
 */
export const PEER_PROTOCOL_VERSION = 1;

/**
 * The deadline that makes "missing/incompatible peer fails boundedly" true.
 * A tool call's worst case is one of these, never an unbounded await.
 */
export const DEFAULT_PEER_TIMEOUT_MS = 5_000;

export interface PeerSelection {
  /** The session the operation was planned in. */
  sessionId: string;
  /** The selected branch entry it was planned against. */
  branchAnchorId: string;
}

/**
 * The comparable identity tuple every request carries. The Goal adapter maps
 * `goalId`/`Stage.id`/`generation`/`contractRevision` onto these generic names
 * (PI_DAG_COMPACT D7); a research adapter maps its study and question scope.
 *
 * A caller CANNOT acquire ownership by supplying these fields: the registered
 * peer decides who owns a scope, and a request from a consumer that does not
 * own the addressed scope is refused with `scope-conflict`.
 */
export interface PeerScope {
  /** Namespaced consumer/owner identity, e.g. "pi-codex-multi-goal". */
  consumer: string;
  /** Stable work-scope identity within that consumer. */
  scopeId: string;
  /** Deterministic identity of the accepted contract for that scope. */
  contractRevision: string;
  /** Execution epoch; a changed epoch invalidates stale callbacks. */
  epoch: number;
  /** The session/branch selection the operation was planned against. */
  selection: PeerSelection;
}

export type PeerOperationKind = "bind" | "read" | "write" | "transition" | "detach";

export interface PeerCapabilities {
  protocolVersion: number;
  peerId: string;
  operations: PeerOperationKind[];
  /** Projection profiles it can render; each declares its own version. */
  profiles: string[];
}

export interface PeerRequest {
  protocolVersion: number;
  /** Correlation and idempotency key. */
  operationId: string;
  kind: PeerOperationKind;
  scope: PeerScope;
  /** The selected revision this was planned against; null only for `bind`. */
  expectedRevision: string | null;
  payload: unknown;
}

export interface PeerReceipt {
  protocolVersion: number;
  operationId: string;
  /** Echoed verbatim, so the caller can verify what the peer thought it did. */
  scope: PeerScope;
  /** The DURABLY SELECTED revision after the commit. */
  selectedRevision: string;
  payloadDigest: string;
  committedAt: number;
}

export type PeerErrorCode =
  | "unavailable"
  | "timeout"
  | "incompatible"
  | "stale-selection"
  | "stale-epoch"
  | "scope-conflict"
  | "replay-conflict"
  | "refused";

/**
 * `pending` is never success (§4 step 2: "a SQLite-only pending_ref result is
 * not success"). It leaves the caller's intent in place and publishes nothing.
 */
/**
 * The closed set, as data. A code outside it is not a new failure class the
 * caller must guess at: it is an answer this protocol version cannot read, so
 * it is reported as `incompatible` — which is retryable. Treating an
 * unrecognised code as terminal would permanently discard an intent for the
 * failure most likely to produce one (a malformed or incompatible peer).
 */
export const PEER_ERROR_CODES: ReadonlySet<string> = new Set<PeerErrorCode>([
  "unavailable",
  "timeout",
  "incompatible",
  "stale-selection",
  "stale-epoch",
  "scope-conflict",
  "replay-conflict",
  "refused",
]);

export function isPeerErrorCode(value: unknown): value is PeerErrorCode {
  return typeof value === "string" && PEER_ERROR_CODES.has(value);
}

export type PeerResponse =
  | { status: "committed"; receipt: PeerReceipt; projection?: unknown }
  | { status: "pending"; operationId: string; reason: string }
  | { status: "error"; code: PeerErrorCode; message: string; operationId?: string };

export interface PeerClient {
  capabilities(): Promise<PeerCapabilities>;
  request(request: PeerRequest): Promise<PeerResponse>;
}

export interface PeerRequirements {
  /** Every one must be supported, or discovery fails as incompatible. */
  operations: PeerOperationKind[];
  /** An unsupported required profile is rejected explicitly, never degraded. */
  profile?: string;
}

/**
 * Is this a structurally complete receipt?
 *
 * Shared deliberately between the verifier (the WRITER, which decides whether
 * to persist a receipt) and the snapshot validator (the READER, which decides
 * whether a persisted one is loadable). When these two drifted apart, a receipt
 * missing a mandatory field could be accepted and retained as a committed
 * operation that the validator then rejected — the goal ran until it reloaded
 * and was skipped as malformed. Every field here is mandatory: absent and
 * malformed are the same answer, "not a receipt".
 */
export function isWellFormedReceipt(value: unknown): value is PeerReceipt {
  if (!value || typeof value !== "object") {
    return false;
  }
  const receipt = value as PeerReceipt;
  return (
    receipt.protocolVersion === PEER_PROTOCOL_VERSION &&
    typeof receipt.operationId === "string" &&
    receipt.operationId.length > 0 &&
    !!receipt.scope &&
    typeof receipt.scope === "object" &&
    typeof receipt.selectedRevision === "string" &&
    // Blank counts as absent: a revision identifier of nothing but whitespace
    // is not a usable identifier, and the state that carries it admits work.
    receipt.selectedRevision.trim().length > 0 &&
    typeof receipt.payloadDigest === "string" &&
    receipt.payloadDigest.length > 0 &&
    typeof receipt.committedAt === "number" &&
    Number.isFinite(receipt.committedAt)
  );
}

export type ReceiptRejection = PeerErrorCode | "pending";

export type ReceiptCheck =
  | { ok: true; receipt: PeerReceipt }
  | { ok: false; code: ReceiptRejection; message: string };

export type DiscoveryResult =
  | { ok: true; capabilities: PeerCapabilities }
  | { ok: false; code: PeerErrorCode; message: string };

/**
 * Recursively key-sorted JSON. Payload identity must not depend on how a
 * caller happened to order its object fields, or a faithful retry of the same
 * operation would look like a conflicting one and the four-step recovery in §4
 * would refuse its own replay.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function canonicalDigest(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload) ?? null), "utf8")
    .digest("hex");
}

export function selectionsEqual(left: PeerSelection, right: PeerSelection): boolean {
  return left.sessionId === right.sessionId && left.branchAnchorId === right.branchAnchorId;
}

/**
 * Total scope equality. Two operations differ if ANY identity field differs —
 * the same discipline as the injective key encodings: an identity established
 * over a subset of what distinguishes two things is not an identity.
 */
export function scopesEqual(left: PeerScope, right: PeerScope): boolean {
  return (
    left.consumer === right.consumer &&
    left.scopeId === right.scopeId &&
    left.contractRevision === right.contractRevision &&
    left.epoch === right.epoch &&
    selectionsEqual(left.selection, right.selection)
  );
}

/**
 * Scope identity within one peer: consumer namespace plus work scope.
 *
 * Both fields are caller-controlled, so the encoding has to be INJECTIVE or the
 * key is forgeable: joining them with a delimiter lets ("a", "b c") and
 * ("a b", "c") name the same scope, which is an ownership conflict at best and,
 * in a peer that keys storage on it, the wrong record. JSON is the same
 * discipline canonicalDigest and computeContractRevision already use, and for
 * the same reason — its escaping makes the field boundary unambiguous, so no
 * value can be crafted to reach across it.
 */
export function scopeKey(scope: PeerScope): string {
  return JSON.stringify([scope.consumer, scope.scopeId]);
}

/**
 * Race a peer call against a deadline. The timer is cleared on the winning
 * path and unref'd so a pending deadline can never hold the process open, and
 * a synchronous throw from the client is caught along with a rejection: an
 * extension that blew up while unloading must look like an absent peer, not
 * like an exception escaping a tool call.
 */
async function withDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; code: "unavailable" | "timeout"; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    const raced = await Promise.race([work(), deadline]);
    if (raced === "timeout") {
      return { ok: false, code: "timeout", message: `the peer did not answer within ${timeoutMs}ms` };
    }
    return { ok: true, value: raced as T };
  } catch (error) {
    return {
      ok: false,
      code: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isPeerResponse(value: unknown): value is PeerResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const response = value as PeerResponse;
  if (response.status === "committed") {
    const receipt = (response as { receipt?: unknown }).receipt;
    return !!receipt && typeof receipt === "object";
  }
  if (response.status === "pending") {
    return typeof (response as { operationId?: unknown }).operationId === "string";
  }
  // The error code is validated against the closed set here, in the parser, so
  // an invented code never reaches a caller that would have to classify it.
  return response.status === "error" && isPeerErrorCode((response as { code?: unknown }).code);
}

/**
 * One peer call that never hangs and never throws. No registered peer answers
 * `unavailable` without waiting on a deadline it could never satisfy, which is
 * what keeps an unbound Goal-only session (invariant 1) free of any peer cost.
 */
export async function callPeer(
  client: PeerClient | null | undefined,
  request: PeerRequest,
  options: { timeoutMs?: number } = {},
): Promise<PeerResponse> {
  if (!client) {
    return {
      status: "error",
      code: "unavailable",
      message: "no peer is registered for this session",
      operationId: request.operationId,
    };
  }
  const outcome = await withDeadline(() => client.request(request), options.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS);
  if (!outcome.ok) {
    return { status: "error", code: outcome.code, message: outcome.message, operationId: request.operationId };
  }
  if (!isPeerResponse(outcome.value)) {
    const code = (outcome.value as { code?: unknown } | null)?.code;
    return {
      status: "error",
      code: "incompatible",
      message:
        typeof code === "string" && !PEER_ERROR_CODES.has(code)
          ? `the peer answered with error code "${code}", which is not in this protocol version's set`
          : "the peer returned a response this protocol version cannot read",
      operationId: request.operationId,
    };
  }
  return outcome.value;
}

/**
 * Capability negotiation. Requirements are declared by the caller and checked,
 * never assumed: an unsupported required operation or projection profile is an
 * explicit `incompatible` rejection (§4), because silently degrading would
 * leave the caller believing content it never received was rendered.
 */
export async function discoverPeer(
  client: PeerClient | null | undefined,
  requirements: PeerRequirements,
  options: { timeoutMs?: number } = {},
): Promise<DiscoveryResult> {
  if (!client) {
    return { ok: false, code: "unavailable", message: "no peer is registered for this session" };
  }
  const outcome = await withDeadline(() => client.capabilities(), options.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS);
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  const capabilities = outcome.value;
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    typeof capabilities.protocolVersion !== "number" ||
    typeof capabilities.peerId !== "string" ||
    capabilities.peerId.length === 0
  ) {
    // `peerId` is mandatory too, and it is recorded on the binding: an
    // unnameable peer cannot be one Goal binds to.
    return { ok: false, code: "incompatible", message: "the peer announced no readable capabilities" };
  }
  if (capabilities.protocolVersion !== PEER_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "incompatible",
      message:
        `the peer speaks protocol version ${capabilities.protocolVersion}; this consumer speaks ` +
        `${PEER_PROTOCOL_VERSION}. A receipt from an unknown version cannot be verified.`,
    };
  }
  const supported = new Set(capabilities.operations ?? []);
  const missing = requirements.operations.filter((operation) => !supported.has(operation));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "incompatible",
      message: `the peer does not support required operation(s): ${missing.join(", ")}`,
    };
  }
  if (requirements.profile && !(capabilities.profiles ?? []).includes(requirements.profile)) {
    return {
      ok: false,
      code: "incompatible",
      message: `the peer does not support the required projection profile ${requirements.profile}`,
    };
  }
  return { ok: true, capabilities };
}

/**
 * Correlation, on every answer that carries an ID.
 *
 * A delayed answer for someone else's request says NOTHING about this one, so
 * applying it would be wrong in either direction — and it is wrong in the
 * expensive direction, because `scope-conflict`, `replay-conflict` and
 * `refused` are legitimately terminal and would discard a valid pending intent.
 * A mismatch is therefore reported as `incompatible`, which is retryable: the
 * caller learns nothing, and loses nothing.
 *
 * The ID is optional on an ERROR and on nothing else, so its absence is not a
 * mismatch THERE — a transport that cannot correlate is not thereby lying, and
 * callPeer's own synthesised errors carry the request's ID anyway. Absent,
 * present-and-valid, and present-but-malformed are three cases, not two:
 * callers for whom the field is mandatory pass `required: true`, and then a
 * missing or non-string ID is a malformed answer rather than a silent pass.
 */
function correlationFailure(
  request: PeerRequest,
  operationId: unknown,
  options: { required?: boolean } = {},
): ReceiptCheck | null {
  if (typeof operationId !== "string" || operationId.length === 0) {
    if (!options.required) {
      return null;
    }
    return {
      ok: false,
      code: "incompatible",
      message: "the answer carries no usable operation id, and this kind of answer must correlate",
    };
  }
  if (operationId === request.operationId) {
    return null;
  }
  return {
    ok: false,
    code: "incompatible",
    message:
      `the peer's answer correlates to operation ${operationId}, not ${request.operationId}; ` +
      "an answer for another request cannot be applied to this one",
  };
}

/**
 * Step 3 of the recoverable ordering, caller side: verify the answer against
 * the request that produced it before anything is persisted or published.
 *
 * The checks are deliberately granular, because the code decides recovery: a
 * stale epoch or selection quarantines the intent, while an unavailable peer
 * keeps it for retry. Verifying here — rather than trusting the transport — is
 * also what makes a late response harmless after cancellation, pause,
 * generation change, or branch change (§4).
 */
export function verifyReceipt(request: PeerRequest, response: PeerResponse): ReceiptCheck {
  if (response.status === "error") {
    // Defence in depth for callers that build a response by hand: an
    // unrecognised code is `incompatible` (retryable), never passed through to
    // be classified as terminal by whoever receives it.
    if (!isPeerErrorCode(response.code)) {
      return {
        ok: false,
        code: "incompatible",
        message: `the peer answered with error code "${String(response.code)}", which this protocol version does not define`,
      };
    }
    const miscorrelated = correlationFailure(request, response.operationId);
    if (miscorrelated) {
      return miscorrelated;
    }
    return { ok: false, code: response.code, message: response.message };
  }
  if (response.status === "pending") {
    // `operationId` is mandatory on a pending answer as well: without it the
    // answer cannot be attributed to anything.
    const miscorrelated = correlationFailure(request, response.operationId, { required: true });
    if (miscorrelated) {
      return miscorrelated;
    }
    return {
      ok: false,
      code: "pending",
      message: `the peer has not durably selected operation ${response.operationId}: ${response.reason}`,
    };
  }
  const receipt = response.receipt;
  if (!receipt || typeof receipt !== "object") {
    return { ok: false, code: "incompatible", message: "the peer returned a committed status with no receipt" };
  }
  if (receipt.protocolVersion !== PEER_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "incompatible",
      message: `the receipt is protocol version ${receipt.protocolVersion}, not ${PEER_PROTOCOL_VERSION}`,
    };
  }
  // Shape before identity: every field below is mandatory on a receipt, so a
  // missing one is a malformed answer, never a field to be compared leniently.
  // This is the same predicate the snapshot validator applies on read, so a
  // receipt that is accepted here can always be loaded back.
  if (!isWellFormedReceipt(receipt)) {
    return {
      ok: false,
      code: "incompatible",
      message: "the receipt is missing a field this protocol version requires",
    };
  }
  const miscorrelated = correlationFailure(request, receipt.operationId, { required: true });
  if (miscorrelated) {
    // The same rule as the error and pending branches: an answer about another
    // operation is `incompatible` (retryable), never a terminal refusal that
    // would discard this caller's valid intent.
    return miscorrelated;
  }
  const scope = receipt.scope;
  if (!scope || typeof scope !== "object") {
    return { ok: false, code: "incompatible", message: "the receipt carries no scope identity" };
  }
  if (scope.consumer !== request.scope.consumer || scope.scopeId !== request.scope.scopeId) {
    return {
      ok: false,
      code: "scope-conflict",
      message: `the receipt is for scope ${scope.consumer}/${scope.scopeId}, not ${request.scope.consumer}/${request.scope.scopeId}`,
    };
  }
  if (scope.epoch !== request.scope.epoch) {
    return {
      ok: false,
      code: "stale-epoch",
      message: `the receipt was issued for execution epoch ${scope.epoch}; ${request.scope.epoch} is in force`,
    };
  }
  if (!scope.selection || !selectionsEqual(scope.selection, request.scope.selection)) {
    return {
      ok: false,
      code: "stale-selection",
      message: "the receipt was issued against a different session/branch selection",
    };
  }
  if (scope.contractRevision !== request.scope.contractRevision) {
    return {
      ok: false,
      code: "refused",
      message: "the receipt mirrors a different contract revision than the one in force",
    };
  }
  if (receipt.payloadDigest !== canonicalDigest(request.payload)) {
    return {
      ok: false,
      code: "replay-conflict",
      message: `operation ${request.operationId} was committed with a different payload`,
    };
  }
  if (typeof receipt.selectedRevision !== "string" || receipt.selectedRevision.trim().length === 0) {
    return {
      ok: false,
      code: "refused",
      message: "the receipt names no durably selected revision, so it is not a commit",
    };
  }
  return { ok: true, receipt };
}
