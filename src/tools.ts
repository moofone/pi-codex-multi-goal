import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { currentStage } from "./state.js";
import type { GoalEntrySource, GoalResult, MultiGoal } from "./types.js";

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: "complete = this stage is done (harness advances). blocked = this stage cannot proceed.",
  }),
});

export interface MemoryUpdateInput {
  goalId: string;
  step: number;
  generation: number;
  revision: number;
  proved: string[];
  unresolved: string[];
  next: string;
}

export interface ToolHost {
  getGoal(): MultiGoal | null;
  completeStage(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  blockGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  updateMemory(input: MemoryUpdateInput, ctx: ExtensionContext): GoalResult;
}

const UpdateGoalMemoryParams = Type.Object({
  goalId: Type.String({
    description: "The goal attribute of the current <goal> snapshot's memory block.",
  }),
  step: Type.Integer({
    description: "The step attribute of the memory block (the k in the snapshot's stage k/n).",
  }),
  generation: Type.Integer({
    description: "The generation attribute of the memory block.",
  }),
  revision: Type.Integer({
    description:
      "The revision attribute you last saw on the memory block. A stale revision is rejected; re-read the snapshot.",
  }),
  proved: Type.Array(Type.String(), {
    description:
      "Concise findings tied to evidence. Each entry references an artifact, operation, revision, or fingerprint — never a raw log. Placement here is your claim.",
  }),
  unresolved: Type.Array(Type.String(), {
    description: "Open questions, blockers, and failed approaches, with what would justify revisiting them.",
  }),
  next: Type.String({
    description: "The next concrete action toward the human-defined success criteria.",
  }),
});

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  // Registered before update_goal so hosts/harnesses that capture a single
  // "goal tool" keep observing the terminal tool; both registrations are live.
  pi.registerTool({
    name: "update_goal_memory",
    label: "Update Goal Memory",
    description:
      "Replace the bounded working-memory record of the CURRENT goal stage, using the goal/step/generation/revision identity from the <goal> snapshot. One record per stage: proved findings (your claims, as short evidence references), unresolved questions, and the next concrete action. The whole record is capped at 8192 UTF-8 JSON bytes. Memory updates never change success criteria, never advance the stage, and never restore allowance — a memory-only loop still consumes no-progress.",
    parameters: UpdateGoalMemoryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = host.updateMemory(params, ctx);
      if (!result.ok || !result.goal) {
        throw new Error(result.message);
      }
      const stage = `${result.goal.index + 1}/${result.goal.stages.length}`;
      // Minimal acknowledgement: never echo the contract, the memory
      // contents, or the next action (A06).
      const text = JSON.stringify(
        {
          recorded: true,
          stage,
          memoryRevision: result.goal.memory.revision,
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details: { stage, memoryRevision: result.goal.memory.revision },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Only call this if you are currently working inside an active <goal> message. complete finishes THIS stage only. blocked stops this stage.",
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result =
        params.status === "complete"
          ? host.completeStage("tool", ctx)
          : host.blockGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throw new Error(result.message);
      }
      const stage = currentStage(result.goal);
      const text = JSON.stringify(
        {
          status: result.goal.status,
          stage: `${result.goal.index + 1}/${result.goal.stages.length}`,
          current: stage.title,
          message: result.message,
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details: { status: result.goal.status, index: result.goal.index },
      };
    },
  });
}
