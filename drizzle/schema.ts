import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

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
    source_pointer: text("source_pointer").notNull(),
    last_verified_at: timestamp("last_verified_at", { withTimezone: true }).notNull(),
    sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sensitivityCheck: check(
      "entries_sensitivity_check",
      sql`${t.sensitivity} IN ('public', 'internal', 'restricted')`,
    ),
    idSensitivityUnique: unique("entries_id_sensitivity_uq").on(t.id, t.sensitivity),
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
