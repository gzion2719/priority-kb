-- ADR-0019 M2b #3 — job queue table + state enum + partial dispatch index.
--
-- Schema is Drizzle-owned per ADR-0008; this migration is hand-authored
-- (matching the 0001/0002/0003 convention) rather than `drizzle-kit generate`-d
-- because the project deliberately retains only the 0000 baseline snapshot.
--
-- `updated_at` is caller-maintained — see ADR-0019 Amendment 2026-05-26 §I
-- ("Every UPDATE statement on `jobs` MUST set `updated_at = now()`"). The
-- trigger from 0001_updated_at_triggers.sql is NOT applied to `jobs` by
-- design (§D10 schema-migration sequencing notes; §I authoritative).
--
-- The partial dispatch index `jobs_dispatch_idx` covers the claim hot path
-- (`WHERE queue_name=$1 AND state='queued' AND run_after<=now()`); the
-- dead-letter inspection path (`WHERE state='dead'`) intentionally tolerates
-- a seq scan in the M2b volume regime (ADR-0019 §D 10-line skeleton notes).
CREATE TYPE "job_state" AS ENUM ('queued', 'in_progress', 'done', 'failed', 'dead');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_idempotency_key_length_check" CHECK (length("jobs"."idempotency_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_dispatch_idx"
	ON "jobs" ("queue_name", "state", "run_after")
	WHERE "state" IN ('queued', 'in_progress');
