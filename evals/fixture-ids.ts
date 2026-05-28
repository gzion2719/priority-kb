// evals/fixture-ids.ts — single source of truth for the synthetic-fixture
// entry UUIDs, keyed by golden-set case id.
//
// Shared by:
//   - scripts/seed-synthetic-entries.ts — pins these ids on the seeded
//     entries (via createEntry's explicit `id`) so a FRESH database (CI)
//     reproduces the exact UUIDs the golden set anchors to. Without pinning,
//     a re-seed gets random ids and CI recall@5 is silently 0.
//   - the golden-set reconciliation test — asserts these equal
//     evals/golden_set.yaml's `phase: ready` cases' expected_source_ids[0],
//     failing loud if the seed and golden set ever drift apart.
//
// A separate module (not the seed script) because seed-synthetic-entries.ts
// self-executes `main()` at import time; importing the ids from it would run
// the seeder. Keep this leaf module import-side-effect-free.
export const SEED_FIXTURE_IDS = {
  "en-001": "4f237dcc-7e47-422f-bb21-e7a51b4a4a9b",
  "en-009": "8a054602-807a-4a62-adff-3665e81bd027",
  "he-003": "5b3a18ba-10e1-43e1-ad61-51baabda22ed",
} as const;
