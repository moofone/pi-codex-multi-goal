import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatHumanStatus } from "./prompts.js";
import { replaceGoal, replaceGoalFromTitles, setGoalStatus } from "./state.js";
import type { GoalContinuationKind, GoalEntrySource, MultiGoal } from "./types.js";
import { collectMultiGoalTitles } from "./wizard.js";

export interface CommandHost {
  getGoal(): MultiGoal | null;
  setGoal(goal: MultiGoal, source: GoalEntrySource, ctx: ExtensionCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionCommandContext): void;
  requestContinuation(ctx: ExtensionCommandContext, kind?: GoalContinuationKind): boolean;
}

const COMMANDS = ["pause", "resume", "clear"] as const;

async function confirmReplaceIfNeeded(
  host: CommandHost,
  ctx: ExtensionCommandContext,
  preview: string,
): Promise<boolean> {
  const current = host.getGoal();
  if (!current || current.status === "complete" || !ctx.hasUI) {
    return true;
  }
  const shouldReplace = await ctx.ui.confirm(
    "Replace goal?",
    `Current:\n${formatHumanStatus(current)}\n\nNew:\n${preview}`,
  );
  if (!shouldReplace) {
    ctx.ui.notify("Goal unchanged.");
    return false;
  }
  return true;
}

function startGoal(host: CommandHost, ctx: ExtensionCommandContext, titles: string[]): void {
  const result = replaceGoalFromTitles(titles);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  host.requestContinuation(ctx, "command_start");
}

export async function handleGoalCommand(
  host: CommandHost,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatHumanStatus(host.getGoal()));
    return;
  }

  if (trimmed === "clear") {
    if (!host.getGoal()) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    const status = trimmed === "pause" ? "paused" : "active";
    const result = setGoalStatus(host.getGoal(), status);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);
    ctx.ui.notify(result.message);
    if (trimmed === "resume" && result.goal.status === "active") {
      host.requestContinuation(ctx, "command_resume");
    }
    return;
  }

  const parsed = replaceGoal(trimmed);
  if (!parsed.ok || !parsed.goal) {
    ctx.ui.notify(parsed.message, "error");
    return;
  }
  const preview = parsed.goal.stages.map((stage) => stage.title).join("\n");
  if (!(await confirmReplaceIfNeeded(host, ctx, preview))) {
    return;
  }
  startGoal(host, ctx, parsed.goal.stages.map((stage) => stage.title));
}

export async function handleGoalMultiCommand(
  host: CommandHost,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const collected = await collectMultiGoalTitles(ctx.ui, { hasUI: ctx.hasUI });
  if (!collected.ok) {
    ctx.ui.notify(collected.message, collected.message.includes("cancelled") || collected.message.includes("rejected") ? "warning" : "error");
    return;
  }
  const preview = collected.titles.map((title, index) => `${index + 1}. ${title}`).join("\n");
  if (!(await confirmReplaceIfNeeded(host, ctx, preview))) {
    return;
  }
  startGoal(host, ctx, collected.titles);
}

export function registerGoalCommand(pi: ExtensionAPI, host: CommandHost): void {
  pi.registerCommand("goal", {
    description:
      "Usage: /goal [<objective>|pause|resume|clear] — Codex-style goal. Use /goal-multi for staged goals.",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trim();
      if (prefix.length === 0 || /\s/.test(argumentPrefix)) {
        return null;
      }
      const items = COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
        value: command,
        label: command,
      }));
      return items.length > 0 ? items : null;
    },
    async handler(args, ctx) {
      await handleGoalCommand(host, args, ctx);
    },
  });
}

export function registerGoalMultiCommand(pi: ExtensionAPI, host: CommandHost): void {
  pi.registerCommand("goal-multi", {
    description: "Interactively define a multi-stage /goal: count, one title per step, then accept or reject.",
    async handler(_args, ctx) {
      await handleGoalMultiCommand(host, ctx);
    },
  });
}
