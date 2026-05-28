// evals/fixture-ids.test.ts — mechanical floor against seed↔golden drift.
//
// The CI evals job seeds entries with the pinned UUIDs in SEED_FIXTURE_IDS so
// a fresh DB reproduces the ids the golden set anchors to. If someone edits a
// `phase: ready` case's expected_source_ids OR adds/removes a ready case
// without updating SEED_FIXTURE_IDS (or vice versa), CI recall@5 silently
// drops to 0 (the eval job only fails on shape_error, not recall). This test
// fails LOUD on that drift before it reaches CI.

import { describe, expect, it } from "vitest";

import { SEED_FIXTURE_IDS } from "./fixture-ids";
import { loadGoldenSet } from "./lib";

describe("seed↔golden fixture-id reconciliation", () => {
  it("every phase:ready golden-set case has a pinned seed id, and they match exactly", async () => {
    const golden = await loadGoldenSet("evals/golden_set.yaml");
    const ready = golden.cases.filter((c) => c.phase === "ready");

    // 1. The set of ready case ids equals the set of pinned seed-id keys.
    //    Catches: a new ready case with no seed id (→ CI recall 0 for it), or
    //    a stale seed id for a case no longer ready.
    const readyIds = ready.map((c) => c.id).sort();
    const pinnedIds = Object.keys(SEED_FIXTURE_IDS).sort();
    expect(readyIds).toEqual(pinnedIds);

    // 2. Each ready case's single expected source id equals the pinned UUID.
    //    Catches: a golden-set UUID edited without re-pinning the seed.
    for (const c of ready) {
      const pinned = SEED_FIXTURE_IDS[c.id as keyof typeof SEED_FIXTURE_IDS];
      expect(pinned, `no pinned seed id for ready case ${c.id}`).toBeDefined();
      expect(
        c.expected_source_ids,
        `expected_source_ids for ${c.id} must be exactly the pinned seed id`,
      ).toEqual([pinned]);
    }
  });
});
