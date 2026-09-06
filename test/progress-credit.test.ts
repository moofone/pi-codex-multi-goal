import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerMultiGoal } from "../src/runtime.ts";
import { createGoal, setEntry } from "../src/state.ts";
import { CUSTOM_ENTRY_TYPE } from "../src/types.ts";

// Task 8 verified mid-step progress credit, on the SAME evidence-validation
// path completion uses (reference exists, producing operation, fingerprint,
// criterion association, not already credited).
//
// Proven here (invariant 1 / A02 no bogus credit):
//   - one coding fixture and one read-only investigation fixture each reset
//     noProgressRemaining to the grant limit exactly once per novel verified
//     evidence ref;
//   - repeating the same evidence never resets again, including after the
//     artifact toggles invalid -> valid again;
//   - a passing check resets ONLY the no-progress streak: totalRemaining and
//     lifetimeRequests are untouched;
//   - identical memory content carrying one NOVEL verified evidence ref still
//     credits exactly once — credit rides the evidence path, not a memory
//     rewrite, so the unchanged-memory short-circuit must not swallow it;
//   - memory rewrites, successful tool exits, and bare edit/write/apply_patch
//     operation names still earn nothing without a verifying evidence ref.

const sha16 = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);

const here = dirname(fileURLToPath(import.meta.url));

function harness(t: any) {
  const root = mkdtempSync(join(tmpdir(), "multi-goal-credit-"));
  const previousCwd = process.cwd();
  const oldAgent = process.env.PI_AGENT_DIR;
  const oldOrchestrator = process.env.PI_ORCHESTRATOR_ROOT;
  process.env.PI_AGENT_DIR = root;
  process.env.PI_ORCHESTRATOR_ROOT = join(root, "orchestrator");
  mkdirSync(join(root, "orchestrator"), { recursive: true });
  writeFileSync(join(root, "pi-codex-multi-goal.json"), JSON.stringify({}));
  // Evidence artifacts resolve against the working directory of the pi
  // process; the harness chdirs into its own root.
  process.chdir(root);

  const seed = [
    {
      type: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      data: setEntry(createGoal(["collect evidence", "second step", "third step"]), "command"),
    },
  ];
  const branch: any[] = [...seed];
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
      getSessionId: () => "credit-session",
      getSessionFile: () => "/qa/credit-session.jsonl",
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
    command: (text: string) => commands.get("goal").handler(text, ctx),
    goalStatus: () => {
      commands.get("goal").handler("", ctx);
      return lastNotified ?? "";
    },
    /** The tool acknowledgement as a parsed object. */
    ack: (result: any) => JSON.parse(result.content[0].text),
    memory: (params: any, id = "memory-call") =>
      tools.get("update_goal_memory").execute(id, params, new AbortController().signal, undefined, ctx),
    identity: () => {
      const goal = h.current();
      return { goalId: goal.goalId, step: goal.index + 1, generation: goal.execution.generation, revision: goal.memory.revision };
    },
    criterionId: (stepIndex = 0) => h.current().stages[stepIndex].criteria[0].id,
    /** A well-formed evidence ref backed by a real artifact file. */
    evidenceRef: (artifact: string, content: string, operation: string, criteria?: string[]) => {
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, content);
      return { operation, artifact, fingerprint: sha16(content), criteria: criteria ?? [h.criterionId(0)] };
    },
    providerRequest: () =>
      emit("before_provider_request", {
        payload: { model: "fake-model", messages: [{ role: "user", content: "<goal>turn</goal>" }], tools: [] },
      }),
    spend: async (requests: number) => {
      for (let i = 0; i < requests; i += 1) await h.providerRequest();
    },
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
    current: () => entries.at(-1)?.data.goal,
  };
  return h;
}

test("verified evidence resets no-progress once", async t => {
  const h = harness(t);
  await h.emit("session_start");
  await h.command("resume");
  assert.match(h.goalStatus(), /Status: active/);
  const grantLimit = h.current().execution.noProgressLimit;
  assert.equal(grantLimit, 20, "sanity: the default grant limit");

  // Spend three no-progress requests: 17/20, 197/200, 3 lifetime.
  await h.spend(3);
  assert.deepEqual(h.counters(), { noProgressRemaining: 17, totalRemaining: 197, lifetimeRequests: 3 });

  // A memory rewrite without evidence is a successful tool exit that changes
  // memory text — it must not reset the streak.
  const first = await h.memory({
    ...h.identity(),
    proved: ["proved: mirror configured (artifact: docs/finding.md)"],
    unresolved: [],
    next: "verify the mirror",
  });
  assert.equal(first.ok !== false, true, "the memory rewrite itself succeeds");
  assert.deepEqual(
    h.counters(),
    { noProgressRemaining: 17, totalRemaining: 197, lifetimeRequests: 3 },
    "a memory rewrite resets nothing",
  );

  // --- identical memory plus one NOVEL verified evidence ref must still
  // credit once: the unchanged-memory short-circuit must not skip evidence
  // validation when evidence is attached (credit is not a memory rewrite).
  const identicalMemory = {
    proved: ["proved: mirror configured (artifact: docs/finding.md)"],
    unresolved: [],
    next: "verify the mirror",
  };
  const revisionAfterFirst = h.identity().revision;
  const identicalEvidence = h.evidenceRef("qa/identical-note.md", "identical memory, novel evidence\n", "read");
  const identical = await h.memory({ ...h.identity(), ...identicalMemory, evidence: [identicalEvidence] });
  assert.equal(identical.ok !== false, true, "identical memory with verified evidence is accepted");
  assert.equal(h.ack(identical).credited, 1, "novel evidence on identical memory still credits once");
  assert.equal(h.counters()!.noProgressRemaining, grantLimit, "the credit resets the no-progress streak");
  assert.equal(h.counters()!.totalRemaining, 197, "the credit never refills the total allowance");
  assert.equal(h.counters()!.lifetimeRequests, 3, "the credit never touches lifetime requests");
  assert.equal(h.identity().revision, revisionAfterFirst, "crediting identical memory does not bump the revision");

  // Repeating that same evidence on the same identical memory: no second credit.
  const repeatIdentical = await h.memory({ ...h.identity(), ...identicalMemory, evidence: [identicalEvidence] });
  assert.equal(h.ack(repeatIdentical).credited, 0, "the same evidence on identical memory never credits twice");
  assert.deepEqual(
    h.counters(),
    { noProgressRemaining: grantLimit, totalRemaining: 197, lifetimeRequests: 3 },
    "the repeat neither resets nor refills anything",
  );
  assert.equal(h.identity().revision, revisionAfterFirst, "the repeat still does not bump the revision");

  // --- coding fixture: one novel verified evidence ref resets the streak once.
  const coding = h.evidenceRef("src/fix.ts", "the duplicate is pinned\n", "edit");
  const credited = await h.memory({
    ...h.identity(),
    proved: ["proved: duplicate pinned (artifact: src/fix.ts)"],
    unresolved: [],
    next: "run the install check",
    evidence: [coding],
  });
  assert.equal(credited.ok !== false, true, "verified evidence is accepted");
  assert.equal(h.ack(credited).credited, 1, "the acknowledgement reports the credit");
  assert.equal(h.counters()!.noProgressRemaining, grantLimit, "verified evidence resets the no-progress streak");
  assert.equal(h.counters()!.totalRemaining, 197, "a passing check never refills the total allowance");
  assert.equal(h.counters()!.lifetimeRequests, 3, "a passing check never zeroes lifetime requests");

  // Spend two, then repeat the SAME evidence: no second reset.
  await h.spend(2);
  assert.equal(h.counters()!.noProgressRemaining, grantLimit - 2);
  const repeated = await h.memory({
    ...h.identity(),
    proved: ["proved: duplicate pinned (artifact: src/fix.ts)"],
    unresolved: [],
    next: "run the install check again",
    evidence: [coding],
  });
  assert.equal(h.ack(repeated).credited, 0, "repeating the same evidence credits nothing");
  assert.equal(h.counters()!.noProgressRemaining, grantLimit - 2, "the same evidence never resets twice");

  // Pass/fail toggling of the same artifact: invalid again, then valid again —
  // still only the original credit.
  writeFileSync("src/fix.ts", "changed after crediting\n");
  await assert.rejects(
    () => h.memory({
      ...h.identity(),
      proved: ["proved: changed"],
      unresolved: [],
      next: "n",
      evidence: [coding],
    }),
    /fingerprint|stale/i,
    "the toggled-invalid ref is refused",
  );
  writeFileSync("src/fix.ts", "the duplicate is pinned\n");
  const toggledBack = await h.memory({
    ...h.identity(),
    proved: ["proved: duplicate pinned again"],
    unresolved: [],
    next: "n",
    evidence: [coding],
  });
  assert.equal(h.ack(toggledBack).credited, 0, "the restored ref is already credited");
  assert.equal(h.counters()!.noProgressRemaining, grantLimit - 2, "toggling the same evidence never refills again");

  // --- read-only investigation fixture: the same evidence path applies.
  await h.spend(3);
  assert.equal(h.counters()!.noProgressRemaining, grantLimit - 5);
  const investigation = h.evidenceRef("docs/finding.md", "registry mirror eu-central is authoritative\n", "read");
  const investigate = await h.memory({
    ...h.identity(),
    proved: ["proved: mirror identified (artifact: docs/finding.md)"],
    unresolved: [],
    next: "compare lockfile against the mirror",
    evidence: [investigation],
  });
  assert.equal(h.ack(investigate).credited, 1, "the investigation fixture earns its credit");
  assert.equal(h.counters()!.noProgressRemaining, grantLimit, "the investigation evidence resets the streak");
  assert.equal(h.counters()!.totalRemaining, 192, "the total allowance is still untouched by credits");
  assert.equal(h.counters()!.lifetimeRequests, 8, "lifetime requests are still untouched by credits");

  // --- bare names and unverifiable refs still earn nothing.
  const before = h.counters();
  for (const bad of [
    // bookkeeping tool name as the producing operation
    { ...h.evidenceRef("docs/finding.md", "registry mirror eu-central is authoritative\n", "update_goal") },
    // nonexistent artifact behind a real tool name
    { operation: "apply_patch", artifact: "src/never-written.ts", fingerprint: sha16("x"), criteria: [h.criterionId(0)] },
    // real artifact, wrong fingerprint
    { ...investigation, fingerprint: sha16("not the content") },
    // criterion from another step
    { ...investigation, criteria: [h.criterionId(1)] },
  ]) {
    await assert.rejects(
      () => h.memory({ ...h.identity(), proved: ["proved: attempt"], unresolved: [], next: "n", evidence: [bad] }),
      /operation|exist|fingerprint|criterion/i,
      `an unverifiable ref is refused: ${JSON.stringify(bad).slice(0, 80)}`,
    );
  }
  assert.deepEqual(h.counters(), before, "none of the unverifiable attempts reset anything");

  // And the successful rewrite afterwards still does not credit.
  await h.memory({ ...h.identity(), proved: ["proved: rewrite only"], unresolved: [], next: "n" });
  assert.deepEqual(h.counters(), before, "memory text still never buys progress");
});
