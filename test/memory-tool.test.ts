import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// Task 7 bounded-memory contract, driven through the registered extension
// handlers with a controlled host (same seam as test/continuation.test.ts).
//
// Proven here:
//   - a valid replace stores proved/unresolved/next with a bumped revision;
//   - an identical replay is a no-op (no second bump, nothing re-persisted);
//   - a stale revision, or a wrong step/generation/goal identity, is rejected;
//   - a record over 8192 UTF-8 JSON bytes is rejected keeping the previous
//     record (A02: bytes, not characters — multibyte content counts);
//   - the tool result never echoes the contract, the memory contents, or the
//     next action (A06 snapshot content);
//   - criteria are unchanged (A01: memory is not a contract mutation), no step
//     transition happens, and execution remaining is unchanged — a memory-only
//     loop still consumes no-progress at a full context (A02 progress-buy).
//   - human /goal status shows the memory record and the counters.

interface HarnessOptions {
  seed?: unknown[];
}

/** A three-step branch snapshot so a wrong-step rejection has a real step 2. */
function seededSteps(): unknown[] {
  return [
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: setEntry(createGoal(["first", "second", "third"]), "command"),
    },
  ];
}

function harness(t: any, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-memory-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  // Settings must be in place before registration reads them.
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify({}));

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
      getSessionId: () => "memory-session",
      getSessionFile: () => "/qa/memory-session.jsonl",
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
  const emit = async (name: string, event: any = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  t.after(async () => {
    await emit("session_shutdown");
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
    providerRequest: () =>
      emit("before_provider_request", {
        payload: { model: "fake-model", messages: [{ role: "user", content: "<goal>turn</goal>" }], tools: [] },
      }),
    compact: () => emit("session_compact", { reason: "threshold" }),
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    /** Goal snapshot as last persisted on the selected branch. */
    current: () => entries.at(-1)?.data.goal,
  };
}

test("update_goal_memory replace reject stale and oversized", async t => {
  const h = harness(t, { seed: seededSteps() });
  await h.emit("session_start");
  await h.command("resume");
  const goal = h.current();
  assert.equal(goal.status, "active");
  const identity = {
    goalId: goal.goalId,
    step: goal.index + 1,
    generation: goal.execution.generation,
    revision: goal.memory.revision,
  };
  assert.equal(identity.revision, 0, "a fresh step starts at memory revision 0");

  // Baselines: memory is continuity state, never a contract or grant mutation.
  const criteriaBefore = JSON.stringify(goal.stages);
  const executionBefore = JSON.parse(JSON.stringify(goal.execution));
  const indexBefore = goal.index;

  // --- a valid replace stores proved/unresolved/next with a bumped revision.
  const proved = ["proved: duplicate pinned in lockfile (artifact: package-lock.json)"];
  const unresolved = ["unresolved: registry retry policy unproven"];
  const next = "rerun the install check";
  const record = await h.memory({ ...identity, proved, unresolved, next });
  const recordText = JSON.stringify(record);
  let current = h.current();
  assert.deepEqual(current.memory, { revision: 1, proved, unresolved, next });

  // --- the tool result does not echo the contract, memory, or next action.
  for (const secret of [...proved, ...unresolved, next, "first", "second", "third"]) {
    assert.equal(recordText.includes(secret), false, `result must not echo: ${secret}`);
  }

  // --- an identical replay (same params, original revision) is a no-op.
  const afterFirst = current.memory;
  await h.memory({ ...identity, proved, unresolved, next });
  current = h.current();
  assert.deepEqual(current.memory, afterFirst, "replay changes nothing");
  assert.equal(current.memory.revision, 1, "replay does not bump the revision");
  // A same-revision replay with identical content is equally a no-op.
  await h.memory({ ...identity, revision: 1, proved, unresolved, next });
  current = h.current();
  assert.deepEqual(current.memory, afterFirst);

  // --- a stale revision with new content is rejected, as is a future one.
  await assert.rejects(
    () => h.memory({ ...identity, revision: 0, proved: ["stale overwrite"], unresolved: [], next: "" }),
    /stale|revision/i,
  );
  await assert.rejects(
    () => h.memory({ ...identity, revision: 9, proved: ["future overwrite"], unresolved: [], next: "" }),
    /stale|revision/i,
  );
  current = h.current();
  assert.deepEqual(current.memory, afterFirst, "rejected updates keep the previous record");

  // --- wrong step, generation, or goal identity is rejected (bound execution).
  await assert.rejects(
    () => h.memory({ ...identity, step: 2, proved: ["x"], unresolved: [], next: "" }),
    /step/i,
  );
  await assert.rejects(
    () => h.memory({ ...identity, generation: 7, proved: ["x"], unresolved: [], next: "" }),
    /generation/i,
  );
  await assert.rejects(
    () => h.memory({ ...identity, goalId: "not-the-current-goal", proved: ["x"], unresolved: [], next: "" }),
    /goal/i,
  );
  current = h.current();
  assert.deepEqual(current.memory, afterFirst);

  // --- size: exactly 8192 UTF-8 JSON bytes is accepted, one byte more is not.
  const overhead = JSON.stringify({ revision: 0, proved: [""], unresolved: [], next: "" }).length;
  const exact = "a".repeat(8192 - overhead);
  await h.memory({ ...identity, revision: 1, proved: [exact], unresolved: [], next: "" });
  current = h.current();
  assert.equal(current.memory.revision, 2, "a record at exactly the byte limit is accepted");
  const atLimit = current.memory;

  await assert.rejects(
    () => h.memory({ ...identity, revision: 2, proved: [`${exact}a`], unresolved: [], next: "" }),
    /8192|bytes|limit/i,
  );
  // Multibyte: 4200 two-byte characters exceed the byte limit at 4200 chars.
  await assert.rejects(
    () => h.memory({ ...identity, revision: 2, proved: ["é".repeat(4200)], unresolved: [], next: "" }),
    /8192|bytes|limit/i,
  );
  current = h.current();
  assert.deepEqual(current.memory, atLimit, "an oversized update keeps the previous record");

  // --- criteria unchanged, no step transition, execution remaining unchanged.
  current = h.current();
  assert.equal(JSON.stringify(current.stages), criteriaBefore, "memory updates cannot change criteria");
  assert.equal(current.index, indexBefore, "memory updates cannot transition steps");
  assert.deepEqual(current.execution, executionBefore, "memory updates never replenish the allowance");

  // --- a memory-only loop still consumes no-progress at a full context, not
  // at a provider-entry turn.
  await h.providerRequest();
  current = h.current();
  assert.equal(
    current.execution.noProgressRemaining,
    executionBefore.noProgressRemaining,
    "a memory-only provider request does not spend no-progress",
  );
  assert.equal(current.execution.lifetimeRequests, executionBefore.lifetimeRequests + 1);
  assert.equal(current.execution.totalRemaining, executionBefore.totalRemaining - 1);

  await h.compact();
  current = h.current();
  assert.equal(
    current.execution.noProgressRemaining,
    executionBefore.noProgressRemaining - 1,
    "memory-only work consumes no-progress at a full context",
  );

  // --- human /goal status shows the memory record and the counters.
  const status = h.goalStatus();
  assert.match(status, /Memory: revision 2/);
  assert.match(status, /no-progress 19\/20, total 399\/400/);
});
