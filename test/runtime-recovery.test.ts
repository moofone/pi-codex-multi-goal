import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { completeCurrentStage, createGoal } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// F03 + F08 recovery contract: reload and tree navigation reconstruct from the
// selected branch, never silently resume or replenish, and stop admitting goal
// work when persistence fails. The restored state is observed through the
// extension's own channels: /goal status text, appended entries, and sent
// messages. Mirrors the controlled host harness from qa/runtime.test.ts.

interface HarnessOptions {
  entries: unknown[];
  branch: unknown[];
}

function harness(t: any, options: HarnessOptions) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-recovery-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator", "repo", "feature"), { recursive: true });

  const entries: any[] = [...options.entries];
  let branch: any[] = [...options.branch];
  const notifications: unknown[][] = [];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let goalTool: any;
  const sent: any[] = [];
  let lastNotified: string | null = null;
  let appendBroken = false;
  const ctx: any = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "recovery-session",
      getSessionFile: () => "/qa/recovery-session.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      setStatus: () => {},
      notify: (...args: unknown[]) => {
        lastNotified = typeof args[0] === "string" ? args[0] : null;
        notifications.push(args);
      },
      confirm: async () => true,
      input: async () => "",
    },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => { goalTool = tool; },
    appendEntry: (customType: string, data: unknown) => {
      if (appendBroken) {
        throw new Error("append failed");
      }
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    sendMessage: (message: any) => { sent.push(message); },
  };
  registerMultiGoal(pi);
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  t.after(async () => {
    await emit("session_shutdown");
    if (oldAgent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldAgent;
    if (oldOrchestrator === undefined) delete process.env.PI_ORCHESTRATOR_ROOT; else process.env.PI_ORCHESTRATOR_ROOT = oldOrchestrator;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    emit,
    sent,
    notifications,
    /** The extension's live view of the goal, via the human status channel. */
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    /** Last goal snapshot the extension appended to the selected branch. */
    appendedGoal: () => {
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const goal = (branch[i]?.data as any)?.goal;
        if (goal) {
          return goal;
        }
      }
      return null;
    },
    command: (text: string) => commands.get("goal").handler(text, ctx),
    complete: () => goalTool.execute("same-completion", { status: "complete" }, new AbortController().signal, undefined, ctx),
    branch: (value: any[]) => { branch = value; },
    breakAppend: () => { appendBroken = true; },
  };
}

/** Step-1 snapshot with a partially consumed execution grant (17/20, 195/200). */
function stepOneEntries() {
  const stepOne = createGoal(["first", "second", "third"], 100);
  stepOne.execution = {
    ...stepOne.execution,
    noProgressRemaining: 17,
    totalRemaining: 195,
  };
  const stepOneEntry = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: { version: 2, kind: "set", source: "command", goal: stepOne, at: 100 },
  };
  // Off-branch advance to step 2 that exists only in the full log.
  const stepTwo = completeCurrentStage(stepOne, 110).goal!;
  const stepTwoEntry = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: { version: 2, kind: "set", source: "runtime", goal: stepTwo, at: 110 },
  };
  return { stepOneEntry, stepTwoEntry };
}

function assertRestoredPausedAtStepOne(status: string): void {
  assert.match(status, /Status: paused/, "restored work is paused for an explicit user decision");
  assert.match(status, /Stage: 1\/3/, "restore must follow the selected branch, not the off-branch step 2");
  assert.match(status, /Paused: .+/, "the pause reason must be visible");
  assert.match(
    status,
    /no-progress 17\/20, total 195\/200/,
    "a partially consumed grant must not be replenished",
  );
}

test("selected branch restore stays paused without refill", async t => {
  const { stepOneEntry, stepTwoEntry } = stepOneEntries();
  // Full log holds the step-2 advance; the selected branch is back at step 1.
  const h = harness(t, {
    entries: [stepOneEntry, stepTwoEntry],
    branch: [stepOneEntry],
  });

  await h.emit("session_start");
  assertRestoredPausedAtStepOne(h.goalStatus());
  assert.equal(h.sent.length, 0, "session_start must not auto-request continuation");

  // The explicit user decision resumes the restored goal.
  await h.command("resume");
  assert.match(h.goalStatus(), /Status: active/, "an explicit resume makes the restored goal active");

  // Tree navigation back to the step-1 branch drops the off-branch step 2.
  const h2 = harness(t, {
    entries: [stepOneEntry, stepTwoEntry],
    branch: [stepOneEntry, stepTwoEntry],
  });
  await h2.emit("session_start");
  assert.match(h2.goalStatus(), /Stage: 2\/3/, "sanity: the step-2 branch is live before navigation");
  h2.branch([stepOneEntry]);
  await h2.emit("session_tree");
  assertRestoredPausedAtStepOne(h2.goalStatus());
  assert.equal(h2.sent.length, 0, "session_tree must not auto-request continuation");
});

test("malformed goal snapshots are skipped during branch restore", async t => {
  const { stepOneEntry, stepTwoEntry } = stepOneEntries();
  const malformed = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: { version: 2, kind: "set", source: "runtime", at: 120, goal: { goalId: "broken" } },
  };
  const corrupt = { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: undefined };
  const h = harness(t, {
    entries: [stepOneEntry, stepTwoEntry, malformed, corrupt],
    branch: [stepOneEntry, malformed, corrupt],
  });

  await h.emit("session_start");
  const status = h.goalStatus();
  assert.match(status, /Stage: 1\/3/, "a malformed tail must not lose the last valid snapshot");
  assert.match(status, /Status: paused/);
  assert.match(status, /total 195\/200/, "malformed entries must not replenish the grant");
});

test("persist failure admits no goal work and notifies", async t => {
  const { stepOneEntry } = stepOneEntries();
  const h = harness(t, { entries: [stepOneEntry], branch: [stepOneEntry] });

  await h.emit("session_start");
  assert.match(h.goalStatus(), /Status: paused/);
  await h.command("resume");
  assert.match(h.goalStatus(), /Status: active/);
  const sentAfterResume = h.sent.length;

  h.breakAppend();
  let acknowledged = true;
  try {
    const result = await h.complete();
    if (result && typeof result === "object" && "ok" in (result as any)) {
      assert.equal((result as any).ok, false, "an unpersisted completion must not be acknowledged as success");
    }
    if (result && typeof result === "object" && Array.isArray((result as any).content)) {
      acknowledged = false; // refusal is also a legitimate host result
    }
  } catch {
    acknowledged = false; // the host rejecting the call is acceptable
  }
  assert.equal(h.appendedGoal()?.index, 0, "no completion entry may be appended while persistence fails");
  assert.match(h.goalStatus(), /Stage: 1\/3/, "the unpersisted completion must not stay in memory");
  assert.ok(
    h.notifications.some(([text]) => typeof text === "string" && /persist/i.test(text as string)),
    "the user must be notified that persistence failed",
  );

  // Still broken: further goal work is refused and no continuation is sent.
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.sent.length, sentAfterResume, "no goal continuation may be admitted while persistence is broken");
  try {
    await h.complete();
  } catch {
    /* rejection is acceptable */
  }
  assert.equal(h.appendedGoal()?.index, 0, "goal work stays disabled while persistence is broken");
  void acknowledged;
});
