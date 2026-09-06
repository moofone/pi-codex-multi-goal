import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// Task 6 continuation-ownership contract, driven through the registered
// extension handlers with a controlled host (qa/evidence/host-capabilities.txt:
// no offline-drivable live agent loop exists, so message delivery, compaction,
// and abort are host events the harness emits explicitly).
//
// Proven here:
//   - the kickoff sends exactly once; ordinary agent_end turns never send;
//   - a context boundary sends exactly one continuation, and only after the
//     previous continuation's delivery was acknowledged (queued / delivered /
//     eligible-for-next-boundary — no per-turn reminder spam, no stacking);
//   - delivery is revalidated against goal/step/generation/status, so a stale
//     continuation arms nothing;
//   - pause/clear/block/replacement withdraw goal-owned work (drop the queued
//     follow-up, abort in-flight goal work exactly once) and never abort a
//     user-owned turn;
//   - a live orchestrate Feature (shouldYield) means compaction neither spends
//     nor pauses the goal and update_goal complete does not advance (A09/F07).

interface HarnessOptions {
  limits?: { noProgressLimit: number; totalLimit: number };
  /** Goal snapshot entries pre-seeded on the selected branch. */
  seed?: unknown[];
}

const CONTRACT = JSON.stringify({ objective: "ship the fix", criteria: ["it ships"] });
const CONTRACT_B = JSON.stringify({ objective: "ship the other fix", criteria: ["it ships too"] });

/** A three-step branch snapshot: completions must advance, not finish. */
function seededSteps(): unknown[] {
  return [
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(createGoal(["first", "second", "third"]), "command") },
  ];
}

/** Task 8 completion evidence for the current stage's criterion, backed by a real artifact. */
function harness_evidenceFor(goal: any) {
  const content = "the fix, applied\n";
  mkdirSync("src", { recursive: true });
  writeFileSync(join("src", "fix.ts"), content);
  return {
    operation: "edit",
    artifact: "src/fix.ts",
    fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
    criteria: [goal.stages[goal.index].criteria[0].id],
  };
}

function harness(t: any, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-continuation-"));
  const previousCwd = process.cwd();
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator", "repo", "feature"), { recursive: true });
  // Settings must be in place before registration reads them.
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify(options.limits ?? {}));
  // Completion evidence artifacts resolve against the working directory of the
  // pi process (Task 8); the harness chdirs into its own root.
  process.chdir(root);

  const branch: any[] = [...(options.seed ?? [])];
  const entries: any[] = branch;
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let goalTool: any;
  const sent: Array<{ message: any; options: any }> = [];
  const pending: any[] = [];
  let aborts = 0;
  const ctx: any = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => pending.length > 0,
    abort: () => {
      aborts += 1;
      // The host abort action drains the queue and cancels the in-flight loop
      // (probe 2: process-global scope — which is why production may only call
      // it after ownership is proven).
      pending.length = 0;
    },
    sessionManager: {
      getSessionId: () => "continuation-session",
      getSessionFile: () => "/qa/continuation-session.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: { setStatus: () => {}, notify: () => {}, confirm: async () => true, input: async () => "" },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => { goalTool = tool; },
    appendEntry: (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      branch.push(entry);
    },
    sendMessage: (message: any, options: any) => {
      assert.equal(message.customType, CUSTOM_ENTRY_TYPE, "only goal continuation messages are sent");
      sent.push({ message, options });
      pending.push(message);
    },
  };
  registerMultiGoal(pi);
  const emit = async (name: string, event: any = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  /** Host delivers the next queued message: the supported acknowledgement events. */
  const deliver = async () => {
    const message = pending.shift();
    await emit("message_start", { message });
    await emit("message_end", { message });
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
    if (oldAgent === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = oldAgent;
    if (oldOrchestrator === undefined) delete process.env.PI_ORCHESTRATOR_ROOT;
    else process.env.PI_ORCHESTRATOR_ROOT = oldOrchestrator;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    emit,
    deliver,
    /** A user message is delivered; user messages take precedence over goal work. */
    userSays: (text: string) =>
      Promise.all([
        emit("message_start", { message: { role: "user", content: text, timestamp: Date.now() } }),
        emit("message_end", { message: { role: "user", content: text, timestamp: Date.now() } }),
      ]),
    sent,
    pending,
    aborted: () => aborts,
    command: (text: string) => commands.get("goal").handler(text, ctx),
    /** The goal/step/generation binding the model reads from the snapshot. */
    identity: () => {
      const goal = entries.at(-1)?.data.goal;
      return { goalId: goal.goalId, step: goal.index + 1, generation: goal.execution.generation };
    },
    /** One evidence ref backed by a real artifact, covering the given criteria. */
    evidence: (criteria: string[], artifact = "src/fix.ts", content = "the fix, applied\n") => {
      const absolute = join(root, artifact);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return {
        operation: "edit",
        artifact,
        fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
        criteria,
      };
    },
    complete: (id = "same-completion") => {
      const goal = entries.at(-1)?.data.goal;
      return goalTool.execute(id, {
        status: "complete",
        goalId: goal.goalId,
        step: goal.index + 1,
        generation: goal.execution.generation,
        evidence: [harness_evidenceFor(goal)],
      }, new AbortController().signal, undefined, ctx);
    },
    block: (id = "same-block") => {
      const goal = entries.at(-1)?.data.goal;
      return goalTool.execute(id, {
        status: "blocked",
        goalId: goal.goalId,
        step: goal.index + 1,
        generation: goal.execution.generation,
      }, new AbortController().signal, undefined, ctx);
    },
    compact: () => emit("session_compact", { reason: "threshold" }),
    providerRequest: () => emit("before_provider_request", {
      payload: { model: "fake-model", messages: [{ role: "user", content: "<goal>turn</goal>" }], tools: [] },
    }),
    own: (phase: string) =>
      writeFileSync(
        join(root, "orchestrator", "repo", "feature", "status.md"),
        `phase: ${phase}\nparent_session_id: continuation-session\n`,
      ),
    current: () => entries.at(-1)?.data.goal,
    /** Execution counters as last persisted on the selected branch. */
    counters: () => {
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const execution = (branch[i]?.data as any)?.goal?.execution;
        if (execution) {
          return {
            noProgressRemaining: execution.noProgressRemaining,
            totalRemaining: execution.totalRemaining,
            lifetimeRequests: execution.lifetimeRequests,
          };
        }
      }
      return null;
    },
  };
}

test("one kickoff one boundary no per-turn spam", async t => {
  const h = harness(t, { seed: seededSteps() });
  await h.emit("session_start");
  assert.equal(h.sent.length, 0, "restored work stays parked: no automatic kickoff");

  await h.command("resume");
  assert.equal(h.sent.length, 1, "the kickoff sends exactly once");
  assert.equal(h.sent[0]!.message.details.kind, "command_resume");
  assert.equal(h.pending.length, 1);

  // Ordinary turn ends never schedule goal work.
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_end", { messages: [] });
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.sent.length, 1, "ordinary agent_end does not send");

  // A boundary while the kickoff is still queued must not stack a second one.
  await h.compact();
  assert.equal(h.sent.length, 1, "at most one pending goal continuation");

  // Delivery acknowledgement on the host message events.
  await h.deliver();

  await h.emit("agent_end", { messages: [] });
  assert.equal(h.sent.length, 1, "a delivered kickoff does not re-send on turn end");

  // The eligible context boundary sends exactly one continuation.
  await h.compact();
  assert.equal(h.sent.length, 2, "an eligible context-boundary compact sends exactly one continuation");
  assert.equal(h.sent[1]!.message.details.kind, "continuation");
  assert.match(JSON.stringify(h.sent[1]!.message.content), /<goal>/);
  assert.equal(h.pending.length, 1, "the boundary continuation is itself queued until acknowledged");

  // No stacking while that one is queued.
  await h.compact();
  assert.equal(h.sent.length, 2);

  await h.deliver();
  // Each acknowledged boundary re-arms exactly one further boundary send.
  await h.compact();
  assert.equal(h.sent.length, 3);

  // Delivery revalidation and the Task 8 completion boundary: the accepted
  // completion withdraws the stale queued step-1 continuation (abort, once —
  // no goal loop is in flight whose tool result could be lost), persists the
  // transition, and admits exactly one kickoff for the next step.
  await h.complete();
  assert.equal(h.current().index, 1, "sanity: completion advances exactly one step");
  assert.equal(h.aborted(), 1, "the stale queued step-1 continuation is withdrawn exactly once");
  assert.equal(h.pending.length, 1, "only the stage-advance kickoff remains queued");
  assert.equal(h.sent.length, 4, "an accepted completion admits exactly one stage-advance kickoff");
  assert.equal(h.sent[3]!.message.details.kind, "stage_advance");
  assert.equal(h.sent[3]!.message.details.stage, 2);
  assert.equal(
    JSON.stringify(h.sent[3]!.message.content).includes("\"first\"") || JSON.stringify(h.sent[3]!.message.content).includes("first\n"),
    false,
    "the stage-advance kickoff snapshot is the new step only",
  );

  // The stage-advance kickoff itself participates in the Task 6 cadence: one
  // boundary snapshot after its delivery, never stacking.
  await h.deliver();
  await h.compact();
  assert.equal(h.sent.length, 5, "after delivery the next boundary re-arms exactly one snapshot");
  await h.compact();
  assert.equal(h.sent.length, 5, "still at most one pending goal continuation");

  await h.deliver();
  await h.emit("agent_end", { messages: [] });
  assert.equal(h.sent.length, 5, "still no per-turn sends");
});

test("pause withdraws goal work not peer", async t => {
  // --- pause drops the queued follow-up and aborts exactly once.
  const h = harness(t);
  await h.emit("session_start");
  await h.command(CONTRACT);
  assert.equal(h.pending.length, 1);
  await h.command("pause");
  assert.equal(h.current().status, "paused");
  assert.equal(h.pending.length, 0, "pause drops the pending goal follow-up");
  assert.equal(h.aborted(), 1, "pause aborts exactly once to withdraw goal-owned work");

  // With nothing outstanding, further lifecycle commands never abort.
  await h.command("clear");
  assert.equal(h.aborted(), 1, "withdraw never aborts without outstanding goal work");

  // --- pause aborts in-flight goal work exactly once.
  const hInFlight = harness(t);
  await hInFlight.emit("session_start");
  await hInFlight.command(CONTRACT);
  await hInFlight.deliver();
  await hInFlight.emit("turn_start", { turnIndex: 0 });
  await hInFlight.command("pause");
  assert.equal(hInFlight.current().status, "paused");
  assert.equal(hInFlight.aborted(), 1, "pause aborts the goal-owned in-flight work once");

  // --- block withdraws the same way.
  const hBlock = harness(t);
  await hBlock.emit("session_start");
  await hBlock.command(CONTRACT);
  await hBlock.deliver();
  await hBlock.emit("turn_start", { turnIndex: 0 });
  await hBlock.block();
  assert.equal(hBlock.current().status, "blocked");
  assert.equal(hBlock.aborted(), 1, "block aborts the goal-owned in-flight work once");

  // --- replacement withdraws the old goal's queued work, then kicks off the new goal.
  const hReplace = harness(t);
  await hReplace.emit("session_start");
  await hReplace.command(CONTRACT);
  assert.equal(hReplace.pending.length, 1);
  await hReplace.command(CONTRACT_B);
  assert.equal(hReplace.aborted(), 1, "replacement withdraws the old goal's queued work once");
  assert.equal(hReplace.sent.length, 2, "the replacement kickoff schedules the new goal");
  assert.equal(hReplace.pending.length, 1, "the old queued follow-up stays withdrawn");
  assert.match(JSON.stringify(hReplace.sent[1]!.message.content), /ship the other fix/);

  // --- a user-owned turn is never aborted by goal withdraw.
  const hUser = harness(t);
  await hUser.emit("session_start");
  await hUser.command(CONTRACT);
  await hUser.deliver();
  await hUser.userSays("do this other thing instead");
  await hUser.emit("turn_start", { turnIndex: 0 });
  await hUser.command("pause");
  assert.equal(hUser.current().status, "paused");
  assert.equal(hUser.aborted(), 0, "a user-owned turn is never aborted by goal withdraw");
  await hUser.emit("agent_end", { messages: [] });
  assert.equal(hUser.sent.length, 1, "and goal work stays withdrawn after the user turn");

  // --- a live orchestrate Feature: compaction neither spends nor pauses the
  // goal, and update_goal complete does not advance.
  const limits = { noProgressLimit: 5, totalLimit: 5 };
  const ho = harness(t, { limits });
  await ho.emit("session_start");
  await ho.command(CONTRACT); // started before orchestrate takes over
  ho.own("implementing");
  await ho.emit("session_start"); // ownership handoff to the peer
  await ho.command("resume"); // explicit user decision; scheduling is refused while yielding
  assert.equal(ho.sent.length, 1, "no goal continuation is scheduled while orchestrate owns the session");
  assert.equal(ho.aborted(), 0, "ownership withdraw never aborts the peer");
  for (let i = 0; i < 5; i++) await ho.compact();
  assert.equal(ho.current().status, "active", "compaction under orchestrate ownership must not pause the goal");
  assert.deepEqual(
    ho.counters(),
    { noProgressRemaining: 5, totalRemaining: 5, lifetimeRequests: 0 },
    "compaction under orchestrate ownership must not spend the allowance",
  );
  await ho.providerRequest();
  assert.deepEqual(
    ho.counters(),
    { noProgressRemaining: 5, totalRemaining: 5, lifetimeRequests: 0 },
    "peer-owned provider entries are not charged to the goal",
  );
  let refused = false;
  try {
    await ho.complete();
  } catch {
    refused = true; // refusing the terminal tool is the expected behavior
  }
  assert.equal(ho.current().index, 0, "update_goal complete does not advance under orchestrate ownership");
  assert.equal(ho.current().status, "active");
  assert.equal(ho.sent.length, 1, "and no goal continuation is scheduled for the peer's turns");
  void refused;
});
