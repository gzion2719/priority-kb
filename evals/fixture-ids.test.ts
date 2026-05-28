// evals/fixture-ids.test.ts — mechanical floor against seed↔golden drift.
//
// The CI evals job seeds entries with the pinned UUIDs in SEED_FIXTURE_IDS so
// a fresh DB reproduces the ids the golden set anchors to. If someone edits a
// `phase: ready` case's expected_source_ids OR adds/removes a ready case
// without updating SEED_FIXTURE_IDS (or vice versa), CI recall@5 silently
// drops to 0 (the eval job only fails on shape_error, not recall). These
// tests fail LOUD on that drift before it reaches CI.

import { describe, expect, it } from "vitest";

import { UUID_V4_REGEX } from "@/lib/retrieval-citations";
import { SEED_FIXTURE_IDS } from "./fixture-ids";
import { loadGoldenSet } from "./lib";
import type { EvalCase } from "./schema";

const GOLDEN_SET_PATH = "evals/golden_set.yaml";

async function readyCases(): Promise<EvalCase[]> {
  const golden = await loadGoldenSet(GOLDEN_SET_PATH);
  return golden.cases.filter((c) => c.phase === "ready");
}

describe("seed↔golden fixture-id reconciliation", () => {
  it("there is at least one phase:ready case (guards against a vacuous pass)", async () => {
    // Without this, every other assertion below passes vacuously if the
    // golden set has zero ready cases (e.g. someone flips them all to queued).
    const ready = await readyCases();
    expect(ready.length).toBeGreaterThan(0);
  });

  it("the set of ready case ids equals the set of pinned seed-id keys", async () => {
    // Catches a new ready case with no pinned seed id (→ CI recall 0 for it),
    // or a stale pinned id for a case no longer ready.
    const ready = await readyCases();
    const readyIds = ready.map((c) => c.id).sort();
    const pinnedIds = Object.keys(SEED_FIXTURE_IDS).sort();
    expect(readyIds).toEqual(pinnedIds);
  });

  it("each ready case's expected_source_ids is exactly its pinned seed id", async () => {
    // Catches a golden-set UUID edited without re-pinning the seed.
    const ready = await readyCases();
    for (const c of ready) {
      const pinned = SEED_FIXTURE_IDS[c.id as keyof typeof SEED_FIXTURE_IDS];
      expect(pinned, `no pinned seed id for ready case ${c.id}`).toBeDefined();
      expect(
        c.expected_source_ids,
        `expected_source_ids for ${c.id} must be exactly the pinned seed id`,
      ).toEqual([pinned]);
    }
  });

  it("every pinned seed id is a valid v4 UUID (insertable + passes §5 citation validation)", async () => {
    // The seed inserts these as entries.id (gen_random_uuid shape) and the
    // citation validator only accepts v4 — a malformed pinned id would fail
    // the seed insert or silently never validate as a citation.
    for (const id of Object.values(SEED_FIXTURE_IDS)) {
      expect(UUID_V4_REGEX.test(id), `${id} is not a valid v4 UUID`).toBe(true);
    }
  });
});
