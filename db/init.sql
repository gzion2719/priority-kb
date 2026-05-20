CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
-- unaccent: hybrid keyword lane (ADR-0013) strips Hebrew niqqud + Latin diacritics.
-- Extensions live here per ADR-0008 §10 — extension installs run as the bootstrap
-- superuser, not as the (future) least-privilege app DB user. Existing dev/CI
-- volumes will NOT re-run this file; reset with `docker compose down -v &&
-- docker compose up -d` so the trigger function added by Drizzle migration 0002
-- finds unaccent installed.
