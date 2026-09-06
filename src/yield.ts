import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIVE_ORCHESTRATE_PHASES = new Set([
  "planning",
  "reviewing",
  "implementing",
  "feature-qa",
  "pr",
  "paused",
  "blocked",
]);

export interface SessionIdentity {
  id?: string;
  file?: string;
}

export function parseStatusFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("##")) {
      break;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (key) {
      fields.set(key, value);
    }
  }
  return fields;
}

function sameSessionFile(left: string, right: string): boolean {
  return left.replaceAll("\\", "/") === right.replaceAll("\\", "/");
}

export function featureYieldsForSession(statusText: string, session: SessionIdentity): boolean {
  const fields = parseStatusFields(statusText);
  const phase = (fields.get("phase") ?? "").trim();
  if (!LIVE_ORCHESTRATE_PHASES.has(phase)) {
    return false;
  }
  const parentId = fields.get("parent_session_id") ?? "";
  const parentFile = fields.get("parent_session_file") ?? "";
  const sid = session.id?.trim() ?? "";
  const sfile = session.file?.trim() ?? "";
  if (sid && parentId && parentId !== "none" && sid === parentId) {
    return true;
  }
  if (sfile && parentFile && parentFile !== "none" && sameSessionFile(sfile, parentFile)) {
    return true;
  }
  return false;
}

export function orchestratorRoot(): string {
  return process.env.PI_ORCHESTRATOR_ROOT?.trim() || join(homedir(), "orchestrator");
}

function statusPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  let repos: string[] = [];
  try {
    repos = readdirSync(root);
  } catch {
    return [];
  }
  for (const repo of repos) {
    const repoDir = join(root, repo);
    try {
      if (!statSync(repoDir).isDirectory()) {
        continue;
      }
      for (const name of readdirSync(repoDir)) {
        const status = join(repoDir, name, "status.md");
        if (existsSync(status)) {
          found.push(status);
        }
      }
    } catch {
      continue;
    }
  }
  return found;
}

export function sessionOwnsLiveOrchestrateFeature(
  session: SessionIdentity,
  root = orchestratorRoot(),
): boolean {
  for (const path of statusPaths(root)) {
    try {
      if (featureYieldsForSession(readFileSync(path, "utf8"), session)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
