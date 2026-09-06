import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// Deliberately separate from the existing suite: these assert the architecture
// contract and are expected to fail until the documented findings are fixed.
// The extension is real; Pi events, message delivery, and UI are controlled.
function harness(t: any, titles = ["first", "second", "third"]) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-qa-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  const statusPath = join(root, "orchestrator", "repo", "feature", "status.md");
  mkdirSync(join(root, "orchestrator", "repo", "feature"), { recursive: true });
  const entries: any[] = [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(createGoal(titles), "command") }];
  let branch = entries.slice();
  let handlers = new Map<string, any>();
  let commands = new Map<string, any>();
  let goalTool: any;
  const sent: any[] = [];
  const pending: any[] = [];
  const statuses: any[][] = [];
  let aborted = 0;
  let idle = true;
  const ctx: any = {
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => pending.length > 0,
    abort: () => { aborted++; pending.length = 0; },
    sessionManager: {
      getSessionId: () => "qa-session",
      getSessionFile: () => "/qa/session.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: { setStatus: (...args: any[]) => statuses.push(args), notify: () => {}, confirm: async () => true },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => { goalTool = tool; },
    appendEntry: (customType: string, data: any) => {
      const entry = { type: "custom", customType, data }; entries.push(entry); branch.push(entry);
    },
    sendMessage: (message: any, options: any) => { sent.push({ message, options }); pending.push(message); },
  };
  const boot = () => { handlers = new Map(); commands = new Map(); registerMultiGoal(pi); };
  boot();
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const deliver = async () => {
    const message = pending.shift();
    await emit("message_start", { message });
    await emit("message_end", { message });
  };
  t.after(async () => {
    await emit("session_shutdown");
    if (oldAgent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldAgent;
    if (oldOrchestrator === undefined) delete process.env.PI_ORCHESTRATOR_ROOT; else process.env.PI_ORCHESTRATOR_ROOT = oldOrchestrator;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    emit, deliver, sent, pending, statuses, entries, boot,
    current: () => entries.at(-1)?.data.goal,
    command: (text: string) => commands.get("goal").handler(text, ctx),
    complete: (id = "same-completion") => goalTool.execute(id, { status: "complete" }, new AbortController().signal, undefined, ctx),
    compact: () => emit("session_compact", { reason: "threshold", willRetry: false }),
    own: (phase: string) => writeFileSync(statusPath, `phase: ${phase}\nparent_session_id: qa-session\n`),
    branch: (value: any[]) => { branch = value; },
    aborted: () => aborted,
    busy: () => { idle = false; },
  };
}

test("QA-01: repeated goal turns pause without compaction", async t => {
  const h = harness(t);
  await h.emit("session_start"); await h.deliver();
  for (let i = 0; i < 100; i++) {
    await h.emit("turn_start", { turnIndex: i });
    await h.emit("tool_execution_end", { toolName: "read", isError: false, result: { content: [] } });
    await h.emit("turn_end", { turnIndex: i, message: { role: "assistant" }, toolResults: [] });
  }
  assert.equal(h.current().status, "paused", "100 no-progress turns must not remain active");
});

test("QA-02: delivered kickoff permits a later boundary continuation", async t => {
  const h = harness(t);
  await h.emit("session_start"); await h.deliver(); await h.compact();
  assert.equal(h.sent.length, 2);
});

test("control: deferred kickoff is delivered once when orchestrate releases ownership", async t => {
  const h = harness(t); h.own("implementing");
  await h.emit("session_start"); assert.equal(h.sent.length, 0);
  h.own("done"); await h.emit("agent_end", { messages: [] });
  assert.equal(h.sent.length, 1);
  await h.emit("agent_end", { messages: [] }); assert.equal(h.sent.length, 1);
});

test("QA-04: repeated completion ID cannot finish the next step", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  await h.complete(); await h.complete();
  assert.equal(h.current().index, 1);
});

test("QA-05: completion does not expose the next objective in the old tool result", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  const result = await h.complete();
  assert.equal(JSON.stringify(result.content).includes("second"), false);
});

test("QA-06: pause withdraws already submitted goal follow-up", async t => {
  const h = harness(t); await h.emit("session_start");
  assert.equal(h.pending.length, 1); await h.command("pause");
  assert.equal(h.current().status, "paused");
  assert.equal(h.pending.length, 0);
});

test("QA-07: pause stops goal execution", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  h.busy(); await h.emit("turn_start", { turnIndex: 0 }); await h.command("pause");
  assert.equal(h.aborted(), 1);
});

test("QA-08: reload preserves partially consumed stall allowance", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  for (let i = 0; i < 4; i++) await h.compact();
  await h.emit("session_shutdown"); h.boot(); await h.emit("session_start"); await h.deliver();
  await h.compact(); assert.equal(h.current().status, "paused");
});

test("QA-09: orchestrate compactions do not spend the goal allowance", async t => {
  const h = harness(t); h.own("implementing"); await h.emit("session_start");
  for (let i = 0; i < 5; i++) await h.compact();
  assert.equal(h.current().status, "active");
});

test("QA-10: orchestrate ownership prevents goal step transitions", async t => {
  const h = harness(t); h.own("implementing"); await h.emit("session_start");
  try { await h.complete(); } catch { /* Rejecting the call is acceptable. */ }
  assert.equal(h.current().index, 0);
});

test("QA-11: status uses the Pi key/text signature", async t => {
  const h = harness(t); await h.emit("session_start");
  assert.deepEqual(h.statuses.at(-1), [CUSTOM_ENTRY_TYPE, "Pursuing 1/3"]);
});

test("QA-12: session-tree reconstruction follows the selected branch", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  const originalBranch = h.entries.slice(); await h.complete();
  h.branch(originalBranch); await h.emit("session_tree");
  // Complete should now advance branch step 1 to step 2, not off-branch step 2 to 3.
  await h.complete("branch-completion"); assert.equal(h.current().index, 1);
});

test("QA-13: orchestrate writes do not reset the goal stall streak", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  for (let i = 0; i < 4; i++) await h.compact();
  h.own("implementing"); await h.emit("tool_execution_end", { toolName: "write", isError: false });
  h.own("done"); await h.compact(); assert.equal(h.current().status, "paused");
});

test("QA-14: next-step model context excludes previous-step transcript", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  const session = SessionManager.inMemory("/qa");
  const appendSent = (item: any) => session.appendCustomMessageEntry(
    item.message.customType, item.message.content, item.message.display, item.message.details,
  );
  appendSent(h.sent[0]);
  session.appendMessage({ role: "user", content: "PREVIOUS_STEP_TRANSCRIPT_SENTINEL", timestamp: Date.now() });
  await h.complete(); appendSent(h.sent[1]);
  assert.equal(JSON.stringify(session.buildSessionContext().messages).includes("PREVIOUS_STEP_TRANSCRIPT_SENTINEL"), false);
});

test("control: normal completion advances exactly one step", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  await h.complete(); assert.equal(h.current().index, 1); assert.equal(h.current().status, "active");
});

test("control: five sterile compactions pause without reload", async t => {
  const h = harness(t); await h.emit("session_start"); await h.deliver();
  for (let i = 0; i < 5; i++) await h.compact();
  assert.equal(h.current().status, "paused");
});
