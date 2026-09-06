import {
  MAX_STAGE_TITLE_CHARS,
  MAX_STAGES,
  MIN_WIZARD_STAGES,
  type GoalStep,
} from "./types.js";

export function parseStepCount(raw: string): { ok: true; count: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return { ok: false, message: `Enter a whole number from ${MIN_WIZARD_STAGES} to ${MAX_STAGES}.` };
  }
  const count = Number(trimmed);
  if (count < MIN_WIZARD_STAGES || count > MAX_STAGES) {
    return {
      ok: false,
      message: `Enter a whole number from ${MIN_WIZARD_STAGES} to ${MAX_STAGES}.`,
    };
  }
  return { ok: true, count };
}

export function validateTitles(
  titles: string[],
): { ok: true; titles: string[] } | { ok: false; message: string } {
  if (titles.length === 0 || (titles.length === 1 && titles[0] === "")) {
    return { ok: false, message: "Objective must not be empty." };
  }
  if (titles.some((title) => title.length === 0)) {
    return { ok: false, message: "Stage titles must not be empty." };
  }
  if (titles.length > MAX_STAGES) {
    return { ok: false, message: `At most ${MAX_STAGES} stages.` };
  }
  for (const title of titles) {
    if ([...title].length > MAX_STAGE_TITLE_CHARS) {
      return { ok: false, message: `Stage titles must be ${MAX_STAGE_TITLE_CHARS} characters or fewer.` };
    }
  }
  return { ok: true, titles };
}

/**
 * `/goal <text>` is a single objective. The former ` || ` stage splitting is
 * retired: the whole argument is one objective, pipes included.
 */
export function parseStageTitles(raw: string): { ok: true; titles: string[] } | { ok: false; message: string } {
  return validateTitles([raw.trim()]);
}

function isNonemptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

const HEADLESS_CONTRACT_USAGE =
  'Headless /goal needs a JSON contract: {"objective":"...","criteria":["..."]} ' +
  '(add "steps":[{"objective":"...","criteria":["..."]}] for a sequence). ' +
  "Plain text never starts a goal.";

function rejectContract(message: string): { ok: false; message: string } {
  return { ok: false, message: `${message} ${HEADLESS_CONTRACT_USAGE}` };
}

function parseStepContract(value: unknown, label: string): { ok: true; step: GoalStep } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return rejectContract(`${label} must be an object with "objective" and nonempty "criteria".`);
  }
  const step = value as { objective?: unknown; criteria?: unknown };
  if (typeof step.objective !== "string" || step.objective.trim().length === 0) {
    return rejectContract(`${label} needs a nonempty "objective" string.`);
  }
  if (!isNonemptyStringArray(step.criteria)) {
    return rejectContract(`${label} needs a nonempty "criteria" array of nonempty strings.`);
  }
  return { ok: true, step: { objective: step.objective.trim(), criteria: step.criteria.map((c) => c.trim()) } };
}

/**
 * Headless `/goal` starts only from the documented JSON contract:
 * `{"objective":"...","criteria":["..."]}` for a single step, plus optional
 * `"steps":[{"objective":"...","criteria":["..."]}]` for a sequence. Every
 * included step — and the contract itself — requires nonempty criteria.
 */
export function parseGoalContract(raw: string): { ok: true; steps: GoalStep[] } | { ok: false; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return rejectContract("Arguments must be a JSON contract.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return rejectContract("Arguments must be a JSON contract object.");
  }
  const contract = data as { objective?: unknown; criteria?: unknown; steps?: unknown };
  const top = parseStepContract(contract, "Contract");
  if (!top.ok) {
    return top;
  }
  if (contract.steps === undefined) {
    return { ok: true, steps: [top.step] };
  }
  if (!Array.isArray(contract.steps) || contract.steps.length === 0) {
    return rejectContract('"steps" must be a nonempty array when present.');
  }
  if (contract.steps.length > MAX_STAGES) {
    return rejectContract(`At most ${MAX_STAGES} steps.`);
  }
  const steps: GoalStep[] = [];
  for (const [index, entry] of contract.steps.entries()) {
    const step = parseStepContract(entry, `"steps[${index}]"`);
    if (!step.ok) {
      return step;
    }
    steps.push(step.step);
  }
  return { ok: true, steps };
}

/** Production constructor validation: objectives plus accepted nonempty criteria. */
export function validateSteps(steps: GoalStep[]): { ok: true; steps: GoalStep[] } | { ok: false; message: string } {
  if (steps.length === 0) {
    return { ok: false, message: "Objective must not be empty." };
  }
  const titles = validateTitles(steps.map((step) => step.objective));
  if (!titles.ok) {
    return titles;
  }
  for (const [index, step] of steps.entries()) {
    if (step.criteria.length === 0 || step.criteria.some((criterion) => criterion.trim().length === 0)) {
      return { ok: false, message: `Step ${index + 1} needs at least one success criterion.` };
    }
  }
  return { ok: true, steps };
}

export function formatStepsPreview(steps: GoalStep[]): string {
  return steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.objective}\n   Criteria:\n${step.criteria
          .map((criterion) => `   - ${criterion}`)
          .join("\n")}`,
    )
    .join("\n");
}
