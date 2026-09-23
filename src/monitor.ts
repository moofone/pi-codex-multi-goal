import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatGoalWrapper } from "./prompts.js";
import { isGoalCustomEntry } from "./state.js";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalEntrySource,
  type GoalMemory,
  type MultiGoal,
  type SessionEntryLike,
} from "./types.js";
import { monitorPageHtml } from "./monitor-page.js";

const HISTORY_CAP = 200;
const COMPACTION_CAP = 100;
const ADMISSION_CAP = 32;
const KEPT_CAP = 80;

export interface MonitorHistoryEvent {
  at: number;
  kind: "set" | "clear";
  source: GoalEntrySource;
  goalId: string | null;
  status?: MultiGoal["status"];
  step?: number;
  stages?: number;
  generation?: number;
  memoryRevision?: number;
  isolationCutoff?: number | null;
  stageTitle?: string;
  pauseReason?: string | null;
  memory?: GoalMemory;
}

export interface MonitorCompactionEvent {
  at: number;
  kind: "session_compact";
  step: number;
  generation: number;
  reason?: string;
  tokensBefore?: number;
}

export interface MonitorKeptMessage {
  role: string;
  timestamp?: number;
  label: string;
  content?: string;
}

export interface MonitorDagAdmission {
  at: number;
  goalId: string;
  step: number;
  generation: number;
  isolationCutoff: number | null;
  handoff: string | null;
  injectedSnapshot: string;
  droppedCount: number;
  keptCount: number;
  kept: MonitorKeptMessage[];
}

export interface MonitorSnapshot {
  at: number;
  listening: boolean;
  url: string | null;
  goal: {
    goalId: string;
    status: MultiGoal["status"];
    pauseReason: string | null;
    stage: { k: number; n: number };
    stages: Array<{
      id: string;
      index: number;
      title: string;
      status: MultiGoal["stages"][number]["status"];
      criteria: Array<{ id: string; text: string; requiresHumanDecision?: boolean }>;
    }>;
    memory: GoalMemory;
    execution: MultiGoal["execution"];
    isolationCutoff: number | null;
    injectedSnapshot: string;
  } | null;
  history: MonitorHistoryEvent[];
  compaction: {
    isolatedSteps: number;
    hostCompactions: number;
    contextsWouldHaveBeenCompacted: number;
    droppedAtIsolation: number;
    events: MonitorCompactionEvent[];
  };
  dag: {
    lastAdmission: MonitorDagAdmission | null;
    admissions: MonitorDagAdmission[];
  };
}

export interface CompactObservation {
  reason?: unknown;
  tokensBefore?: number;
}

export interface ContextObservation {
  incoming: unknown[];
  kept: unknown[];
  goal: MultiGoal;
}

function asEpochMs(value: number): number {
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function historyKey(goal: MultiGoal | null): string {
  if (!goal) {
    return "clear";
  }
  return [
    goal.goalId,
    goal.status,
    String(goal.index),
    String(goal.memory.revision),
    String(goal.execution.generation),
    String(goal.isolationCutoff ?? ""),
    goal.pauseReason ?? "",
  ].join("|");
}

function cloneMemory(memory: GoalMemory): GoalMemory {
  return {
    revision: memory.revision,
    proved: [...memory.proved],
    unresolved: [...memory.unresolved],
    next: memory.next,
  };
}

function eventFromGoal(goal: MultiGoal, source: GoalEntrySource, at: number): MonitorHistoryEvent {
  const stage = goal.stages[goal.index];
  return {
    at,
    kind: "set",
    source,
    goalId: goal.goalId,
    status: goal.status,
    step: goal.index + 1,
    stages: goal.stages.length,
    generation: goal.execution.generation,
    memoryRevision: goal.memory.revision,
    isolationCutoff: goal.isolationCutoff ?? null,
    stageTitle: stage?.title,
    pauseReason: goal.pauseReason,
    memory: cloneMemory(goal.memory),
  };
}

/** Walk persisted custom entries into a bounded monitor timeline. */
export function historyFromBranch(entries: Iterable<SessionEntryLike>): MonitorHistoryEvent[] {
  const events: MonitorHistoryEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data;
    if (!isGoalCustomEntry(data)) {
      continue;
    }
    if (data.kind === "clear") {
      events.push({
        at: asEpochMs(data.at),
        kind: "clear",
        source: data.source,
        goalId: data.clearedGoalId,
      });
      continue;
    }
    events.push(eventFromGoal(data.goal, data.source, asEpochMs(data.at)));
  }
  return events.length > HISTORY_CAP ? events.slice(-HISTORY_CAP) : events;
}

export function countIsolatedSteps(history: readonly MonitorHistoryEvent[]): number {
  let count = 0;
  let previous: number | null = null;
  for (const event of history) {
    if (event.kind !== "set") {
      previous = null;
      continue;
    }
    const cutoff = event.isolationCutoff ?? null;
    if (cutoff !== null && cutoff !== previous) {
      count += 1;
    }
    previous = cutoff;
  }
  return count;
}

function summarizeMessage(message: unknown): MonitorKeptMessage {
  const record = (message ?? {}) as {
    role?: unknown;
    timestamp?: unknown;
    customType?: unknown;
    content?: unknown;
    details?: unknown;
    toolCallId?: unknown;
  };
  const role = typeof record.role === "string" ? record.role : "unknown";
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
  const details = (record.details ?? {}) as { stage?: unknown; stages?: unknown; kind?: unknown };
  if (role === "custom" && record.customType === CUSTOM_ENTRY_TYPE) {
    const stage = typeof details.stage === "number" ? details.stage : "?";
    const stages = typeof details.stages === "number" ? details.stages : "?";
    const kind = typeof details.kind === "string" ? details.kind : "snapshot";
    const content = typeof record.content === "string" ? record.content : undefined;
    return {
      role,
      timestamp,
      label: `goal ${kind} ${stage}/${stages}`,
      content,
    };
  }
  if (typeof record.toolCallId === "string") {
    return { role, timestamp, label: `${role} ${record.toolCallId}` };
  }
  return { role, timestamp, label: role };
}

function admissionKey(goal: MultiGoal): string {
  return `${goal.goalId}:${goal.index}:${goal.execution.generation}:${goal.isolationCutoff ?? ""}`;
}

function cap<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(-limit) : items;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createGoalMonitor() {
  let goal: MultiGoal | null = null;
  let history: MonitorHistoryEvent[] = [];
  let lastHistoryKey = historyKey(null);
  const compactionEvents: MonitorCompactionEvent[] = [];
  const admissions: MonitorDagAdmission[] = [];
  let lastAdmission: MonitorDagAdmission | null = null;
  let lastAdmissionKey = "";
  let pendingTokensBefore: number | undefined;

  let server: Server | null = null;
  let port: number | null = null;
  let starting: Promise<{ url: string; reused: boolean }> | null = null;
  const sseClients = new Set<ServerResponse>();

  const listeningUrl = (): string | null => (port === null ? null : `http://127.0.0.1:${port}/`);

  const snapshot = (): MonitorSnapshot => {
    const isolatedSteps = countIsolatedSteps(history);
    const hostCompactions = compactionEvents.length;
    const droppedAtIsolation = admissions.reduce((sum, admission) => sum + admission.droppedCount, 0);
    return {
      at: Date.now(),
      listening: port !== null,
      url: listeningUrl(),
      goal: goal
        ? {
            goalId: goal.goalId,
            status: goal.status,
            pauseReason: goal.pauseReason,
            stage: { k: goal.index + 1, n: goal.stages.length },
            stages: goal.stages.map((stage, index) => ({
              id: stage.id,
              index,
              title: stage.title,
              status: stage.status,
              criteria: stage.criteria.map((criterion) => ({
                id: criterion.id,
                text: criterion.text,
                requiresHumanDecision: criterion.requiresHumanDecision,
              })),
            })),
            memory: cloneMemory(goal.memory),
            execution: {
              ...goal.execution,
              creditedEvidence: [...(goal.execution.creditedEvidence ?? [])],
            },
            isolationCutoff: goal.isolationCutoff ?? null,
            injectedSnapshot: formatGoalWrapper(goal),
          }
        : null,
      history: [...history],
      compaction: {
        isolatedSteps,
        hostCompactions,
        contextsWouldHaveBeenCompacted: isolatedSteps + hostCompactions,
        droppedAtIsolation,
        events: [...compactionEvents],
      },
      dag: {
        lastAdmission,
        admissions: [...admissions],
      },
    };
  };

  const publish = (): void => {
    if (sseClients.size === 0) {
      return;
    }
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of sseClients) {
      client.write(payload);
    }
  };

  const syncGoal = (next: MultiGoal | null, source: GoalEntrySource = "runtime"): void => {
    goal = next;
    const key = historyKey(next);
    if (key !== lastHistoryKey) {
      lastHistoryKey = key;
      if (!next) {
        history = cap(
          [...history, { at: Date.now(), kind: "clear" as const, source, goalId: null }],
          HISTORY_CAP,
        );
      } else {
        history = cap([...history, eventFromGoal(next, source, Date.now())], HISTORY_CAP);
      }
    }
    publish();
  };

  const hydrateFromBranch = (entries: Iterable<SessionEntryLike>): void => {
    const reconstructed = historyFromBranch(entries);
    if (reconstructed.length > 0) {
      history = reconstructed;
    }
    lastHistoryKey = historyKey(goal);
    publish();
  };

  const noteCompactPrep = (tokensBefore: unknown): void => {
    pendingTokensBefore = typeof tokensBefore === "number" && Number.isFinite(tokensBefore) ? tokensBefore : undefined;
  };

  const recordCompact = (observation: CompactObservation): void => {
    if (!goal) {
      pendingTokensBefore = undefined;
      return;
    }
    compactionEvents.push({
      at: Date.now(),
      kind: "session_compact",
      step: goal.index + 1,
      generation: goal.execution.generation,
      reason: typeof observation.reason === "string" ? observation.reason : undefined,
      tokensBefore: observation.tokensBefore ?? pendingTokensBefore,
    });
    if (compactionEvents.length > COMPACTION_CAP) {
      compactionEvents.splice(0, compactionEvents.length - COMPACTION_CAP);
    }
    pendingTokensBefore = undefined;
    publish();
  };

  const observeContext = (observation: ContextObservation): void => {
    const current = observation.goal;
    const kept = observation.kept.map(summarizeMessage);
    const snapshotContent = kept.find((message) => message.content)?.content ?? formatGoalWrapper(current);
    const admission: MonitorDagAdmission = {
      at: Date.now(),
      goalId: current.goalId,
      step: current.index + 1,
      generation: current.execution.generation,
      isolationCutoff: current.isolationCutoff ?? null,
      handoff:
        current.isolationCutoff != null && current.memory.revision === 0
          ? (current.memory.proved[0] ?? null)
          : null,
      injectedSnapshot: snapshotContent,
      droppedCount: Math.max(0, observation.incoming.length - observation.kept.length),
      keptCount: observation.kept.length,
      kept: kept.slice(0, KEPT_CAP),
    };
    lastAdmission = admission;
    const key = admissionKey(current);
    if (key !== lastAdmissionKey) {
      lastAdmissionKey = key;
      admissions.push(admission);
      if (admissions.length > ADMISSION_CAP) {
        admissions.splice(0, admissions.length - ADMISSION_CAP);
      }
    } else if (admissions.length > 0) {
      admissions[admissions.length - 1] = admission;
    }
    publish();
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      send(res, 200, monitorPageHtml(), "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && path === "/api/snapshot") {
      send(res, 200, JSON.stringify(snapshot()), "application/json; charset=utf-8");
      return;
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }
    send(res, 404, "not found\n", "text/plain; charset=utf-8");
  };

  const listen = async (): Promise<{ url: string; reused: boolean }> => {
    if (server && port !== null) {
      return { url: listeningUrl()!, reused: true };
    }
    if (starting) {
      return starting;
    }
    starting = new Promise<{ url: string; reused: boolean }>((resolve, reject) => {
      const next = createServer(handleRequest);
      const fail = (error: Error): void => {
        next.close();
        reject(error);
      };
      next.once("error", fail);
      next.listen(0, "127.0.0.1", () => {
        next.off("error", fail);
        const address = next.address();
        const bound = typeof address === "object" && address ? address.port : 0;
        if (!bound) {
          next.close();
          reject(new Error("Goal monitor failed to bind a free port."));
          return;
        }
        server = next;
        port = bound;
        resolve({ url: `http://127.0.0.1:${bound}/`, reused: false });
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  };

  const stop = (): void => {
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
    const current = server;
    server = null;
    port = null;
    starting = null;
    current?.close();
  };

  return {
    snapshot,
    syncGoal,
    hydrateFromBranch,
    noteCompactPrep,
    recordCompact,
    observeContext,
    start: listen,
    stop,
    url: listeningUrl,
  };
}

export type GoalMonitor = ReturnType<typeof createGoalMonitor>;

export function registerGoalMonitorCommand(
  pi: ExtensionAPI,
  monitor: GoalMonitor,
  host: { getGoal: () => MultiGoal | null },
): void {
  pi.registerCommand("goal-monitor", {
    description:
      "Launch a localhost dashboard on a random free port: live memory, multi-step history, and DAG isolation/compaction.",
    async handler(_args, ctx) {
      monitor.syncGoal(host.getGoal(), "runtime");
      const branch = (
        ctx as ExtensionCommandContext & {
          sessionManager?: { getBranch?: () => SessionEntryLike[] };
        }
      ).sessionManager?.getBranch?.();
      if (branch) {
        monitor.hydrateFromBranch(branch);
      }
      try {
        const { url, reused } = await monitor.start();
        ctx.ui.notify(reused ? `Goal monitor already running at ${url}` : `Goal monitor: ${url}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Goal monitor failed to start.";
        ctx.ui.notify(message, "error");
      }
    },
  });
}
