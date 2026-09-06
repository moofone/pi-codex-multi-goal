import assert from "node:assert/strict";
import test from "node:test";

import { parseStageTitles } from "../src/parse.ts";

test("single stage", () => {
  assert.deepEqual(parseStageTitles("  pin duplicate  "), { ok: true, titles: ["pin duplicate"] });
});

test("splits on space-pipe-pipe-space only", () => {
  const parsed = parseStageTitles("pin duplicate || write red test || fix miner");
  assert.deepEqual(parsed, {
    ok: true,
    titles: ["pin duplicate", "write red test", "fix miner"],
  });
  assert.equal(parseStageTitles("keep | single | pipes").ok, true);
});

test("rejects empty and oversized lists", () => {
  assert.equal(parseStageTitles("").ok, false);
  assert.equal(parseStageTitles("a || ").ok, false);
  assert.equal(parseStageTitles(" || b").ok, false);
  const tooMany = Array.from({ length: 25 }, (_, i) => `s${i}`).join(" || ");
  assert.equal(parseStageTitles(tooMany).ok, false);
});
