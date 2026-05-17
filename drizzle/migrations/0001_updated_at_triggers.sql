-- Hand-written companion to 0000_baseline.sql.
-- entries.updated_at: DEFAULT now() fires only on INSERT; Drizzle's $onUpdate is
-- application-side. A BEFORE UPDATE trigger keeps the column honest for any writer
-- (admin route, ad-hoc psql, future M2b worker) without relying on app-layer
-- discipline. ADR-0009 §7 requires updated_at to track edits.
--
-- Scoped to `entries` only: `chunks` is full DELETE-INSERT on every re-chunk
-- (ADR-0009 §7), and `audit_log` is append-only — both have no updatable rows
-- by design, so no updated_at column and no trigger needed.
--
-- Function is schema-qualified to public.set_updated_at so a future restrictive
-- search_path (e.g., when the app-DB-role split lands; see BACKLOG) cannot break
-- the trigger.

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER entries_set_updated_at
  BEFORE UPDATE ON "entries"
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
