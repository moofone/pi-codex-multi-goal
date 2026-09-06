import {
  MAX_STAGE_TITLE_CHARS,
  MAX_STAGES,
  MIN_WIZARD_STAGES,
  STAGE_SEPARATOR,
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

export function parseStageTitles(raw: string): { ok: true; titles: string[] } | { ok: false; message: string } {
  return validateTitles(raw.split(STAGE_SEPARATOR).map((part) => part.trim()));
}

export function formatStagePreview(titles: string[]): string {
  return titles.map((title, index) => `${index + 1}. ${title}`).join("\n");
}
