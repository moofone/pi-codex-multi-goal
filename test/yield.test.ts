import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { featureYieldsForSession, sessionOwnsLiveOrchestrateFeature } from "../src/yield.ts";

const session = { id: "sess-1", file: "/tmp/session.jsonl" };

test("live phase + matching parent yields; done does not", () => {
  const live = ["phase: implementing", "parent_session_id: sess-1", "parent_session_file: none"].join("\n");
  assert.equal(featureYieldsForSession(live, session), true);

  const done = ["phase: done", "parent_session_id: sess-1"].join("\n");
  assert.equal(featureYieldsForSession(done, session), false);

  const other = ["phase: implementing", "parent_session_id: other"].join("\n");
  assert.equal(featureYieldsForSession(other, session), false);
});

test("walks orchestrator root for matching live Feature", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-"));
  mkdirSync(join(root, "icemining", "feat-a"), { recursive: true });
  writeFileSync(
    join(root, "icemining", "feat-a", "status.md"),
    ["phase: planning", "parent_session_id: sess-1"].join("\n"),
  );
  assert.equal(sessionOwnsLiveOrchestrateFeature(session, root), true);
  assert.equal(sessionOwnsLiveOrchestrateFeature({ id: "nope" }, root), false);
});
