# pi-codex-multi-goal

Codex-style `/goal` for Pi: the human defines the objective and its success
criteria; the harness owns execution limits, accounting, and step transitions.
The model sees only the current step's contract plus one small working-memory
record, injected at step start and at eligible context boundaries — never the
whole sequence, other steps, or previous transcripts.

## Install

```bash
pi install /Users/greg/Dev/git/pi-codex-multi-goal
```

Do not load this together with another `/goal` owner (narumitw, kky42, pi-codex-goal).

## Usage

```
/goal <objective>   TUI: prompts for success criteria, then confirms the contract
/goal-multi         multi-step: per-step objective + criteria, then one sequence confirm
/goal               show contract, working memory, status, and remaining allowance
/goal pause         pause and withdraw goal-owned work (in-flight goal work aborts once)
/goal resume        explicit resume; grants a fresh bounded no-progress allowance
/goal clear         remove the goal
```

`/goal-multi` asks how many steps, collects an objective and a criteria list for
each, previews the sequence, and starts only after one confirm. Cancelling setup
or rejecting the preview leaves an existing goal untouched.

### Headless (no TUI): JSON contract only

Plain text never starts a goal headless — an agent cannot fabricate criteria.
`/goal` starts only from the full JSON contract:

```json
/goal { "objective": "pin the duplicate SUBMIT", "criteria": ["duplicate SUBMIT pin documented"] }
```

Multi-step goals pass `steps` (every step needs an objective and nonempty criteria):

```json
/goal { "steps": [ { "objective": "pin the duplicate", "criteria": ["lockfile updated"] }, { "objective": "document the pin", "criteria": ["README section merged"] } ] }
```

Missing or empty `criteria` refuse to start. In the TUI, leaving the criteria
blank means "the objective is the sole criterion" and still requires an explicit
contract confirm.

## Model-facing tools

- `update_goal { goalId, step, generation, status: "complete" | "blocked", evidence? }`
  finishes or blocks **this step only**. Calls are bound to the originating
  goal/step/generation: replayed or stale completions are idempotent rejections,
  and two terminal calls in one response cannot advance twice. Completion
  requires evidence covering the human's criteria; a criterion marked
  `requiresHumanDecision` keeps the step blocked awaiting the human. The result
  acknowledges only the old step and never reveals the next objective.
- `update_goal_memory { goalId, step, generation, revision, proved, unresolved, next }`
  replaces the current step's bounded working-memory record (at most **8 KiB of
  UTF-8 JSON**, provisional). Stale or oversized writes are rejected and keep
  the previous record. Memory writes never change criteria, transition a step,
  or refill the allowance.

## Limits (provisional)

Each step gets a finite execution grant. Defaults: **20** provider requests
without verified progress and **200** total. There is no unlimited mode: `0`,
`null`, and malformed values clamp to the finite defaults. Verified evidence
(the same validation path completion uses) resets only the no-progress streak,
once per novel evidence ref; memory rewrites, tool success, and
`edit`/`write`/`apply_patch` calls alone earn nothing. Reloads, retries, and
compaction never refund; lifetime totals never reset. Exhaustion pauses the goal
with a persisted reason, and `/goal resume` grants a fresh bounded no-progress
streak only.

Settings live in `~/.pi/agent/pi-codex-multi-goal.json`:

```json
{ "noProgressLimit": 20, "totalLimit": 200 }
```

Migration: `maxCompactionsWithoutMutation` is retired — full-context-window
counting no longer gates execution. A positive legacy value migrates onto
`noProgressLimit`; the old `0`/`null` "disable" meaning clamps to the finite
defaults instead of disabling admission.

The 8 KiB memory limit and the 20/200 defaults are provisional pending long-run
fixture validation; bytes are not a token count.

## Host limitations (not advertised complete)

Recorded against the installed Pi peer by `qa/host-capabilities.test.ts` in
`qa/evidence/host-capabilities.txt`:

- `before_provider_request` observes and may replace the payload but **cannot
  deny** a request, including provider-level retries. The allowance is therefore
  enforced by refusing to schedule goal continuations once remaining is 0 and
  charging every goal-owned request once at provider entry; the host itself is
  not walled off.
- No offline-drivable live agent loop exists, so end-to-end admission, retry,
  and delivery behavior is not behaviorally verified.
- `ctx.abort()` is process-global; the extension aborts only after proving the
  work is goal-owned, never peer or user work.
- Step isolation uses the `context` event filter (probe: pass); its end-to-end
  behavior in a live agent loop remains unconfirmed.

## /orchestrate

No shared commands, tools, or session entry types. While this session owns a
live Feature under `~/orchestrator`, the goal yields: no continuations, no
allowance charges, no step transitions — and the peer's status key is never
taken.
