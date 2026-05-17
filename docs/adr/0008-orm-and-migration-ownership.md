# ADR-0008 — ORM + migration ownership (Drizzle replaces Alembic for schema; SQL-first migrations)

- **Date:** 2026-05-17
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

`db/init.sql` currently contains one line — `CREATE EXTENSION IF NOT EXISTS vector;`. `lib/db.ts` uses raw `pg.Pool` for `/healthz` only. No application tables exist yet, and no migration tool is wired in.

ROADMAP M1 line 17 names **Alembic** (Python / SQLAlchemy) as the migration tool. That commitment was made at bootstrap (ADR-0001) under the assumption that the Python FastAPI worker would land alongside the Next.js app. Since then, sequencing has shifted: M2a (text-only ingestion) and M3 (retrieval) both ship before M2b activates Python. The schema needs to land in M1/M2a, before the Python runtime exists. Running an Alembic-only tool from a dormant Python sub-package — when every schema writer for the next two milestones is TypeScript — inverts the cost / benefit balance.

This ADR re-opens the Alembic-as-given assumption and decides:

1. The Node-side ORM / query-builder.
2. The migration tool and which runtime owns it.
3. How the Node app stays in sync with the schema.
4. Local-dev bootstrap after the migration tool owns the schema.
5. CI integration.
6. Where the iron-rule columns land (`prompt_hash`, `embedding_model + embedding_version`, `sensitivity`, `source_pointer`, `last_verified_at`) — at the *schema-pattern* level, not the table-shape level (the latter is the baseline-migration PR's job).
7. Admin-only-writes enforcement layer.
8. Re-embed event mechanics.
9. Seed / fixture ownership for tests (non-negotiable #8: no live APIs in tests).
10. The `CREATE EXTENSION` privilege boundary between `db/init.sql` and the migration tool.
11. Production runner.
12. Rollback policy.

Closing this ADR retires two BACKLOG entries: "Migration-runner cross-runtime decision" and "ORM / query-builder ADR" (both under Architecture & Infra).

## Decision

**Drizzle ORM (Node) + Drizzle-Kit migrations (SQL-first) + raw `pg` driver underneath.** Alembic is dropped. Python's M2b worker reads the same DB as a consumer; schema is Drizzle-owned.

**Schema shape skeleton (per the ADR-with-new-types sub-rule):**

```ts
// drizzle/schema.ts — source of truth, TypeScript-first
import { pgTable, uuid, text, timestamp, vector, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const sensitivityEnum = ["public", "internal", "restricted"] as const;
export type Sensitivity = (typeof sensitivityEnum)[number];

// Pattern only — final shape for chunks lands in the chunking-strategy ADR +
// baseline-migration PR. entries_versions (per ROADMAP M2a) is also out of scope
// for this skeleton on purpose.
export const entries = pgTable("entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),             // #6 (text + CHECK)
  source_pointer: text("source_pointer").notNull(),                                  // #7
  last_verified_at: timestamp("last_verified_at", { withTimezone: true }).notNull(), // #7
});

// preview only; final shape per the chunking ADR
export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_id: uuid("entry_id").notNull().references(() => entries.id),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),                    // synchronous ingest only
  embedding_model: text("embedding_model").notNull(),                                // #9
  embedding_version: text("embedding_version").notNull(),                            // #9
});

export const audit_log = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),                                                    // discriminator
    entry_id: uuid("entry_id").references(() => entries.id),                         // nullable: non-entry audit events
    prompt_hash: text("prompt_hash"),                                                // #10
    occurred_at: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // #10 enforced mechanically: agent_* rows MUST carry a prompt_hash
    promptHashRequiredForAgent: check(
      "audit_log_prompt_hash_required_for_agent",
      sql`${t.kind} NOT LIKE 'agent_%' OR ${t.prompt_hash} IS NOT NULL`,
    ),
  }),
);
```

The skeleton illustrates the **pattern** the baseline migration will follow — the iron-rule columns are columns on real tables, typed in the schema source, enforced by `NOT NULL` at the DB level (plus a `CHECK` for the #10 discriminator), and by Zod at the API boundary. The `chunks` portion is preview-only; final shape is fixed by the chunking-strategy ADR. `chunks.embedding` is `NOT NULL` because M2a ingestion is synchronous — the embedding is computed before the row is inserted; partial rows (chunk inserted, embedding deferred) are not a legal state in M2a. If asynchronous embedding lands later, a separate `embedding_queue` table fronts it without weakening `chunks.embedding`'s contract.

### 1. ORM / query-builder choice — Drizzle ORM

| Option | Verdict | Reason |
| --- | --- | --- |
| Raw `pg` (status quo) | rejected | Hand-written TS types are a parallel source of truth that *will* drift. Type safety on chunks/embeddings/entries joins is exactly where M3 retrieval pays its rent. |
| `postgres.js` | rejected | Tagged-template SQL is nicer than `pg`, but doesn't solve the source-of-truth or join-typing problem. |
| **Drizzle ORM** | **chosen** | TS schema is the source of truth; raw-SQL escape hatch (`sql\`…\``) for pgvector ops the query builder doesn't model; `drizzle-zod` derives runtime validators from the same schema; zero codegen binary (unlike Prisma). |
| Prisma | rejected | Engine binary + deployment artifact; schema-first DSL is a *third* language alongside TS and SQL; tooling surface is much larger than the M1/M2a query shape warrants. |

### 2. Migration tool — Drizzle-Kit

Drizzle-Kit generates SQL migration files from schema diffs. Output is plain SQL, reviewed in PRs as SQL. Lives at `drizzle/migrations/NNNN_<slug>.sql` with a `meta/_journal.json` index.

| Option | Verdict | Reason |
| --- | --- | --- |
| Alembic | rejected (overrides ROADMAP M1) | Requires activating dormant Python for a single concern, with the schema-writers being TypeScript for the next two milestones. Cross-runtime hand-off is real cost; Python's M2b SQLAlchemy is read-side and doesn't need migration authority. |
| node-pg-migrate | rejected | Decoupled from any TS schema source; would still need a parallel TS type story. |
| **Drizzle-Kit** | **chosen** | One source of truth (the TS schema); migrations are SQL on disk (reviewable, replayable); the *generator* is TS, the *artifact* is SQL. |

**Cross-runtime hand-off.** Python's M2b worker uses SQLAlchemy (per `pyproject.toml`'s anticipated deps) as a **read-side** ORM only — it does not own migrations. SQLAlchemy declarative models in `api/` are **hand-mirrored** to the Drizzle schema; drift is caught by an integration test in `api/tests/` that introspects the live (migrated) DB schema and asserts the SQLAlchemy models match. The integration test lands with the M2b worker; it is the mechanical floor that keeps the consumer relationship honest. This is a strict consumer relationship, not a peer.

### 3. Node-app schema awareness — Drizzle schema + `drizzle-zod`

Drizzle's TS schema declarations are the source of truth for both:
- Query-builder types (compile time).
- API boundary validators (runtime, via `drizzle-zod`'s `createInsertSchema` / `createSelectSchema`).

| Option | Verdict |
| --- | --- |
| Hand-written TS interfaces | rejected — parallel source of truth. |
| Generated types from DB introspection | rejected — DB is downstream of schema; introspecting in the wrong direction. |
| Runtime-only (no static types) | rejected — defeats the whole point of TypeScript on the API path. |
| **Drizzle schema + `drizzle-zod`** | **chosen** — one source of truth, types AND validators derived. |
| Zod schemas as source-of-truth | rejected — would still need a TS↔SQL mapping layer; Drizzle does that natively. |

### 4. Local-dev bootstrap

```
docker compose up -d           # postgres starts; db/init.sql runs ONCE as the bootstrap user → CREATE EXTENSION vector + app user
npm install
npm run db:migrate             # drizzle-kit applies migrations as the app DB user
npm run dev
```

Reset: `docker compose down -v && docker compose up -d && npm run db:migrate`.

`db/init.sql` keeps exactly one responsibility: bootstrap work that the app user cannot do — `CREATE EXTENSION vector` and creating the least-privilege app DB role. This keeps `db/init.sql` and Drizzle migrations on disjoint privilege footprints. (pgvector ≥ 0.5 is marked `trusted`, so a database owner with `CREATE` could install it in principle; we still keep extension-install in `db/init.sql` so the app user has no `CREATE EXTENSION` need.)

**Lifecycle note (for CI service containers and dev resets):** the Postgres image runs `/docker-entrypoint-initdb.d/*` scripts **only when `PGDATA` is empty** (first volume init). On re-runs against an existing volume the scripts do not re-execute. Therefore every `CREATE …` in `db/init.sql` must be idempotent (`CREATE EXTENSION IF NOT EXISTS …`, `DO $$ … IF NOT EXISTS …` for role creation) so volume reuse doesn't error and a fresh volume is identical to a long-lived one.

### 5. CI integration

The Node CI job (`.github/workflows/ci.yml`) does NOT spin up Postgres until M2a — current `/healthz` tests mock `pg` (non-negotiable #8). When the first migration ships, the CI job grows a Postgres service container, runs `db/init.sql` via the container's `/docker-entrypoint-initdb.d/` hook, runs `npm run db:migrate`, then runs vitest. No separate Python job is activated by this ADR — `make py-check` remains M2b's problem.

The decision: **`npm run check` does NOT shell out to `alembic upgrade head` or any Python toolchain.** Migrations are TS-tool-owned and run from `npm run db:migrate`.

### 6. Iron-rule column placement (schema pattern)

| Iron rule | Column(s) | Location |
| --- | --- | --- |
| #6 sensitivity | `entries.sensitivity: text NOT NULL` enum-constrained | every entry row |
| #7 source pointer + verification | `entries.source_pointer: text NOT NULL`, `entries.last_verified_at: timestamptz NOT NULL` | every entry row |
| #9 embedding identifiers | `chunks.embedding_model: text NOT NULL`, `chunks.embedding_version: text NOT NULL` | every chunk row |
| #10 prompt hash | `audit_log.prompt_hash: text` (nullable for non-agent actions) | one row per agent invocation; entries reference via FK on the audit row created by the write |

**Single source for prompt hashes:** `audit_log.prompt_hash`. Not duplicated on `entries` or `chunks`. Joining entry → audit_log is one hop on the FK created by the ingestion-agent write path.

### 7. Admin-only-writes enforcement — app-layer in M1/M2a; DB-roles in M5

App-layer: Next.js middleware on `/api/ingest/*` reads `x-stub-user-role` (stub auth, per M2a checklist) and rejects non-admin. Server-side, not UI-hidden (non-negotiable #4).

**Postgres-role-level enforcement (RLS or role-grants) is deferred to M5** when Entra ID lands and group claims can be mapped to DB roles. Adding RLS now without role-mapping is theater — stub auth is one header, not a DB principal. The M5 hosting + auth ADR re-opens this with concrete role mappings.

### 8. Re-embed event mechanics (model bump operationalization)

A model-version bump (non-negotiable #9: "re-embed when the model changes") is a **data migration**, not a schema migration. The Drizzle migration that "ships" the new model version does **not** call Voyage — it records the bump intent in a project-defined channel (a row in a small `migration_audit` table, or a flag the worker watches; final shape is the M2b worker's call). The actual re-embed runs out-of-band via the M2b FastAPI worker, batch-processing affected chunks against the new model and updating `chunks.embedding` + `chunks.embedding_model` + `chunks.embedding_version` in place. The migration is the trigger; the worker is the executor. **The Drizzle migration never blocks on a Voyage API call** — that's a stuck-transaction footgun.

### 9. Seed / fixture ownership — SQL fixtures + per-test transactional rollback

Tests load fixtures via `db/fixtures/*.sql` in a vitest `beforeEach` that opens a transaction; `afterEach` rolls back. No state leaks between tests; no Drizzle migrations re-run per test.

Unit tests that don't touch the DB stay on the mocked-`pg` pattern from the existing `/healthz` tests. Integration tests against a real Postgres service container appear in M2a alongside the first ingestion route. **This ADR does not add a mechanical enforcement of non-negotiable #8** (no live embedding/Claude APIs in tests) — the existing pattern (mock the client modules) remains the enforcement layer, and the mechanical floor for #8 (a vitest setup assertion that the Voyage / Anthropic client modules resolve to stubs in test mode) lands when the first real call site does, in M2a. Listed for completeness in the BACKLOG-style note alongside the M2a checklist.

### 10. `db/init.sql` vs Drizzle — bootstrap / app-user privilege boundary

`db/init.sql` owns **only** the bootstrap steps that should not run as the app user: `CREATE EXTENSION vector` and creating the least-privilege app DB role. It runs at first-volume-init via the Postgres container's `docker-entrypoint-initdb.d/` hook, as the bootstrap superuser. Drizzle migrations run as the app DB user and own every other DDL statement. Every statement in `db/init.sql` is idempotent (`IF NOT EXISTS`) so volume reuse is safe.

### 11. Production runner of migrations

**Manual deploy step**, gated by env var, run from the same container/job that deploys the Next.js app:

```
npm run db:migrate && npm run start
```

| Option | Verdict |
| --- | --- |
| App-startup hook | rejected — multi-instance deploy races; first-boot deadlock risk. |
| Init container | rejected — only available on some hosting targets (e.g. Kubernetes / Azure App Service custom container), not others (e.g. Vercel). The M5 hosting ADR may re-open this for the chosen target; the manual-deploy-step decision below works on every target. |
| **Manual deploy step (chained command)** | **chosen** — explicit, replayable, no race, hosting-target-agnostic. |

### 12. Rollback policy — forward-only

Drizzle-Kit's `drizzle-kit drop` is supported but unpolished compared to Alembic's `downgrade`. **Forward-only migration policy:** a bad migration is recovered by a forward-fix migration, not by `downgrade`. Same posture as most production Postgres shops.

A bad migration in development is recovered by `docker compose down -v` + restart. A bad migration in production is recovered by either (a) a forward-fix migration or (b) the M5 nightly `pg_dump` restore drill. Both are documented in the M5 production-readiness checklist.

**Transactional-wrap caveat.** Drizzle-Kit wraps each migration in a single transaction by default — so an in-flight failure rolls back cleanly. The exception is statements Postgres cannot run inside a transaction (notably `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, certain `VACUUM` operations). When a migration needs one of those, **it must ship as its own migration file** with no other DDL, and the forward-only policy then means a half-applied concurrent-index migration is recovered by a forward-fix that drops the partial index and re-creates it.

## Consequences

**Positive.**

- One source of truth (TS schema) for query types and API validators; no parallel hand-written types to drift.
- Migrations are SQL on disk — reviewable in PRs as SQL, replayable against any Postgres, portable if we ever leave Drizzle.
- No Python toolchain activation for migrations — `pyproject.toml` stays dormant until M2b actually needs FastAPI.
- Test ergonomics: `drizzle-zod` validators on API boundaries; transactional-rollback fixtures; no live APIs.
- Cross-runtime story is honest: Python is a downstream consumer of a TS-owned schema, not a peer migration writer.

**Negative / accepted.**

- **Overrides ROADMAP M1's Alembic commitment.** This ADR amends ROADMAP M1 line 17 in the same PR — see the file-changes list below.
- **Cross-runtime mirror is hand-maintained.** When Python's M2b worker lands, its SQLAlchemy models mirror the Drizzle schema. Drift is possible. Mitigation: an integration test in `api/tests/` that introspects the live DB schema and asserts SQLAlchemy models match. Deferred to M2b.
- **Forward-only rollback policy.** Means a bad production migration costs a forward-fix PR + deploy, not a `downgrade`. Accepted; same posture as most Postgres shops.
- **Drizzle is still evolving.** Major version bumps could be disruptive. Mitigation: pin Drizzle + Drizzle-Kit by exact version in `package.json`; document upgrades as their own PRs with the migration-replay test as gate.

**Files this ADR's acceptance touches (no code in THIS PR; cascading edits only):**

- `docs/adr/README.md` — add ADR-0008 to the index.
- `docs/BACKLOG.md` — remove "Migration-runner cross-runtime decision" and "ORM / query-builder ADR" from Architecture & Infra (both superseded).
- `docs/ROADMAP.md` M1 line 17 — amend the Alembic reference to point to ADR-0008.

**Downstream PRs unblocked by this ADR (not in scope here):**

1. Chunking-strategy ADR (independent of ADR-0008; can land in either order).
2. Baseline migration PR — wires `drizzle-orm` + `drizzle-kit` into `package.json`, creates `drizzle/schema.ts` with the real table shapes, generates `drizzle/migrations/0001_baseline.sql`, replaces `lib/db.ts`'s raw `pg` usage with the Drizzle client. **Waits for the chunking ADR** because `chunks` table shape (size, overlap, metadata) depends on the chunking strategy.

## Alternatives considered

- **Keep Alembic per ROADMAP M1.** Rejected — activates Python for a single concern in a stretch (M1 → M3) where every schema writer is TypeScript. The original ROADMAP commitment was made before sequencing flipped M2b after M3; the constraint that justified Alembic (Python-runtime-from-day-one) no longer holds.
- **Raw `pg` + node-pg-migrate.** Rejected — SQL-first migrations are nice, but TS types remain hand-written and *will* drift from the SQL. The drift-cost compounds with every M2a/M3 query.
- **Prisma.** Rejected — schema-first DSL is a third language; engine binary is a deployment artifact; production downgrade is weak.
- **Drizzle ORM + Alembic migrations.** Rejected — two sources of truth (Drizzle schema in TS + Alembic schema in Python migrations) with no automatic sync. The cross-runtime hand-off is the *worst* of both worlds: every schema change is two PRs.
- **Postgres roles / RLS enforced from M1.** Rejected — stub auth (one header) has no DB-principal mapping. RLS without role-mapping is configuration that doesn't enforce anything. M5 with Entra ID is the right moment.
- **App-startup migration hook.** Rejected — multi-instance deploy race; first-boot deadlock risk on contended migrations.
- **Per-test live DB without transactions.** Rejected — test pollution; non-negotiable #8 violation if any test accidentally pulls a real embedding.
