# Architecture QA — 2026-09-06

**Verdict: not ready to claim compliance with [architecture.md](architecture.md).**
The helper suite passes, but execution safety, recovery, continuation, peer
ownership, and step isolation have reproducible gaps. This review adds evidence
and failing contract tests; it does not change production behavior.

## Scope and results

Reviewed all production modules, the existing tests, and the architecture contract.
Checked relevant API contracts against installed Pi **0.84.4**, and session-tree
and ownership conventions in the adjacent Pi and pi-orchestrate source trees.
No live model requests, production orchestration runs, or external actions occurred.

| Check | Result | Evidence |
| --- | --- | --- |
| Existing tests (`rtk npm test`) | 15 passed, 0 failed | [Retained baseline rerun](../qa/evidence/baseline.txt) |
| Added architecture/runtime probes | 16 executed: 3 controls passed, 13 contract assertions failed | [Runtime output](../qa/evidence/runtime.txt) |
| TypeScript with installed peers | Failed: 5 status-signature diagnostics and 9 test-import diagnostics | [Compiler output](../qa/evidence/typecheck.txt) |
| Revision provenance | Directory has no Git repository; source hashes retained instead | [SHA-256 manifest](../qa/evidence/source-sha256.txt) |
| Environment | Node v24.10.0; installed Pi 0.84.4 | [Environment record](../qa/evidence/environment.json) |

The runtime probes call the real extension registration, command handlers, tool
handler, and event callbacks using a controlled Pi host. QA-14 also uses Pi's real
in-memory `SessionManager` to build model context. These are boundary tests, not
full provider/agent-loop tests. In particular, the 100-turn probe demonstrates
missing extension enforcement; it does not measure actual token consumption or
prove a specific provider-request overshoot. Queue withdrawal and cancellation
still require real-host tests after remediation.

## Invariant coverage

| Architecture invariant | Assessment | Findings |
| --- | --- | --- |
| 1. Bound unproductive execution | Fail: no request/turn ceiling; pause is not execution cancellation; accounting resets | F01–F03 |
| 2. Small, explicit controller | Partial: compact modules and one continuation object, but replay and recovery are incorrect | F04, F05, F08 |
| 3. Peer coexistence | Fail: follow-up suppression works in the simple case; other runtime paths ignore ownership | F07, F09 |
| 4. Review near context boundary | Fail: no boundary-only scheduling policy; sent marker suppresses boundary continuation | F04 |
| 5. Deterministic, isolated steps | Fail: duplicate completion advances twice; old context persists | F05, F06, F08 |

P1 below means an execution-safety or core lifecycle failure that blocks this
architecture's acceptance. P2 means a functional or validation defect.

## Findings

### F01 — P1: no finite turn ceiling or useful-progress accounting

**Evidence:** [runtime.ts](../src/runtime.ts), [stall.ts](../src/stall.ts),
[settings.ts](../src/settings.ts); QA-01 remains active after 100 consecutive
read/tool turns without compaction.

The only limit counts threshold/overflow compactions. There is no turn counter or
provider-admission gate, so an ongoing tool loop cannot exhaust a turn allowance.
Settings also permit `0`/`null` to disable the sole fuse. Successful tools named
`edit`, `write`, or `apply_patch` reset the streak regardless of relevance or actual
progress. Research/validation results cannot reset it through their evidence.

**Required outcome:** a finite, persisted per-step allowance enforced before
goal-owned model admission, with an explicit conservative progress rule. Validate
kickoff, tool continuations, retries, and recovery through a controlled provider;
the limit must hold without waiting for natural idle or compaction.

### F02 — P1: pause changes state without stopping submitted execution

**Evidence:** [commands.ts](../src/commands.ts), `setGoal` and the compaction pause
path in [runtime.ts](../src/runtime.ts), `clear` in
[continuation.ts](../src/continuation.ts); QA-06 and QA-07.

Pausing clears only the extension's timer and local sent marker. It neither
withdraws a message already handed to Pi nor invokes cancellation for active
goal-owned work. The controlled host retains one submitted message after pause;
the active-turn probe records zero abort calls. Clearing or blocking follows the
same local-clear pattern.

**Required outcome:** pause/clear/block invalidate future goal execution and stop
owned in-flight work without aborting pi-orchestrate or user-owned work. Verify
the actual host queue and provider entry boundary, including races with delivery.
Calling a global abort indiscriminately would not satisfy peer coexistence.

### F03 — P1: restart replenishes the stall allowance

**Evidence:** `session_start` in [runtime.ts](../src/runtime.ts), persisted
`MultiGoal` in [types.ts](../src/types.ts); QA-08.

Four sterile compactions followed by shutdown/re-registration/start and another
sterile compaction leave the goal active. Without the reload, the five-compaction
control pauses correctly. The streak and pause reason are memory-only;
`session_start` explicitly resets them. A restart therefore defeats even the
existing, weaker safety fuse and loses a safety pause's explanation.

**Required outcome:** persist and restore safety accounting and pause reason;
restart and compaction must not grant new work allowance.

### F04 — P1: the sent marker permanently suppresses continuation

**Evidence:** `send`, `request`, and `clear` in
[continuation.ts](../src/continuation.ts); runtime event registration; QA-02.

Sending sets `queuedFor = goalId`. No delivery/turn handler acknowledges and
clears it. After kickoff is delivered, a threshold compaction still produces only
one total message instead of the expected boundary continuation. The marker is
cleared by lifecycle changes, not ordinary delivery.

The source also requests continuation at every `agent_end` without checking
context proximity. **This does not currently prove a prompt is sent every turn:**
the stuck marker suppresses those requests too. The passing ownership-release
control confirms a deferred kickoff can be sent once; that is not itself a
cadence violation. Simply clearing the marker after each turn would expose the
unconditional agent-end scheduling and introduce repeated reminders.

**Required outcome:** distinguish queued, delivered, and eligible-for-next-boundary
states with minimal explicit state. Prove one kickoff, no routine per-turn
reminders, and exactly one continuation at an eligible context boundary.

### F05 — P1: duplicate completion skips a step

**Evidence:** `execute` in [tools.ts](../src/tools.ts), `completeCurrentStage` in
[state.ts](../src/state.ts); QA-04.

Calling `update_goal(complete)` twice with the same tool-call ID advances from
step 1 to step 3. The handler ignores `_toolCallId` and acts on whichever step is
current when invoked. There is no originating step/generation check. A stale
completion can therefore finish work that was never performed.

**Required outcome:** bind terminal actions to their originating goal and step,
reject stale actions, and make replay of the same completion idempotent. Test
duplicate calls in one response as well as delayed/replayed calls after advance.

### F06 — P1: step advance retains old context and exposes the next objective

**Evidence:** `completeStage` in [runtime.ts](../src/runtime.ts), completion result
in [tools.ts](../src/tools.ts); QA-05 and QA-14.

Advance queues the next wrapper in the same session. The completion tool result
already contains `current: <next step title>`, so the old step's tool loop can see
the next objective immediately. No context reset/filter or new session occurs.
Building context with Pi's real `SessionManager` retains a previous-step sentinel
alongside the next wrapper.

The existing prompt test proves only that a newly formatted wrapper omits other
titles. It does not establish transcript isolation.

**Required outcome:** close old-step execution, establish an isolated context,
then introduce the next objective. Transfer only deliberate factual artifacts or
handoffs. Inspect the messages actually sent to the provider at the transition.

### F07 — P1: pi-orchestrate ownership guards only follow-up scheduling

**Evidence:** `shouldYield` in [continuation.ts](../src/continuation.ts),
compaction/tool/completion paths in [runtime.ts](../src/runtime.ts); QA-09, QA-10,
QA-13. Simple matching-session suppression is covered by existing passing tests
and the new handoff control.

With a matching live Feature:

- Five compactions pause the goal despite pi-orchestrate owning execution.
- A successful orchestrate `write` resets the goal's existing stall streak.
- The goal completion tool still advances the step, although its follow-up is suppressed.

Ownership is inferred by scanning status files; it is not enforced across all
execution and state-transition boundaries. Abort handling also checks assistant
messages without determining which controller owned the aborted work (source
finding; not a separate runtime probe).

**Required outcome:** apply the same ownership decision to admission, accounting,
terminal tools, cancellation, and handoff. Prove an ownership change cannot leak
queued goal work or affect the peer. Live coexistence is not yet validated.

### F08 — P1: tree navigation restores state from other branches

**Evidence:** `session_start`/`session_tree` in [runtime.ts](../src/runtime.ts),
`reconstructGoal` in [state.ts](../src/state.ts); QA-12. Pi's `getEntries()` returns
all entries; `getBranch()` returns the selected ancestry.

Reconstruction reads the entire append-only log and chooses the last goal
snapshot, regardless of the selected branch. Returning to a branch at step 1
still restores off-branch step 2; the next completion advances to step 3.
An off-branch clear or status change can likewise affect reconstruction.

**Required outcome:** define branch recovery explicitly, read the authoritative
branch, and fence old callbacks and accounting across navigation. Validate using
the real session-tree API in addition to the controlled branch probe.

### F09 — P2: status integration and project type-checking fail

**Evidence:** `refresh` in [runtime.ts](../src/runtime.ts),
[tsconfig.json](../tsconfig.json); QA-11 and retained compiler output.

Pi expects `ui.setStatus(key, text)`. The extension passes its display text as the
only argument, so it becomes the key and the text is undefined. The normal status
is not registered under a stable extension key. This is not evidence of an
observed collision with pi-orchestrate; it is a confirmed API misuse.

The compiler additionally rejects nine existing `.ts` test imports because
`allowImportingTsExtensions` is absent. `npm test` runs tsx and does not catch
these type errors. The package has no typecheck script and uses wildcard optional
peer dependencies, so a supported Pi API range is not documented/enforced.

**Required outcome:** use a stable status key, correct the TypeScript configuration,
and add a repeatable typecheck against supported installed peers.

## Additional source observations

- `isMultiGoal` checks only numeric index range, not integer index or consistent
  stage statuses. A malformed persisted snapshot can pass validation and later
  fail in `currentStage`, or represent multiple active stages. This is a P2
  recovery-hardening gap, not a reproduced corruption in a real session.
- README says `/goal` is single-objective, but `parseStageTitles` and an existing
  passing test accept `one || two`. Align the documented command contract.
- The wizard confirms ordered titles and handles cancellation; normal completion
  advances one step and blocking preserves the index. These passing paths do not
  cover replay, context isolation, or cancellation of ongoing execution.

## Reproduction and acceptance gate

The added tests intentionally assert required behavior and currently fail. They
live outside `test/*.test.ts` so the original baseline remains independently
measurable. Do not interpret its green result as architecture acceptance.

Run the isolated QA harness with an installed Pi package and an existing toolchain:

```sh
rtk proxy node qa/run.mjs \
  /Users/greg/.nvm/versions/node/v24.10.0/lib/node_modules/@earendil-works/pi-coding-agent \
  /Users/greg/Dev/git/pi/node_modules
```

The runner copies source into a temporary directory, links installed peers there,
retains raw results and hashes under `qa/evidence`, and exits nonzero on failed
checks. It does not install packages or change production source. The package
path must contain its `pi-ai` and `typebox` dependencies; the toolchain directory
must contain `tsx`, `typescript`, and `@types/node`.

Before sign-off, fix the ownership/accounting and transition boundaries, make
these contract tests and typechecking pass, then run controlled provider tests
for exact admission limits, retries, cancellation, queued-message races, restart,
and actual next-step model context. Finish with an isolated real Pi session
loading both extensions. No production-readiness or live coexistence claim is
supported by this review alone.
