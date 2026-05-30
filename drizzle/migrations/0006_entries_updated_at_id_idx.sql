-- M4 #1a — keyset-pagination index for the admin entries browser.
--
-- Backs the SELECT in lib/entries.ts `listEntriesForAdmin`:
--   ORDER BY updated_at DESC, id DESC
--   WHERE (updated_at, id) < ($cursor_updated_at, $cursor_id)
--
-- Postgres row-comparison `(updated_at, id) < (...)` is lexicographic in
-- natural (ASC) order, which gives the correct "next page after cursor"
-- half-plane for an ORDER BY updated_at DESC, id DESC sort (rows that
-- come AFTER the cursor in DESC,DESC are precisely the rows strictly
-- less in ASC,ASC). Declaring the btree as (updated_at DESC, id DESC)
-- aligns the physical scan direction with the ORDER BY so the planner
-- uses an index-only walk instead of sort-after-scan.
--
-- Schema is Drizzle-owned per ADR-0008; this migration is hand-authored
-- (matching the 0001/0002/0003/0004/0005 convention) and is mirrored in
-- drizzle/schema.ts `entries.updatedAtIdIdx`.
CREATE INDEX IF NOT EXISTS "entries_updated_at_id_idx"
	ON "entries" ("updated_at" DESC, "id" DESC);
