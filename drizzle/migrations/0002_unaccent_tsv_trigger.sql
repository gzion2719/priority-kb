-- ADR-0013 §2.1 — hybrid keyword lane: tsvector column + trigger.
-- Companion to db/init.sql (which owns CREATE EXTENSION unaccent per ADR-0008 §10).
-- Migration runs as the app user; unaccent must be pre-installed by the bootstrap
-- superuser. If this migration fails with "function unaccent(text) does not exist",
-- run `docker compose down -v && docker compose up -d` so db/init.sql re-fires.

-- New column. Default '' lets existing rows satisfy NOT NULL until the backfill
-- below replaces them with the real tsvector (computed via the trigger fired by
-- the `SET title = title` canonical backfill).
ALTER TABLE "entries" ADD COLUMN "tsv" tsvector NOT NULL DEFAULT ''::tsvector;
--> statement-breakpoint

-- Trigger fn — re-compute tsv from (title, tags, body) on every insert/update of
-- those columns. Schema-qualified to public.* so a future restrictive search_path
-- (e.g., app-DB-role split per BACKLOG) cannot break the trigger.
--
-- Normalization pipeline (applied in this exact order at both index and query
-- time — see lib/retrieval-keyword.ts for the query-side mirror):
--   1. regexp_replace strips Hebrew combining marks ONLY. The character class
--      is the non-contiguous union of the combining-mark subranges in the
--      Hebrew block (U+0591..U+05C7), explicitly excluding U+05BE MAQAF,
--      U+05C0 PASEQ, U+05C3 SOF PASUQ, U+05C6 NUN HAFUKHA — those are visible
--      punctuation, not combining marks, and stripping the maqaf would
--      silently corrupt compound nouns like בית־ספר → ביתספר. ADR-0013 §2.2
--      originally claimed unaccent() handles niqqud — empirically refuted
--      pre-commit (see §2.1 Errata 2026-05-21 items 4).
--   2. unaccent(...) — strip Latin diacritics so café ↔ cafe.
--   3. to_tsvector('simple', ...) — tokenize on word boundaries, no stemming
--      (no packaged Hebrew stemmer; under-collapse over wrong-language stemmer).
--
-- SET search_path pins the function's name resolution to pg_catalog + public
-- so a future restrictive search_path role (M5 app-DB-role split per BACKLOG)
-- cannot break the `unaccent` / `regexp_replace` / `to_tsvector` resolution.
CREATE OR REPLACE FUNCTION public.entries_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector(
    'simple',
    unaccent(
      regexp_replace(
        coalesce(NEW.title, '') || ' '
        || array_to_string(NEW.tags, ' ') || ' '
        || coalesce(NEW.body, ''),
        '[֑-ֽֿׁ-ׂׄ-ׇׅ]',
        '',
        'g'
      )
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
--> statement-breakpoint

-- Trigger — scoped to (title, tags, body). Updates of unrelated columns
-- (last_verified_at, sensitivity, etc.) do NOT regenerate tsv. The
-- entries_tsv_no_direct_write trigger below protects against any caller writing
-- to `tsv` directly (e.g., ad-hoc admin SQL, future migrations) and corrupting
-- the invariant tsv == to_tsvector(simple, unaccent(title || tags || body)).
CREATE TRIGGER entries_tsv_refresh_trigger
  BEFORE INSERT OR UPDATE OF "title", "tags", "body" ON "entries"
  FOR EACH ROW
  EXECUTE FUNCTION public.entries_tsv_refresh();
--> statement-breakpoint

-- Guard trigger — raises on any direct UPDATE that mentions tsv in its SET
-- clause. The legitimate write path is entries_tsv_refresh_trigger; any other
-- writer is corrupting the invariant tsv == to_tsvector(simple, ...). Note:
-- the trigger fires based on the SQL UPDATE's SET-list (UPDATE OF tsv),
-- NOT on whether NEW.tsv actually changed — so even `UPDATE entries SET
-- tsv = tsv` (a no-op write) is rejected. The principle is "no direct
-- write at all", not "no value-change". pg_trigger_depth() > 1 means the
-- assignment came from inside another trigger's BEFORE handler (i.e.,
-- entries_tsv_refresh writing NEW.tsv); that path is allowed.
CREATE OR REPLACE FUNCTION public.entries_tsv_no_direct_write() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION
      'direct UPDATE of entries.tsv is forbidden; tsv is maintained by entries_tsv_refresh_trigger'
      USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE TRIGGER entries_tsv_no_direct_write_trigger
  BEFORE UPDATE OF "tsv" ON "entries"
  FOR EACH ROW
  EXECUTE FUNCTION public.entries_tsv_no_direct_write();
--> statement-breakpoint

-- Backfill — `SET title = title` fires entries_tsv_refresh_trigger naturally
-- (title is in the trigger's column list); we cannot `SET tsv = ...` directly
-- because the guard trigger above blocks it. Canonical Postgres idiom for
-- column-list trigger backfills.
--
-- Side-effect: entries_set_updated_at (from migration 0001, BEFORE UPDATE
-- with no column list) ALSO fires on this no-op write and bumps every row's
-- updated_at to migration-deploy-time. Pre-M5 the corpus is empty so this
-- is invisible; if this migration is ever re-applied or back-ported against
-- a populated table, accept the updated_at bump as part of the migration's
-- cost, OR wrap the backfill in `ALTER TABLE entries DISABLE TRIGGER
-- entries_set_updated_at; UPDATE ...; ENABLE TRIGGER ...;`. The bare form
-- shipped here keeps the migration small and the pre-M5 cost is zero.
UPDATE "entries" SET "title" = "title" WHERE TRUE;
