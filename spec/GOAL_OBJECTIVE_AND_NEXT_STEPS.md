# Goal objective and next steps

Status: implementation plan; no implementation or release approval implied.
Created: 2026-09-06.

Authoritative behavior: [architecture invariants](../docs/architecture.md).
Starting defects and evidence: [architecture QA](../docs/qa-architecture.md).

## Objective

Support long-running single- and multi-step goals with human-defined success
criteria, small agent-maintained working memory, and harness-enforced execution
limits. The agent should retain useful evidence through compaction and restart,
stop when it cannot make progress, and start each new step without the previous
step's conversation or working memory.

The human decides what success requires. The agent records what has been proved,
what remains unresolved, and the next concrete action. The harness owns durable
state, budgets, execution ownership, cancellation, and transitions.

## Scope

Implement architecture invariants 1–6 as one coherent lifecycle. Include the
existing QA defects because adding memory on top of unsafe continuation and step
transitions would preserve the same failures.

Keep the first version small: one goal state, one current-step memory record, one
continuation owner, and one accounting path. Use existing modules where possible.
Do not add a general planner, semantic scoring engine, evaluator model, vector
database, cross-step memory service, or per-turn goal-review loop. External-event
waiting and richer experiment tracking remain follow-up work.

## Baseline and evidence limits

The retained QA run reports 15 passing existing tests, 13 failing architecture
assertions with 3 passing controls, and a failed typecheck against Pi 0.84.4.
Its provider and queue behavior is partly mocked; those results are not a full
agent-loop admission or cancellation proof.

At plan creation, every production file, `package.json`, and `tsconfig.json` still
matches the [QA source hashes](../qa/evidence/source-sha256.txt).
`docs/architecture.md` has subsequently gained invariant 6; that new memory
contract was not covered by the original QA run. Capture fresh hashes and test
results before implementation. This directory currently has no Git repository;
use content hashes unless a repository is established separately.

## Intended user behavior

1. `/goal <objective>` collects human success criteria and shows the resulting
   contract before starting. `/goal-multi` collects an objective and criteria for
   each step, then confirms the ordered sequence once.
2. During execution, the agent updates memory only when relevant evidence,
   unresolved work, or the next action changes. No repeated confirmation is needed.
3. `/goal` shows the current contract, memory, status, and remaining allowance to
   the human without injecting all steps into model context.
4. Pause, block, compaction, reload, and peer ownership preserve the current
   contract and memory. Explicit resume continues the same step with a bounded
   allowance and its previous evidence available.
5. Completion accounts for the human's success criteria. The harness closes the
   old step, clears its working memory, establishes isolated context, and then
   starts the next step. Human approval at completion is required only if the
   human included that requirement in the contract.

Keep `/goal` single-objective and multi-step creation in `/goal-multi`; retire the
undocumented ` || ` splitting behavior and update its test. A headless caller
must provide the complete human-authored contract through a documented structured
input path. Missing criteria leave the goal unstarted; the agent cannot fabricate
them. The objective itself may be accepted by the human as the success criterion
when it already expresses an observable result.

## State and ownership design

### Human contract

Each step has a stable ID, objective, and nonempty list of success criteria with
stable criterion IDs. Preserve the accepted sequence and contract unchanged during
execution. Model tools cannot mutate these fields. For the first version, use
explicit user replacement to change a contract; preserve the old session history
and create a new goal identity instead of adding in-place contract revisions.

### Current-step memory

Store one bounded record for the current step:

| Field | Content |
| --- | --- |
| `proved` | Concise claims with criterion IDs and evidence references |
| `unresolved` | Open questions, blockers, and failed approaches worth remembering |
| `next` | One concrete next action, or empty when ready for terminal handling |

Evidence references identify actual artifacts or observed tool results. Preserve
enough provenance to distinguish a current observation from a stale result:
for example, the relevant file/content revision and the producing operation.
Avoid copying raw logs into memory. A record's placement in `proved` is an agent
claim until the applicable verification has occurred; it is not automatic proof.

Proposed initial storage limit: **8 KiB of UTF-8 JSON for the complete memory
record**, including evidence references. Reject oversized updates with a concise
instruction to reduce them; retain the previous valid record. Do not silently
truncate evidence or call another model to summarize it. Validate this provisional
limit with the long-run fixture before finalizing it; bytes are not a token count.

### Durable runtime state

Extend the versioned persisted state with current-step memory, execution allowance,
pause reason, and the minimum identities needed for request/transition recovery.
Bind work to a goal ID, step ID, and execution generation. Generation changes
invalidate stale callbacks without granting additional budget.

Persist an accepted change before acknowledging it or admitting dependent work.
If persistence fails, retain the last committed state and stop goal admission with
a visible error. Validate integer indices, stage order/status consistency, record
sizes, and IDs on recovery. Never expose a partially updated contract/memory pair.

Read goal state from the selected session branch. Tree navigation invalidates
outstanding work and restores that branch paused for an explicit user decision;
it must not silently reactivate old work or refill an execution allowance. Record
the chosen branch/accounting recovery behavior in tests before enabling resume.

Completed steps retain status and any small explicit completion receipt needed
for human inspection; their active memory is removed. Historical session entries
and workspace artifacts remain intact. Historical memory is never automatically
reintroduced into model context.

## Model interaction and evidence rules

### Memory update

Add one narrowly scoped tool, provisionally `update_goal_memory`, that replaces
the current bounded record. Include expected step identity and memory revision;
replayed identical updates are no-ops, and stale or conflicting updates are
rejected. Bind calls to the originating execution as well as validating supplied
IDs, so an old call cannot claim a newly active step.

Return only a small acknowledgement/revision. Do not echo the contract, the whole
memory record, or the next step's objective. Updates cannot change success
criteria, transition a step, or replenish the allowance. Memory-only tool loops
consume the same no-progress allowance as other unproductive activity.

### Goal prompt and recovery

At step start and an eligible context boundary, supply exactly one current
contract/memory snapshot with `k/n`. Replace older extension-owned snapshots in
the model view; do not replay a growing list of reminders or memory updates.
Ordinary working turns receive no additional goal-review prompt.

Use the already committed memory for crash recovery. Do not depend on a final
model-written summary arriving before a crash or overflow. Evidence discovered
but not committed remains unproved after recovery and must be re-established.

### Progress and completion

Use one evidence-validation path for progress credit and completion checks.
Start with narrow deterministic checks: reference existence, producing operation,
result/fingerprint, criterion association, and whether that observation has
already received credit. A filename, successful tool exit, changed memory text,
or arbitrary edit alone is insufficient. Repeated pass/fail toggling of the same
evidence must not repeatedly refill the allowance.

These checks establish provenance and novelty, not universal semantic relevance.
Identify which acceptance checks the harness can actually verify, using the
human's declared criteria. Other claims remain explicitly agent-assessed; if they
cannot safely earn automatic progress credit, preserve them in memory without
resetting the counter. Do not claim arbitrary prose has been mechanically proved.
This evidence policy must pass both a coding and a read-only investigation fixture
before declaring invariant 1 satisfied.

Extend terminal handling to provide criterion-to-evidence coverage. Missing,
invalidated, or unresolved criteria prevent completion. If the human's criteria
require a human decision, preserve the step blocked awaiting that decision.
Otherwise completion can proceed automatically after the applicable checks.

## Execution safety and step transitions

### Accounting

- Count every admitted goal-owned model request, including kickoff, tool-loop
  continuations, retries, and recovery. Check allowance before provider entry;
  do not rely on `agent_end` or post-request accounting.
- Maintain a finite no-progress allowance and a finite total allowance for the
  current execution grant. Proposed initial defaults are 20 no-progress requests
  and 200 total requests; these are provisional values to evaluate in fixtures.
  Neither limit accepts an unlimited setting in the safe default mode.
- Verified progress resets only the no-progress streak. Explicit user resume may
  grant a new bounded allowance. Lifetime step request/usage totals remain visible
  and never reset across grants; a new step starts its own accounting.
- Reserve/charge admitted work durably once. Reload, retries, terminal tool calls,
  and uncertain in-flight outcomes must not return already consumed allowance.
- Track available token usage for human inspection. A request ceiling alone is
  not an exact token or monetary ceiling; missing provider usage must remain
  unknown. Exact monetary limits are outside this first implementation.

### Ownership and continuation

Use the same ownership decision for admission, memory, progress credit, terminal
tools, cancellation, and handoff. While pi-orchestrate owns the session, preserve
goal state and admit no goal work. Do not count peer events, take over its status
key, rewrite its prompts, or abort its operation.

Replace the never-cleared `queuedFor` marker and idle polling with explicit
delivery acknowledgement and eligible boundary state using supported host events.
Keep at most one pending goal continuation. Revalidate ownership, goal/step
identity, status, and allowance at delivery and provider admission. User messages
take precedence without clearing or overwriting their content.

### Completion boundary

1. Validate completion against the originating step and committed evidence.
2. Durably record completion and invalidate further old-step work. The tool result
   acknowledges only that old step; it does not expose the next objective.
3. Stop old-step execution and establish a clean provider-visible context boundary.
4. Remove old working memory, initialize the next step's empty memory/allowance,
   and persist the transition before its single kickoff can be admitted.

Persist enough transition state that restart after any boundary resumes this
sequence once. Failure to isolate leaves execution paused; it cannot fall back to
running the next step in the old transcript. Allow only explicit minimal factual
handoffs required by a declared dependency. Handoffs cannot introduce instructions
or redefine the next step's success criteria.

## Implementation sequence

### Phase 0 — Establish the host capabilities and regression baseline

- [ ] Refresh source hashes, baseline tests, and the existing QA reproductions.
- [ ] Correct the status signature, test import configuration, and reproducible
  dependency/typecheck setup. Specify the tested Pi API range. Addresses F09.
- [ ] Build a controlled provider fixture through Pi's actual agent loop. Locate
  a pre-admission stop mechanism that prevents the next provider request, including
  retries, and a means to cancel only goal-owned work and pending messages.
- [ ] Prove an automatic step-isolation mechanism and its behavior when both
  extensions are loaded. Inspect the actual provider payload, not only wrappers.

**Gate:** document the actual APIs and passing capability probes. Installed Pi
0.84.4 has `context` message filtering, `before_provider_request` payload hooks,
and `ctx.abort()`, but their existence does not prove an admission barrier.
`newSession()` belongs to `ExtensionCommandContext`, not ordinary tool callbacks;
do not cast a tool context to that type or reuse a stale command context.
If a required guarantee needs a Pi API change, record it as an explicit dependency
and keep the affected automation disabled until it is available. Do not patch the
peer extension or replace the guarantee with prompt instructions.

### Phase 1 — Persisted contract, memory, and human setup

- [ ] Extend [types.ts](../src/types.ts), [state.ts](../src/state.ts), and
  [persistence.ts](../src/persistence.ts) with validated version-2 state.
- [ ] Update [commands.ts](../src/commands.ts), [wizard.ts](../src/wizard.ts), and
  [parse.ts](../src/parse.ts) for accepted human criteria and consistent commands.
- [ ] Migrate version-1 snapshots without inventing criteria or reconstructing
  missing safety history. Preserve titles and completed statuses; restore
  unfinished legacy goals paused for criteria confirmation and a bounded grant.
- [ ] Restore the selected branch safely and persist pause explanations. Address
  F03, F08, and malformed-state observations.

**Gate:** contract immutability, validation, migration, persistence-failure, and
branch recovery tests pass. Cancelling setup leaves the existing goal untouched.

### Phase 2 — Admission, ownership, and cancellation

- [ ] Implement the proven Phase-0 admission path in [runtime.ts](../src/runtime.ts),
  replacing compaction/mutation counting in [stall.ts](../src/stall.ts).
- [ ] Update [settings.ts](../src/settings.ts); retire the old unlimited and
  compaction-based semantics with a documented migration.
- [ ] Repair [continuation.ts](../src/continuation.ts) delivery acknowledgement and
  context-boundary eligibility together; fixing the marker alone must not create
  per-turn reminder spam.
- [ ] Apply ownership consistently through [yield.ts](../src/yield.ts) and runtime
  transitions. Cover pause, clear, replacement, block, abort, and shutdown.
  Addresses F01, F02, F04, F07.

**Gate:** a fake provider emitting bookkeeping tools forever, with allowance 3,
enters exactly three requests and never a fourth. Repeat for kickoff, retry,
reload, compaction, and ownership handoff. No peer or user request is cancelled.

### Phase 3 — Bounded memory and sparse goal review

- [ ] Add the memory tool and narrow evidence checks in [tools.ts](../src/tools.ts)
  and a small memory module only if it keeps validation separate from orchestration.
- [ ] Render current contract/memory through [prompts.ts](../src/prompts.ts) and
  the Phase-0 model-context boundary. Persist updates without echoing them.
- [ ] Reject stale writes, deduplicate unchanged records, preserve unresolved
  approaches, and invalidate evidence affected by later changes.
- [ ] Show memory and counters in human status without polluting model context.

**Gate:** memory survives interruption; repeated rewrites neither grow the injected
snapshot nor earn progress; ordinary turns add zero review calls. Both coding and
read-only investigation fixtures retain useful evidence with bounded memory.

### Phase 4 — Evidence-backed completion and isolated advancement

- [ ] Bind terminal tools to goal/step/generation and deduplicate completions.
- [ ] Implement the durable completion boundary and clean next-step context.
- [ ] Clear old memory only after completion is accepted; reject late writes and
  callbacks. Preserve current memory on pause/block. Addresses F05 and F06.

**Gate:** inspect the next actual provider request for old transcript, old tool
results, old memory, and other step titles. All are absent except explicitly
allowed handoff facts. Crash/replay at each boundary cannot skip or repeat a step.

### Phase 5 — Integration QA and documentation

- [ ] Convert confirmed QA findings into maintained behavioral regressions. Keep
  historical evidence separately; do not delete failing acceptance requirements
  merely to make the suite green. Adapt mock-specific tests to the chosen host API.
- [ ] Add a repeatable integration/typecheck command and include it in the normal
  project verification path. No architecture gate may silently run zero tests.
- [ ] Run an isolated real Pi session with both extensions, including step advance,
  peer handoff, user interruption, compaction, restart, and completion.
- [ ] Update README, architecture implementation status, settings/command migration,
  and QA findings with fresh source hashes, commands, and evidence limits.

## Acceptance matrix

| ID | Required observation | Traceability |
| --- | --- | --- |
| A01 | Missing/unaccepted criteria cannot start; model writes cannot change them | Invariant 6 |
| A02 | New evidence updates one bounded record; unchanged updates are no-ops; oversized/stale writes preserve valid state | Invariants 2, 6 |
| A03 | Pause/block/yield/reload/compaction preserve the current memory and accounting | Invariants 1, 3, 6; F03, F07 |
| A04 | Endless tool use stops at configured provider admission limit without natural idle | Invariant 1; F01 |
| A05 | Pause/clear/block withdraw or invalidate goal work while preserving peer and user work | Invariants 1, 3; F02 |
| A06 | Kickoff occurs once; ordinary turns add no goal-review prompts; each eligible boundary receives one current snapshot | Invariant 4; F04 |
| A07 | Replayed completion and two terminal calls in one response cannot advance twice | Invariants 2, 5; F05 |
| A08 | Next provider context has empty step memory and no old transcript or next-step leakage into the previous tool result | Invariants 5, 6; F06 |
| A09 | Peer-owned events neither spend nor reset goal allowance or mutate memory/steps | Invariant 3; F07 |
| A10 | Selected-branch restore and legacy migration never silently replenish or resume work | Invariants 1, 2; F03, F08 |
| A11 | Missing/stale evidence blocks completion; a human-review criterion requires the human decision | Invariant 6 |
| A12 | Typecheck and existing/new integration suites pass with a nonzero test count on the supported Pi version | F09; release gate |

Use deterministic clocks and controlled model responses for repeatable tests.
Retain provider-entry counts, abort observations, persisted snapshots, and actual
provider messages. Long-run fixtures must cross several context boundaries and
include restart and at least two steps; a prompt-format test alone is insufficient.
Record memory size, repeated-work count, review-call count, and available token
usage. Report observed cost changes without claiming a percentage saving before
measurement.

## Definition of done

All acceptance rows pass; F01–F09 have current disposition and supporting evidence;
legacy goals recover safely; and a two-step end-to-end run meets human-authored
criteria with bounded memory, bounded unattended execution, and clean step context.
The agent cannot change success, memory churn cannot buy more execution, and no
goal continuation interferes with pi-orchestrate. Remaining host limitations are
explicitly documented and prevent the affected capability from being advertised
as complete.

The first implementation action is Phase 0. Do not enable automatic multi-step
execution until admission, cancellation, and context-isolation gates pass.
