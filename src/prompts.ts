import { budgetPressure } from "./allowance.js";
import { backendAdmitsExecution } from "./backend.js";
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
  // Exactly one current contract + memory snapshot (A06): this step's
  // objective, criteria, working memory, and k/n — never other steps'
  // titles, instructions, or memory. The memory block carries the goal/step
  // identity, execution generation, and revision that update_goal_memory
  // validates against.
  const lines = [
    "<goal>",
    "<objective>",
    escapeXmlText(stage.title),
    "</objective>",
    `<stage>${k}/${n}</stage>`,
  ];
  if (stage.criteria.length > 0) {
    lines.push("<criteria>");
    for (const criterion of stage.criteria) {
      const decision = criterion.requiresHumanDecision ? " (needs human decision)" : "";
      // Criterion ids are stable: evidence refs associate by id.
      lines.push(`- ${criterion.id}: ${escapeXmlText(criterion.text)}${decision}`);
    }
    lines.push("</criteria>");
  }
  lines.push(
    `<memory goal="${escapeXmlText(goal.goalId)}" step="${k}" ` +
      `generation="${goal.execution.generation}" revision="${goal.memory.revision}">`,
  );
  if (goal.memory.proved.length > 0) {
    lines.push("<proved>");
    for (const item of goal.memory.proved) {
      lines.push(`- ${escapeXmlText(item)}`);
    }
    lines.push("</proved>");
  }
  if (goal.memory.unresolved.length > 0) {
    lines.push("<unresolved>");
    for (const item of goal.memory.unresolved) {
      lines.push(`- ${escapeXmlText(item)}`);
    }
    lines.push("</unresolved>");
  }
  if (goal.memory.next.length > 0) {
    lines.push("<next>");
    lines.push(escapeXmlText(goal.memory.next));
    lines.push("</next>");
  }
  lines.push("</memory>");
  lines.push(
    "<instructions>",
    "You are working on this active goal stage.",
    "Keep making concrete progress on THIS stage only.",
    "Do not stop until you call update_goal complete or blocked for THIS stage.",
    "Do not work on other stages. Do not redefine this stage.",
    "Before declaring this stage done, verify it against current evidence.",
    "Evidence refs are project-relative: { operation: the tool run that produced the artifact, artifact: its path, fingerprint: first 16 hex chars of the artifact's sha256, criteria: the criterion ids above }.",
    'To record memory or report verified progress, call update_goal_memory with the goal, step, generation, and revision from this snapshot; optional evidence refs earn progress credit once per novel verified ref. It replaces the whole memory record.',
    'When THIS stage is fully achieved and every criterion is covered by valid evidence, call update_goal with {"status":"complete", goalId, step, generation, evidence}.',
    'If this stage cannot proceed without user input, call update_goal with {"status":"blocked", goalId, step, generation}.',
    "</instructions>",
    "</goal>",
  );
  return lines.join("\n");
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
  // Which working-memory authority is in force. An unbound goal shows nothing
  // here: that is today's view, and P0 does not add noise to a Goal-only
  // session (invariant 1).
  // A reason without a state change still matters: a binding that ended with
  // the stage it belonged to must not disappear silently.
  if (goal.backend.state !== "unbound" || goal.backend.reason !== null) {
    lines.push(`Backend: ${goal.backend.state}`);
    if (goal.backend.reason) {
      lines.push(`  Reason: ${goal.backend.reason}`);
    }
    if (goal.backend.binding?.selectedRevision) {
      lines.push(`  Selected revision: ${goal.backend.binding.selectedRevision}`);
    }
  }
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
  if (goal.status === "active" && !backendAdmitsExecution(goal.backend)) {
    // Execution is withheld, not exhausted: say which authority is missing
    // rather than showing a budget the user cannot spend anyway.
    return goal.backend.state === "binding-pending"
      ? `Goal ${stageLabel} · backend switch pending`
      : `Goal ${stageLabel} · backend unavailable`;
  }
  if (goal.status === "active") {
    // Budget pressure is shown only once a fuse passes its warning threshold,
    // so an ordinary goal reads as "Pursuing 2/4" and a goal that is about to
    // pause says which budget is running out before it does (D4).
    const pressure = budgetPressure(goal.execution);
    return pressure
      ? `Pursuing ${stageLabel} · ${pressure.budget} ${pressure.percent}%`
      : `Pursuing ${stageLabel}`;
  }
  if (goal.status === "paused") {
    return "Goal paused (/goal resume)";
  }
  if (goal.status === "blocked") {
    return "Goal blocked (/goal resume)";
  }
  return "Goal achieved";
}
