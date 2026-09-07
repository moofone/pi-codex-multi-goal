import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { validateEvidenceRefs } from "../src/evidence.ts";
import { replaceGoalFromSteps } from "../src/state.ts";
import type { MultiGoal } from "../src/types.ts";

/**
 * B20 (review finding, P1, src/evidence.ts): the workspace check was lexical.
 * `resolve()` plus `relative()` proves the STRING stays under the working
 * directory; it says nothing about where a symlink inside the workspace
 * actually points. statSync and readFileSync then followed the link and
 * fingerprinted the external target, so an evidence ref could earn credit for
 * any readable file on the machine.
 *
 * It matters more since D4: a credited ref returns a capped grant to the
 * working request budget, so this is a way to buy execution budget by pointing
 * at /etc/hosts.
 */

const sha16 = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, 16);

function oneStepGoal(): MultiGoal {
  const result = replaceGoalFromSteps([{ objective: "ship it", criteria: ["the fix is in place"] }]);
  assert.ok(result.ok && result.goal, result.message);
  return result.goal;
}

interface Workspace {
  root: string;
  outside: string;
  write(relativePath: string, content: string): string;
}

function workspace(t: any): Workspace {
  // realpath both, so a platform whose temp dir is itself a symlink (macOS
  // /var -> /private/var) does not look like an escape.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "multi-goal-workspace-")));
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  });
  return {
    root,
    outside,
    write(relativePath, content) {
      const absolute = join(root, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return absolute;
    },
  };
}

function ref(goal: MultiGoal, artifact: string, content: string) {
  return {
    operation: "edit",
    artifact,
    fingerprint: sha16(content),
    criteria: goal.stages[0]!.criteria.map((criterion) => criterion.id),
  };
}

test("B20: a symlink inside the workspace pointing outside it cannot earn credit", (t) => {
  const ws = workspace(t);
  const goal = oneStepGoal();
  const secret = "root:x:0:0:not yours\n";
  writeFileSync(join(ws.outside, "hosts"), secret);
  // An ordinary-looking project path whose target is outside the workspace.
  symlinkSync(join(ws.outside, "hosts"), join(ws.root, "evidence.txt"));

  const result = validateEvidenceRefs(goal, [ref(goal, "evidence.txt", secret)]);

  assert.equal(result.ok, false, "a link out of the workspace is not project evidence");
  assert.match(
    result.ok === false ? result.message : "",
    /workspace|project|outside|traversal/i,
    "and the reason says the artifact left the workspace",
  );
});

test("B20: a symlinked directory inside the workspace escaping it is refused too", (t) => {
  const ws = workspace(t);
  const goal = oneStepGoal();
  const secret = "measurements taken elsewhere\n";
  mkdirSync(join(ws.outside, "results"), { recursive: true });
  writeFileSync(join(ws.outside, "results", "run.json"), secret);
  symlinkSync(join(ws.outside, "results"), join(ws.root, "results"));

  const result = validateEvidenceRefs(goal, [ref(goal, "results/run.json", secret)]);

  assert.equal(result.ok, false, "a linked directory does not extend the workspace either");
});

test("B20: an ordinary symlink that stays inside the workspace still works", (t) => {
  // Regression preservation: a symlinked directory inside a project is
  // ordinary, so the fix must resolve links rather than ban them.
  const ws = workspace(t);
  const goal = oneStepGoal();
  const content = "the fix, applied\n";
  ws.write("packages/core/fix.ts", content);
  symlinkSync(join(ws.root, "packages", "core"), join(ws.root, "core"));

  const direct = validateEvidenceRefs(goal, [ref(goal, "packages/core/fix.ts", content)]);
  assert.equal(direct.ok, true, direct.ok ? "" : direct.message);

  const linked = validateEvidenceRefs(goal, [ref(goal, "core/fix.ts", content)]);
  assert.equal(linked.ok, true, linked.ok ? "" : linked.message);
});

test("B20: a plain in-workspace artifact is unaffected", (t) => {
  const ws = workspace(t);
  const goal = oneStepGoal();
  const content = "the fix, applied\n";
  ws.write("src/fix.ts", content);

  const result = validateEvidenceRefs(goal, [ref(goal, "src/fix.ts", content)]);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.equal(result.ok === true ? result.refs.length : 0, 1);
});

test("B20: lexical traversal and absolute paths are still refused", (t) => {
  const ws = workspace(t);
  const goal = oneStepGoal();
  const secret = "not yours\n";
  writeFileSync(join(ws.outside, "hosts"), secret);

  const traversal = validateEvidenceRefs(goal, [ref(goal, "../outside/hosts", secret)]);
  assert.equal(traversal.ok, false, "traversal is still refused");

  const absolute = validateEvidenceRefs(goal, [ref(goal, join(ws.outside, "hosts"), secret)]);
  assert.equal(absolute.ok, false, "an absolute path is still refused");
});

test("B20: a missing artifact still reports as missing, not as an escape", (t) => {
  // The two failures stay distinguishable: a typo'd path is the common case and
  // deserves its own message.
  const ws = workspace(t);
  const goal = oneStepGoal();
  ws.write("src/other.ts", "x\n");

  const result = validateEvidenceRefs(goal, [ref(goal, "src/missing.ts", "x\n")]);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /exist/i);
});

test("B20: a dangling symlink is refused rather than crashing validation", (t) => {
  const ws = workspace(t);
  const goal = oneStepGoal();
  symlinkSync(join(ws.root, "never-created.txt"), join(ws.root, "dangling.txt"));

  const result = validateEvidenceRefs(goal, [ref(goal, "dangling.txt", "x\n")]);
  assert.equal(result.ok, false, "a link to nothing is not evidence");
});
