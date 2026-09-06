import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GoalEntrySource, GoalResult, MultiGoal } from "./types.js";

const EvidenceRefParams = Type.Object({
  operation: Type.String({
    description:
      "The producing operation: the tool run that produced or exposed the artifact (bash, read, edit, write, apply_patch, grep, glob, find, ls). Bookkeeping tool names are never evidence.",
  }),
  artifact: Type.String({
    description: "Project-relative path of the artifact this evidence is about.",
  }),
  fingerprint: Type.String({
    description:
      "First 16 hex characters of the artifact's current sha256 — proof the reference matches the bytes you observed.",
  }),
  criteria: Type.Array(Type.String(), {
    description: "Criterion ids of the CURRENT step this evidence supports.",
  }),
});

const UpdateGoalParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: "complete = this stage is done (harness advances). blocked = this stage cannot proceed.",
  }),
  goalId: Type.String({
    description: "The goal attribute of the current <goal> snapshot's memory block.",
  }),
  step: Type.Integer({
    description: "The step attribute of the memory block (the k in the snapshot's stage k/n).",
  }),
  generation: Type.Integer({
    description: "The generation attribute of the memory block.",
  }),
  evidence: Type.Optional(
    Type.Array(EvidenceRefParams, {
      description:
        "Required for complete: refs proving every criterion of the current step (same validation as progress credit). Missing or stale evidence is refused.",
    }),
  ),
  handoff: Type.Optional(
    Type.String({
      description:
        "For complete only: ONE minimal factual note (max 512 chars) the next step explicitly depends on. No instructions; the next step's criteria cannot be changed.",
    }),
  ),
});

export interface TerminalInput {
  toolCallId: string;
  goalId: string;
  step: number;
  generation: number;
  evidence?: unknown;
  handoff?: unknown;
}

export interface MemoryUpdateInput {
  goalId: string;
  step: number;
  generation: number;
  revision: number;
  proved: string[];
  unresolved: string[];
  next: string;
  evidence?: unknown;
}

/** Terminal-tool outcome; acknowledgedStep is the OLD (terminal) step number. */
export type TerminalResult = GoalResult & { acknowledgedStep?: number };
export type MemoryResult = GoalResult & { credited?: number };

export interface ToolHost {
  getGoal(): MultiGoal | null;
  completeStage(source: GoalEntrySource, ctx: ExtensionContext, input: TerminalInput): TerminalResult;
  blockGoal(source: GoalEntrySource, ctx: ExtensionContext, input: TerminalInput): TerminalResult;
  updateMemory(input: MemoryUpdateInput, ctx: ExtensionContext): MemoryResult;
}

const UpdateGoalMemoryParams = Type.Object({
  goalId: Type.String({
    description: "The goal attribute of the current <goal> snapshot's memory block.",
  }),
  step: Type.Integer({
    description: "The step attribute of the memory block (the k in the snapshot's stage k/n).",
  }),
  generation: Type.Integer({
    description: "The generation attribute of the memory block.",
  }),
  revision: Type.Integer({
    description:
      "The revision attribute you last saw on the memory block. A stale revision is rejected; re-read the snapshot.",
  }),
  proved: Type.Array(Type.String(), {
    description:
      "Concise findings tied to evidence. Each entry references an artifact, operation, revision, or fingerprint — never a raw log. Placement here is your claim.",
  }),
  unresolved: Type.Array(Type.String(), {
    description: "Open questions, blockers, and failed approaches, with what would justify revisiting them.",
  }),
  next: Type.String({
    description: "The next concrete action toward the human-defined success criteria.",
  }),
  evidence: Type.Optional(
    Type.Array(EvidenceRefParams, {
      description:
        "Optional refs verified on the same path as completion (artifact exists, producing operation, sha256-16 fingerprint, criterion ids). Each NOVEL verified ref resets the no-progress allowance once; unverifiable claims stay in memory without credit.",
    }),
  ),
});

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  // Registered before update_goal so hosts/harnesses that capture a single
  // "goal tool" keep observing the terminal tool; both registrations are live.
  pi.registerTool({
    name: "update_goal_memory",
    label: "Update Goal Memory",
    description:
      "Replace the bounded working-memory record of the CURRENT goal stage, using the goal/step/generation/revision identity from the <goal> snapshot. One record per stage: proved findings (your claims, as short evidence references), unresolved questions, and the next concrete action. The whole record is capped at 8192 UTF-8 JSON bytes. Memory updates never change success criteria, never advance the stage, and never restore the total allowance — a memory-only loop still consumes no-progress.",
    parameters: UpdateGoalMemoryParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = host.updateMemory(params, ctx);
      if (!result.ok || !result.goal) {
        throw new Error(result.message);
      }
      const stage = `${result.goal.index + 1}/${result.goal.stages.length}`;
      // Minimal acknowledgement: never echo the contract, the memory
      // contents, or the next action (A06).
      const text = JSON.stringify(
        {
          recorded: true,
          stage,
          memoryRevision: result.goal.memory.revision,
          credited: result.credited ?? 0,
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details: { stage, memoryRevision: result.goal.memory.revision, credited: result.credited ?? 0 },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Only call this if you are currently working inside an active <goal> message. Terminal for THIS stage only, bound to the goal/step/generation from the snapshot. complete requires evidence refs covering every criterion; a replayed completion is acknowledged without advancing. The result acknowledges only the completed step and never names another step.",
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input: TerminalInput = {
        toolCallId: _toolCallId,
        goalId: params.goalId,
        step: params.step,
        generation: params.generation,
        evidence: params.evidence,
        handoff: params.handoff,
      };
      const result =
        params.status === "complete"
          ? host.completeStage("tool", ctx, input)
          : host.blockGoal("tool", ctx, input);
      if (!result.ok || !result.goal) {
        throw new Error(result.message);
      }
      // Acknowledge only the old step, by position (F06): no step titles that
      // belong to any other stage of the goal.
      const stage = `${result.acknowledgedStep ?? result.goal.index + 1}/${result.goal.stages.length}`;
      const text = JSON.stringify(
        {
          status: params.status,
          stage,
          message: result.message,
        },
        null,
        2,
      );
      return {
        content: [{ type: "text", text }],
        details: { status: params.status, stage },
      };
    },
  });
}
