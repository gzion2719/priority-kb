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
  // Batch 1 — seeded 2026-05-27 (M2a #8).
  "en-001": "4f237dcc-7e47-422f-bb21-e7a51b4a4a9b",
  "en-009": "8a054602-807a-4a62-adff-3665e81bd027",
  "he-003": "5b3a18ba-10e1-43e1-ad61-51baabda22ed",
  // Batch 2 — seeded 2026-05-29 (M3 #6, first expansion). 3 topics x 2
  // languages; each case anchors to its OWN same-language entry so the
  // `simple`-config keyword lane retrieves it before real Voyage is wired.
  "en-002": "fb72d02a-e5c6-4c5d-922f-dba59533a3ec",
  "he-002": "c5ffa98b-6312-48bc-a4a1-f8c2ac63e6c0",
  "en-007": "abea2065-ede2-4071-8a23-b7a61b898a6f",
  "he-007": "6973850d-5749-4c84-91d8-2054d7a67ad5",
  "en-011": "ee5169eb-72e3-45f8-9d9c-bc318b555682",
  "he-011": "02372ca3-a15b-4fe8-ade0-55d12f0624e0",
} as const;
