import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatStagePreview, parseStepCount } from "./parse.js";
import { MAX_STAGES, MIN_WIZARD_STAGES } from "./types.js";

export type WizardUi = Pick<ExtensionCommandContext["ui"], "input" | "confirm" | "notify">;

export async function collectMultiGoalTitles(
  ui: WizardUi,
  options: { hasUI: boolean },
): Promise<{ ok: true; titles: string[] } | { ok: false; message: string }> {
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

  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    while (true) {
      const raw = await ui.input(`Step ${i + 1}/${count}:`, "");
      if (raw === undefined) {
        return { ok: false, message: "Multi-goal cancelled." };
      }
      const title = raw.trim();
      if (title.length === 0) {
        ui.notify("Step title must not be empty.", "warning");
        continue;
      }
      titles.push(title);
      break;
    }
  }

  const preview = formatStagePreview(titles);
  const accepted = await ui.confirm("Start this multi-goal?", preview);
  if (!accepted) {
    return { ok: false, message: "Multi-goal rejected." };
  }
  return { ok: true, titles };
}
