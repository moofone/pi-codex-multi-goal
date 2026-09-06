import assert from "node:assert/strict";
import test from "node:test";

import {
  createStallState,
  noteFullContextCompact,
  noteMutation,
  resetStallState,
} from "../src/stall.ts";
import { parseSettings } from "../src/settings.ts";

test("five sterile compactons pause; mutation and advance reset", () => {
  const state = createStallState();
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(
      noteFullContextCompact(state, { goalActive: true, limit: 5, reason: "threshold" }),
      { type: "count", compactonsWithoutMutation: i },
    );
  }
  noteMutation(state);
  assert.equal(
    noteFullContextCompact(state, { goalActive: true, limit: 5, reason: "overflow" }).type,
    "reset",
  );
  resetStallState(state);
  for (let i = 1; i <= 5; i++) {
    noteFullContextCompact(state, { goalActive: true, limit: 5, reason: "threshold" });
  }
  assert.equal(state.compactonsWithoutMutation, 5);
  assert.equal(
    noteFullContextCompact(state, { goalActive: true, limit: 5, reason: "manual" }).type,
    "ignore",
  );
});

test("settings default 5; 0/null disable", () => {
  const path = "/tmp/pi-codex-multi-goal.json";
  assert.equal(parseSettings(undefined, path).maxCompactionsWithoutMutation, 5);
  assert.equal(parseSettings({ maxCompactionsWithoutMutation: 0 }, path).maxCompactionsWithoutMutation, null);
  assert.equal(parseSettings({ maxCompactionsWithoutMutation: 3 }, path).maxCompactionsWithoutMutation, 3);
});
