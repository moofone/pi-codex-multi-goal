import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// F09: Pi's ExtensionUIContext.setStatus takes (key, text). The extension must
// register its footer status under the stable CUSTOM_ENTRY_TYPE key and clear
// it with (CUSTOM_ENTRY_TYPE, undefined). Passing the display text as the only
// argument makes it the key and leaves the text undefined. Mirrors the
// controlled host harness from qa/runtime.test.ts.

function harness(t: any, titles: string[] | null = ["first", "second", "third"]) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-status-"));
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator", "repo", "feature"), { recursive: true });

  const entries: any[] = titles
    ? [{ type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(createGoal(titles), "command") }]
    : [];
  const statuses: unknown[][] = [];
  const handlers = new Map<string, any>();
  const ctx: any = {
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    sessionManager: {
      getSessionId: () => "status-qa-session",
      getSessionFile: () => "/qa/status-session.jsonl",
      getEntries: () => entries,
      getBranch: () => entries,
    },
    ui: {
      setStatus: (...args: unknown[]) => { statuses.push(args); },
      notify: () => {},
    },
  };
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage: () => {},
  };
  registerMultiGoal(pi);
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  t.after(async () => {
    await emit("session_shutdown");
    if (oldAgent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = oldAgent;
    if (oldOrchestrator === undefined) delete process.env.PI_ORCHESTRATOR_ROOT; else process.env.PI_ORCHESTRATOR_ROOT = oldOrchestrator;
    rmSync(root, { recursive: true, force: true });
  });
  return { emit, statuses };
}

test("status uses the Pi key/text signature", async t => {
  const h = harness(t);
  await h.emit("session_start");
  assert.ok(h.statuses.length > 0, "session_start must set the footer status");
  assert.deepEqual(h.statuses.at(-1), [CUSTOM_ENTRY_TYPE, "Pursuing 1/3"]);
  for (const call of h.statuses) {
    assert.equal(call.length, 2, "setStatus must be called with a key and a text argument");
    assert.equal(call[0], CUSTOM_ENTRY_TYPE, "the status key must be CUSTOM_ENTRY_TYPE, not display text");
  }
});

test("status clears with the key and undefined text when no goal is set", async t => {
  const h = harness(t, null);
  await h.emit("session_start");
  assert.ok(h.statuses.length > 0, "session_start must set (or clear) the footer status");
  assert.deepEqual(h.statuses.at(-1), [CUSTOM_ENTRY_TYPE, undefined]);
  for (const call of h.statuses) {
    assert.equal(call[0], CUSTOM_ENTRY_TYPE, "even the clear call must use the CUSTOM_ENTRY_TYPE key");
  }
});
