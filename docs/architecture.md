# Architecture invariants

Status: implemented by the goal-memory-and-limits feature. Invariants 1–6 are
enforced in code and covered by maintained regressions in `test/*.test.ts`
(run with typecheck via `npm test`); findings F01–F09 from
[qa-architecture.md](qa-architecture.md) carry current dispositions. The
implementation choices below (the 20/40/400/1000 allowances, 8 KiB memory) are provisional
constants, and the recorded host limitations in qa-architecture.md bound what is
claimed: admission is a schedule-side fallback, and end-to-end behavior in a
live agent loop is not behaviorally verified.

`pi-codex-multi-goal` is a small goal controller for Pi. It keeps an objective
moving, stops unproductive execution, and optionally advances through an ordered
sequence of steps. The human defines the objective and what success requires.
The harness owns execution limits and step transitions; the model does the work,
maintains a small evidence record, and reports completion or a blocker.

## 1. Unproductive execution is bounded

- Every active step has a finite maximum number of consecutive full contexts
  without useful progress. Reaching the limit pauses that step and stops proven
  goal-owned work before another goal-owned context can begin.
- A full context means one context-window fill (a `session_compact`). Provider
  requests inside a continuing tool loop do not spend the no-progress allowance.
  A per-agent-turn request bound catches a runaway loop instead, and a separate
  evidence-renewed working total bounds the step. Kickoff,
  continuation, retries, and recovery cannot bypass accounting by using a
  different entry path.
- Useful progress is new, verifiable movement toward the current objective:
  a relevant implementation change, a meaningful validation result, or evidence
  that resolves an open question. A successful tool call, arbitrary edit, repeated
  test result, status update, or rewritten plan is not sufficient by itself.
- Accounting is cheap and harness-owned. It must not require an extra model call
  per turn to decide whether the previous turn was useful. Uncertain progress
  does not automatically replenish the allowance.
- Compaction, reload, and retries preserve the current step's accounting. Only
  verified progress, an explicit user resume, or a legitimate new step starts a
  fresh no-progress allowance.
- Pausing cancels pending goal continuations and stops further goal-owned model
  execution. It preserves the objective, completed work, and a visible reason.
  Resuming requires an explicit user action; exhaustion never means completion.

## 2. Keep the controller small and explicit

- Use one authoritative state model, one continuation owner, and one place that
  enforces execution limits. Persist only the state needed for correct recovery.
- Prefer direct state transitions over overlapping timers, layered retries,
  hidden flags, or speculative abstractions.
- Every mechanism must support an invariant in this document. This project is
  not a second planner, workflow engine, or general orchestration framework.
- Recovering or replaying the same event must not duplicate work, advance twice,
  or silently grant a fresh allowance.

## 3. Coexist with pi-orchestrate as a peer

- Both extensions operate at the same level. Neither owns or rewrites the
  other's lifecycle, state, prompts, commands, tools, or UI status.
- Goal state and session entries are independently namespaced. Integration uses
  a small, explicit ownership boundary rather than shared mutable internals.
- Only one controller may drive automatic execution in a session at a time.
  While pi-orchestrate owns execution, this controller yields and injects no
  competing goal follow-ups or step transitions.
- Yielding preserves the current step and allowance. Orchestrate-owned work is
  neither charged as goal contexts or requests nor treated as proof of goal progress.
- Handoff must not cancel the peer's work, lose user input, duplicate a queued
  continuation, or revive a paused goal. With no goal active, the extension is inert.

## 4. Goal checks happen near the context boundary

Here, "Codex-style" means the desired interaction pattern: let the model work
without repeatedly asking it to reconsider the goal.

- Introduce the current objective at step start. Schedule routine goal review
  near the end of the context window, around the compaction boundary, rather
  than injecting a goal check after every turn or agent-end event.
- Boundary checks decide whether to continue, complete, or report a blocker
  using the current objective and available evidence. Recovery retains a compact
  representation of that objective without accumulating reminder history.
- Completion, blockers, user pause, and safety exhaustion may be handled as soon
  as they occur; they do not need to wait for a full context window.
- Silent accounting is separate from model-facing goal review. Sparse
  reminders must never create an unbounded tool loop or bypass the execution limits.

## 5. Optional steps are deterministic and isolated

- A single objective is a one-step goal. Multiple steps are optional and use the
  same lifecycle and safety rules.
- The user accepts the ordered sequence before execution. Exactly one step is
  active; the harness advances to the next step only after current-step completion.
  The model cannot silently reorder, skip, invent, or rewrite steps.
- Completion applies to the step that produced it. Duplicate or stale completion
  events cannot complete a later step. The goal is complete only when all steps
  are complete; pausing or blocking keeps the current step selected.
- Each new step receives its own no-progress allowance. An unproductive step
  pauses the sequence rather than allowing execution to skip ahead.
- Goal-specific model context contains the current step's objective, success
  criteria, working memory, and position (`k/n`), not the full sequence or other
  steps' instructions or memory.
- A transition establishes a clean step context before execution begins. Previous
  transcripts, tool results, reminders, and hidden reasoning are not carried into
  the next step. Merely hiding other step titles is not context isolation.
- Workspace artifacts remain available. Necessary dependencies pass through
  explicit, minimal artifacts or factual handoffs, not accumulated conversation.
  The user may inspect the full sequence without injecting it into model context.

## 6. Human-defined success, agent-maintained step memory

- The human defines or explicitly accepts each step's objective and success
  criteria before it starts. Criteria can be short plain text. The agent may
  suggest clarification, but cannot silently invent, weaken, or replace them.
- Each step has one bounded working-memory record, maintained by the agent and
  persisted by the harness. Keep it to three parts:
  - **Proved:** concise findings tied to evidence, such as a test result, artifact,
    or reproducible observation relevant to a success criterion.
  - **Unresolved:** remaining questions or blockers, including failed approaches
    and what would justify revisiting them.
  - **Next:** the next concrete action toward the human-defined success criteria.
- Update memory during normal work when meaningful new evidence appears, a prior
  finding is invalidated, or the next action changes. Do not require an update or
  an extra model call every turn. These updates are distinct from routine goal
  review, which stays near the context boundary.
- Maintain a compact current record by replacing superseded facts and removing
  duplication. Store references to evidence instead of full logs, transcripts,
  or hidden reasoning. A hypothesis must not be recorded as proved, and evidence
  affected by subsequent changes must be revalidated before supporting completion.
- Memory is continuity state, not an authority to redefine success. Writing or
  rewriting it does not itself count as useful progress, replenish an allowance,
  or establish that the step is complete.
- Pause, blocking, yielding, compaction, and reload preserve the current step's
  memory. Recovery restores that record with the human-defined criteria, without
  replaying a history of memory updates into model context.
- Completion must account for every success criterion with applicable evidence.
  Human-defined criteria do not imply approval at every transition; require a
  human completion decision only when the agreed criteria explicitly require it.
- After completion is accepted, clear the completed step's working memory and
  start the next step with empty memory in an isolated context. Keep the completed
  status and workspace artifacts. Carry dependencies only through explicit minimal
  handoffs; never copy the previous step's memory wholesale.
- Memory updates belong to a specific goal and step. Delayed updates from a
  completed or replaced step cannot populate the current step's memory. Clearing
  working memory means removing active state and model context, not deleting
  workspace evidence or rewriting the host's historical session log.

## Acceptance evidence

The implementation should demonstrate these properties with deterministic
runtime tests, including controlled model responses:

- An endless bookkeeping/tool loop is bounded by the per-turn request bound, stops
  when that budget is spent, and admits no further goal-owned model request.
  Unproductive full context windows pause at the configured no-progress limit
  and stop proven goal-owned work.
- Relevant research and validation can count as progress; repeated no-op activity
  cannot. Reload and compaction do not erase a partially consumed allowance.
- Ordinary turns do not inject goal-review prompts; the context boundary does.
- With pi-orchestrate driving the session, no competing goal execution occurs;
  handoff preserves state and schedules at most one continuation.
- Each step starts with an isolated model context and its own allowance. Replayed
  completion and stale callbacks cannot skip steps or restart paused execution.
- Agent memory updates cannot alter human-defined success criteria or reset safety
  accounting. Compaction and reload recover the latest bounded record, including
  unresolved questions, without introducing a per-turn model-review loop.
- Completing a step clears its working memory before the next step runs. Stale
  updates and old transcripts cannot repopulate it; explicit handoffs remain small.

## Implementation status and decisions

Implemented in the goal-memory-and-limits feature. No-progress counting is
full-context (compaction) again; mutation-name resets stay retired in favor of
verified evidence:

- **State (invariants 2, 5, 6):** validated v2 custom entries with per-stage
  stable IDs, human-authored criteria, one current-step memory record
  (`proved`/`unresolved`/`next`, revision-bound, 8 KiB UTF-8 JSON cap), a finite
  execution grant (`generation`, no-progress/total remaining, lifetime totals,
  credited-evidence dedupe keys), `pauseReason`, and an isolation cutoff. v1
  snapshots migrate paused with titles and completed statuses preserved; no
  criteria are ever invented.
- **Human setup (invariant 6):** `/goal` collects criteria with an explicit
  contract confirm (blank means "objective as sole criterion", still confirmed);
  `/goal-multi` collects per-step criteria behind one sequence confirm; headless
  starts only from the documented JSON contract. The undocumented ` || `
  splitting is retired.
- **Accounting (invariant 1):** four durable fuses in three units. No-progress
  is charged once per full context (`session_compact`); the per-turn bound, the
  working total, and the lifetime ceiling are charged once per goal-owned
  provider request. No unlimited settings. Exhaustion pauses and withdraws
  proven goal-owned work, naming the fuse that blew. Verified evidence —
  validated on the same path as completion — resets the no-progress streak,
  clears the per-turn bound, and returns a capped grant to the working total,
  once per novel ref; it never refunds `lifetimeRequests`. Explicit resume
  grants a fresh bounded no-progress streak and a new turn; the working total
  never refills and the ceiling never lifts. Being long and being stuck are
  bounded separately: a step doing real work is not killed for its length.
- **Continuation (invariants 3, 4):** queued / delivered /
  eligible-for-next-boundary with delivery acknowledgement; one kickoff, zero
  per-turn reminders, one snapshot per eligible boundary; peer-owned sessions
  are neither charged nor advanced and never aborted.
- **Transitions (invariant 5):** terminal tools bound to goal/step/generation,
  idempotent under replay; completion requires criterion coverage from valid
  evidence (human-decision criteria block); accepted completion persists, drops
  pre-cutoff messages via the host `context` filter, clears old memory, and
  admits exactly one stage-advance kickoff — or, if isolation is unavailable,
  withholds the kickoff paused instead of running the next step in the old
  transcript.

Explicit provisional choices: 20 no-progress full contexts, a 40-request per-turn loop bound, a 400-request evidence-renewed working total and a 1000-request lifetime ceiling per grant,
8 KiB memory record, validated in fixtures before being treated as product
numbers; bytes are not tokens. Recovery reads the selected session branch and
never silently resumes or refills.
