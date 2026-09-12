# pi-codex-multi-goal

Codex-style `/goal` for Pi: the human defines the objective and its success
criteria; the harness owns execution limits, accounting, and step transitions.
The model sees only the current step's contract plus one small working-memory
record — the latest snapshot of THIS goal, injected at step start, again when
an unfinished turn goes idle (force keep going), and at eligible context
boundaries. Never the whole sequence, other steps, previous transcripts, or a
pile of stale wrappers.

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

Multi-step goals add a nonempty `steps` array to the same contract: the
object still needs its own top-level `objective` and nonempty `criteria`, and
every step needs an objective and nonempty criteria too:

```json
/goal { "objective": "ship the duplicate SUBMIT pin", "criteria": ["duplicate SUBMIT pin documented"], "steps": [ { "objective": "pin the duplicate", "criteria": ["lockfile updated"] }, { "objective": "document the pin", "criteria": ["README section merged"] } ] }
```

Missing or empty `criteria` refuse to start. In the TUI, leaving the criteria
blank means "the objective is the sole criterion" and still requires an explicit
contract confirm.

### Contract identity

Every persisted goal snapshot carries a `contractRevision`: the sha256 of the
current step's objective, its ordered criterion IDs and text, and its
human-decision flags. It gives a peer extension a stable name for "the contract
in force right now" without re-reading the criteria, and a step transition
necessarily changes it.

It is derived, never authored. It is recomputed from the criteria on every load,
so a stale or tampered stored value is corrected rather than trusted, and a
snapshot written before the field existed gets one.

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

Each step gets a finite execution grant with four independent fuses, so that
being long and being stuck are bounded separately:

| Fuse | Unit | Default | Renewed by |
|---|---|---|---|
| no-progress | full contexts (compaction / context-window fills) | 20 | verified evidence, `/goal resume` |
| turn | goal-owned provider requests inside one agent turn | 40 | the next agent turn, verified evidence |
| working total | goal-owned provider requests this step | 400 | verified evidence, by a grant of 50, never above the cap |
| lifetime | goal-owned provider requests, whole goal | 1000 | nothing |

Turns inside a tool loop do not spend the no-progress allowance; a runaway loop
is caught by the per-turn bound instead. There is no unlimited mode: `0`,
`null`, and malformed values clamp to the finite defaults.

Verified evidence (the same validation path completion uses) is what separates
a long productive step from a stuck one. Once per novel evidence ref, it resets
the no-progress streak, clears the per-turn bound, and returns a capped grant to
the working total. Memory rewrites, tool success, and `edit`/`write`/`apply_patch`
calls alone earn nothing, and nothing ever refunds `lifetimeRequests`. Reloads,
retries, and compaction never refund. Exhaustion pauses the goal with a persisted
reason naming the fuse that blew **and stops proven goal-owned work** (queued
follow-up or in-flight goal loop). `/goal resume` grants a fresh bounded
no-progress streak and starts a new turn; it never refills the working total and
never lifts the lifetime ceiling. Once a budget passes 80 % the footer names it.

Settings live in `~/.pi/agent/pi-codex-multi-goal.json`:

```json
{
  "noProgressLimit": 20,
  "turnLimit": 40,
  "totalLimit": 400,
  "evidenceGrant": 50,
  "lifetimeCeiling": 1000
}
```

Migration: `maxCompactionsWithoutMutation` is the legacy name for the
no-progress full-context limit. A positive legacy value migrates onto
`noProgressLimit` (same unit: context windows). The old `0`/`null` "disable"
meaning clamps to the finite defaults instead of disabling admission. A goal
snapshot written before the per-turn bound existed loads with its spent budgets
intact and the new limits materialized at their defaults.

The 8 KiB memory limit and these defaults are provisional pending long-run
fixture validation; bytes are not a token count.

## Host limitations (not advertised complete)

Recorded against the installed Pi peer by `qa/host-capabilities.test.ts` in
`qa/evidence/host-capabilities.txt`:

- `before_provider_request` observes and may replace the payload but **cannot
  deny** a request, including provider-level retries. The allowance is therefore
  enforced by refusing to schedule goal continuations once remaining is 0,
  charging the total budget once per goal-owned request at provider entry,
  charging no-progress once per full context at `session_compact`, and aborting
  proven goal-owned work on exhaustion; the host itself is not walled off.
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
