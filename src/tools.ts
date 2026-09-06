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

export interface ToolHost {
  getGoal(): MultiGoal | null;
  completeStage(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  blockGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
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
