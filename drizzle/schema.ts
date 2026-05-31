import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// `tsvector` is not a built-in Drizzle column type. customType lets us reference
// it in the schema for drift-detection + query-builder use; the column itself is
// maintained by a trigger declared in drizzle/migrations/0002_unaccent_tsv_trigger.sql
// per ADR-0013 §2.1.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

export const sensitivityEnum = ["public", "internal", "restricted"] as const;
export type Sensitivity = (typeof sensitivityEnum)[number];

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    body: text("body").notNull(),
    // Display-only label derived from the post-scrub body (ADR-0023 D1/D2).
    // Nullable; NOT embedded, NOT chunked, NOT in `tsv`. Populated by
    // lib/ingest.ts on create/update; existing rows stay NULL until re-saved.
    caption: text("caption"),
    source_pointer: text("source_pointer").notNull(),
    last_verified_at: timestamp("last_verified_at", { withTimezone: true }).notNull(),
    sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Trigger-maintained hybrid keyword-lane index (ADR-0013 §2.1). Computed in
    // Postgres from to_tsvector('simple', unaccent(title || tags || body));
    // direct writes are blocked by entries_tsv_no_direct_write_trigger.
    tsv: tsvector("tsv")
      .notNull()
      .default(sql`''::tsvector`),
  },
  (t) => ({
    sensitivityCheck: check(
      "entries_sensitivity_check",
      sql`${t.sensitivity} IN ('public', 'internal', 'restricted')`,
    ),
    idSensitivityUnique: unique("entries_id_sensitivity_uq").on(t.id, t.sensitivity),
    tsvGin: index("entries_tsv_gin_idx").using("gin", t.tsv),
    // M4 #1a — backs listEntriesForAdmin keyset pagination
    // (ORDER BY updated_at DESC, id DESC). See migration 0006.
    updatedAtIdIdx: index("entries_updated_at_id_idx").on(t.updated_at.desc(), t.id.desc()),
    // M4 #5 — backs listStaleEntries keyset pagination
    // (ORDER BY last_verified_at ASC, id ASC). See migration 0007.
    lastVerifiedAtIdIdx: index("entries_last_verified_at_id_idx").on(
      t.last_verified_at.asc(),
      t.id.asc(),
    ),
  }),
);

export const entries_versions = pgTable(
  "entries_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entry_id: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    version_no: integer("version_no").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    body: text("body").notNull(),
    sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sensitivityCheck: check(
      "entries_versions_sensitivity_check",
      sql`${t.sensitivity} IN ('public', 'internal', 'restricted')`,
    ),
    entryVersionUnique: unique("entries_versions_entry_id_version_no_uq").on(
      t.entry_id,
      t.version_no,
    ),
  }),
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entry_id: uuid("entry_id").notNull(),
    sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),
    chunk_index: integer("chunk_index").notNull(),
    chunk_total: integer("chunk_total").notNull(),
    content_start: integer("content_start").notNull(),
    content_end: integer("content_end").notNull(),
    token_count: integer("token_count").notNull(),
    chunking_policy_version: text("chunking_policy_version").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    embedding_model: text("embedding_model").notNull(),
    embedding_version: text("embedding_version").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sensitivityCheck: check(
      "chunks_sensitivity_check",
      sql`${t.sensitivity} IN ('public', 'internal', 'restricted')`,
    ),
    // Composite FK propagates entries.sensitivity changes into chunks.sensitivity.
    // Requires the entries_id_sensitivity_uq unique constraint on entries.
    entryFk: foreignKey({
      columns: [t.entry_id, t.sensitivity],
      foreignColumns: [entries.id, entries.sensitivity],
      name: "chunks_entry_id_sensitivity_fk",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    // HNSW index for cosine-similarity retrieval. NOTE: future migrations that add
    // an HNSW index against a non-empty table must ship as their own no-other-DDL
    // file and use CREATE INDEX CONCURRENTLY (ADR-0008 §12 transactional-wrap caveat).
    embeddingHnsw: index("chunks_embedding_hnsw_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

// ADR-0019 M2b #3 — job queue. Drizzle owns the schema (ADR-0008); the table is
// consumed from both Node (lib/jobs.ts enqueue) and Python (api/jobs.py worker).
// `updated_at` is caller-maintained — no auto-update trigger (ADR-0019
// Amendment 2026-05-26 §I; §D10 cross-references).
export const jobStateEnum = ["queued", "in_progress", "done", "failed", "dead"] as const;
export type JobState = (typeof jobStateEnum)[number];
export const jobState = pgEnum("job_state", jobStateEnum);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queue_name: text("queue_name").notNull(),
    payload: jsonb("payload").notNull(),
    idempotency_key: text("idempotency_key").notNull(),
    state: jobState("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(5),
    run_after: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    locked_until: timestamp("locked_until", { withTimezone: true }),
    locked_by: text("locked_by"),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyKeyUnique: unique("jobs_idempotency_key_uq").on(t.idempotency_key),
    idempotencyKeyLength: check(
      "jobs_idempotency_key_length_check",
      sql`length(${t.idempotency_key}) BETWEEN 1 AND 200`,
    ),
    dispatchIdx: index("jobs_dispatch_idx")
      .on(t.queue_name, t.state, t.run_after)
      .where(sql`${t.state} IN ('queued', 'in_progress')`),
  }),
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export const audit_log = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    entry_id: uuid("entry_id").references(() => entries.id, { onDelete: "restrict" }),
    prompt_hash: text("prompt_hash"),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    promptHashRequiredForAgent: check(
      "audit_log_prompt_hash_required_for_agent",
      sql`${t.kind} NOT LIKE 'agent_%' OR ${t.prompt_hash} IS NOT NULL`,
    ),
  }),
);
