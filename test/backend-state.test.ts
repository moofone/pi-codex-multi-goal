import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { backendAdmitsExecution } from "../src/backend.ts";
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
        payloadDigest: "a".repeat(64),
        outcome: "committed",
        receipt: null,
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

function boundSnapshot(state: GoalBackend["state"], reason: string | null): unknown {
  const goal = createGoal(["first", "second"]);
  const backend: GoalBackend = {
    state,
    binding: {
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
    pending: null,
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
