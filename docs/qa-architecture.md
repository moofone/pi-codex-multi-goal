# Architecture QA — 2026-09-06

**Verdict at review time: not ready to claim compliance with
[architecture.md](architecture.md).**
The helper suite passes, but execution safety, recovery, continuation, peer
ownership, and step isolation have reproducible gaps. This review adds evidence
and failing contract tests; it does not change production behavior.

**Current dispositions (goal-memory-and-limits, updated after Tasks 1–9):**
F01–F09 are fixed in code and each finding below carries a `Disposition:` line
backed by maintained regressions in `test/*.test.ts`. The review-time outputs in
`qa/evidence/` (`baseline.txt`, `runtime.txt`, `typecheck.txt`) are retained
verbatim as historical evidence; `environment.json`, `source-sha256.txt`, and
`host-capabilities.txt` are refreshed by `qa/run.mjs`. Two limitations remain
explicitly open and are **not** advertised complete: (1) admission is a
schedule-side fallback — `before_provider_request` cannot deny a request
including retries (probe 1 `[fail]`), so A04's host-side admission barrier is
not claimed; (2) no offline-drivable live agent loop exists, so end-to-end
admission, delivery, and isolation behavior is not behaviorally verified. See
[Remaining host limitations](#remaining-host-limitations).

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

**Disposition (fixed):** `src/allowance.ts` persists a finite no-progress/total
grant per step. No-progress is charged once per full context (`session_compact`);
the total budget is charged once per goal-owned provider request at provider
entry (kickoff, continuations, retries, recovery). Reloads never refund,
lifetime totals never reset, and settings no longer accept unlimited values
(`test/admission.test.ts`, `test/stall.test.ts`). Verified evidence resets only
the no-progress streak, once per novel ref (`test/progress-credit.test.ts`); a
spent no-progress streak pauses at compaction, not at tool-loop turns
(`test/admission.test.ts`, `no-progress exhaustion is full contexts, not turns, and stops`),
and valid exhaustion withdraws proven goal-owned work. Remaining gap: the host
hook cannot deny retries (probe 1), so the in-flight provider request itself is
not walled off — A04's barrier is not claimed.

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

**Disposition (fixed):** pause, clear, block, replacement, and shutdown
invalidate goal work, drop the queued follow-up, and abort goal-owned in-flight
work exactly once; user-owned turns are never aborted (`test/continuation.test.ts`,
`pause withdraws goal work not peer`). Because `ctx.abort()` is process-global
(probe 2), abort is called only after the ownership decision, so peer and user
work stay untouched. End-to-end queue/delivery races in a live host remain
unverified (no offline live agent loop).

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

**Disposition (fixed):** `execution` counters and `pauseReason` are persisted in
the v2 entry; `session_start`/`session_tree` restore the selected branch paused
with the charged grant unchanged (`test/runtime-recovery.test.ts`,
`selected branch restore stays paused without refill`; persisted-failure admits
no goal work).

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

**Disposition (fixed):** `src/continuation.ts` tracks queued / delivered /
eligible-for-next-boundary with delivery acknowledgement on the supported host
message events; at most one continuation is pending, ordinary `agent_end` turns
never send, and each eligible boundary sends exactly one snapshot
(`test/continuation.test.ts`, `one kickoff one boundary no per-turn spam`).

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

**Disposition (fixed):** `update_goal` is bound to the originating
goal/step/generation; replaying the same tool-call id is a no-op and two
terminal calls in one response advance exactly one step
(`test/completion-isolation.test.ts`, `duplicate complete does not skip`).

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

**Disposition (fixed):** completion is bound to goal/step/generation and is
idempotent under replay and duplicate same-response calls; the tool result
acknowledges only the old step; the accepted transition persists, drops
pre-cutoff messages via the `context` filter (probe 3 `[pass]`), clears old
memory, and admits exactly one stage-advance kickoff
(`test/completion-isolation.test.ts`). If the filter capability were missing,
the kickoff is withheld and execution stays paused instead of falling back to
the old transcript. Live provider-payload confirmation remains unavailable
(no offline live agent loop).

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

**Disposition (fixed):** one `shouldYield` decision now gates scheduling,
admission accounting, terminal tools, cancellation, and handoff: peer-owned
compactions and provider entries neither spend nor reset the allowance,
`update_goal complete` refuses to advance, and withdraw never aborts the peer
(`test/continuation.test.ts`, ownership section; `test/progress-credit.test.ts`).
Live coexistence in a real session with both extensions loaded remains unvalidated.

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

**Disposition (fixed):** reconstruction reads `getBranch()` (selected ancestry),
skips malformed snapshots, restores that branch paused without refill, and
fences outstanding continuations (`test/runtime-recovery.test.ts`).

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

**Disposition (fixed):** status uses `ui.setStatus(CUSTOM_ENTRY_TYPE, text)` and
clears with the key (`test/runtime-status.test.ts`); `allowImportingTsExtensions`
lands with a `typecheck` script, and `npm test` now runs `tsc --noEmit` before
the suite (`test/npm-test-script.test.ts`), so typecheck is on the normal
verification path (A12).

## Additional source observations

- ~~`isMultiGoal` checks only numeric index range, not integer index or
  consistent stage statuses.~~ Resolved in goal-memory-and-limits Task 2: v2
  validation requires integer index, a consistent unique active stage, unique
  IDs, and the 8 KiB memory bound; malformed snapshots are skipped on restore.
- ~~README says `/goal` is single-objective, but `parseStageTitles` and an
  existing passing test accept `one || two`.~~ Resolved in Task 3: the
  undocumented ` || ` splitting is retired (`test/parse.test.ts`), `/goal` is
  single-objective, and the README documents the JSON headless contract
  (`test/readme-contract.test.ts`).
- The wizard confirms ordered titles and handles cancellation; normal completion
  advances one step and blocking preserves the index. These passing paths do not
  cover replay, context isolation, or cancellation of ongoing execution.
  Superseded by the maintained regressions in `test/wizard.test.ts`,
  `test/completion-isolation.test.ts`, and `test/continuation.test.ts`.

## Remaining host limitations

Recorded by `qa/host-capabilities.test.ts` against the installed peer (currently
Pi 0.84.4) in [`qa/evidence/host-capabilities.txt`](../qa/evidence/host-capabilities.txt),
refreshed by `qa/run.mjs`. Until these change, the affected capabilities stay
disabled or fallback-only and are not advertised complete:

- **No deny-including-retries (probe 1: fail).** `before_provider_request`
  observes and may replace the payload, but a denying handler is swallowed and
  the request proceeds; the hook also fires before the provider's internal retry
  loop. Enforcement is therefore a schedule-side fallback: goal continuations
  stop being requested once the allowance reaches 0, and every goal-owned
  request is charged durably once at provider entry. A04's host-side admission
  barrier is NOT claimed.
- **No offline live agent loop (unavailable).** `createAgentSession` performs
  real provider requests; there is no offline-drivable loop, so admission,
  retry, delivery, and isolation behavior is not behaviorally verified
  end-to-end. An isolated real-Pi two-extension session remains future work.
- **`ctx.abort()` is process-global (probe 2: pass, scope unproven).** The
  extension aborts only after proving goal ownership (Task 6), never peer or
  user work.
- **Context filter (probe 3: pass at boundary level).** A `context` handler's
  returned `messages` replaces the provider-visible list, which is the isolation
  mechanism for step transitions; its behavior inside a live agent loop is
  unconfirmed, so `test/completion-isolation.test.ts` withholds the next
  kickoff and stays paused if the recorded probe stops passing.
- **No `newSession` from tool callbacks (probe 4: pass).** Session replacement
  is unreachable from a tool context, so isolation never uses `newSession`.

## Reproduction and acceptance gate

At review time, the added tests intentionally asserted required behavior and
failed; they lived outside `test/*.test.ts` so the original baseline remained
independently measurable. They have since been converted into maintained
regressions under `test/*.test.ts` (green, run by `npm test` together with
`tsc --noEmit`); the historical probe suite `qa/runtime.test.ts` and its
retained outputs assert the pre-fix semantics and are kept verbatim as review
evidence — failing requirements are documented, not deleted.

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
