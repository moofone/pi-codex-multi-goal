import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Default true; headless JSON-contract tests set false. */
  hasUI?: boolean;
}

function harness(t: any, options: HarnessOptions) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-recovery-"));
  const previousCwd = process.cwd();
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator", "repo", "feature"), { recursive: true });
  // Completion evidence artifacts resolve against the working directory of the
  // pi process (Task 8); the harness chdirs into its own root.
  process.chdir(root);

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
    hasUI: options.hasUI ?? true,
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
  /** Last goal snapshot the extension appended to the selected branch. */
  const appendedGoalSnapshot = () => {
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const goal = (branch[i]?.data as any)?.goal;
      if (goal) {
        return goal;
      }
    }
    return null;
  };
  t.after(async () => {
    await emit("session_shutdown");
    // Nested harnesses restore cwd outermost-first; a previous dir may already
    // be gone, and losing the restore must not fail the test.
    try {
      process.chdir(previousCwd);
    } catch {
      /* previous directory already removed */
    }
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
    appendedGoal: appendedGoalSnapshot,
    command: (text: string) => commands.get("goal").handler(text, ctx),
    // A well-formed terminal call under the Task 8 contract: bound to the
    // current goal/step/generation with evidence covering the current criterion.
    complete: () => {
      const goal = appendedGoalSnapshot();
      const content = "the fix, applied\n";
      mkdirSync(dirname(join(root, "src", "fix.ts")), { recursive: true });
      writeFileSync(join(root, "src", "fix.ts"), content);
      return goalTool.execute("same-completion", {
        status: "complete",
        goalId: goal.goalId,
        step: goal.index + 1,
        generation: goal.execution.generation,
        evidence: [{
          operation: "edit",
          artifact: "src/fix.ts",
          fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
          criteria: [goal.stages[goal.index].criteria[0].id],
        }],
      }, new AbortController().signal, undefined, ctx);
    },
    branch: (value: any[]) => { branch = value; },
    breakAppend: () => { appendBroken = true; },
  };
}

/** Step-1 snapshot with a partially consumed execution grant (17/20, 195/400). */
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
    /no-progress 17\/20, total 195\/400/,
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
  assert.match(status, /total 195\/400/, "malformed entries must not replenish the grant");
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

test("v1 restore resume without criteria stays paused", async t => {
  // A v1 unfinished snapshot migrates to paused with empty criteria (A10);
  // humans confirm criteria through /goal or /goal-multi, which starts a new
  // goal identity. /goal resume must never activate the criteria-less goal.
  const v1Entry = {
    type: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "set",
      source: "command",
      at: 5,
      goal: {
        goalId: "v1-unfinished",
        status: "active",
        index: 0,
        createdAt: 1,
        updatedAt: 2,
        stages: [{ title: "stage one", status: "active" }],
      },
    },
  };
  const h = harness(t, { entries: [v1Entry], branch: [v1Entry], hasUI: false });

  await h.emit("session_start");
  assert.match(h.goalStatus(), /Status: paused/, "the migrated v1 goal is paused");
  assert.match(h.goalStatus(), /confirm criteria/i, "the pause reason names criteria confirmation");
  assert.equal(h.sent.length, 0, "restore itself schedules nothing");

  const sentBefore = h.sent.length;
  await h.command("resume");

  // Refused: the goal stays paused with the criteria-confirmation reason, no
  // continuation is scheduled, and nothing is persisted (A01, A10).
  const status = h.goalStatus();
  assert.match(status, /Status: paused/, "resume must not activate a goal without accepted criteria");
  assert.match(status, /confirm criteria/i, "the pause reason still names criteria confirmation");
  assert.match(status, /Criteria: \(awaiting confirmation\)/, "criteria stay unaccepted");
  assert.equal(h.sent.length, sentBefore, "a refused resume must not schedule a continuation");
  assert.equal(h.appendedGoal(), v1Entry.data.goal, "a refused resume persists no new snapshot");
  assert.ok(
    h.notifications.some(([text]) => typeof text === "string" && /criteria/i.test(text)),
    "the refusal names criteria confirmation to the user",
  );

  // A valid JSON contract can replace the criteria-less goal and start it.
  await h.command(
    JSON.stringify({ objective: "confirmed objective", criteria: ["confirmed criterion"] }),
  );
  const replaced = h.appendedGoal();
  assert.ok(replaced);
  assert.equal(replaced.status, "active", "the confirmed contract starts a new active goal");
  assert.notEqual(replaced.goalId, "v1-unfinished", "the replacement is a new goal identity");
  assert.deepEqual(
    replaced.stages.map((stage: any) => stage.criteria.map((criterion: any) => criterion.text)),
    [["confirmed criterion"]],
    "the new goal carries the confirmed criteria, none fabricated",
  );
  assert.equal(h.sent.length, sentBefore + 1, "the replacement kickoff is scheduled");
  assert.match(h.goalStatus(), /Status: active/);
});
