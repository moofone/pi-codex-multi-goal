import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatStepsPreview, parseStepCount } from "./parse.js";
import { MAX_STAGES, MIN_WIZARD_STAGES, type GoalStep } from "./types.js";

export type WizardUi = Pick<ExtensionCommandContext["ui"], "input" | "confirm" | "notify">;

async function promptStepObjective(
  ui: WizardUi,
  index: number,
  count: number,
): Promise<string | undefined> {
  while (true) {
    const raw = await ui.input(`Step ${index + 1}/${count} objective:`, "");
    if (raw === undefined) {
      return undefined;
    }
    const objective = raw.trim();
    if (objective.length === 0) {
      ui.notify("Step objective must not be empty.", "warning");
      continue;
    }
    return objective;
  }
}

async function promptStepCriteria(
  ui: WizardUi,
  index: number,
  count: number,
): Promise<string[] | undefined> {
  const criteria: string[] = [];
  while (true) {
    const raw = await ui.input(
      criteria.length === 0
        ? `Step ${index + 1}/${count} success criteria (one per entry; required):`
        : `Step ${index + 1}/${count}: another criterion (blank to finish):`,
      "",
    );
    if (raw === undefined) {
      return undefined;
    }
    const criterion = raw.trim();
    if (criterion.length === 0) {
      if (criteria.length > 0) {
        return criteria;
      }
      ui.notify("Enter at least one criterion for this step.", "warning");
      continue;
    }
    criteria.push(criterion);
  }
}

/** Collects a nonempty criteria list per step; starts only after one sequence confirm. */
export async function collectMultiGoalSteps(
  ui: WizardUi,
  options: { hasUI: boolean },
): Promise<{ ok: true; steps: GoalStep[] } | { ok: false; message: string }> {
  if (!options.hasUI) {
    return { ok: false, message: "/goal-multi needs the TUI. Run it interactively." };
  }

  let count: number | undefined;
  while (count === undefined) {
    const raw = await ui.input(
      `How many steps? (${MIN_WIZARD_STAGES}–${MAX_STAGES})`,
      String(MIN_WIZARD_STAGES),
    );
    if (raw === undefined) {
      return { ok: false, message: "Multi-goal cancelled." };
    }
    const parsed = parseStepCount(raw);
    if (!parsed.ok) {
      ui.notify(parsed.message, "warning");
      continue;
    }
    count = parsed.count;
  }

  const steps: GoalStep[] = [];
  for (let i = 0; i < count; i++) {
    const objective = await promptStepObjective(ui, i, count);
    if (objective === undefined) {
      return { ok: false, message: "Multi-goal cancelled." };
    }
    const criteria = await promptStepCriteria(ui, i, count);
    if (criteria === undefined) {
      return { ok: false, message: "Multi-goal cancelled." };
    }
    steps.push({ objective, criteria });
  }

  const accepted = await ui.confirm("Start this multi-goal?", formatStepsPreview(steps));
  if (!accepted) {
    return { ok: false, message: "Multi-goal rejected." };
  }
  return { ok: true, steps };
}
