import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { backendAdmitsExecution, isGoalBackend } from "../src/backend.ts";
import { registerMultiGoal } from "../src/runtime.ts";
import { cloneGoal, createGoal, reconstructGoal, replaceGoalFromSteps, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE, type GoalBackend, type MultiGoal } from "../src/types.ts";

/**
 * P0 gates B01 and the runtime half of B10 (GOAL_WITH_DAG_SUPPORT §10 P0 row,
 * §3's state table, invariants 1, 2 and 8), at the boundary that owns the
 * persisted snapshot and the model-facing tools.
 *
 *   B01 — "unrelated checkpoints stay inert". The P0 row's warning is explicit:
 *         P0 must not start rejecting working Goal-only memory writes just
 *         because it discovers a checkpoint. Unbound is today's behaviour,
 *         byte for byte, with no new settings and no peer.
 *   B10 — a bound backend is persisted, survives reload, and while the peer is
 *         unavailable Goal does not silently downgrade to its stale blob.
 */

// --- B01: the unbound snapshot -------------------------------------------

function twoStepGoal(): MultiGoal {
  const result = replaceGoalFromSteps([
    { objective: "ship the fix", criteria: ["the regression test passes"] },
    { objective: "measure it", criteria: ["p95 is recorded"] },
  ]);
  assert.ok(result.ok && result.goal, result.message);
  return result.goal;
}

function reloadOf(goal: MultiGoal): MultiGoal | null {
  const entry = JSON.parse(JSON.stringify(setEntry(goal, "runtime")));
  return reconstructGoal([{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: entry }]);
}

test("B01: every goal starts unbound, with no peer and no settings", () => {
  const goal = twoStepGoal();
  assert.equal(goal.backend.state, "unbound");
  assert.equal(goal.backend.binding, null);
  assert.equal(goal.backend.pending, null);
  assert.deepEqual(goal.backend.operations, []);
  assert.equal(goal.backend.reason, null);

  assert.equal(createGoal(["one step"], 1).backend.state, "unbound", "including the test-compat constructor");
});

test("B01: a snapshot written before the backend field existed reloads as unbound", () => {
  const goal = twoStepGoal();
  assert.equal(goal.backend.state, "unbound", "sanity: there is a backend to materialise");
  const legacy = cloneGoal(goal) as Partial<MultiGoal>;
  delete legacy.backend;

  const reloaded = reconstructGoal([
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "set", source: "runtime", goal: legacy, at: 1 },
    },
  ]);

  assert.ok(reloaded, "an older snapshot must restore, not be skipped as malformed");
  assert.equal(reloaded.backend.state, "unbound");
});

test("B10: a bound backend survives a reload intact", () => {
  const goal = twoStepGoal();
  const backend: GoalBackend = {
    state: "bound-available",
    binding: {
      peerId: "fake-dag-peer",
      taskId: "task-1",
      goalId: goal.goalId,
      stageId: goal.stages[0]!.id,
      generation: 0,
      contractRevision: goal.contractRevision,
      sessionId: "session-a",
      branchAnchorId: "anchor-1",
      selectedRevision: "rev-3",
    },
    pending: null,
    operations: [
      {
        operationId: "op-1",
        kind: "bind",
        scope: {
          consumer: "pi-codex-multi-goal",
          scopeId: `goal:${goal.goalId}:stage:${goal.stages[0]!.id}`,
          contractRevision: goal.contractRevision,
          epoch: 0,
          selection: { sessionId: "session-a", branchAnchorId: "anchor-1" },
        },
        expectedRevision: null,
        payloadDigest: "a".repeat(64),
        outcome: "committed",
        receipt: {
          protocolVersion: 1,
          operationId: "op-1",
          scope: {
            consumer: "pi-codex-multi-goal",
            scopeId: `goal:${goal.goalId}:stage:${goal.stages[0]!.id}`,
            contractRevision: goal.contractRevision,
            epoch: 0,
            selection: { sessionId: "session-a", branchAnchorId: "anchor-1" },
          },
          selectedRevision: "rev-3",
          payloadDigest: "a".repeat(64),
          committedAt: 1,
        },
        reason: null,
      },
    ],
    reason: null,
  };

  const reloaded = reloadOf({ ...goal, backend });

  assert.ok(reloaded);
  assert.equal(reloaded.backend.state, "bound-available");
  assert.equal(reloaded.backend.binding?.selectedRevision, "rev-3", "the selected revision is a recovery anchor");
  assert.equal(reloaded.backend.binding?.stageId, goal.stages[0]!.id, "identity is Stage.id, not the step number");
  assert.equal(reloaded.backend.operations.length, 1, "retention survives, so replay protection survives");
});

test("B10: a malformed backend is skipped, never downgraded to unbound", () => {
  // Invariant 8: previously authoritative but unreadable backend state cannot
  // silently become "there was never a binding".
  const goal = twoStepGoal();
  const good = setEntry(goal, "runtime");
  const broken = JSON.parse(JSON.stringify(setEntry(goal, "runtime")));
  broken.goal.backend = { state: "bound-and-sideways", binding: null, pending: null, operations: [], reason: null };

  const reloaded = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: good },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: broken },
  ]);

  assert.ok(reloaded, "the last valid snapshot is kept");
  assert.equal(reloaded.backend.state, "unbound", "the malformed entry was skipped, not adopted");
});

// --- the runtime boundary -------------------------------------------------

interface HarnessOptions {
  seed?: unknown[];
}

function harness(t: any, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-backend-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify({}));
  // Evidence artifacts are project-relative files resolved against the working
  // directory, so the harness chdirs into its own root (same seam as
  // test/completion-isolation.test.ts).
  const previousCwd = process.cwd();
  process.chdir(root);

  const branch: any[] = [...(options.seed ?? [])];
  const entries: any[] = [...branch];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  let lastNotified: string | null = null;
  const ctx: any = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "backend-session",
      getSessionFile: () => "/qa/backend-session.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      setStatus: () => {},
      notify: (...args: unknown[]) => {
        lastNotified = typeof args[0] === "string" ? args[0] : null;
      },
      confirm: async () => true,
      input: async () => "",
    },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    sendMessage: () => {},
  };
  registerMultiGoal(pi);
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  t.after(async () => {
    await emit("session_shutdown");
    process.chdir(previousCwd);
    if (oldAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = oldAgent;
    if (oldOrchestrator === undefined) delete process.env.PI_ORCHESTRATOR_ROOT;
    else process.env.PI_ORCHESTRATOR_ROOT = oldOrchestrator;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    emit,
    command: (text: string) => commands.get("goal").handler(text, ctx),
    memory: (params: any, id = "memory-call") =>
      tools.get("update_goal_memory").execute(id, params, new AbortController().signal, undefined, ctx),
    updateGoal: (params: any, id = "terminal-call") =>
      tools.get("update_goal").execute(id, params, new AbortController().signal, undefined, ctx),
    /** One evidence ref bound to the given criteria, backed by a real artifact. */
    evidence: (criteria: string[], artifact = "src/fix.ts", content = "the fix, applied\n", operation = "edit") => {
      const absolute = join(root, artifact);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return {
        operation,
        artifact,
        fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
        criteria,
      };
    },
    providerRequest: () =>
      emit("before_provider_request", {
        payload: { model: "fake-model", messages: [], tools: [] },
      }),
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    current: (): MultiGoal =>
      [...entries].reverse().find((entry) => entry.customType === CUSTOM_ENTRY_TYPE)?.data.goal,
  };
}

/** An unrelated peer checkpoint sitting on the same branch. */
const FOREIGN_CHECKPOINT = {
  type: "custom",
  customType: "pi-dag-compact",
  data: {
    kind: "checkpoint",
    taskId: "some-other-task",
    revisionId: "rev-77",
    scopeId: "study:unrelated",
  },
};

test("B01: an unbound goal with a foreign checkpoint on its branch keeps working", async (t) => {
  const goal = createGoal(["first", "second"]);
  const h = harness(t, {
    seed: [FOREIGN_CHECKPOINT, { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(goal, "command") }],
  });
  await h.emit("session_start");
  await h.command("resume");

  const active = h.current();
  assert.equal(active.status, "active", "sanity: the goal is running");
  assert.equal(active.backend.state, "unbound", "a checkpoint that describes other work does not bind anything");

  const identity = {
    goalId: active.goalId,
    step: active.index + 1,
    generation: active.execution.generation,
    revision: active.memory.revision,
  };
  const executionBefore = JSON.parse(JSON.stringify(active.execution));

  await h.memory({ ...identity, proved: ["proved: x (artifact: a.txt)"], unresolved: [], next: "keep going" });

  const after = h.current();
  assert.equal(after.memory.revision, 1, "the Goal-only memory write still succeeds");
  assert.deepEqual(after.memory.proved, ["proved: x (artifact: a.txt)"]);
  assert.equal(after.backend.state, "unbound", "and discovering a checkpoint never changes the backend state");

  await h.providerRequest();
  const charged = h.current();
  assert.equal(charged.execution.totalRemaining, executionBefore.totalRemaining - 1, "accounting is unchanged");
  assert.equal(charged.execution.noProgressRemaining, executionBefore.noProgressRemaining);
});

/**
 * A seeded snapshot in one of the bound states, built the way the state machine
 * actually builds it: a bound state carries its binding and no bind intent, and
 * `binding-pending` carries the bind intent that is switching authority and no
 * binding yet.
 */
function boundSnapshot(state: GoalBackend["state"], reason: string | null): unknown {
  const goal = createGoal(["first", "second"]);
  const scope = {
    consumer: "pi-codex-multi-goal",
    scopeId: `goal:${goal.goalId}:stage:${goal.stages[0]!.id}`,
    contractRevision: goal.contractRevision,
    epoch: 0,
    selection: { sessionId: "backend-session", branchAnchorId: "anchor-1" },
  };
  const switching = state === "binding-pending";
  const backend: GoalBackend = {
    state,
    binding: switching
      ? null
      : {
          peerId: "fake-dag-peer",
          taskId: "task-1",
          goalId: goal.goalId,
          stageId: goal.stages[0]!.id,
          generation: 0,
          contractRevision: goal.contractRevision,
          sessionId: "backend-session",
          branchAnchorId: "anchor-1",
          selectedRevision: "rev-3",
        },
    pending: switching
      ? {
          operationId: "op-bind",
          kind: "bind",
          expectedState: "bound-available",
          previousState: "unbound",
          scope,
          expectedRevision: null,
          payloadDigest: "b".repeat(64),
          payload: { contract: {}, memory: null },
          createdAt: 1,
        }
      : null,
    operations: [],
    reason,
  };
  return { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry({ ...goal, backend }, "command") };
}

test("B10: while the peer is unavailable, Goal-only memory writes are refused, not silently accepted", async (t) => {
  const h = harness(t, { seed: [boundSnapshot("bound-unavailable", "the peer was unloaded")] });
  await h.emit("session_start");
  await h.command("resume");

  const active = h.current();
  assert.equal(active.backend.state, "bound-unavailable", "sanity: the binding survived the restore");
  const memoryBefore = JSON.stringify(active.memory);
  const executionBefore = JSON.parse(JSON.stringify(active.execution));
  const identity = {
    goalId: active.goalId,
    step: active.index + 1,
    generation: active.execution.generation,
    revision: active.memory.revision,
  };

  await assert.rejects(
    () => h.memory({ ...identity, proved: ["stale blob write"], unresolved: [], next: "" }),
    /backend|peer|unavailable/i,
    "invariant 8: an unavailable authority cannot downgrade to the old Goal blob",
  );

  const after = h.current();
  assert.equal(JSON.stringify(after.memory), memoryBefore, "the record is unchanged");
  assert.deepEqual(after.execution, executionBefore, "and no allowance moved");
  assert.deepEqual(after.backend.binding, active.backend.binding, "the binding and its pointers are preserved");
});

test("B10: a completion cannot be accepted while the backend switch is in progress", async (t) => {
  const h = harness(t, { seed: [boundSnapshot("binding-pending", "migrating the working record")] });
  await h.emit("session_start");
  await h.command("resume");

  const active = h.current();
  assert.equal(active.backend.state, "binding-pending", "sanity: the switch is in progress");

  await assert.rejects(
    () =>
      h.updateGoal({
        status: "complete",
        goalId: active.goalId,
        step: active.index + 1,
        generation: active.execution.generation,
        evidence: [],
      }),
    /backend|peer|switch|migrat/i,
    "§3: Goal execution is withheld during the switch",
  );

  const after = h.current();
  assert.equal(after.index, active.index, "no step advanced");
  assert.equal(after.stages[0]!.status, "active");
});

test("B10: /goal status names the backend state and its reason", async (t) => {
  const h = harness(t, { seed: [boundSnapshot("bound-unavailable", "the peer was unloaded")] });
  await h.emit("session_start");

  const status = h.goalStatus();
  assert.match(status, /Backend: bound-unavailable/, "the human can see which authority is in force");
  assert.match(status, /the peer was unloaded/, "and why it is not answering");
});

test("B01: an unbound goal shows no backend noise in /goal status", async (t) => {
  const goal = createGoal(["first", "second"]);
  const h = harness(t, { seed: [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(goal, "command") }] });
  await h.emit("session_start");

  const status = h.goalStatus();
  assert.match(status, /Stage: 1\/2/, "sanity: the status rendered");
  assert.equal(/Backend:/.test(status), false, "unbound is today's view, unchanged");
});

/**
 * B11 (review finding 1): no state reachable within P0 may be permanently
 * unrecoverable.
 *
 * Completing a stage on a bound goal used to move the backend to
 * `binding-pending` for the next stage's contract — but P0 has no transition
 * operation and no runtime path that submits one, so the pending switch could
 * never complete. `requestContinuation` refuses while the switch is pending and
 * `abandonOperation` needs a pending intent that was never created, which left
 * a bound multi-stage goal wedged after stage 1 with no user-reachable exit.
 *
 * The binding is scoped to a stage: `goal:<goalId>:stage:<Stage.id>`. A
 * transition moves to a DIFFERENT scope that nothing ever bound, so the honest
 * answer for the new stage is that it has no backend. It starts unbound —
 * runnable, with the empty memory record §8 mandates — and says why.
 */
test("B11: a bound goal that completes stage 1 can still run stage 2, user-reachable only", async (t) => {
  const h = harness(t, { seed: [boundSnapshot("bound-available", null)] });
  await h.emit("session_start");
  await h.command("resume");

  const active = h.current();
  assert.equal(active.backend.state, "bound-available", "sanity: stage 1 is bound");
  assert.equal(active.stages.length, 2, "sanity: there is a stage 2 to get stuck before");
  const criterionIds = active.stages[0]!.criteria.map((criterion: any) => criterion.id);

  await h.updateGoal({
    status: "complete",
    goalId: active.goalId,
    step: active.index + 1,
    generation: active.execution.generation,
    evidence: [h.evidence(criterionIds)],
  });

  const advanced = h.current();
  assert.equal(advanced.index, 1, "sanity: the goal advanced to stage 2");
  assert.equal(advanced.status, "active");

  // The whole point: stage 2 is runnable with no external state surgery.
  assert.equal(
    backendAdmitsExecution(advanced.backend),
    true,
    "stage 2 must not start in a state nothing can leave",
  );
  assert.equal(advanced.backend.pending, null, "no unsubmittable intent was invented");
  assert.equal(
    advanced.backend.binding,
    null,
    "§1: a stage transition invalidates the old stage's active selection before admitting the next",
  );

  // Goal owns the new stage's record, and the memory tool proves it end to end.
  await h.memory({
    goalId: advanced.goalId,
    step: advanced.index + 1,
    generation: advanced.execution.generation,
    revision: advanced.memory.revision,
    proved: [],
    unresolved: [],
    next: "start stage 2",
  });
  assert.equal(h.current().memory.revision, 1, "stage 2's memory record is writable");

  // Not silent: the human can see the binding ended with the stage it belonged to.
  const status = h.goalStatus();
  assert.match(status, /Backend: unbound/);
  assert.match(status, /ended with that stage/);
  assert.match(status, /fake-dag-peer/, "and which peer it was bound to");
});

/**
 * B15/B16 (review findings, P1): the validator checked a field's shape when it
 * was PRESENT but never checked that a state's REQUIRED fields were there. So
 * the state machine's invariants could be entered from disk without ever
 * passing the guard that enforces them — `bound-available` with no binding,
 * `binding-pending` with no intent, a `committed` retained record with no
 * receipt for `resolveReplay` to bless as `identical`.
 *
 * The rule this repo already adopted applies: a malformed backend record makes
 * the whole snapshot malformed rather than being repaired, so a corrupt record
 * cannot be laundered into authority. These cases are that rule enforced
 * thoroughly: each state declares what it requires AND what it forbids.
 */

const SCOPE = {
  consumer: "pi-codex-multi-goal",
  scopeId: "goal:g-1:stage:s-1",
  contractRevision: "c".repeat(64),
  epoch: 0,
  selection: { sessionId: "session-a", branchAnchorId: "anchor-1" },
};

const DIGEST = "d".repeat(64);

function binding(overrides: Partial<GoalBackend["binding"] & object> = {}): any {
  return {
    peerId: "fake-dag-peer",
    taskId: "task-1",
    goalId: "g-1",
    stageId: "s-1",
    generation: 0,
    contractRevision: "c".repeat(64),
    sessionId: "session-a",
    branchAnchorId: "anchor-1",
    selectedRevision: "rev-3",
    ...overrides,
  };
}

function pendingOp(overrides: Record<string, unknown> = {}): any {
  return {
    operationId: "op-pending",
    kind: "bind",
    expectedState: "bound-available",
    previousState: "unbound",
    scope: SCOPE,
    expectedRevision: null,
    payloadDigest: DIGEST,
    payload: { contract: {}, memory: null },
    createdAt: 1,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}): any {
  return {
    protocolVersion: 1,
    operationId: "op-done",
    scope: SCOPE,
    selectedRevision: "rev-3",
    payloadDigest: DIGEST,
    committedAt: 1,
    ...overrides,
  };
}

function committedRecord(overrides: Record<string, unknown> = {}): any {
  return {
    operationId: "op-done",
    kind: "bind",
    scope: SCOPE,
    expectedRevision: null,
    payloadDigest: DIGEST,
    outcome: "committed",
    receipt: receipt(),
    reason: null,
    ...overrides,
  };
}

function quarantinedRecord(overrides: Record<string, unknown> = {}): any {
  return {
    operationId: "op-gone",
    kind: "write",
    scope: SCOPE,
    expectedRevision: "rev-3",
    payloadDigest: DIGEST,
    outcome: "quarantined",
    receipt: null,
    reason: "the branch moved",
    ...overrides,
  };
}

function backend(overrides: Record<string, unknown> = {}): any {
  return { state: "unbound", binding: null, pending: null, operations: [], reason: null, ...overrides };
}

test("B15: a backend that contradicts its own state is malformed", () => {
  const cases: Array<[string, any]> = [
    // A state that claims authority must show what grants it.
    ["bound-available with no binding", backend({ state: "bound-available" })],
    [
      "bound-available whose binding selected nothing",
      backend({ state: "bound-available", binding: binding({ selectedRevision: null }) }),
    ],
    [
      "bound-available whose selected revision is empty",
      backend({ state: "bound-available", binding: binding({ selectedRevision: "" }) }),
    ],
    ["bound-unavailable with no binding", backend({ state: "bound-unavailable" })],
    // A state that claims no authority must not carry one.
    ["unbound carrying a binding", backend({ binding: binding() })],
    ["detached carrying a binding", backend({ state: "detached", binding: binding() })],
    // An intent implies a switch in progress, and only a bind switches authority.
    ["unbound carrying a pending intent", backend({ pending: pendingOp() })],
    ["detached carrying a pending intent", backend({ state: "detached", pending: pendingOp() })],
    ["binding-pending with no pending intent", backend({ state: "binding-pending" })],
    [
      "binding-pending whose intent is not a bind",
      backend({
        state: "binding-pending",
        pending: pendingOp({ kind: "write", expectedRevision: "rev-3", previousState: "bound-available" }),
      }),
    ],
    [
      "a bind intent outside binding-pending",
      backend({
        state: "bound-available",
        binding: binding(),
        pending: pendingOp({ kind: "bind" }),
      }),
    ],
    // The field acceptReceipt promotes on must be reachable by the kind.
    [
      "an intent whose expected state its kind cannot reach",
      backend({
        state: "bound-available",
        binding: binding(),
        pending: pendingOp({ kind: "write", expectedState: "detached", expectedRevision: "rev-3" }),
      }),
    ],
    // A state with no authority cannot hold a committed operation to replay.
    ["unbound holding a committed operation", backend({ operations: [committedRecord()] })],
  ];

  for (const [label, value] of cases) {
    assert.equal(isGoalBackend(value), false, `must be rejected: ${label}`);
  }
});

test("B16: a retained record must carry what its outcome claims", () => {
  const bound = (operations: any[]) =>
    backend({ state: "bound-available", binding: binding(), operations });

  const cases: Array<[string, any]> = [
    ["committed with no receipt", bound([committedRecord({ receipt: null })])],
    ["committed with a missing receipt field", bound([committedRecord({ receipt: undefined })])],
    ["committed with a malformed receipt", bound([committedRecord({ receipt: { nonsense: true } })])],
    [
      "committed whose receipt answers another operation",
      bound([committedRecord({ receipt: receipt({ operationId: "op-somebody-else" }) })]),
    ],
    [
      "committed whose receipt digest disagrees with the record",
      bound([committedRecord({ receipt: receipt({ payloadDigest: "e".repeat(64) }) })]),
    ],
    [
      "committed whose receipt selected nothing",
      bound([committedRecord({ receipt: receipt({ selectedRevision: "" }) })]),
    ],
    [
      "committed whose receipt is from another protocol version",
      bound([committedRecord({ receipt: receipt({ protocolVersion: 99 }) })]),
    ],
    ["quarantined carrying a receipt", bound([quarantinedRecord({ receipt: receipt() })])],
    ["quarantined with no reason", bound([quarantinedRecord({ reason: null })])],
    [
      "the same operation id retained twice",
      bound([committedRecord(), quarantinedRecord({ operationId: "op-done" })]),
    ],
    [
      "an id that is both pending and retained",
      backend({
        state: "binding-pending",
        pending: pendingOp({ operationId: "op-done" }),
        operations: [committedRecord()],
      }),
    ],
  ];

  for (const [label, value] of cases) {
    assert.equal(isGoalBackend(value), false, `must be rejected: ${label}`);
  }
});

test("B15/B16: the arrangements the state machine actually produces still load", () => {
  const valid: Array<[string, any]> = [
    ["a fresh unbound backend", backend()],
    ["unbound after a bind was abandoned", backend({ operations: [quarantinedRecord()], reason: "abandoned" })],
    ["a bind in flight", backend({ state: "binding-pending", pending: pendingOp() })],
    ["a live binding", backend({ state: "bound-available", binding: binding(), operations: [committedRecord()] })],
    [
      "a write in flight against a live binding",
      backend({
        state: "bound-available",
        binding: binding(),
        pending: pendingOp({
          operationId: "op-write",
          kind: "write",
          previousState: "bound-available",
          expectedRevision: "rev-3",
        }),
        operations: [committedRecord()],
      }),
    ],
    [
      "a bound backend that stopped answering",
      backend({ state: "bound-unavailable", binding: binding(), reason: "the peer was unloaded" }),
    ],
    ["a detached backend", backend({ state: "detached", operations: [committedRecord({ kind: "detach" })] })],
  ];

  for (const [label, value] of valid) {
    assert.equal(isGoalBackend(value), true, `must be accepted: ${label}`);
  }
});

test("B15: a snapshot cannot assert bound-available from disk without a bind behind it", () => {
  // The route the recurring beginOperation finding actually describes: not a
  // call that skips the guard, but a snapshot that asserts the state the guard
  // exists to protect. reconstructGoal keeps the last VALID snapshot.
  const goal = twoStepGoal();
  const honest = setEntry(goal, "runtime");
  const forged = JSON.parse(JSON.stringify(setEntry(goal, "runtime")));
  forged.goal.backend = {
    state: "bound-available",
    binding: null,
    pending: null,
    operations: [],
    reason: null,
  };

  const reloaded = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: honest },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: forged },
  ]);

  assert.ok(reloaded, "the last valid snapshot is kept");
  assert.equal(reloaded.backend.state, "unbound", "the forged authority was skipped, not adopted");
  assert.equal(reloaded.backend.binding, null);
});

test("B16: a committed record with no receipt cannot be loaded and replayed as success", () => {
  const goal = twoStepGoal();
  const honest = setEntry(goal, "runtime");
  const forged = JSON.parse(JSON.stringify(setEntry(goal, "runtime")));
  forged.goal.backend = {
    state: "bound-available",
    binding: binding({ goalId: goal.goalId, stageId: goal.stages[0]!.id }),
    pending: null,
    // resolveReplay would call this `identical` and hand back a null receipt as
    // success, without ever contacting the peer.
    operations: [committedRecord({ receipt: null })],
    reason: null,
  };

  const reloaded = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: honest },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: forged },
  ]);

  assert.ok(reloaded);
  assert.equal(reloaded.backend.state, "unbound", "the receiptless commit was skipped");
  assert.deepEqual(reloaded.backend.operations, []);
});
