import { currentStage } from "./state.js";
import type { GoalMemory, MultiGoal } from "./types.js";

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatGoalWrapper(goal: MultiGoal): string {
  const stage = currentStage(goal);
  const k = goal.index + 1;
  const n = goal.stages.length;
  return [
    "<goal>",
    "<objective>",
    escapeXmlText(stage.title),
    "</objective>",
    `<stage>${k}/${n}</stage>`,
    "<instructions>",
    "You are working on this active goal stage.",
    "Keep making concrete progress on THIS stage only.",
    "Do not work on other stages. Do not redefine this stage.",
    "Before declaring this stage done, verify it against current evidence.",
    'When THIS stage is fully achieved, call update_goal with {"status":"complete"}.',
    'If this stage cannot proceed without user input, call update_goal with {"status":"blocked"}.',
    "</instructions>",
    "</goal>",
  ].join("\n");
}

export function otherStageTitles(goal: MultiGoal): string[] {
  return goal.stages.filter((_, index) => index !== goal.index).map((stage) => stage.title);
}

function formatMemoryLine(memory: GoalMemory): string {
  if (
    memory.revision === 0 &&
    memory.proved.length === 0 &&
    memory.unresolved.length === 0 &&
    memory.next === ""
  ) {
    return "  Memory: none recorded yet";
  }
  const parts = [`revision ${memory.revision}`];
  if (memory.proved.length > 0) {
    parts.push(`proved: ${memory.proved.length}`);
  }
  if (memory.unresolved.length > 0) {
    parts.push(`unresolved: ${memory.unresolved.length}`);
  }
  if (memory.next.length > 0) {
    parts.push(`next: ${memory.next}`);
  }
  return `  Memory: ${parts.join("; ")}`;
}

export function formatHumanStatus(goal: MultiGoal | null): string {
  if (!goal) {
    return [
      "No goal is currently set.",
      "Usage: /goal <objective>   or   /goal-multi",
      'Headless (no TUI): /goal {"objective":"...","criteria":["..."]} — plain text never starts a goal.',
    ].join("\n");
  }
  const lines = [
    `Status: ${goal.status}`,
    `Stage: ${goal.index + 1}/${goal.stages.length}`,
  ];
  goal.stages.forEach((stage, index) => {
    const mark = stage.status === "complete" ? "x" : stage.status === "active" ? ">" : " ";
    lines.push(`  [${mark}] ${index + 1}. ${stage.title}`);
    if (stage.criteria.length === 0) {
      lines.push("        Criteria: (awaiting confirmation)");
    } else {
      for (const criterion of stage.criteria) {
        const decision = criterion.requiresHumanDecision ? " (needs human decision)" : "";
        lines.push(`        - ${criterion.text}${decision}`);
      }
    }
  });
  lines.push(formatMemoryLine(goal.memory));
  lines.push(
    `Allowance: no-progress ${goal.execution.noProgressRemaining}/${goal.execution.noProgressLimit}, total ${goal.execution.totalRemaining}/${goal.execution.totalLimit}`,
  );
  if (goal.pauseReason) {
    lines.push(`Paused: ${goal.pauseReason}`);
  }
  if (goal.status === "active") {
    lines.push("Hint: /goal pause, /goal clear");
  } else if (goal.status === "paused" || goal.status === "blocked") {
    lines.push("Hint: /goal resume, /goal clear");
  } else {
    lines.push("Hint: /goal <objective> or /goal-multi to replace, /goal clear");
  }
  return lines.join("\n");
}

export function formatFooterStatus(
  goal: MultiGoal | null,
  options: { yielding?: boolean; stallReason?: string | null } = {},
): string | undefined {
  if (!goal) {
    return undefined;
  }
  if (options.stallReason) {
    return options.stallReason;
  }
  if (options.yielding && goal.status === "active") {
    return "Goal waiting on /orchestrate";
  }
  const stageLabel = `${goal.index + 1}/${goal.stages.length}`;
  if (goal.status === "active") {
    return `Pursuing ${stageLabel}`;
  }
  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }
  if (goal.status === "blocked") {
    return "Goal blocked (/goal resume)";
  }
  return "Goal achieved";
}
