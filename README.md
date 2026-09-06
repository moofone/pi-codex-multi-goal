# pi-codex-multi-goal

Codex-style `/goal` for Pi with **harness-owned stages** and **no context pollution**.

The model only ever sees the current stage title plus `k/n`. Completing a stage is a runtime transition, not a prompt. Five full context windows with no `edit`/`write`/`apply_patch` pause the current stage.

Plan: `~/plan/pi-codex-multi-goal.md`

## Install

```bash
pi install /Users/greg/Dev/git/pi-codex-multi-goal
```

Do not load this together with another `/goal` owner (narumitw, kky42, pi-codex-goal).

## Usage

```
/goal pin the duplicate SUBMIT
/goal-multi
/goal
/goal pause
/goal resume
/goal clear
```

`/goal-multi` asks how many steps, prompts one title each, shows the list, then accept or reject. That is the staged-goal path. `/goal` stays single-objective (plus pause/resume/clear).

`update_goal {status:"complete"}` finishes **this stage**. The harness advances or completes the goal. `{status:"blocked"}` stops on this stage.

## Stall

`~/.pi/agent/pi-codex-multi-goal.json`:

```json
{ "maxCompactionsWithoutMutation": 5 }
```

`null` or `0` disables. Per stage; resume and stage advance reset the streak.

## /orchestrate

No shared commands, tools, or session entry types. While this session owns a live Feature under `~/orchestrator`, goal follow-ups are not injected (`Goal waiting on /orchestrate`).
