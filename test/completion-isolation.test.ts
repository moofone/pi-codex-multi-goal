import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// Task 8 isolated-completion contract, driven through the registered extension
// handlers with a controlled host (same seam as test/continuation.test.ts).
//
// Proven here:
//   - duplicate complete (same tool-call id) is idempotent, and two terminal
//     calls in one response with distinct ids cannot advance twice (F05/A07);
//   - the completion tool result acknowledges only the old step and never
//     contains another step's title (F06);
//   - missing/stale evidence cannot complete, and a requiresHumanDecision
//     criterion leaves the step blocked from evidence-based completion (A11);
//   - the next provider-visible context is clean — no previous-step
//     transcript sentinel, no old memory, no other step titles — and exactly
//     one kickoff is admitted for the next step (F06/A08), or, if Task 1
//     recorded context isolation as unavailable, the kickoff is withheld and
//     execution stays paused with a visible reason;
//   - the transition survives restart and resumes the sequence exactly once.

const sha16 = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);

const EVIDENCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "qa", "evidence", "host-capabilities.txt");

/** Task 1's recorded probe outcome decides which isolation branch is honest. */
function contextFilterRecordedPass(): boolean {
  try {
    return /Probe \(3\) context-filter: \[pass\]/.test(readFileSync(EVIDENCE_FILE, "utf8"));
  } catch {
    return false; // unrecorded capability is unavailable; withhold, never fake
  }
}

interface HarnessOptions {
  seed?: unknown[];
}

function harness(t: any, options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-completion-"));
  const previousCwd = process.cwd();
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify({}));
  // Evidence artifacts are project-relative files resolved against the working
  // directory the pi process runs in; the harness chdirs into its own root.
  process.chdir(root);

  const branch: any[] = [...(options.seed ?? [])];
  const entries: any[] = [...branch];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const pending: any[] = [];
  let aborts = 0;
  let lastNotified: string | null = null;
  const ctx: any = {
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => pending.length > 0,
    abort: () => {
      aborts += 1;
      pending.length = 0;
    },
    sessionManager: {
      getSessionId: () => "completion-session",
      getSessionFile: () => "/qa/completion-session.jsonl",
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
    sendMessage: (message: any, sendOptions: any) => {
      assert.equal(message.customType, CUSTOM_ENTRY_TYPE, "only goal continuation messages are sent");
      sent.push({ message, options: sendOptions });
      pending.push(message);
    },
  };
  registerMultiGoal(pi);
  const emit = async (name: string, event: any = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
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

  const h = {
    emit,
    deliver,
    sent,
    pending,
    aborted: () => aborts,
    command: (text: string) => commands.get("goal").handler(text, ctx),
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    /** Current goal identity binding, as the model would read it from the snapshot. */
    identity: () => {
      const goal = h.current();
      return {
        goalId: goal.goalId,
        step: goal.index + 1,
        generation: goal.execution.generation,
        revision: goal.memory.revision,
      };
    },
    criterionIds: (stepIndex = 0): string[] =>
      h.current().stages[stepIndex].criteria.map((c: any) => c.id),
    /** One evidence ref bound to the given criteria, backed by a real artifact. */
    evidence: (criteria: string[], artifact = "src/fix.ts", content = "the fix, applied\n", operation = "edit") => {
      const absolute = join(root, artifact);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return { operation, artifact, fingerprint: sha16(content), criteria };
    },
    updateGoal: (params: any, id = "terminal-1") =>
      tools.get("update_goal").execute(id, params, new AbortController().signal, undefined, ctx),
    block: (id = "terminal-block") => h.updateGoal({ status: "blocked", ...h.identity() }, id),
    memory: (params: any, id = "memory-call") =>
      tools.get("update_goal_memory").execute(id, params, new AbortController().signal, undefined, ctx),
    context: async (messages: any[]) => emit("context", { messages }),
    providerRequest: () =>
      emit("before_provider_request", {
        payload: { model: "fake-model", messages: [{ role: "user", content: "<goal>turn</goal>" }], tools: [] },
      }),
    current: () => entries.at(-1)?.data.goal,
    branchSnapshot: () => [...branch],
  };
  return h;
}

function seededGoal(): unknown[] {
  return [
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: setEntry(createGoal(["first", "second", "third"]), "command"),
    },
  ];
}

/** A goal whose first step carries a human-decision criterion. */
function seededHumanDecisionGoal(): unknown[] {
  const goal = createGoal(["review target", "second", "third"]);
  goal.stages[0]!.criteria = [
    { id: "c-normal", text: "the analysis is written down" },
    { id: "c-decision", text: "release manager signs off", requiresHumanDecision: true },
  ];
  return [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(goal, "command") }];
}

test("duplicate complete does not skip", async t => {
  const h = harness(t, { seed: seededGoal() });
  await h.emit("session_start");
  await h.command("resume");
  assert.equal(h.sent.length, 1, "sanity: the kickoff went out");
  await h.deliver();
  assert.equal(h.current().index, 0);
  const before = h.identity();
  assert.equal(before.step, 1);

  // One complete advances exactly one step and admits exactly one kickoff.
  const result = await h.updateGoal({
    status: "complete",
    ...before,
    evidence: [h.evidence(h.criterionIds(0))],
  }, "terminal-a");
  assert.equal(result.ok !== false, true, "the first terminal call succeeds");
  assert.equal(h.current().index, 1, "completion advances exactly one step");
  assert.equal(h.current().stages[0].status, "complete");
  assert.equal(h.current().stages[1].status, "active");
  assert.equal(h.sent.length, 2, "the accepted completion schedules exactly one kickoff");
  assert.equal(h.sent[1]!.message.details.kind, "stage_advance");
  assert.equal(h.sent[1]!.message.details.stage, 2);

  // The next step starts on a fresh grant with cleared memory and a bumped
  // generation; the lifetime total keeps counting.
  const advanced = h.current();
  assert.equal(advanced.execution.generation, before.generation + 1);
  assert.equal(advanced.execution.noProgressRemaining, advanced.execution.noProgressLimit);
  assert.equal(advanced.execution.totalRemaining, advanced.execution.totalLimit);
  assert.equal(advanced.memory.revision, 0, "the next step starts with empty memory");
  assert.equal(advanced.memory.proved.length, 0);
  assert.equal(typeof advanced.isolationCutoff, "number", "the isolation boundary is persisted");

  // Replay of the SAME tool-call id is idempotent: acknowledged, no advance.
  const replay = await h.updateGoal({
    status: "complete",
    ...before,
    evidence: [h.evidence(h.criterionIds(0))],
  }, "terminal-a");
  assert.equal(replay.ok !== false, true, "a replayed completion stays acknowledged");
  assert.equal(h.current().index, 1, "a replayed completion does not advance again");
  assert.equal(h.sent.length, 2, "a replay does not admit a second kickoff");

  // Two terminal calls in one response with distinct ids: the second call was
  // built for step 1, which is already complete — it is refused as stale.
  await assert.rejects(
    () => h.updateGoal({
      status: "complete",
      ...before,
      evidence: [h.evidence(h.criterionIds(0))],
    }, "terminal-b"),
    /stale|bound|step/i,
  );
  assert.equal(h.current().index, 1, "two terminal calls in one response leave the index at 1");
  assert.equal(h.sent.length, 2, "and do not admit another kickoff");
  void result;
});

test("completion does not leak next objective", async t => {
  const h = harness(t, { seed: seededGoal() });
  await h.emit("session_start");
  await h.command("resume");
  await h.deliver();

  const result = await h.updateGoal({ status: "complete", ...h.identity(), evidence: [h.evidence(h.criterionIds(0))] });
  const text = JSON.stringify(result.content);
  assert.equal(text.includes("second"), false, "the completion result must not leak the next step title");
  assert.equal(text.includes("third"), false, "the completion result must not leak any later step title");
  assert.match(text, /1\/3/, "the result acknowledges the OLD step by position");
  assert.match(text, /complete/i);
  assert.equal(h.current().index, 1, "sanity: the accepted completion advanced one step");
});

test("missing evidence and human-decision block complete", async t => {
  // --- missing, nonexistent, stale, and unassociated evidence refuse completion.
  const h = harness(t, { seed: seededGoal() });
  await h.emit("session_start");
  await h.command("resume");
  await h.deliver();
  const identity = h.identity();

  await assert.rejects(
    () => h.updateGoal({ status: "complete", ...identity }),
    /evidence|coverage/i,
    "completion without evidence is refused",
  );
  assert.equal(h.current().index, 0);

  await assert.rejects(
    () => h.updateGoal({
      status: "complete",
      ...identity,
      evidence: [{ operation: "edit", artifact: "src/missing.ts", fingerprint: sha16("x"), criteria: h.criterionIds(0) }],
    }),
    /exist|artifact/i,
    "evidence referencing a nonexistent artifact is refused",
  );

  const stale = h.evidence(h.criterionIds(0), "src/fix.ts", "original content\n");
  writeFileSync(join("src", "fix.ts"), "changed after the fingerprint was taken\n");
  await assert.rejects(
    () => h.updateGoal({ status: "complete", ...identity, evidence: [stale] }),
    /fingerprint|stale/i,
    "stale evidence (fingerprint no longer matches) is refused",
  );
  assert.equal(h.current().index, 0);

  await assert.rejects(
    () => h.updateGoal({
      status: "complete",
      ...identity,
      evidence: [h.evidence(["no-such-criterion"])],
    }),
    /criterion/i,
    "evidence not associated with a current criterion is refused",
  );

  // Valid evidence on every criterion completes the step.
  await h.updateGoal({ status: "complete", ...identity, evidence: [h.evidence(h.criterionIds(0))] });
  assert.equal(h.current().index, 1, "sanity: covered criteria complete the step");

  // --- a requiresHumanDecision criterion leaves the step blocked.
  const hd = harness(t, { seed: seededHumanDecisionGoal() });
  await hd.emit("session_start");
  await hd.command("resume");
  await hd.deliver();
  const hdMemory = JSON.parse(JSON.stringify(hd.current().memory));
  await assert.rejects(
    () => hd.updateGoal({
      status: "complete",
      ...hd.identity(),
      evidence: [hd.evidence(["c-normal"], "src/analysis.md", "the analysis\n")],
    }),
    /human decision/i,
    "a human-decision criterion cannot be completed from agent evidence",
  );
  assert.equal(hd.current().index, 0, "the step does not advance");
  assert.equal(hd.current().status, "active");
  assert.deepEqual(hd.current().memory, hdMemory, "a refused completion preserves memory");

  // The way out is the explicit blocked path, which preserves memory too.
  await hd.block();
  assert.equal(hd.current().status, "blocked");
  assert.deepEqual(hd.current().memory, hdMemory, "blocking preserves the current memory");
});

test("next context is clean or kickoff is withheld", async t => {
  const isolationProven = contextFilterRecordedPass();
  const h = harness(t, { seed: seededGoal() });
  await h.emit("session_start");
  await h.command("resume");
  assert.equal(h.sent.length, 1);
  await h.deliver();

  // Old-step working memory that must never reach the next step's context.
  const identity = h.identity();
  await h.memory({ ...identity, proved: ["old-memory-note-from-step-one"], unresolved: [], next: "old-next-action" });
  assert.equal(h.current().memory.revision, 1, "sanity: old memory recorded");

  await h.updateGoal({
    status: "complete",
    ...identity,
    evidence: [h.evidence(h.criterionIds(0))],
    handoff: "handoff-fact: pin applied in lockfile v2",
  });

  if (!isolationProven) {
    // Isolation unavailable: never run the next step inside the old transcript.
    assert.equal(h.sent.length, 1, "no next kickoff may be admitted without proven isolation");
    assert.match(h.goalStatus(), /Status: paused/, "execution stays paused");
    assert.match(h.goalStatus(), /Paused: .+/, "with a visible reason");
    return;
  }

  // Isolation is proven (Task 1 probe 3): exactly one kickoff for the next step.
  assert.equal(h.sent.length, 2, "an accepted completion admits exactly one kickoff");
  const cutoff = h.current().isolationCutoff;
  assert.equal(typeof cutoff, "number", "the isolation boundary is persisted");

  // The provider-visible transcript as the host would assemble it: the old
  // step's conversation, a sentinel planted in the old step, the old-step tool
  // acknowledgement, and the new kickoff after the boundary.
  const asCustom = (sent: { message: any }, timestamp: number) => ({
    role: "custom",
    customType: sent.message.customType,
    content: sent.message.content,
    display: sent.message.display,
    details: sent.message.details,
    timestamp,
  });
  const transcript = [
    { role: "user", content: "please start with the first step", timestamp: 1000 },
    asCustom(h.sent[0]!, 1500),
    { role: "user", content: "PREVIOUS_STEP_TRANSCRIPT_SENTINEL", timestamp: 1600 },
    { role: "assistant", content: [{ type: "text", text: "working on step one PREVIOUS_STEP_TRANSCRIPT_SENTINEL" }], timestamp: 1700 },
    { role: "toolResult", toolCallId: "terminal-1", content: [{ type: "text", text: "Stage 1/3 complete." }], timestamp: cutoff + 100 },
    asCustom(h.sent[1]!, cutoff + 200),
  ];
  const filtered = await h.context(transcript);
  assert.ok(filtered && Array.isArray(filtered.messages), "the extension filters the provider-visible list");
  const visible = JSON.stringify(filtered.messages);
  assert.equal(visible.includes("PREVIOUS_STEP_TRANSCRIPT_SENTINEL"), false, "no previous-step transcript");
  assert.equal(visible.includes("old-memory-note-from-step-one"), false, "no old memory");
  assert.equal(visible.includes("old-next-action"), false, "no old next action");
  assert.equal(visible.includes('"first"') || visible.includes(">first<"), false, "no other step titles");
  assert.equal(visible.includes("third"), false, "no other step titles");
  assert.ok(visible.includes("second"), "the next step's own objective is visible");
  assert.ok(visible.includes("handoff-fact: pin applied in lockfile v2"), "the explicit minimal factual handoff is allowed through");
  assert.match(visible, /revision=\\?"0\\?"/, "the next step starts with empty step memory");

  // Restart resumes the sequence exactly once: the transition state (next step,
  // fresh grant, isolation boundary) is persisted; the resumed session sends
  // one kickoff into a clean context.
  const reloaded = harness(t, { seed: h.branchSnapshot() });
  await reloaded.emit("session_start");
  assert.equal(reloaded.current().index, 1, "the restart restores the advanced step");
  assert.equal(reloaded.current().isolationCutoff, cutoff, "the isolation boundary survives restart");
  assert.match(reloaded.goalStatus(), /Status: paused/);
  await reloaded.command("resume");
  assert.equal(reloaded.sent.length, 1, "the sequence resumes with exactly one kickoff");
  const resumed = await reloaded.context([
    { role: "user", content: "PREVIOUS_STEP_TRANSCRIPT_SENTINEL", timestamp: 1000 },
    asCustom(reloaded.sent[0]!, cutoff + 300),
  ]);
  const resumedVisible = JSON.stringify(resumed?.messages ?? []);
  assert.equal(resumedVisible.includes("PREVIOUS_STEP_TRANSCRIPT_SENTINEL"), false);
  assert.ok(resumedVisible.includes("second"), "the resumed kickoff is the new step's snapshot");
});
