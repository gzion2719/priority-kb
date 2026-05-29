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
  // Batch 3 — seeded 2026-05-29 (M3 #6, second expansion). 3 topics x 2
  // languages: Screen Generator menu add, BPM sales-order trigger, publish
  // test->production. Same same-language-anchor pattern as batch 2.
  "en-004": "85e550c1-7071-4032-94b7-84ea29d9fbc1",
  "he-004": "69a0f6bb-4b60-4f48-aa22-7c4af19b409f",
  "en-005": "259fd122-e7ca-4628-9f1b-6e7e0d366e33",
  "he-005": "522d0da3-2333-4820-8395-eee0e4d134bf",
  "en-006": "596cc28e-963e-4a5f-97e9-7c06a5de0b02",
  "he-006": "ef7a47c5-cd79-47f1-9108-590ae4a27afc",
} as const;
