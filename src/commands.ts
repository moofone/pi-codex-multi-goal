import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatHumanStatus } from "./prompts.js";
import { formatStepsPreview, parseGoalContract, parseStageTitles } from "./parse.js";
import { replaceGoalFromSteps, setGoalStatus } from "./state.js";
import type { GoalContinuationKind, GoalEntrySource, GoalStep, MultiGoal } from "./types.js";
import { collectMultiGoalSteps } from "./wizard.js";

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

async function confirmGoalContract(
  ctx: ExtensionCommandContext,
  preview: string,
): Promise<boolean> {
  const accepted = await ctx.ui.confirm("Start with these success criteria?", preview);
  if (!accepted) {
    ctx.ui.notify("Goal unchanged.");
  }
  return accepted;
}

function startGoalFromSteps(
  host: CommandHost,
  ctx: ExtensionCommandContext,
  steps: GoalStep[],
): void {
  const result = replaceGoalFromSteps(steps);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  host.requestContinuation(ctx, "command_start");
}

/**
 * Prompts for success criteria. An empty first answer means "use the objective
 * as the sole criterion" — that default is only accepted via the contract
 * confirm. Returning undefined means the human cancelled.
 */
async function collectSingleGoalCriteria(
  ui: ExtensionCommandContext["ui"],
  objective: string,
): Promise<string[] | undefined> {
  const criteria: string[] = [];
  while (true) {
    const raw = await ui.input(
      criteria.length === 0
        ? `Success criteria for "${objective}" (blank = use the objective itself):`
        : "Another criterion (blank to finish):",
      "",
    );
    if (raw === undefined) {
      return undefined;
    }
    const criterion = raw.trim();
    if (criterion.length === 0) {
      return criteria;
    }
    criteria.push(criterion);
  }
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

  if (!ctx.hasUI) {
    // Headless starts only from the documented JSON contract; plain text is
    // never started (an agent cannot fabricate criteria).
    const contract = parseGoalContract(trimmed);
    if (!contract.ok) {
      ctx.ui.notify(contract.message, "error");
      return;
    }
    if (!(await confirmReplaceIfNeeded(host, ctx, formatStepsPreview(contract.steps)))) {
      return;
    }
    startGoalFromSteps(host, ctx, contract.steps);
    return;
  }

  const parsed = parseStageTitles(trimmed);
  if (!parsed.ok) {
    ctx.ui.notify(parsed.message, "error");
    return;
  }
  const objective = parsed.titles[0]!;

  const criteria = await collectSingleGoalCriteria(ctx.ui, objective);
  if (criteria === undefined) {
    ctx.ui.notify("Goal setup cancelled; goal unchanged.", "warning");
    return;
  }
  const blankCriteria = criteria.length === 0;
  const step: GoalStep = { objective, criteria: blankCriteria ? [objective] : criteria };
  const preview = formatStepsPreview([step]) +
    (blankCriteria ? "\n   (no criteria entered: the objective is the sole criterion)" : "");

  if (!(await confirmReplaceIfNeeded(host, ctx, preview))) {
    return;
  }
  if (!(await confirmGoalContract(ctx, preview))) {
    return;
  }
  startGoalFromSteps(host, ctx, [step]);
}

export async function handleGoalMultiCommand(
  host: CommandHost,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const collected = await collectMultiGoalSteps(ctx.ui, { hasUI: ctx.hasUI });
  if (!collected.ok) {
    ctx.ui.notify(collected.message, collected.message.includes("cancelled") || collected.message.includes("rejected") ? "warning" : "error");
    return;
  }
  const preview = formatStepsPreview(collected.steps);
  if (!(await confirmReplaceIfNeeded(host, ctx, preview))) {
    return;
  }
  startGoalFromSteps(host, ctx, collected.steps);
}

export function registerGoalCommand(pi: ExtensionAPI, host: CommandHost): void {
  pi.registerCommand("goal", {
    description:
      "Usage: /goal [<objective>|pause|resume|clear] — Codex-style goal; headless accepts a JSON contract. Use /goal-multi for staged goals.",
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
    description:
      "Interactively define a multi-stage /goal: count, then per-step objective and criteria, then accept or reject.",
    async handler(_args, ctx) {
      await handleGoalMultiCommand(host, ctx);
    },
  });
}
