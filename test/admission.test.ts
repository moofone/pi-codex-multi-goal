import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// A04/F01 admission contract, driven through the registered extension
// handlers with fake provider payloads (qa/evidence/host-capabilities.txt:
// there is no offline-drivable live agent loop, and before_provider_request
// CANNOT deny a request including retries — probe 1 [fail]).
//
// Therefore this suite deliberately does NOT claim a host-side admission
// barrier (A04 stays open). It proves the fallback contract: the total
// budget is charged durably per goal-owned provider request; no-progress is
// charged per full context (session_compact); exhaustion pauses and withdraws
// proven goal-owned work; reloads never refund; a fourth goal-owned provider
// entry is never recorded even though the host itself cannot be denied.

interface HarnessOptions {
  limits?: { noProgressLimit: number; totalLimit: number };
  branch?: unknown[];
}

/**
 * Fake provider payload from a provider that only emits bookkeeping tools
 * (update_goal): no real code changes exist, so no non-accounting signal may
 * reset the counters.
 */
function fakeProviderPayload() {
  return {
    model: "fake-model",
    messages: [{ role: "user", content: "<goal>admission probe turn</goal>" }],
    tools: [{ type: "function", name: "update_goal" }],
  };
}

function harness(t: any, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-admission-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  // Settings must be in place before registration reads them.
  writeFileSync(
    join(root, "pi-codex-multi-goal.json"),
    JSON.stringify(options.limits ?? {}),
  );

  const branch: any[] = [...(options.branch ?? [])];
  const entries: any[] = [...branch];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  let lastNotified: string | null = null;
  let aborts = 0;
  const ctx: any = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {
      aborts += 1;
    },
    sessionManager: {
      getSessionId: () => "admission-session",
      getSessionFile: () => "/qa/admission-session.jsonl",
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
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    sendMessage: (message: any) => {
      assert.equal(
        message.customType,
        CUSTOM_ENTRY_TYPE,
        "every goal-owned provider entry goes out as a goal continuation message",
      );
      sent.push(message);
    },
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
    sent,
    aborted: () => aborts,
    branchSnapshot: () => [...branch],
    /** Simulates the host running one provider request against the fake provider. */
    providerRequest: () =>
      emit("before_provider_request", { payload: fakeProviderPayload() }),
    /** One full context window (compaction boundary). */
    compact: () => emit("session_compact", { reason: "threshold" }),
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    command: (text: string) => commands.get("goal").handler(text, ctx),
    /** Execution counters as last persisted on the selected branch. */
    lastExecution: () => {
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const goal = (branch[i]?.data as any)?.goal;
        if (goal?.execution) {
          return goal.execution;
        }
      }
      return null;
    },
  };
}

function assertExecution(
  h: ReturnType<typeof harness>,
  expected: { noProgressRemaining: number; totalRemaining: number; lifetimeRequests: number },
  message?: string,
) {
  const execution = h.lastExecution();
  assert.deepEqual(
    execution && {
      noProgressRemaining: execution.noProgressRemaining,
      totalRemaining: execution.totalRemaining,
      lifetimeRequests: execution.lifetimeRequests,
    },
    expected,
    message ?? "execution counters",
  );
}

test("allowance three admits three never four", async t => {
  const limits = { noProgressLimit: 3, totalLimit: 3 };
  const h = harness(t, { limits });

  await h.emit("session_start");
  assert.equal(h.sent.length, 0, "no goal set: no goal-owned provider entries");

  // Entry 1 — kickoff from the explicit user start.
  await h.command(JSON.stringify({ objective: "ship the fix", criteria: ["it ships"] }));
  assert.equal(h.sent.length, 1, "the kickoff is the first goal-owned provider entry");
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 3, lifetimeRequests: 0 },
    "scheduling a request is not yet charging it");
  await h.providerRequest();
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 2, lifetimeRequests: 1 },
    "the kickoff request spends total only, once, durably");

  // Entry 2 — a retried request: another provider request for the same goal
  // turn (a tool-loop continuation of the kickoff), charged again at the hook.
  await h.providerRequest();
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 1, lifetimeRequests: 2 },
    "the retried request is charged against total; no-progress is untouched");
  await h.emit("agent_end", { messages: [] });
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 1, lifetimeRequests: 2 },
    "turn ends never recharge an already-charged request");

  // Reload must not refund: the restored grant is the charged one.
  const reloaded = harness(t, { limits, branch: h.branchSnapshot() });
  await reloaded.emit("session_start");
  const restored = reloaded.goalStatus();
  assert.match(restored, /Status: paused/, "restored work waits for an explicit decision");
  assert.match(
    restored,
    /no-progress 3\/3, total 1\/3/,
    "a reload must not refund the consumed allowance",
  );

  // Entry 3 — the explicit user resume admits exactly one more request.
  await reloaded.command("resume");
  assert.match(reloaded.goalStatus(), /Status: active/);
  assert.equal(reloaded.sent.length, 1, "the resume kickoff is the third goal-owned entry");
  await reloaded.providerRequest();
  assertExecution(reloaded, { noProgressRemaining: 3, totalRemaining: 0, lifetimeRequests: 3 },
    "the third request exhausts the total allowance and is charged once");
  assert.match(reloaded.goalStatus(), /Status: paused/);
  assert.match(reloaded.goalStatus(), /working budget of 3 provider requests is spent/);

  // Never a fourth: scheduling stops once remaining is 0, and no fourth
  // goal-owned provider entry is recorded — even though the host cannot be
  // denied (probe 1), so we emit the host-side request the extension cannot
  // prevent and assert it records nothing.
  await reloaded.emit("agent_end", { messages: [] });
  assert.equal(reloaded.sent.length, 1, "no goal continuation is requested once remaining is 0");
  await reloaded.command("resume");
  await reloaded.emit("agent_end", { messages: [] });
  assert.equal(
    reloaded.sent.length,
    1,
    "a user resume grants at most a bounded allowance, never a spent total",
  );
  await reloaded.providerRequest();
  assertExecution(reloaded, { noProgressRemaining: 3, totalRemaining: 0, lifetimeRequests: 3 },
    "a fourth goal-owned provider entry is never recorded (no negative counters, no refund)");
  assert.equal(
    h.sent.length + reloaded.sent.length,
    2,
    "only the kickoff and the resume kickoff were scheduled: the retried request " +
      "reused the kickoff turn, and everything after exhaustion was refused",
  );
  assert.equal(
    reloaded.lastExecution()?.lifetimeRequests,
    3,
    "exactly three goal-owned provider entries were recorded, never a fourth",
  );
});

// Tool-loop provider requests are not full contexts. noProgressLimit: 3 means
// three session_compact events, not three model turns. Exhaustion pauses and
// withdraws the outstanding queued kickoff (abort once).
test("no-progress exhaustion is full contexts, not turns, and stops", async t => {
  const h = harness(t, { limits: { noProgressLimit: 3, totalLimit: 200 } });

  await h.emit("session_start");
  await h.command(JSON.stringify({ objective: "ship the fix", criteria: ["it ships"] }));
  assert.equal(h.sent.length, 1, "the kickoff is scheduled once");
  await h.providerRequest();
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 199, lifetimeRequests: 1 },
    "a provider request spends total, not no-progress");

  // A tight tool loop must not burn the 3 full-context allowance.
  await h.providerRequest();
  await h.providerRequest();
  assert.match(h.goalStatus(), /Status: active/, "turns without a full context must not pause");
  assertExecution(h, { noProgressRemaining: 3, totalRemaining: 197, lifetimeRequests: 3 });
  assert.equal(h.aborted(), 0, "active tool-loop turns do not stop the goal");

  await h.compact();
  await h.compact();
  assert.match(h.goalStatus(), /Status: active/);
  assertExecution(h, { noProgressRemaining: 1, totalRemaining: 197, lifetimeRequests: 3 });

  await h.compact();
  assert.match(h.goalStatus(), /Status: paused/);
  assert.match(h.goalStatus(), /full contexts/, "the pause reason names full contexts");
  assertExecution(h, { noProgressRemaining: 0, totalRemaining: 197, lifetimeRequests: 3 });
  assert.equal(h.aborted(), 1, "valid exhaustion withdraws outstanding goal-owned work once");
  assert.equal(h.sent.length, 1, "no further goal continuation is requested once the streak is spent");

  // Host-side requests the extension cannot deny record nothing: counters
  // never go negative. Already-paused work is not aborted again.
  await h.emit("agent_end", { messages: [] });
  await h.providerRequest();
  await h.compact();
  assertExecution(h, { noProgressRemaining: 0, totalRemaining: 197, lifetimeRequests: 3 });
  assert.equal(h.aborted(), 1, "a second exhaustion does not abort again");
  assert.equal(h.sent.length, 1);

  // An explicit user resume grants a fresh bounded no-progress streak only.
  await h.command("resume");
  assertExecution(
    h,
    { noProgressRemaining: 3, totalRemaining: 197, lifetimeRequests: 3 },
    "resume refills only the no-progress streak; total and lifetime never reset",
  );
});
