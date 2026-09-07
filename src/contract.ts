import { createHash } from "node:crypto";

import type { Stage } from "./types.js";

/**
 * The deterministic identity of the human contract in force for one step
 * (PI_DAG_COMPACT D7): the sha256 of the accepted objective, the ordered
 * criterion IDs and text, and the human-decision flags.
 *
 * Goal computes it; a bound peer carries it unchanged. That lets the peer
 * compare "the contract I mirrored" against "the contract in force now"
 * without re-reading Goal's criteria, and makes a stage transition — which
 * necessarily changes the criterion IDs — visible as a changed identity.
 *
 * It is derived, never authored. Nothing outside the criteria may influence
 * it, so budgets, memory, status, timestamps, and other steps are excluded.
 *
 * The canonical form is JSON, whose escaping makes the field boundaries
 * unambiguous: no objective or criterion text can be crafted to collide with a
 * different contract by embedding a delimiter.
 */
export function computeContractRevision(stage: Stage): string {
  const canonical = JSON.stringify([
    stage.title,
    stage.criteria.map((criterion) => [
      criterion.id,
      criterion.text,
      criterion.requiresHumanDecision === true,
    ]),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
