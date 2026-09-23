import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  countIsolatedSteps,
  createGoalMonitor,
  historyFromBranch,
} from "../src/monitor.ts";
import { registerMultiGoal } from "../src/runtime.ts";
import { acceptCompletion, createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

test("historyFromBranch follows memory and isolation across steps", () => {
  const first = createGoal(["pin", "document"]);
  first.memory = { revision: 1, proved: ["lockfile updated"], unresolved: [], next: "write the README" };
  const second = acceptCompletion(first, 1_700_000_000_000);
  assert.equal(second.ok, true);
  const entries = [
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(first, "command", 100) },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(second.goal!, "tool", 200) },
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: { version: 2, kind: "clear", source: "command", clearedGoalId: first.goalId, at: 300 },
    },
  ];
  const history = historyFromBranch(entries);
  assert.equal(history.length, 3);
  assert.equal(history[0]!.kind, "set");
  assert.equal(history[0]!.step, 1);
  assert.equal(history[0]!.memoryRevision, 1);
  assert.equal(history[0]!.memory?.next, "write the README");
  assert.equal(history[1]!.step, 2);
  assert.equal(history[1]!.isolationCutoff, 1_700_000_000_000);
  assert.equal(history[1]!.stageTitle, "document");
  assert.equal(history[2]!.kind, "clear");
  assert.equal(countIsolatedSteps(history), 1);
});

test("monitor server binds localhost, reuses the port, and serves memory plus DAG", async () => {
  const monitor = createGoalMonitor();
  const goal = createGoal(["pin the duplicate", "document the pin"]);
  goal.memory = {
    revision: 2,
    proved: ["lockfile updated"],
    unresolved: ["changelog wording"],
    next: "draft README",
  };
  monitor.syncGoal(goal, "command");
  const first = await monitor.start();
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(first.reused, false);
  const second = await monitor.start();
  assert.equal(second.url, first.url);
  assert.equal(second.reused, true);

  const page = await fetch(first.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Goal monitor/);

  const snap = await fetch(new URL("api/snapshot", first.url)).then((response) => response.json());
  assert.equal(snap.goal.memory.next, "draft README");
  assert.equal(snap.goal.stages.length, 2);
  assert.equal(snap.goal.stages[0].criteria[0].text, "pin the duplicate");
  assert.equal(snap.goal.injectedSnapshot.includes("pin the duplicate"), true);
  assert.equal(snap.compaction.hostCompactions, 0);

  monitor.noteCompactPrep(12_000);
  monitor.recordCompact({ reason: "threshold" });
  const afterCompact = monitor.snapshot();
  assert.equal(afterCompact.compaction.hostCompactions, 1);
  assert.equal(afterCompact.compaction.events[0]!.tokensBefore, 12_000);
  assert.equal(afterCompact.compaction.contextsWouldHaveBeenCompacted, 1);

  const advanced = acceptCompletion(goal, 99).goal!;
  monitor.syncGoal(advanced, "tool");
  monitor.observeContext({
    incoming: [
      { role: "user", content: "old step", timestamp: 1 },
      { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "<goal>step 2</goal>", details: { stage: 2, stages: 2, kind: "stage_advance" }, timestamp: 100 },
    ],
    kept: [
      { role: "custom", customType: CUSTOM_ENTRY_TYPE, content: "<goal>step 2</goal>", details: { stage: 2, stages: 2, kind: "stage_advance" }, timestamp: 100 },
    ],
    goal: advanced,
  });
  const dag = monitor.snapshot();
  assert.equal(dag.compaction.isolatedSteps, 1);
  assert.equal(dag.compaction.contextsWouldHaveBeenCompacted, 2);
  assert.equal(dag.dag.lastAdmission?.droppedCount, 1);
  assert.equal(dag.dag.lastAdmission?.keptCount, 1);
  assert.equal(dag.dag.lastAdmission?.injectedSnapshot, "<goal>step 2</goal>");
  assert.equal(dag.dag.lastAdmission?.step, 2);

  monitor.stop();
  await assert.rejects(() => fetch(first.url), /fetch failed|ECONNREFUSED/i);
});

function harness(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-monitor-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify({}));

  const branch: unknown[] = [];
  const entries: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let lastNotified: string | null = null;
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "monitor-session",
      getSessionFile: () => "/qa/monitor-session.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      setStatus: () => {},
      notify: (message: string) => {
        lastNotified = message;
      },
      confirm: async () => true,
      input: async () => "",
    },
  };
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, command),
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    sendMessage: () => {},
  };
  registerMultiGoal(pi as never);
  const emit = async (name: string, event: Record<string, unknown> = {}) =>
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
    lastNotified: () => lastNotified,
    command: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
    hasCommand: (name: string) => commands.has(name),
  };
}

test("/goal-monitor launches a dashboard that tracks goal, compact, and DAG context", async (t) => {
  const h = harness(t);
  assert.equal(h.hasCommand("goal-monitor"), true);
  await h.emit("session_start");
  await h.command(
    "goal",
    JSON.stringify({
      objective: "ship the pin",
      criteria: ["pin documented"],
      steps: [
        { objective: "pin the duplicate", criteria: ["lockfile updated"] },
        { objective: "document the pin", criteria: ["README section merged"] },
      ],
    }),
  );

  await h.command("goal-monitor");
  const notified = h.lastNotified() ?? "";
  const match = notified.match(/http:\/\/127\.0\.0\.1:\d+\//);
  assert.ok(match, `expected a localhost URL in ${notified}`);
  const url = match[0]!;

  const snap = await fetch(new URL("api/snapshot", url)).then((response) => response.json());
  assert.equal(snap.goal.stage.k, 1);
  assert.equal(snap.goal.stage.n, 2);
  assert.equal(snap.goal.stages[1].title, "document the pin");
  assert.equal(snap.goal.stages[1].criteria[0].text, "README section merged");
  assert.match(snap.goal.injectedSnapshot, /pin the duplicate/);

  await h.emit("session_before_compact", { preparation: { tokensBefore: 64000 } });
  await h.emit("session_compact", { reason: "threshold" });
  const compacted = await fetch(new URL("api/snapshot", url)).then((response) => response.json());
  assert.equal(compacted.compaction.hostCompactions, 1);
  assert.equal(compacted.compaction.events[0].tokensBefore, 64000);
  assert.equal(compacted.compaction.contextsWouldHaveBeenCompacted, 1);

  const cutoff = Date.now();
  await h.emit("context", {
    messages: [
      { role: "user", content: "old transcript", timestamp: cutoff - 10 },
      {
        role: "custom",
        customType: CUSTOM_ENTRY_TYPE,
        content: "<goal>current</goal>",
        details: { goalId: snap.goal.goalId, stage: 1, stages: 2, kind: "continuation" },
        timestamp: cutoff + 10,
      },
    ],
  });
  const dag = await fetch(new URL("api/snapshot", url)).then((response) => response.json());
  assert.equal(dag.dag.lastAdmission.keptCount, 2);
  assert.equal(dag.dag.lastAdmission.droppedCount, 0);
  assert.equal(dag.dag.lastAdmission.injectedSnapshot.includes("current"), true);

  await h.command("goal-monitor");
  assert.match(h.lastNotified() ?? "", /already running/);

  await h.emit("session_shutdown");
  await assert.rejects(() => fetch(url), /fetch failed|ECONNREFUSED/i);
});
