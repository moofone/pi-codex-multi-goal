import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { handleGoalCommand, type CommandHost } from "../src/commands.ts";
import { createGoal, goalsEquivalent, setGoalStatus } from "../src/state.ts";
import type { GoalContinuationKind, GoalEntrySource, MultiGoal } from "../src/types.ts";

interface TestHost extends CommandHost {
  goal: MultiGoal | null;
  setCalls: Array<{ goal: MultiGoal; source: GoalEntrySource }>;
  clearCalls: Array<GoalEntrySource | null>;
  continuations: GoalContinuationKind[];
}

function makeHost(goal: MultiGoal | null = null): TestHost {
  const host: TestHost = {
    goal,
    setCalls: [],
    clearCalls: [],
    continuations: [],
    getGoal() {
      return this.goal;
    },
    setGoal(next: MultiGoal, source: GoalEntrySource) {
      this.goal = next;
      this.setCalls.push({ goal: next, source });
    },
    clearGoal(source: GoalEntrySource) {
      this.goal = null;
      this.clearCalls.push(source);
    },
    requestContinuation(_ctx: ExtensionCommandContext, kind: GoalContinuationKind = "continuation") {
      this.continuations.push(kind);
      return true;
    },
  };
  return host;
}

function makeCtx(options: { hasUI: boolean; inputs?: Array<string | undefined>; confirms?: boolean[] }): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; level?: string }>;
  confirmCalls: Array<{ title: string; message: string }>;
  inputPrompts: string[];
} {
  const notifications: Array<{ message: string; level?: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const inputPrompts: string[] = [];
  const ctx = {
    hasUI: options.hasUI,
    ui: {
      async input(prompt: string, _preset?: string) {
        inputPrompts.push(prompt);
        return options.inputs?.shift();
      },
      async confirm(title: string, message: string) {
        confirmCalls.push({ title, message });
        return options.confirms?.shift() ?? false;
      },
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifications, confirmCalls, inputPrompts };
}

test("headless start requires JSON contract", async () => {
  // Plain text with hasUI: false does not start a goal.
  const plain = makeHost();
  await handleGoalCommand(plain, "pin the duplicate", makeCtx({ hasUI: false }).ctx);
  assert.equal(plain.setCalls.length, 0);
  assert.equal(plain.continuations.length, 0);
  assert.equal(plain.goal, null);

  // Not JSON at all does not start.
  const notJson = makeHost();
  await handleGoalCommand(notJson, "{objective: pin the duplicate}", makeCtx({ hasUI: false }).ctx);
  assert.equal(notJson.setCalls.length, 0);

  // JSON missing criteria does not start.
  const missingCriteria = makeHost();
  await handleGoalCommand(
    missingCriteria,
    JSON.stringify({ objective: "pin the duplicate" }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(missingCriteria.setCalls.length, 0);

  // Empty criteria does not start.
  const emptyCriteria = makeHost();
  await handleGoalCommand(
    emptyCriteria,
    JSON.stringify({ objective: "pin the duplicate", criteria: [] }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(emptyCriteria.setCalls.length, 0);

  // A blank criterion is not accepted criteria.
  const blankCriterion = makeHost();
  await handleGoalCommand(
    blankCriterion,
    JSON.stringify({ objective: "x", criteria: ["   "] }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(blankCriterion.setCalls.length, 0);

  // Steps without top-level criteria do not start (criteria always required).
  const stepsOnly = makeHost();
  await handleGoalCommand(
    stepsOnly,
    JSON.stringify({ objective: "overall", steps: [{ objective: "s1", criteria: ["c1"] }] }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(stepsOnly.setCalls.length, 0);

  // A step with empty criteria does not start.
  const emptyStepCriteria = makeHost();
  await handleGoalCommand(
    emptyStepCriteria,
    JSON.stringify({
      objective: "overall",
      criteria: ["c0"],
      steps: [
        { objective: "s1", criteria: ["c1"] },
        { objective: "s2", criteria: [] },
      ],
    }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(emptyStepCriteria.setCalls.length, 0);

  // Valid single-step JSON starts.
  const valid = makeHost();
  await handleGoalCommand(
    valid,
    JSON.stringify({ objective: "pin the duplicate", criteria: ["no duplicate pin"] }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(valid.setCalls.length, 1);
  const started = valid.setCalls[0]!.goal;
  assert.equal(started.status, "active");
  assert.equal(started.stages.length, 1);
  assert.equal(started.stages[0]!.title, "pin the duplicate");
  assert.deepEqual(
    started.stages[0]!.criteria.map((criterion) => criterion.text),
    ["no duplicate pin"],
  );
  assert.deepEqual(valid.continuations, ["command_start"]);

  // Valid multi-step JSON starts the whole sequence.
  const multi = makeHost();
  await handleGoalCommand(
    multi,
    JSON.stringify({
      objective: "ship the fix",
      criteria: ["release notes updated"],
      steps: [
        { objective: "write red test", criteria: ["failing test committed"] },
        { objective: "fix miner", criteria: ["test passes"] },
      ],
    }),
    makeCtx({ hasUI: false }).ctx,
  );
  assert.equal(multi.setCalls.length, 1);
  assert.deepEqual(
    multi.setCalls[0]!.goal.stages.map((stage) => stage.title),
    ["write red test", "fix miner"],
  );
  assert.ok(multi.setCalls[0]!.goal.stages.every((stage) => stage.criteria.length > 0));

  // TUI: blank criteria still requires the contract confirm; accepting it is
  // explicit acceptance of the objective as the sole criterion.
  const tui = makeHost();
  const tuiCtx = makeCtx({ hasUI: true, inputs: [""], confirms: [true] });
  await handleGoalCommand(tui, "pin the duplicate", tuiCtx.ctx);
  assert.equal(tui.setCalls.length, 1);
  assert.equal(tuiCtx.confirmCalls.length, 1);
  assert.match(tuiCtx.confirmCalls[0]!.message, /pin the duplicate/);
  assert.deepEqual(
    tui.setCalls[0]!.goal.stages[0]!.criteria.map((criterion) => criterion.text),
    ["pin the duplicate"],
  );

  // TUI: declining the contract confirm does not start.
  const declined = makeHost();
  await handleGoalCommand(declined, "pin the duplicate", makeCtx({ hasUI: true, inputs: [""], confirms: [false] }).ctx);
  assert.equal(declined.setCalls.length, 0);

  // Cancelling setup leaves an existing goal untouched.
  const existing = createGoal(["existing goal"], 1);
  const cancelled = makeHost(existing);
  await handleGoalCommand(cancelled, "replacement objective", makeCtx({ hasUI: true, inputs: [undefined] }).ctx);
  assert.equal(cancelled.setCalls.length, 0);
  assert.ok(cancelled.goal !== null && goalsEquivalent(cancelled.goal, existing));

  // Declining either confirm of a replacement leaves the goal untouched.
  const declinedReplace = makeHost(existing);
  await handleGoalCommand(
    declinedReplace,
    "replacement objective",
    makeCtx({ hasUI: true, inputs: [""], confirms: [true, false] }).ctx,
  );
  assert.equal(declinedReplace.setCalls.length, 0);
  assert.ok(declinedReplace.goal !== null && goalsEquivalent(declinedReplace.goal, existing));

  // Accepting both confirms of a replacement starts with the entered criteria.
  const replaced = makeHost(existing);
  await handleGoalCommand(
    replaced,
    "replacement objective",
    makeCtx({ hasUI: true, inputs: ["clean criterion", ""], confirms: [true, true] }).ctx,
  );
  assert.equal(replaced.setCalls.length, 1);
  assert.equal(
    replaced.setCalls[0]!.goal.stages[0]!.criteria[0]!.text,
    "clean criterion",
  );
});

test("/goal resume never asks for criteria", async () => {
  const paused = setGoalStatus(createGoal(["ship the fix"], 1), "paused").goal!;
  const host = makeHost(paused);
  const ui = makeCtx({
    hasUI: true,
    inputs: ["should never be read", ""],
    confirms: [true, true],
  });

  await handleGoalCommand(host, "resume", ui.ctx);

  assert.deepEqual(ui.inputPrompts, [], "resume must not open the criteria wizard");
  assert.equal(ui.confirmCalls.length, 0, "resume must not confirm a new contract");
  assert.equal(host.setCalls.length, 1);
  assert.equal(host.setCalls[0]!.goal.status, "active");
  assert.equal(host.setCalls[0]!.goal.stages[0]!.title, "ship the fix");
  assert.deepEqual(host.continuations, ["command_resume"]);
  assert.match(ui.notifications.at(-1)?.message ?? "", /resumed/i);

  // Case and surrounding whitespace still resume; extra tokens are usage, not a new objective.
  const again = makeHost(setGoalStatus(createGoal(["keep going"], 1), "paused").goal!);
  const caps = makeCtx({ hasUI: true, inputs: ["hijack"], confirms: [true] });
  await handleGoalCommand(again, "  Resume  ", caps.ctx);
  assert.deepEqual(caps.inputPrompts, []);
  assert.equal(again.setCalls[0]!.goal.status, "active");

  const extra = makeHost(paused);
  const extraUi = makeCtx({ hasUI: true, inputs: ["hijack"], confirms: [true] });
  await handleGoalCommand(extra, "resume now", extraUi.ctx);
  assert.deepEqual(extraUi.inputPrompts, []);
  assert.equal(extra.setCalls.length, 0);
  assert.match(extraUi.notifications.at(-1)?.message ?? "", /Usage: \/goal resume/);
});
